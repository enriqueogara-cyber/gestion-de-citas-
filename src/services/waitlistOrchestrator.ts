import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { notifyPatient } from "../notifications/notify";
import { reserveAppointment, getService, SlotTakenError } from "../domain/bookingEngine";
import { recordEvent } from "./auditLog";
import { logger } from "../lib/logger";
import { scheduleWaitlistExpiryJob, cancelWaitlistExpiryJobs } from "../scheduler/persistentJobs";
import {
  nextWaitingCandidate,
  markBooked,
  markExpired,
  markBackToWaiting,
  tryClaimOffer,
} from "./waitlist";

/**
 * Se llama cada vez que se libera un hueco (cancelación o no-show). Busca
 * al primero en lista de espera compatible, le "apalabra" el hueco creando
 * un SlotHold (para que nadie se lo pueda quitar mientras decide) y le
 * avisa. Esto es el corazón del "relleno de huecos de última hora".
 */
export async function offerFreedSlot(
  serviceId: string,
  slotStart: DateTime,
  professionalId: string | null = null
): Promise<boolean> {
  const candidate = await nextWaitingCandidate(serviceId, slotStart, professionalId);
  if (!candidate) return false;

  const service = getService(serviceId);
  const slotEnd = slotStart.plus({ minutes: service.durationMinutes });
  const expiresAt = DateTime.now().plus({ minutes: clinicConfig.waitlistOfferWindowMinutes }).toJSDate();

  // La oferta, el hold y su job de caducidad son una sola escritura lógica.
  // En SQLite la transacción serializa también los reintentos concurrentes.
  const created = await prisma.$transaction(async (tx) => {
    const overlap = { startsAt: { lt: slotEnd.toJSDate() }, endsAt: { gt: slotStart.toJSDate() } };
    const professionalFilter = professionalId
      ? { OR: [{ professionalId }, { professionalId: null }] }
      : {};
    const [hold, booked] = await Promise.all([
      tx.slotHold.findFirst({ where: { ...overlap, ...professionalFilter, expiresAt: { gt: new Date() } } }),
      tx.appointment.findFirst({ where: { ...overlap, ...professionalFilter, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] } } }),
    ]);
    if (hold || booked) return false;
    const claimed = await tx.waitlistEntry.updateMany({
      where: { id: candidate.id, status: "WAITING" },
      data: { status: "OFFERED", offeredSlotStart: slotStart.toJSDate(), offeredEndAt: slotEnd.toJSDate(), offerExpiresAt: expiresAt, offeredProfessionalId: professionalId },
    });
    if (claimed.count !== 1) return false;
    await tx.slotHold.create({
      data: { serviceId, professionalId, startsAt: slotStart.toJSDate(), endsAt: slotEnd.toJSDate(),
        patientId: candidate.patientId, reason: "WAITLIST_OFFER", expiresAt },
    });
    await scheduleWaitlistExpiryJob({
      waitlistEntryId: candidate.id,
      slotStartIso: slotStart.toISO() ?? slotStart.toString(),
      expiresAt,
    }, tx);
    return true;
  });
  if (!created) return false;

  const when = slotStart.setLocale("es").toFormat("cccc d 'de' LLLL 'a las' HH:mm");
  try {
    await notifyPatient(
      candidate.patient,
      `¡Buenas noticias! Se ha liberado un hueco para ${service.label} el ${when}. ` +
        `Es tuyo si respondes "SI" en los próximos ${clinicConfig.waitlistOfferWindowMinutes} minutos. ` +
        `Si no te viene bien, no hace falta que contestes.`
    );
  } catch (err) {
    // La entrega puede ser ambigua. Conservamos la oferta hasta su vencimiento
    // y dejamos que el job libere el hold; reintentar aquí duplicaría avisos.
    logger.error("waitlist_offer_notification_failed", { entryId: candidate.id, err });
  }

  await recordEvent("WAITLIST_OFFER_CREATED", {
    patientId: candidate.patientId,
    metadata: { service: serviceId, slot: slotStart.toISO() },
  });
  return true;
}

/** El paciente acepta la oferta ("SI"): intenta convertirla en cita real. */
export async function acceptWaitlistOffer(entryId: string, entry: {
  id: string;
  patientId: string;
  service: string;
  professionalId: string | null;
  offeredSlotStart: Date | null;
  patient: { id: string; phone: string; name: string | null };
}) {
  const current = await prisma.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!current || current.patientId !== entry.patientId || current.service !== entry.service) {
    throw new Error("No encuentro esa oferta para este paciente.");
  }
  // Si la reserva se confirmó pero el proceso cayó antes de marcar BOOKED,
  // el reintento recupera la cita existente en vez de crear otra.
  const existingBooking = async () => current.offeredSlotStart
    ? prisma.appointment.findFirst({ where: {
        patientId: entry.patientId, service: entry.service, startsAt: current.offeredSlotStart,
        recoveredFromWaitlist: true, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] },
      } })
    : null;
  if (current && ["ACCEPTING", "BOOKED"].includes(current.status)) {
    const booked = await existingBooking();
    if (booked) {
      await markBooked(entryId);
      await cancelWaitlistExpiryJobs(entryId);
      return booked;
    }
  }
  const claimed = await tryClaimOffer(entryId);
  if (!claimed) {
    throw new Error("Esa oferta ya no está disponible: caducó o ya se procesó por otra vía.");
  }
  if (!current.offeredSlotStart) {
    await markBackToWaiting(entryId);
    throw new Error("Esta entrada no tiene un hueco ofrecido.");
  }
  const slotStart = DateTime.fromJSDate(current.offeredSlotStart);

  try {
    const appt = await reserveAppointment({
      patientId: entry.patientId,
      patientName: entry.patient.name || "",
      patientPhone: entry.patient.phone,
      serviceId: entry.service,
      start: slotStart,
      professionalId: current?.offeredProfessionalId ?? entry.professionalId ?? undefined,
      recoveredFromWaitlist: true,
      waitlistEntryId: entryId,
    });
    await markBooked(entryId);
    await cancelWaitlistExpiryJobs(entryId); // ya no hace falta que caduque nada
    await recordEvent("WAITLIST_OFFER_ACCEPTED", {
      patientId: entry.patientId,
      appointmentId: appt.id,
      metadata: { service: entry.service },
    });
    return appt;
  } catch (err) {
    const booked = await existingBooking();
    if (booked) {
      // No se revierte a WAITING: la cita ya existe aunque falle un paso
      // posterior. El siguiente intento finalizará el estado de la oferta.
      logger.error("waitlist_accept_committed_needs_recovery", { entryId, appointmentId: booked.id, err });
      throw err;
    }
    if (err instanceof SlotTakenError) {
      // Muy raro (el hold debería haberlo evitado) pero por si acaso: se
      // pasa el hueco al siguiente en vez de dejar la oferta colgada.
      await markExpired(entryId);
      // El job permanece pendiente: si falla el encadenado, volverá a
      // intentarlo sin duplicar una oferta ya creada.
      if (current.offerExpiresAt) {
        await prisma.slotHold.deleteMany({ where: { patientId: entry.patientId, startsAt: current.offeredSlotStart, expiresAt: current.offerExpiresAt, reason: "WAITLIST_OFFER" } });
      }
      await offerFreedSlot(entry.service, slotStart, current?.offeredProfessionalId ?? entry.professionalId);
    } else {
      // Un fallo transitorio permite reintentar la misma oferta, sin crear
      // una segunda ni dejar un hold perteneciente a una entrada WAITING.
      await prisma.waitlistEntry.updateMany({
        where: { id: entryId, status: "ACCEPTING", offerExpiresAt: { gt: new Date() } },
        data: { status: "OFFERED" },
      });
      logger.error("waitlist_accept_failed", { entryId, err });
    }
    throw err;
  }
}

/** Caduca la oferta y libera el hold juntos. Puede reanudar el encadenado
 * si el proceso cayó después de marcar EXPIRED pero antes de ofrecer el hueco.
 */
export async function handleWaitlistOfferExpiredJob(waitlistEntryId: string): Promise<void> {
  const entry = await prisma.waitlistEntry.findUnique({ where: { id: waitlistEntryId }, include: { patient: true } });
  if (!entry || !entry.offeredSlotStart || !["OFFERED", "EXPIRED", "CANCELLED"].includes(entry.status)) return;

  const newlyExpired = await prisma.$transaction(async (tx) => {
    const changed = await tx.waitlistEntry.updateMany({ where: { id: entry.id, status: "OFFERED" }, data: { status: "EXPIRED" } });
    if ((changed.count === 1 || ["EXPIRED", "CANCELLED"].includes(entry.status)) && entry.offerExpiresAt) {
      await tx.slotHold.deleteMany({ where: { patientId: entry.patientId, startsAt: entry.offeredSlotStart!, expiresAt: entry.offerExpiresAt, reason: "WAITLIST_OFFER" } });
    }
    return changed.count === 1;
  });
  if (!newlyExpired && !["EXPIRED", "CANCELLED"].includes(entry.status)) return;

  const slotStart = DateTime.fromJSDate(entry.offeredSlotStart);
  if (newlyExpired) {
    try {
      await notifyPatient(
        entry.patient,
        `Se ha pasado el tiempo para confirmar el hueco, lo hemos ofrecido a otro paciente. ` +
          `Sigues en la lista de espera para el siguiente hueco disponible.`
      );
    } catch (err) {
      logger.error("waitlist_expiry_notification_failed", { entryId: entry.id, err });
    }
    await recordEvent("WAITLIST_OFFER_EXPIRED", { patientId: entry.patientId, metadata: { service: entry.service } });
  }
  await offerFreedSlot(entry.service, slotStart, entry.offeredProfessionalId ?? entry.professionalId);
}

/** Recupera ofertas vencidas incluso si su job falló o es legado y limpia holds huérfanos. */
export async function cleanupExpiredSlotHolds(): Promise<void> {
  const now = new Date();
  // ACCEPTING es un lease: si el proceso murió después del claim, se
  // reconcilia con la cita real. La reserva comprueba el estado de la oferta
  // dentro de su transacción, de modo que no puede aparecer otra cita después
  // de que la recuperación la marque EXPIRED.
  const staleAccepting = await prisma.waitlistEntry.findMany({
    where: { status: "ACCEPTING", updatedAt: { lte: new Date(now.getTime() - 10 * 60_000) } },
    orderBy: { updatedAt: "asc" }, take: 100,
  });
  for (const entry of staleAccepting) {
    if (!entry.offeredSlotStart) continue;
    try {
      await prisma.$transaction(async (tx) => {
        const booked = await tx.appointment.findFirst({ where: {
          patientId: entry.patientId, service: entry.service, startsAt: entry.offeredSlotStart!,
          recoveredFromWaitlist: true, status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] },
        } });
        const changed = await tx.waitlistEntry.updateMany({
          where: { id: entry.id, status: "ACCEPTING", updatedAt: { lte: new Date(now.getTime() - 10 * 60_000) } },
          data: { status: booked ? "BOOKED" : "EXPIRED" },
        });
        if (!changed.count) return;
        if (entry.offerExpiresAt) {
          await tx.slotHold.deleteMany({ where: { patientId: entry.patientId, startsAt: entry.offeredSlotStart!, expiresAt: entry.offerExpiresAt, reason: "WAITLIST_OFFER" } });
        }
        if (booked) {
          await tx.scheduledJob.updateMany({ where: { waitlistEntryId: entry.id, status: "PENDING" }, data: { status: "CANCELLED" } });
        } else {
          const job = await tx.scheduledJob.findFirst({ where: { waitlistEntryId: entry.id, type: "WAITLIST_OFFER_EXPIRED" }, orderBy: { createdAt: "desc" } });
          if (job) {
            await tx.scheduledJob.update({ where: { id: job.id }, data: { status: "PENDING", scheduledAt: now, attempts: 0, claimToken: null } });
          } else {
            await tx.scheduledJob.create({ data: {
              type: "WAITLIST_OFFER_EXPIRED", waitlistEntryId: entry.id, scheduledAt: now,
              idempotencyKey: `waitlistRecovery:${entry.id}:${entry.offeredSlotStart!.toISOString()}`,
            } });
          }
        }
      });
      await handleWaitlistOfferExpiredJob(entry.id);
    } catch (err) {
      logger.error("waitlist_accepting_recovery_failed", { entryId: entry.id, err });
    }
  }
  const overdueOffers = await prisma.waitlistEntry.findMany({
    where: { status: "OFFERED", offerExpiresAt: { lte: now }, offeredSlotStart: { not: null } },
    orderBy: { updatedAt: "asc" }, take: 100,
  });
  const unfinishedJobs = await prisma.scheduledJob.findMany({
    where: { type: "WAITLIST_OFFER_EXPIRED", status: { in: ["PENDING", "PROCESSING", "FAILED"] }, scheduledAt: { lte: now }, waitlistEntryId: { not: null } },
    orderBy: { scheduledAt: "asc" }, take: 100,
  });
  const ids = new Set([...overdueOffers.map(e => e.id), ...unfinishedJobs.map(j => j.waitlistEntryId!) ]);
  for (const entryId of ids) {
    try {
      await handleWaitlistOfferExpiredJob(entryId);
      const state = await prisma.waitlistEntry.findUnique({ where: { id: entryId }, select: { status: true } });
      if (state && ["EXPIRED", "CANCELLED", "BOOKED"].includes(state.status)) {
        await prisma.scheduledJob.updateMany({
          where: { waitlistEntryId: entryId, type: "WAITLIST_OFFER_EXPIRED", status: { in: ["PENDING", "FAILED"] }, scheduledAt: { lte: now } },
          data: { status: "COMPLETED", processedAt: now, lastError: null },
        });
      }
    } catch (err) {
      logger.error("waitlist_expiry_recovery_failed", { entryId, err });
    }
  }
  await prisma.slotHold.deleteMany({ where: { expiresAt: { lte: now } } });
}
