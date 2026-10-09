import { asyncRouter } from "../lib/asyncRouter";
import { getClinicSettings } from "../services/clinicSettings";
import { getServicesSync } from "../services/serviceCatalog";
import { listActiveProfessionals, parseServiceIds } from "../services/professionals";
import { renderPatientPage } from "./page";
import { DateTime } from "luxon";
import { z } from "zod";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { rateLimit } from "../lib/rateLimit";
import { getAvailability, SlotTakenError } from "../services/appointments";
import { serviceLabel, APPOINTMENT_STATUS_LABEL } from "../lib/labels";
import { contactSchema, publicCreate, portalAppointment, manageAppointment, portalDate } from "./service";
import type { Request, Response } from "express";

export const patientRouter = asyncRouter();
patientRouter.use("/api", rateLimit({ windowMs: 60_000, max: 60 }));
patientRouter.use("/api", (req, res, next) => {
  if (process.env.NODE_ENV === "production" && process.env.PUBLIC_BOOKING_ENABLED !== "true") { res.status(503).json({ error: "Las reservas online aún no están activadas. Contacta con la clínica." }); return; }
  if (req.method !== "GET" && (req.get("X-Patient-Request") !== "1" || req.get("Sec-Fetch-Site") === "cross-site")) { res.status(403).json({ error: "Abre la página de reservas del centro para continuar." }); return; }
  next();
});
const token = (req: Request) => String(req.get("Authorization") || "").replace(/^Bearer /, "");
const action = (handler: (req: Request, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
  try { await handler(req, res); } catch (e) {
    const message = e instanceof z.ZodError ? "Revisa los datos introducidos y el prefijo internacional del teléfono." : e instanceof Error && !/prisma|database|SQL|connect|timeout/i.test(e.message) ? e.message : "No se ha podido completar la solicitud. Contacta con recepción antes de repetirla.";
    res.status(e instanceof SlotTakenError ? 409 : 400).json({ error: message });
  }
};
patientRouter.get("/", async (_req, res) => {
  const [clinic, professionals] = await Promise.all([getClinicSettings(), listActiveProfessionals()]);
  res.type("html").send(renderPatientPage(clinic, getServicesSync(), professionals.map(p => ({ id: p.id, name: p.name, serviceIds: parseServiceIds(p.serviceIds) }))));
});
patientRouter.get("/api/slots", action(async (req, res) => {
  const q = z.object({ serviceId: z.string(), professionalId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
  const slots = await getAvailability(q.serviceId, 1, q.professionalId, portalDate(q.date));
  const earliest = Date.now() + clinicConfig.minBookingNoticeMinutes * 60_000;
  res.json({ slots: slots.filter(d => d.toMillis() > earliest).map(d => ({ iso: d.toISO(), label: d.setZone(clinicConfig.timezone).toFormat("HH:mm") })) });
}));
patientRouter.post("/api/book", rateLimit({ windowMs: 60_000, max: 8 }), action(async (req, res) => { res.json(await publicCreate(token(req), "booking", req.body)); }));
patientRouter.post("/api/waitlist", rateLimit({ windowMs: 60_000, max: 8 }), action(async (req, res) => { res.json(await publicCreate(token(req), "waitlist", req.body)); }));
patientRouter.post("/api/contact", rateLimit({ windowMs: 60_000, max: 3 }), action(async (req, res) => {
  const data = contactSchema.extend({ message: z.string().trim().min(3).max(500) }).parse(req.body);
  // Repeated clicks/retries do not create repeated callback requests.
  const existing = await prisma.contactRequest.findFirst({ where: { phone: data.phone, message: data.message, status: "OPEN", createdAt: { gte: new Date(Date.now() - 3600_000) } } });
  if (!existing) await prisma.contactRequest.create({ data });
  res.json({ ok: true });
}));
patientRouter.get("/api/appointment", action(async (req, res) => {
  const a = await portalAppointment(token(req));
  res.json({ serviceId: a.service, serviceLabel: serviceLabel(a.service), professionalId: a.professionalId, professionalName: a.professional?.name || "Equipo del centro", startsAt: a.startsAt, when: DateTime.fromJSDate(a.startsAt).setZone(clinicConfig.timezone).setLocale("es").toFormat("cccc d 'de' LLLL, HH:mm"), status: a.status, statusLabel: APPOINTMENT_STATUS_LABEL[a.status], editable: a.startsAt > new Date() && ["PENDING_CONFIRMATION", "CONFIRMED"].includes(a.status) });
}));
patientRouter.post("/api/manage", rateLimit({ windowMs: 60_000, max: 10 }), action(async (req, res) => {
  const b = z.object({ action: z.enum(["cancel", "change", "confirm"]), startsAt: z.string().optional() }).parse(req.body);
  await manageAppointment(token(req), b.action, b.startsAt); res.json({ ok: true });
}));
