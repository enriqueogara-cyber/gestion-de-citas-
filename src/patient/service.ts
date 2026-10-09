import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { bookAppointment, cancelAppointment, confirmAppointment, rescheduleAppointment, getService } from "../services/appointments";
import { getQualifiedProfessionals } from "../services/professionals";
import { joinWaitlist } from "../services/waitlist";
import { withConversation } from "../lib/conversationLock";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const contactSchema = z.object({ name: z.string().trim().min(2).max(80), phone: z.string().transform(s => s.replace(/[\s()+-]/g, "")).pipe(z.string().regex(/^[1-9]\d{7,14}$/, "Incluye el prefijo internacional en el teléfono.")) });
export const bookingSchema = contactSchema.extend({ serviceId: z.string().min(1).max(100), professionalId: z.string().min(1).max(100), startsAt: z.string().datetime({ offset: true }) });
export const waitlistSchema = contactSchema.extend({ serviceId: z.string().min(1).max(100), professionalId: z.string().min(1).max(100), fromDate: z.string(), toDate: z.string(), preferredTimeOfDay: z.enum(["MORNING", "AFTERNOON"]).optional() });
export function portalDate(value: string) {
  const date = DateTime.fromISO(value, { zone: clinicConfig.timezone });
  const now = DateTime.now().setZone(clinicConfig.timezone);
  if (!date.isValid || date < now.startOf("day") || date > now.plus({ days: 60 }).endOf("day")) throw new Error("Elige una fecha entre hoy y los próximos 60 días.");
  return date;
}
export function tokenHash(token: unknown) {
  return digest(z.string().regex(/^[a-f0-9]{64}$/).parse(token));
}
async function validateProfessional(serviceId: string, professionalId: string) {
  getService(serviceId);
  if (!(await getQualifiedProfessionals(serviceId)).some(p => p.id === professionalId)) throw new Error("Este profesional no está disponible para el servicio elegido.");
}
export async function publicCreate(token: string, kind: "booking" | "waitlist", input: unknown) {
  const key = tokenHash(token);
  const data = kind === "booking" ? bookingSchema.parse(input) : waitlistSchema.parse(input);
  const requestHash = digest(JSON.stringify({ kind, data }));
  return withConversation("portal:" + key, async () => {
    const previous = await prisma.portalAccess.findUnique({ where: { tokenHash: key } });
    if (previous) {
      if (previous.requestHash !== requestHash || previous.kind !== kind) throw new Error("Esta solicitud ya se utilizó. Empieza una nueva reserva.");
      if (previous.status !== "READY") throw new Error("Esta solicitud requiere revisión. Contacta con recepción antes de repetirla.");
      if (previous.revokedAt || previous.expiresAt < new Date()) throw new Error("El enlace ha caducado. Contacta con recepción.");
      return { ok: true, kind, appointmentId: previous.appointmentId };
    }
    await validateProfessional(data.serviceId, data.professionalId);
    if ("startsAt" in data) portalDate(data.startsAt);
    else { if (portalDate(data.toDate) < portalDate(data.fromDate)) throw new Error("La fecha final debe ser posterior a la inicial."); }
    // The durable PROCESSING marker prevents a retry from repeating an ambiguous interrupted booking.
    await prisma.portalAccess.create({ data: { tokenHash: key, requestHash, kind, contactName: data.name, contactPhone: data.phone, expiresAt: DateTime.now().plus({ days: 90 }).toJSDate() } });
    try {
      const patient = await prisma.patient.upsert({ where: { phone: data.phone }, update: {}, create: { phone: data.phone, name: data.name } });
      if ("startsAt" in data) {
        const appointment = await bookAppointment({ patientId: patient.id, patientName: data.name, patientPhone: data.phone, serviceId: data.serviceId, professionalId: data.professionalId, start: portalDate(data.startsAt) });
        await prisma.portalAccess.update({ where: { tokenHash: key }, data: { status: "READY", appointmentId: appointment.id } });
        return { ok: true, kind, appointmentId: appointment.id };
      }
      const entry = await joinWaitlist({ patientId: patient.id, serviceId: data.serviceId, professionalId: data.professionalId, earliestDate: portalDate(data.fromDate).startOf("day"), latestDate: portalDate(data.toDate).endOf("day"), preferredTimeOfDay: data.preferredTimeOfDay });
      await prisma.portalAccess.update({ where: { tokenHash: key }, data: { status: "READY", waitlistId: entry.id } });
      return { ok: true, kind, appointmentId: null };
    } catch (error) {
      await prisma.portalAccess.update({ where: { tokenHash: key }, data: { status: "REVIEW" } });
      throw error;
    }
  });
}
export async function portalAppointment(token: string) {
  const access = await prisma.portalAccess.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!access || access.revokedAt || access.expiresAt <= new Date() || !access.appointmentId || access.status !== "READY") throw new Error("Este enlace no está disponible o ha caducado. Contacta con recepción.");
  const appointment = await prisma.appointment.findFirst({ where: { id: access.appointmentId, clinicId: "default" }, include: { professional: true } });
  if (!appointment) throw new Error("La cita no está disponible. Contacta con recepción.");
  return appointment;
}
export async function manageAppointment(token: string, action: "cancel" | "change" | "confirm", startsAt?: string) {
  const key = tokenHash(token);
  return withConversation("portal:" + key, async () => {
    const a = await portalAppointment(token);
    return withConversation(a.patientId, async () => {
      if (action === "cancel" && a.status === "CANCELLED") return;
      if (a.startsAt <= new Date() || !["PENDING_CONFIRMATION", "CONFIRMED"].includes(a.status)) throw new Error("Esta cita ya no admite cambios online. Contacta con recepción.");
      if (action === "cancel") { await cancelAppointment(a.id, a.patientId); return; }
      if (action === "confirm") { if (a.status === "PENDING_CONFIRMATION") await confirmAppointment(a.id, a.patientId); return; }
      const start = portalDate(z.string().datetime({ offset: true }).parse(startsAt));
      if (start.toMillis() === a.startsAt.getTime()) return;
      const patient = await prisma.patient.findUniqueOrThrow({ where: { id: a.patientId } });
      const next = await rescheduleAppointment({ appointmentId: a.id, patientId: a.patientId, patientName: patient.name || "", patientPhone: patient.phone, newStart: start });
      await prisma.portalAccess.update({ where: { tokenHash: key }, data: { appointmentId: next.id } });
    });
  });
}
