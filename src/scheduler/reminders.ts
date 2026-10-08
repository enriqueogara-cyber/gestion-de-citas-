import cron from "node-cron";
import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { notifyPatient, notifyPatientTemplate } from "../notifications/notify";
import { recordEvent } from "../services/auditLog";
import { logger } from "../lib/logger";
import { handleWaitlistOfferExpiredJob, cleanupExpiredSlotHolds } from "../services/waitlistOrchestrator";
import { processDueJobs } from "./persistentJobs";

/**
 * Recordatorios y caducidad de ofertas de lista de espera, sobre la tabla
 * `ScheduledJob` (ver scheduler/persistentJobs.ts) — cada uno es una fila
 * con su propio estado y reintentos, no solo "lo que encuentre un cron al
 * escanear citas cada 15 minutos". Esto es lo que hace que sobrevivan a un
 * reinicio del proceso: `processDueJobs()` se llama una vez nada más
 * arrancar (retoma lo pendiente) y luego en cada tick.
 *
 * `markPastNoShows`/`markPastCompletions` siguen siendo barridos simples
 * (no recordatorios "que hay que mandar una vez", sino un cambio de estado
 * masivo e idempotente por sí mismo vía `updateMany` con el estado de
 * origen en el WHERE) — no aportaría nada convertirlos en jobs.
 */

function formatWhen(date: Date): string {
  return DateTime.fromJSDate(date)
    .setZone(clinicConfig.timezone)
    .setLocale("es")
    .toFormat("cccc d 'de' LLLL 'a las' HH:mm");
}

/**
 * Recordatorio ~24h antes. Suele caer fuera de la ventana de 24h de
 * "servicio al cliente" de WhatsApp (el paciente no ha escrito hoy), así
 * que usamos una plantilla aprobada en Meta en lugar de texto libre.
 *
 * Plantilla a crear en Meta Business Manager, nombre "recordatorio_cita_24h":
 *   "Hola {{1}}, te recordamos tu cita de {{2}} el {{3}}.
 *    Responde SI para confirmar o NO para cancelar y liberar el hueco."
 */
async function handleReminder24hJob(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { patient: true } });
  if (!appt || appt.status !== "PENDING_CONFIRMATION") return; // cancelada/confirmada entre medias: nada que hacer

  await notifyPatientTemplate(
    appt.patient,
    `Hola ${appt.patient.name || ""}, te recordamos tu cita de ${appt.service} el ${formatWhen(appt.startsAt)}. ` +
      `Responde SI para confirmar o NO para cancelar y liberar el hueco.`,
    {
      name: "recordatorio_cita_24h",
      languageCode: "es",
      bodyParams: [appt.patient.name || "", appt.service, formatWhen(appt.startsAt)],
    }
  );
  await prisma.appointment.update({ where: { id: appt.id }, data: { reminder24hSentAt: new Date() } });
  await recordEvent("REMINDER_SENT", { patientId: appt.patientId, appointmentId: appt.id, metadata: { kind: "24h" } });
}

/**
 * Aviso ~2h antes. A estas alturas suele haber conversación reciente
 * (el paciente respondió al recordatorio de 24h), así que probamos con
 * texto libre; si Meta lo rechaza por ventana cerrada, caemos a plantilla.
 */
async function handleReminder2hJob(appointmentId: string): Promise<void> {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId }, include: { patient: true } });
  if (!appt || !["PENDING_CONFIRMATION", "CONFIRMED"].includes(appt.status)) return;

  const hhmm = DateTime.fromJSDate(appt.startsAt).setZone(clinicConfig.timezone).toFormat("HH:mm");
  const msg = `Te esperamos hoy a las ${hhmm} para ${appt.service}. Si al final no puedes venir, avísanos y liberamos el hueco para otro paciente.`;
  try {
    await notifyPatient(appt.patient, msg);
  } catch (err) {
    logger.warn("reminder_2h_free_text_failed_trying_template", { appointmentId: appt.id, err });
    await notifyPatientTemplate(appt.patient, msg, {
      name: "recordatorio_cita_2h",
      languageCode: "es",
      bodyParams: [appt.service, hhmm],
    });
  }
  await prisma.appointment.update({ where: { id: appt.id }, data: { reminder2hSentAt: new Date() } });
  await recordEvent("REMINDER_SENT", { patientId: appt.patientId, appointmentId: appt.id, metadata: { kind: "2h" } });
}

/** Bookkeeping: citas que nunca se confirmaron y ya pasó su hora se marcan como no-show. */
async function markPastNoShows() {
  const stale = await prisma.appointment.findMany({
    where: { status: "PENDING_CONFIRMATION", startsAt: { lt: new Date() } },
    select: { id: true, patientId: true },
  });
  if (stale.length === 0) return;

  await prisma.appointment.updateMany({
    where: { id: { in: stale.map((a) => a.id) } },
    data: { status: "NO_SHOW" },
  });
  for (const a of stale) {
    await recordEvent("APPOINTMENT_NO_SHOW", { patientId: a.patientId, appointmentId: a.id });
  }
  logger.info("appointments_marked_no_show", { count: stale.length });
}

/** Bookkeeping: citas confirmadas cuya hora ya pasó se dan por completadas. */
async function markPastCompletions() {
  const stale = await prisma.appointment.findMany({
    where: { status: "CONFIRMED", endsAt: { lt: new Date() } },
    select: { id: true, patientId: true },
  });
  if (stale.length === 0) return;

  await prisma.appointment.updateMany({
    where: { id: { in: stale.map((a) => a.id) } },
    data: { status: "COMPLETED" },
  });
  for (const a of stale) {
    await recordEvent("APPOINTMENT_COMPLETED", { patientId: a.patientId, appointmentId: a.id });
  }
  logger.info("appointments_marked_completed", { count: stale.length });
}

async function runJobTick() {
  const { processed, failed } = await processDueJobs({
    REMINDER_24H: handleReminder24hJob,
    REMINDER_2H: handleReminder2hJob,
    WAITLIST_OFFER_EXPIRED: handleWaitlistOfferExpiredJob,
  });
  if (processed > 0 || failed > 0) logger.info("scheduled_jobs_tick", { processed, failed });
}

export function startScheduler() {
  // Recuperación al arrancar: retoma cualquier job que quedara pendiente de
  // un reinicio (dentro de la ventana razonable, ver persistentJobs.ts).
  runJobTick().catch((err) => logger.error("job_tick_startup_failed", { err }));

  // Jobs (recordatorios + caducidad de ofertas): cada minuto. Ya no hace
  // falta una ventana de barrido de 15 minutos — cada job lleva su propio
  // `scheduledAt` exacto.
  cron.schedule("* * * * *", () => {
    runJobTick().catch((err) => logger.error("job_tick_failed", { err }));
    cleanupExpiredSlotHolds().catch((err) => logger.error("cleanupExpiredSlotHolds_failed", { err }));
  });

  // Bookkeeping de estados (no-show/completada): cada 15 minutos es suficiente.
  cron.schedule("*/15 * * * *", () => {
    markPastNoShows().catch((err) => logger.error("markPastNoShows_failed", { err }));
    markPastCompletions().catch((err) => logger.error("markPastCompletions_failed", { err }));
  });

  logger.info("scheduler_started", { jobsEveryMinutes: 1, bookkeepingEveryMinutes: 15 });
}
