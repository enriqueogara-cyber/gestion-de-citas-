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
  markOffered,
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

  const offered = await markOffered(candidate.id, slotStart, slotEnd);
  await prisma.slotHold.create({
    data: {
      serviceId,
      professionalId,
      startsAt: slotStart.toJSDate(),
      endsAt: slotEnd.toJSDate(),
      patientId: candidate.patientId,
      reason: "WAITLIST_OFFER",
      expiresAt: offered.offerExpiresAt ?? slotStart.toJSDate(),
    },
  });

  // Job persistente de caducidad (ver scheduler/persistentJobs.ts): si el
  // proceso se reinicia antes de que expire la ventana de respuesta, esto
  // no se pierde — se retoma al arrancar.
  await scheduleWaitlistExpiryJob({
    waitlistEntryId: candidate.id,
    slotStartIso: slotStart.toISO() ?? slotStart.toString(),
    expiresAt: offered.offerExpiresAt ?? slotStart.toJSDate(),
  });

  const when = slotStart.setLocale("es").toFormat("cccc d 'de' LLLL 'a las' HH:mm");
  await notifyPatient(
    candidate.patient,
    `¡Buenas noticias! Se ha liberado un hueco para ${service.label} el ${when}. ` +
      `Es tuyo si respondes "SI" en los próximos ${clinicConfig.waitlistOfferWindowMinutes} minutos. ` +
      `Si no te viene bien, no hace falta que contestes.`
  );

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
  const claimed = await tryClaimOffer(entryId);
  if (!claimed) {
    throw new Error("Esa oferta ya no está disponible: caducó o ya se procesó por otra vía.");
  }
  if (!entry.offeredSlotStart) {
    await markBackToWaiting(entryId);
    throw new Error("Esta entrada no tiene un hueco ofrecido.");
  }
  const slotStart = DateTime.fromJSDate(entry.offeredSlotStart);

  try {
    const appt = await reserveAppointment({
      patientId: entry.patientId,
      patientName: entry.patient.name || "",
      patientPhone: entry.patient.phone,
      serviceId: entry.service,
      start: slotStart,
      professionalId: entry.professionalId ?? undefined,
      recoveredFromWaitlist: true,
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
    if (err instanceof SlotTakenError) {
      // Muy raro (el hold debería haberlo evitado) pero por si acaso: se
      // pasa el hueco al siguiente en vez de dejar la oferta colgada.
      await markExpired(entryId);
      await cancelWaitlistExpiryJobs(entryId);
      await prisma.slotHold.deleteMany({ where: { patientId: entry.patientId, startsAt: entry.offeredSlotStart } });
      await offerFreedSlot(entry.service, slotStart, entry.professionalId);
    } else {
      // Fallo inesperado: devolvemos la entrada a WAITING en vez de dejarla
      // atascada en "ACCEPTING" para siempre.
      await markBackToWaiting(entryId);
      logger.error("waitlist_accept_failed", { entryId, err });
    }
    throw err;
  }
}

/**
 * Handler del job WAITLIST_OFFER_EXPIRED (ver scheduler/persistentJobs.ts):
 * procesa la caducidad de UNA oferta concreta. Si para cuando se procesa
 * ya se resolvió por otra vía (aceptada, ya caducada...), `markExpired` no
 * afecta a ninguna fila y no se hace nada más — idempotente a propósito.
 */
export async function handleWaitlistOfferExpiredJob(waitlistEntryId: string): Promise<void> {
  const entry = await prisma.waitlistEntry.findUnique({ where: { id: waitlistEntryId }, include: { patient: true } });
  if (!entry) return;

  const result = await markExpired(entry.id);
  if (result.count === 0) return; // ya resuelta por otra vía

  if (!entry.offeredSlotStart) return;

  await prisma.slotHold.deleteMany({ where: { patientId: entry.patientId, startsAt: entry.offeredSlotStart } });
  const slotStart = DateTime.fromJSDate(entry.offeredSlotStart);
  await notifyPatient(
    entry.patient,
    `Se ha pasado el tiempo para confirmar el hueco, lo hemos ofrecido a otro paciente. ` +
      `Sigues en la lista de espera para el siguiente hueco disponible.`
  );
  await recordEvent("WAITLIST_OFFER_EXPIRED", { patientId: entry.patientId, metadata: { service: entry.service } });
  await offerFreedSlot(entry.service, slotStart, entry.professionalId);
}

/** Limpieza de holds vencidos que ningún camino haya borrado ya (defensivo, no la vía principal). */
export async function cleanupExpiredSlotHolds(): Promise<void> {
  await prisma.slotHold.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}
