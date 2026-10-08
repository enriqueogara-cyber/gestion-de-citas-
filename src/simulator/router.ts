import { Router, Request, Response } from "express";
import { prisma } from "../db/client";
import { findOrCreatePatient } from "../services/patients";
import { handleIncomingMessage } from "../agent/claude";
import { renderChatPage } from "./chatPage";
import { renderDashboardPage, AgendaRow } from "./dashboardPage";
import { renderWaitlistPage, WaitlistRow } from "./waitlistPage";
import { renderSettingsPage } from "./settingsPage";
import { isUsingRealGoogleCalendar } from "../calendar";
import { getClinicSettings, updateClinicSettings } from "../services/clinicSettings";
import { getDashboardStats, listUpcomingAgenda } from "../services/reportingService";
import { getLlmStats } from "../services/llmStats";
import { listRecentEvents, listAttentionItems } from "../services/auditLog";
import { listAllActiveWaitlist, listWaitlistForPatient } from "../services/waitlist";
import {
  listActiveProfessionals,
  createProfessional,
  deactivateProfessional,
  setProfessionalServices,
} from "../services/professionals";
import {
  getAllServicesSync,
  createService,
  updateService,
  setServiceActive,
  replaceOpeningHoursForDay,
  getOpeningHoursSync,
  ServiceValidationError,
  OpeningHoursValidationError,
} from "../services/serviceCatalog";
import { listUpcomingAppointments } from "../services/appointments";
import { seedDemoData, resetAllDemoData, runRecoverSlotScenario, getRecoverySlotDemoService } from "../services/demoScenarios";
import { logger } from "../lib/logger";
import { singleFlight, AlreadyRunningError } from "../lib/singleFlight";
import { rateLimit } from "../lib/rateLimit";
import { serviceLabel, AUDIT_EVENT_LABEL, APPOINTMENT_STATUS_LABEL } from "../lib/labels";
import { formatLong } from "../lib/dates";

export const simulatorRouter = Router();

// Ver lib/rateLimit.ts. Dos perfiles: uno para lo que llama al LLM (más
// caro, tanto en latencia como en coste real), otro para mutaciones en
// general (ajustes, demo...). Ambos se pueden desactivar con
// RATE_LIMIT_DISABLED=1 para no romper QA automatizado.
const llmRateLimit = rateLimit({ windowMs: 60_000, max: 20 });
const mutationRateLimit = rateLimit({ windowMs: 60_000, max: 30 });

function demoPhone(sessionId: string): string {
  // Prefijo claro para no confundir nunca estos pacientes de prueba con
  // números de WhatsApp reales.
  return `demo-${sessionId}`;
}

// --- Páginas ---

simulatorRouter.get("/", async (_req: Request, res: Response) => {
  const settings = await getClinicSettings();
  res.type("html").send(renderChatPage(settings));
});

simulatorRouter.get("/dashboard", async (_req: Request, res: Response) => {
  const settings = await getClinicSettings();
  const [stats, events, agendaRaw, attentionRaw, llmStats] = await Promise.all([
    getDashboardStats(),
    listRecentEvents(30),
    listUpcomingAgenda(20),
    listAttentionItems(),
    getLlmStats(),
  ]);
  const agenda: AgendaRow[] = agendaRaw.map((a) => ({
    id: a.id,
    service: a.service,
    startsAt: a.startsAt,
    status: a.status,
    patientName: a.patient.name || a.patient.phone,
    professionalName: a.professional?.name ?? null,
    recoveredFromWaitlist: a.recoveredFromWaitlist,
  }));

  const attentionPatientIds = [...new Set(attentionRaw.map((e) => e.patientId).filter((x): x is string => !!x))];
  const attentionPatients = attentionPatientIds.length
    ? await prisma.patient.findMany({ where: { id: { in: attentionPatientIds } } })
    : [];
  const attentionPatientName = new Map(attentionPatients.map((p) => [p.id, p.name || p.phone]));
  const attention = attentionRaw.map((e) => ({
    id: e.id,
    type: e.type,
    patientName: e.patientId ? attentionPatientName.get(e.patientId) ?? null : null,
    reason: typeof e.metadata.reason === "string" ? e.metadata.reason : null,
    createdAt: e.createdAt,
  }));
  const demoService = getRecoverySlotDemoService();
  res.type("html").send(renderDashboardPage(settings, stats, events, agenda, demoService, attention, llmStats));
});

simulatorRouter.get("/api/llm-stats", async (_req: Request, res: Response) => {
  res.json(await getLlmStats());
});

simulatorRouter.get("/waitlist", async (_req: Request, res: Response) => {
  const settings = await getClinicSettings();
  const rows = await listAllActiveWaitlist();
  const view: WaitlistRow[] = rows.map((r) => ({
    id: r.id,
    patientName: r.patient.name || r.patient.phone,
    service: r.service,
    earliestDate: r.earliestDate,
    latestDate: r.latestDate,
    professionalName: r.Professional?.name ?? null,
    preferredTimeOfDay: r.preferredTimeOfDay,
    status: r.status,
    offeredSlotStart: r.offeredSlotStart,
    offerExpiresAt: r.offerExpiresAt,
    createdAt: r.createdAt,
  }));
  res.type("html").send(renderWaitlistPage(settings, view));
});

simulatorRouter.get("/settings", async (_req: Request, res: Response) => {
  const settings = await getClinicSettings();
  const professionals = await listActiveProfessionals();
  const services = getAllServicesSync();
  const openingHours = getOpeningHoursSync();
  res.type("html").send(renderSettingsPage(settings, professionals, services, openingHours));
});

simulatorRouter.post("/api/professionals", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    const created = await createProfessional(String(req.body?.name || ""));
    res.json(created);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "No se pudo dar de alta al profesional." });
  }
});

simulatorRouter.post("/api/professionals/:id/deactivate", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    await deactivateProfessional(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "No se pudo dar de baja al profesional." });
  }
});

simulatorRouter.post("/api/professionals/:id/services", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    const serviceIds = Array.isArray(req.body?.serviceIds) ? req.body.serviceIds.map(String) : [];
    await setProfessionalServices(req.params.id, serviceIds);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "No se pudieron guardar los servicios del profesional." });
  }
});

// --- Servicios (ver FASE 2: configurables desde Settings, no en código) ---

simulatorRouter.post("/api/services", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    await createService({
      name: String(b.name || ""),
      durationMinutes: Number(b.durationMinutes),
      priceEur: b.priceEur === "" || b.priceEur == null ? null : Number(b.priceEur),
    });
    res.json({ ok: true });
  } catch (err: any) {
    const status = err instanceof ServiceValidationError ? 400 : 500;
    res.status(status).json({ error: err?.message || "No se pudo crear el servicio." });
  }
});

simulatorRouter.post("/api/services/:id", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    await updateService(req.params.id, {
      name: String(b.name || ""),
      durationMinutes: Number(b.durationMinutes),
      priceEur: b.priceEur === "" || b.priceEur == null ? null : Number(b.priceEur),
    });
    res.json({ ok: true });
  } catch (err: any) {
    const status = err instanceof ServiceValidationError ? 400 : 500;
    res.status(status).json({ error: err?.message || "No se pudo actualizar el servicio." });
  }
});

simulatorRouter.post("/api/services/:id/active", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    await setServiceActive(req.params.id, !!req.body?.active);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "No se pudo cambiar el estado del servicio." });
  }
});

// --- Horario de apertura (ver FASE 4) ---

simulatorRouter.post("/api/opening-hours/:weekday", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    const weekday = Number(req.params.weekday);
    const ranges = Array.isArray(req.body?.ranges) ? req.body.ranges : [];
    await replaceOpeningHoursForDay(weekday, ranges);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err instanceof OpeningHoursValidationError ? 400 : 500;
    res.status(status).json({ error: err?.message || "No se pudo guardar el horario." });
  }
});

// --- APIs de datos ---

simulatorRouter.get("/api/status", (_req: Request, res: Response) => {
  res.json({ calendarConfigured: isUsingRealGoogleCalendar });
});

simulatorRouter.get("/api/dashboard", async (_req: Request, res: Response) => {
  const [stats, events] = await Promise.all([getDashboardStats(), listRecentEvents(30)]);
  res.json({ stats, events });
});

simulatorRouter.get("/api/settings", async (_req: Request, res: Response) => {
  res.json(await getClinicSettings());
});

simulatorRouter.post("/api/settings", mutationRateLimit, async (req: Request, res: Response) => {
  try {
    const updated = await updateClinicSettings(req.body || {});
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || "No se pudo guardar la configuración." });
  }
});

simulatorRouter.get("/api/history", async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.json({ messages: [] });

  const patient = await prisma.patient.findUnique({ where: { phone: demoPhone(sessionId) } });
  if (!patient) return res.json({ messages: [] });

  const messages = await prisma.conversationMessage.findMany({
    where: { patientId: patient.id },
    orderBy: { createdAt: "asc" },
  });
  res.json({ messages: messages.map((m) => ({ role: m.role, content: m.content })) });
});

// Estado real (nunca inventado) de la conversación actual, para el panel
// lateral "Estado de conversación" del chat en desktop: la cita u oferta de
// lista de espera más relevante del paciente ahora mismo, tal cual está en
// la base de datos, más el último evento registrado. Si no hay nada, el
// frontend muestra un empty state — nunca se rellena con datos de relleno.
simulatorRouter.get("/api/state", async (req: Request, res: Response) => {
  const sessionId = String(req.query.sessionId || "");
  if (!sessionId) return res.json({ patientName: null, appointment: null, waitlist: null, lastEvent: null });

  const patient = await prisma.patient.findUnique({ where: { phone: demoPhone(sessionId) } });
  if (!patient) return res.json({ patientName: null, appointment: null, waitlist: null, lastEvent: null });

  const [appointments, waitlist, lastEvent] = await Promise.all([
    listUpcomingAppointments(patient.id),
    listWaitlistForPatient(patient.id),
    prisma.auditLog.findFirst({ where: { patientId: patient.id }, orderBy: { createdAt: "desc" } }),
  ]);

  const appt = appointments[0];
  const wait = !appt ? waitlist[0] : undefined;

  res.json({
    patientName: patient.name || null,
    appointment: appt
      ? {
          service: serviceLabel(appt.service),
          professionalName: appt.professional?.name ?? null,
          whenLabel: formatLong(appt.startsAt),
          status: appt.status,
          statusLabel: APPOINTMENT_STATUS_LABEL[appt.status] || appt.status,
        }
      : null,
    waitlist: wait
      ? {
          service: serviceLabel(wait.service),
          statusLabel: wait.status === "OFFERED" ? "Hueco ofrecido, esperando respuesta" : "En lista de espera",
          offeredWhenLabel: wait.offeredSlotStart ? formatLong(wait.offeredSlotStart) : null,
        }
      : null,
    lastEvent: lastEvent ? AUDIT_EVENT_LABEL[lastEvent.type] || lastEvent.type : null,
  });
});

simulatorRouter.post("/api/message", llmRateLimit, async (req: Request, res: Response) => {
  const { sessionId, text } = req.body || {};
  if (!sessionId || !text) {
    return res.status(400).json({ error: "Falta sessionId o text." });
  }

  try {
    const patient = await findOrCreatePatient(demoPhone(sessionId), "Paciente Demo");
    const result = await handleIncomingMessage(
      { patientId: patient.id, phone: patient.phone, name: patient.name || "" },
      String(text)
    );
    res.json({ reply: result.reply, handoffReason: result.handoffReason });
  } catch (err: any) {
    // handleIncomingMessage ya captura sus propios fallos y devuelve una
    // respuesta natural (ver agent/claude.ts); si llegamos aquí es un fallo
    // realmente inesperado (DB caída, etc.) — sí queremos verlo en la demo.
    logger.error("simulator_message_failed", { err });
    res.status(500).json({ error: `El agente ha fallado (revisa la consola del servidor): ${err?.message || "error desconocido"}` });
  }
});

simulatorRouter.post("/api/reset", mutationRateLimit, async (req: Request, res: Response) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: "Falta sessionId." });

  const patient = await prisma.patient.findUnique({ where: { phone: demoPhone(sessionId) } });
  if (patient) {
    // Orden por claves foráneas: mensajes/citas/lista de espera antes que el paciente.
    await prisma.conversationMessage.deleteMany({ where: { patientId: patient.id } });
    await prisma.waitlistEntry.deleteMany({ where: { patientId: patient.id } });
    await prisma.appointment.deleteMany({ where: { patientId: patient.id } });
    await prisma.patient.delete({ where: { id: patient.id } });
  }
  res.json({ ok: true });
});

// --- Controles de demo (ver README, "Demo mode") ---
// Cada acción va protegida con singleFlight: un doble clic (o dos pestañas)
// no puede ejecutar la misma acción dos veces en paralelo — crítico para
// "Simular recuperar hueco", que si corriera dos veces a la vez podría
// contar ingresos recuperados por duplicado.

simulatorRouter.post("/api/demo/seed", mutationRateLimit, async (_req: Request, res: Response) => {
  try {
    res.json(await singleFlight("demo:seed", seedDemoData));
  } catch (err: any) {
    const status = err instanceof AlreadyRunningError ? 409 : 500;
    res.status(status).json({ error: err?.message || "No se pudo sembrar la demo." });
  }
});

simulatorRouter.post("/api/demo/reset-all", mutationRateLimit, async (_req: Request, res: Response) => {
  try {
    await singleFlight("demo:reset-all", resetAllDemoData);
    res.json({ ok: true });
  } catch (err: any) {
    const status = err instanceof AlreadyRunningError ? 409 : 500;
    res.status(status).json({ error: err?.message || "No se pudo reiniciar la demo." });
  }
});

simulatorRouter.post("/api/demo/recover-slot-scenario", mutationRateLimit, async (_req: Request, res: Response) => {
  try {
    res.json(await singleFlight("demo:recover-slot-scenario", runRecoverSlotScenario));
  } catch (err: any) {
    const status = err instanceof AlreadyRunningError ? 409 : 500;
    res.status(status).json({ error: err?.message || "No se pudo ejecutar el escenario." });
  }
});
