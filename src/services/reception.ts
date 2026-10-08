import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { BookingValidationError, transitionAppointment } from "../domain/bookingEngine";
import { AppointmentStatus } from "../domain/appointmentStateMachine";
import { recordEvent } from "./auditLog";
import { cancelJobsForAppointment } from "../scheduler/persistentJobs";
import { withConversation } from "../lib/conversationLock";
import { notifyPatient, isDemoPhone } from "../notifications/notify";

export function dayRange(date: string) {
  const from = DateTime.fromISO(date, { zone: clinicConfig.timezone }).startOf("day");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !from.isValid) throw new Error("Fecha inválida.");
  return { from: from.toJSDate(), to: from.plus({ days: 1 }).toJSDate() };
}
export async function listDay(date: string, professionalId?: string) {
  const { from, to } = dayRange(date);
  return prisma.appointment.findMany({ where: { clinicId: "default", startsAt: { gte: from, lt: to }, ...(professionalId ? { professionalId } : {}) }, include: { patient: true, professional: true }, orderBy: { startsAt: "asc" } });
}
export async function recordAttendance(id: string, status: AppointmentStatus) {
  if (!["ARRIVED", "COMPLETED", "NO_SHOW"].includes(status)) throw new Error("Estado de asistencia inválido.");
  const appt = await prisma.appointment.findFirst({ where: { id, clinicId: "default" } });
  if (!appt) throw new Error("No se encuentra la cita.");
  if (status === "NO_SHOW" && appt.startsAt > new Date()) throw new Error("Todavía no ha llegado la hora de la cita.");
  const result = await transitionAppointment(id, appt.patientId, status);
  if (!result.ok) throw new BookingValidationError(result.reason, result.code);
  if (status === "ARRIVED") await prisma.appointment.update({ where: { id }, data: { arrivedAt: new Date() } });
  await cancelJobsForAppointment(id);
  await recordEvent(status === "COMPLETED" ? "APPOINTMENT_COMPLETED" : status === "NO_SHOW" ? "APPOINTMENT_NO_SHOW" : "APPOINTMENT_ARRIVED", { appointmentId: id, patientId: appt.patientId });
  return result.appointment;
}
export async function recordPayment(id: string, cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > 100000000) throw new Error("Importe inválido.");
  const appt = await prisma.appointment.findFirst({ where: { id, clinicId: "default" } });
  if (!appt || appt.status !== "COMPLETED") throw new Error("Registra primero la cita como completada.");
  await prisma.appointment.update({ where: { id }, data: { paidCents: cents } });
  await recordEvent("PAYMENT_RECORDED", { appointmentId: id, metadata: { cents } });
}
export async function createBlock(params: { professionalId?: string; startsAt: string; endsAt: string; reason: string }) {
  const start = DateTime.fromISO(params.startsAt, { zone: clinicConfig.timezone });
  const end = DateTime.fromISO(params.endsAt, { zone: clinicConfig.timezone });
  if (!start.isValid || !end.isValid || end <= start || !params.reason.trim() || params.reason.length > 120) throw new Error("Introduce un tramo y un motivo válidos.");
  return prisma.$transaction(async tx => {
    if (params.professionalId && !await tx.professional.findFirst({ where: { id: params.professionalId, active: true, clinicId: "default" } })) throw new Error("Profesional inválido.");
    const overlap = { startsAt: { lt: end.toJSDate() }, endsAt: { gt: start.toJSDate() } };
    if (await tx.appointment.count({ where: { ...overlap, clinicId: "default", status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] }, ...(params.professionalId ? { professionalId: params.professionalId } : {}) } })) throw new Error("Hay citas en ese tramo. Cámbialas antes de bloquearlo.");
    if (await tx.slotHold.count({ where: { ...overlap, expiresAt: { gt: new Date() }, ...(params.professionalId ? { OR: [{ professionalId: null }, { professionalId: params.professionalId }] } : {}) } })) throw new Error("Hay un hueco ofrecido a un paciente en ese tramo.");
    return tx.availabilityBlock.create({ data: { professionalId: params.professionalId || null, startsAt: start.toJSDate(), endsAt: end.toJSDate(), reason: params.reason.trim() } });
  });
}
export async function requestHandoff(patientId: string, reason: string) {
  await prisma.patient.update({ where: { id: patientId, clinicId: "default" }, data: { aiPaused: true, handoffReason: reason, handoffRequestedAt: new Date(), handoffClaimedBy: null } });
  await recordEvent("HUMAN_HANDOFF_REQUESTED", { patientId });
}
export async function setHandoff(patientId: string, paused: boolean, staffId: string) {
  return withConversation(patientId, async () => {
    const patient = await prisma.patient.findFirstOrThrow({ where: { id: patientId, clinicId: "default" } });
    if (patient.handoffClaimedBy && patient.handoffClaimedBy !== staffId) throw new Error("La conversación ya está asignada a otra persona del equipo.");
    await prisma.patient.update({ where: { id: patientId, clinicId: "default" }, data: { aiPaused: paused, handoffClaimedBy: paused ? staffId : null, ...(!paused ? { handoffReason: null, handoffRequestedAt: null } : {}) } });
    await recordEvent(paused ? "HUMAN_HANDOFF_CLAIMED" : "HUMAN_HANDOFF_RESOLVED", { patientId, metadata: { staffId } });
  });
}
export async function staffReply(patientId: string, text: string, staffId: string) {
  if (!text.trim() || text.length > 4000) throw new Error("Escribe un mensaje de hasta 4000 caracteres.");
  return withConversation(patientId, async () => {
    const patient = await prisma.patient.findFirst({ where: { id: patientId, clinicId: "default" } });
    if (!patient?.aiPaused || patient.handoffClaimedBy !== staffId) throw new Error("Hazte cargo de la conversación antes de responder.");
    await notifyPatient(patient, text.trim());
    if (!isDemoPhone(patient.phone)) await prisma.conversationMessage.create({ data: { patientId, role: "assistant", content: text.trim() } });
    await recordEvent("HUMAN_REPLY_SENT", { patientId, metadata: { staffId } });
  });
}
