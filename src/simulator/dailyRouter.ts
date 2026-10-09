import { DateTime } from "luxon";
import { randomBytes } from "node:crypto";
import { prisma } from "../db/client";
import { asyncRouter } from "../lib/asyncRouter";
import { clinicConfig } from "../config";
import { serviceLabel, APPOINTMENT_STATUS_LABEL } from "../lib/labels";
import { confirmAppointment } from "../services/appointments";
import { digest } from "../patient/service";

export const dailyRouter = asyncRouter();
const serialize = (a: any) => ({ id: a.id, patientName: a.patient.name || a.patient.phone, phone: a.patient.phone, service: a.service, serviceLabel: serviceLabel(a.service), professionalId: a.professionalId, status: a.status, statusLabel: APPOINTMENT_STATUS_LABEL[a.status], startsAt: a.startsAt, localStart: DateTime.fromJSDate(a.startsAt).setZone(clinicConfig.timezone).toFormat("yyyy-MM-dd'T'HH:mm"), when: DateTime.fromJSDate(a.startsAt).setZone(clinicConfig.timezone).setLocale("es").toFormat("dd/LL HH:mm") });
dailyRouter.get("/api/today", async (_req, res) => {
  const today = DateTime.now().setZone(clinicConfig.timezone).startOf("day");
  const [appointments, handoffs, requests, jobs, inbox, portal] = await Promise.all([
    prisma.appointment.findMany({ where: { clinicId: "default", startsAt: { gte: today.toJSDate(), lt: today.plus({ days: 1 }).toJSDate() }, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] } }, include: { patient: true }, orderBy: { startsAt: "asc" } }),
    prisma.patient.count({ where: { clinicId: "default", aiPaused: true } }),
    prisma.contactRequest.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 50 }),
    prisma.scheduledJob.findMany({ where: { status: "FAILED" }, orderBy: { updatedAt: "desc" }, take: 30 }),
    prisma.inboundMessage.count({ where: { status: "FAILED" } }),
    prisma.portalAccess.findMany({ where: { OR: [{ status: "REVIEW" }, { status: "PROCESSING", createdAt: { lt: new Date(Date.now()-5*60_000) } }] }, take: 30, select: { tokenHash: true, contactName: true, contactPhone: true, kind: true } }),
  ]);
  res.json({ date: today.toFormat("dd/LL/yyyy"), appointments: appointments.map(serialize), handoffs, requests, failures: jobs.map(j => ({ id: j.id, appointmentId: j.appointmentId, label: j.type.startsWith("REMINDER") ? "No se pudo completar el recordatorio" : "La oferta de lista de espera necesita revisión" })), inbox, portal });
});
dailyRouter.get("/api/patients/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 80);
  if (q.length < 2) { res.json({ patients: [] }); return; }
  const phone = q.replace(/[\s()+-]/g, "");
  const patients = await prisma.patient.findMany({ where: { clinicId: "default", OR: [{ name: { contains: q } }, { phone: { contains: phone || q } }] }, take: 20, orderBy: { name: "asc" }, include: { appointments: { where: { startsAt: { gte: new Date() }, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] } }, orderBy: { startsAt: "asc" }, take: 1 } } });
  res.json({ patients: patients.map(p => ({ id: p.id, name: p.name || "Sin nombre", phone: p.phone, next: p.appointments[0] ? serialize({ ...p.appointments[0], patient: p }) : null })) });
});
dailyRouter.get("/api/patients/:id", async (req, res) => {
  const p = await prisma.patient.findFirst({ where: { id: req.params.id, clinicId: "default" }, select: { id: true, name: true, phone: true } });
  if (!p) { res.status(404).json({ error: "Paciente no encontrado." }); return; } res.json(p);
});
dailyRouter.get("/api/appointments/:id", async (req, res) => {
  const a = await prisma.appointment.findFirst({ where: { id: req.params.id, clinicId: "default" }, include: { patient: true } });
  if (!a) { res.status(404).json({ error: "Cita no encontrada." }); return; } res.json(serialize(a));
});
dailyRouter.post("/api/appointments/:id/confirm", async (req, res) => {
  const a = await prisma.appointment.findFirst({ where: { id: req.params.id, clinicId: "default" } });
  if (!a) { res.status(404).json({ error: "Cita no encontrada." }); return; }
  if(a.status !== "CONFIRMED") await confirmAppointment(a.id, a.patientId);
  res.json({ ok: true });
});
dailyRouter.post("/api/appointments/:id/link", async (req, res) => {
  const a = await prisma.appointment.findFirst({ where: { id: req.params.id, clinicId: "default" } });
  if (!a || !["PENDING_CONFIRMATION", "CONFIRMED"].includes(a.status) || a.startsAt < new Date()) { res.status(400).json({ error: "Solo se puede generar un enlace para una cita futura activa." }); return; }
  const token = randomBytes(32).toString("hex");
  await prisma.$transaction([
    prisma.portalAccess.updateMany({ where: { appointmentId: a.id }, data: { revokedAt: new Date() } }),
    prisma.portalAccess.create({ data: { tokenHash: digest(token), requestHash: "staff", kind: "booking", status: "READY", appointmentId: a.id, expiresAt: DateTime.now().plus({ days: 90 }).toJSDate() } }),
  ]);
  res.json({ token });
});
dailyRouter.post("/api/contacts/:id/resolve", async (req, res) => { await prisma.contactRequest.updateMany({ where: { id: req.params.id, status: "OPEN" }, data: { status: "RESOLVED" } }); res.json({ ok: true }); });
dailyRouter.post("/api/jobs/:id/review", async (req, res) => { await prisma.scheduledJob.updateMany({ where: { id: req.params.id, status: "FAILED" }, data: { status: "REVIEWED" } }); res.json({ ok: true }); });
dailyRouter.post("/api/portal/:id/review", async (req, res) => {
  await prisma.portalAccess.updateMany({ where: { tokenHash: req.params.id, OR: [{ status: "REVIEW" }, { status: "PROCESSING", createdAt: { lt: new Date(Date.now()-5*60_000) } }] }, data: { status: "REVIEWED" } }); res.json({ ok: true });
});
