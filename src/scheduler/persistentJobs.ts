import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { logger } from "../lib/logger";
import { recordEvent } from "../services/auditLog";

/**
 * Trabajos programados persistentes (ver README, "Scheduler persistente" y
 * el modelo `ScheduledJob`). Sustituye la dependencia exclusiva de
 * node-cron + memoria: cada recordatorio y cada caducidad de oferta de
 * lista de espera es una FILA en base de datos con su propio estado,
 * reintentos y marca de tiempo — si el proceso se reinicia, los jobs
 * pendientes siguen ahí y se retoman (dentro de una ventana razonable, ver
 * `isTooLateToProcess` más abajo) en vez de perderse silenciosamente.
 */

export type JobType = "REMINDER_24H" | "REMINDER_2H" | "WAITLIST_OFFER_EXPIRED";
export type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";

const MAX_ATTEMPTS = 3;

// Cuánto se tolera procesar un job con retraso (p.ej. tras un reinicio
// largo) antes de considerarlo ya sin sentido y cancelarlo en vez de
// ejecutarlo tarde. Decisión documentada explícitamente (ver README):
// un recordatorio de 24h que llega con más de 6h de retraso confunde más
// de lo que ayuda; uno de 2h, con más de 1h. La caducidad de una oferta de
// lista de espera SIEMPRE merece procesarse aunque llegue tarde: encadenar
// al siguiente candidato sigue siendo valioso por atrasado que esté.
const LATE_WINDOWS: Partial<Record<JobType, { hours: number }>> = {
  REMINDER_24H: { hours: 6 },
  REMINDER_2H: { hours: 1 },
};

function isTooLateToProcess(type: JobType, scheduledAt: Date): boolean {
  const window = LATE_WINDOWS[type];
  if (!window) return false;
  const overdueHours = DateTime.now().diff(DateTime.fromJSDate(scheduledAt), "hours").hours;
  return overdueHours > window.hours;
}

/** Crea (o reutiliza, por idempotencyKey) un job programado. */
async function scheduleJob(params: {
  type: JobType;
  scheduledAt: Date;
  appointmentId?: string;
  waitlistEntryId?: string;
  idempotencyKey: string;
}): Promise<void> {
  await prisma.scheduledJob.upsert({
    where: { idempotencyKey: params.idempotencyKey },
    update: {}, // ya existe: no lo tocamos, es idempotente a propósito
    create: {
      type: params.type,
      scheduledAt: params.scheduledAt,
      appointmentId: params.appointmentId,
      waitlistEntryId: params.waitlistEntryId,
      idempotencyKey: params.idempotencyKey,
    },
  });
}

/** Al crear una cita: programa sus dos recordatorios. Se llama desde domain/bookingEngine.ts. */
export async function scheduleReminderJobs(appointment: { id: string; startsAt: Date }): Promise<void> {
  const start = DateTime.fromJSDate(appointment.startsAt);
  await Promise.all([
    scheduleJob({
      type: "REMINDER_24H",
      scheduledAt: start.minus({ hours: 24 }).toJSDate(),
      appointmentId: appointment.id,
      idempotencyKey: `reminder24h:${appointment.id}`,
    }),
    scheduleJob({
      type: "REMINDER_2H",
      scheduledAt: start.minus({ hours: 2 }).toJSDate(),
      appointmentId: appointment.id,
      idempotencyKey: `reminder2h:${appointment.id}`,
    }),
  ]);
}

/** Al cancelar una cita: los recordatorios pendientes ya no tienen sentido. */
export async function cancelJobsForAppointment(appointmentId: string): Promise<void> {
  await prisma.scheduledJob.updateMany({
    where: { appointmentId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
}

/** Al ofrecer un hueco liberado a alguien de la lista de espera: programa su caducidad. */
export async function scheduleWaitlistExpiryJob(params: {
  waitlistEntryId: string;
  slotStartIso: string;
  expiresAt: Date;
}): Promise<void> {
  await scheduleJob({
    type: "WAITLIST_OFFER_EXPIRED",
    scheduledAt: params.expiresAt,
    waitlistEntryId: params.waitlistEntryId,
    idempotencyKey: `waitlistExpiry:${params.waitlistEntryId}:${params.slotStartIso}`,
  });
}

/** Si la oferta se acepta/rechaza antes de caducar, el job de caducidad ya no debe dispararse. */
export async function cancelWaitlistExpiryJobs(waitlistEntryId: string): Promise<void> {
  await prisma.scheduledJob.updateMany({
    where: { waitlistEntryId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
}

export interface JobHandlers {
  REMINDER_24H: (appointmentId: string) => Promise<void>;
  REMINDER_2H: (appointmentId: string) => Promise<void>;
  WAITLIST_OFFER_EXPIRED: (waitlistEntryId: string) => Promise<void>;
}

/**
 * Procesa los jobs vencidos. Se llama periódicamente (ver
 * scheduler/reminders.ts → startScheduler) Y una vez al arrancar (para
 * retomar lo que quedó pendiente de un reinicio, dentro de la ventana
 * razonable de `isTooLateToProcess`).
 *
 * Reclama cada job con un compare-and-swap (`updateMany` con status
 * PENDING en el WHERE) antes de procesarlo: si dos ticks del scheduler se
 * solaparan (no debería, pero por si acaso) o hubiera más de un proceso,
 * como máximo uno de los dos se queda el job.
 */
export async function processDueJobs(handlers: JobHandlers): Promise<{ processed: number; failed: number }> {
  const due = await prisma.scheduledJob.findMany({
    where: { status: "PENDING", scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: "asc" },
    take: 100,
  });

  let processed = 0;
  let failed = 0;

  for (const job of due) {
    const type = job.type as JobType;

    if (isTooLateToProcess(type, job.scheduledAt)) {
      await prisma.scheduledJob.updateMany({
        where: { id: job.id, status: "PENDING" },
        data: { status: "CANCELLED", lastError: "Demasiado tarde para procesarlo con sentido (ver ventana en persistentJobs.ts)." },
      });
      continue;
    }

    const claimed = await prisma.scheduledJob.updateMany({
      where: { id: job.id, status: "PENDING" },
      data: { status: "PROCESSING", attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
    if (claimed.count === 0) continue; // otro proceso se lo llevó

    try {
      if (type === "REMINDER_24H" && job.appointmentId) await handlers.REMINDER_24H(job.appointmentId);
      else if (type === "REMINDER_2H" && job.appointmentId) await handlers.REMINDER_2H(job.appointmentId);
      else if (type === "WAITLIST_OFFER_EXPIRED" && job.waitlistEntryId) await handlers.WAITLIST_OFFER_EXPIRED(job.waitlistEntryId);
      else throw new Error(`Job ${type} sin la referencia esperada (appointmentId/waitlistEntryId).`);

      await prisma.scheduledJob.update({ where: { id: job.id }, data: { status: "COMPLETED", processedAt: new Date() } });
      processed += 1;
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = (err as Error)?.message || String(err);
      const exhausted = attempts >= job.maxAttempts;
      logger.error("scheduled_job_failed", { jobId: job.id, type, attempts, exhausted, err });
      await prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? "FAILED" : "PENDING", // vuelve a PENDING para reintentar en el siguiente tick
          lastError: message,
        },
      });
      if (exhausted) {
        await recordEvent("SCHEDULED_JOB_FAILED", {
          appointmentId: job.appointmentId ?? undefined,
          metadata: { jobType: type, attempts, message },
        });
      }
      failed += 1;
    }
  }

  return { processed, failed };
}
