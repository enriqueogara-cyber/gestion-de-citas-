import { Router, Request, Response } from "express";
import { z } from "zod";
import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { getClinicSettings } from "../services/clinicSettings";
import { listActiveProfessionals, parseServiceIds } from "../services/professionals";
import { getServicesSync } from "../services/serviceCatalog";
import { getDashboardStats, ReportPeriod } from "../services/reportingService";
import { findOrCreatePatient } from "../services/patients";
import { bookAppointment, rescheduleAppointment, cancelAppointment } from "../services/appointments";
import { listDay, dayRange, recordAttendance, recordPayment, createBlock, setHandoff, staffReply } from "../services/reception";
import { hashPassword, logout } from "../services/staffAuth";
import { createBackup } from "../services/backups";
import { renderOperationsPage } from "./operationsPage";
import { serviceLabel, APPOINTMENT_STATUS_LABEL } from "../lib/labels";
import { rateLimit } from "../lib/rateLimit";
export const operationsRouter = Router();
operationsRouter.use("/api", rateLimit({ windowMs: 60_000, max: 100 }));
const route = (fn: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await fn(req, res); } catch (err) { res.status(400).json({ error: err instanceof z.ZodError ? "Revisa los datos del formulario." : err instanceof Error && !err.message.includes("prisma") ? err.message : "No se pudo guardar el cambio." }); }
};
operationsRouter.get("/operations", route(async (_req, res) => { res.type("html").send(renderOperationsPage(await getClinicSettings())); }));
operationsRouter.get("/api/operations", route(async (req, res) => {
  const date = String(req.query.date || DateTime.now().setZone(clinicConfig.timezone).toISODate());
  const { from, to } = dayRange(date);
  const professionalId = String(req.query.professionalId || "");
  const period = z.enum(["month", "week", "all"]).parse(req.query.period || "month") as ReportPeriod;
  const [appointments, professionals, stats, blocks, handoffs, failures, users] = await Promise.all([
    listDay(date, professionalId || undefined), listActiveProfessionals(), getDashboardStats(period),
    prisma.availabilityBlock.findMany({ where: { clinicId: "default", startsAt: { lt: to }, endsAt: { gt: from }, ...(professionalId ? { OR: [{ professionalId: null }, { professionalId }] } : {}) }, orderBy: { startsAt: "asc" } }),
    prisma.patient.findMany({ where: { clinicId: "default", aiPaused: true }, include: { messages: { orderBy: { createdAt: "desc" }, take: 50 } }, orderBy: { handoffRequestedAt: "asc" } }),
    prisma.inboundMessage.findMany({ where: { status: "FAILED" }, orderBy: { createdAt: "desc" }, take: 30 }),
    res.locals.staff.role === "ADMIN" ? prisma.staffUser.findMany({ select: { id: true, email: true, role: true, active: true } }) : Promise.resolve([]),
  ]);
  const tz = (d: Date) => DateTime.fromJSDate(d).setZone(clinicConfig.timezone);
  const claimIds = handoffs.map(p => p.handoffClaimedBy).filter((id): id is string => !!id);
  const owners = await prisma.staffUser.findMany({ where: { id: { in: claimIds } }, select: { id: true, email: true } });
  res.json({ staff: res.locals.staff, services: getServicesSync(), stats, users,
    professionals: professionals.map(p => ({ ...p, serviceIds: parseServiceIds(p.serviceIds) })),
    appointments: appointments.map(a => ({ ...a, time: tz(a.startsAt).toFormat("HH:mm"), localStart: tz(a.startsAt).toFormat("yyyy-MM-dd'T'HH:mm"), serviceLabel: serviceLabel(a.service), statusLabel: APPOINTMENT_STATUS_LABEL[a.status], needsReview: a.startsAt < new Date() && ["PENDING_CONFIRMATION", "CONFIRMED"].includes(a.status) })),
    blocks: blocks.map(b => ({ ...b, label: (professionals.find(p => p.id === b.professionalId)?.name || "Todo el centro") + " · " + tz(b.startsAt).toFormat("dd/MM HH:mm") + "–" + tz(b.endsAt).toFormat("dd/MM HH:mm") })),
    handoffs: handoffs.map(p => ({ ...p, messages: [...p.messages].reverse(), staffName: owners.find(u => u.id === p.handoffClaimedBy)?.email || "Recepción" })), failures,
  });
}));
const booking = z.object({ name: z.string().trim().min(1).max(80), phone: z.string().regex(/^\d{7,15}$/), serviceId: z.string().min(1), professionalId: z.string().min(1), startsAt: z.string().min(1) });
operationsRouter.post("/api/appointments", route(async (req, res) => {
  const b = booking.parse(req.body), patient = await findOrCreatePatient(b.phone, b.name);
  const appt = await bookAppointment({ patientId: patient.id, patientName: b.name, patientPhone: b.phone, serviceId: b.serviceId, professionalId: b.professionalId, start: DateTime.fromISO(b.startsAt, { zone: clinicConfig.timezone }) });
  res.json({ ok: true, id: appt.id });
}));
operationsRouter.post("/api/appointments/:id/reschedule", route(async (req, res) => {
  const b = z.object({ serviceId: z.string().min(1), professionalId: z.string().min(1), startsAt: z.string().min(1) }).parse(req.body);
  const a = await prisma.appointment.findFirstOrThrow({ where: { id: req.params.id, clinicId: "default" }, include: { patient: true } });
  await rescheduleAppointment({ appointmentId: a.id, patientId: a.patientId, patientName: a.patient.name || "", patientPhone: a.patient.phone, newServiceId: b.serviceId, newProfessionalId: b.professionalId, newStart: DateTime.fromISO(b.startsAt, { zone: clinicConfig.timezone }) }); res.json({ ok: true });
}));
operationsRouter.post("/api/appointments/:id/cancel", route(async (req, res) => { const a = await prisma.appointment.findFirstOrThrow({ where: { id: req.params.id, clinicId: "default" } }); await cancelAppointment(a.id, a.patientId); res.json({ ok: true }); }));
operationsRouter.post("/api/appointments/:id/attendance", route(async (req, res) => { const b = z.object({ status: z.enum(["ARRIVED", "COMPLETED", "NO_SHOW"]) }).parse(req.body); await recordAttendance(req.params.id, b.status); res.json({ ok: true }); }));
operationsRouter.post("/api/appointments/:id/payment", route(async (req, res) => { const b = z.object({ paidCents: z.number().int().min(0).max(100000000) }).parse(req.body); await recordPayment(req.params.id, b.paidCents); res.json({ ok: true }); }));
operationsRouter.post("/api/blocks", route(async (req, res) => { await createBlock(z.object({ professionalId: z.string().optional(), startsAt: z.string(), endsAt: z.string(), reason: z.string().trim().min(1).max(120) }).parse(req.body)); res.json({ ok: true }); }));
operationsRouter.post("/api/blocks/:id/remove", route(async (req, res) => { await prisma.availabilityBlock.deleteMany({ where: { id: req.params.id, clinicId: "default" } }); res.json({ ok: true }); }));
operationsRouter.post("/api/handoffs/:id", route(async (req, res) => { const b = z.object({ paused: z.boolean() }).parse(req.body); await setHandoff(req.params.id, b.paused, res.locals.staff.id); res.json({ ok: true }); }));
operationsRouter.post("/api/handoffs/:id/reply", route(async (req, res) => { await staffReply(req.params.id, z.string().trim().min(1).max(4000).parse(req.body.text), res.locals.staff.id); res.json({ ok: true }); }));
operationsRouter.post("/api/staff", route(async (req, res) => {
  const b = z.object({ email: z.string().email(), password: z.string().min(12).max(256), role: z.enum(["ADMIN", "RECEPTION"]) }).parse(req.body);
  if (await prisma.staffUser.count() === 0 && b.role !== "ADMIN") throw new Error("El primer usuario debe ser administrador.");
  await prisma.staffUser.create({ data: { email: b.email.toLowerCase(), passwordHash: hashPassword(b.password), role: b.role } }); res.json({ ok: true });
}));
operationsRouter.post("/api/staff/:id/disable", route(async (req, res) => { if (req.params.id === res.locals.staff.id) throw new Error("No puedes desactivar tu propio usuario."); await prisma.staffUser.update({ where: { id: req.params.id }, data: { active: false } }); await prisma.staffSession.deleteMany({ where: { userId: req.params.id } }); res.json({ ok: true }); }));
operationsRouter.post("/api/backup", route(async (_req, res) => { await createBackup(); res.json({ ok: true }); }));
operationsRouter.post("/api/logout", route(logout));
operationsRouter.post("/api/inbox/:id/dismiss", route(async (req, res) => { await prisma.inboundMessage.updateMany({ where: { id: req.params.id, status: "FAILED" }, data: { status: "REVIEWED" } }); res.json({ ok: true }); }));
