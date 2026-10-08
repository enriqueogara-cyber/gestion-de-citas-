import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { isCandidateCompatible, timeOfDayOf } from "../domain/waitlistMatching";
import { computeSlotsFromBusy } from "../calendar/slots";
import { recordEvent } from "./auditLog";
import { BookingValidationError, getService } from "../domain/bookingEngine";

const MAX_FEASIBILITY_DAYS = 60;

/**
 * Antes de apuntar a alguien, comprobamos que la preferencia pedida sea
 * físicamente posible con el horario del centro (ver bug real: un paciente
 * podía quedar apuntado para "el viernes por la tarde" en un centro que
 * cierra los viernes a las 14:00, una entrada que nunca se iba a poder
 * cumplir). Solo mira el horario de apertura, no la agenda real — es
 * barato y evita el caso más claro de "esto nunca va a pasar".
 */
function hasFeasibleWindow(
  serviceId: string,
  earliestDate: DateTime,
  latestDate: DateTime,
  preferredTimeOfDay?: "MORNING" | "AFTERNOON"
): boolean {
  const service = getService(serviceId);
  const daysAhead = Math.min(
    Math.max(1, Math.ceil(latestDate.diff(earliestDate, "days").days) + 1),
    MAX_FEASIBILITY_DAYS
  );
  const candidateSlots = computeSlotsFromBusy(service, [], {
    fromDate: earliestDate,
    daysAhead,
    maxSlots: 500,
  });
  return candidateSlots.some(
    (s) => s <= latestDate && (!preferredTimeOfDay || timeOfDayOf(s) === preferredTimeOfDay)
  );
}

export async function joinWaitlist(params: {
  patientId: string;
  serviceId: string;
  earliestDate: DateTime;
  latestDate: DateTime;
  professionalId?: string;
  preferredTimeOfDay?: "MORNING" | "AFTERNOON";
}) {
  if (!hasFeasibleWindow(params.serviceId, params.earliestDate, params.latestDate, params.preferredTimeOfDay)) {
    throw new BookingValidationError(
      "Ese horario no encaja nunca con el horario de apertura del centro para ese servicio, así que no puedo apuntarte así. ¿Probamos con otra franja o rango de fechas?"
    );
  }

  const entry = await prisma.waitlistEntry.create({
    data: {
      patientId: params.patientId,
      service: params.serviceId,
      earliestDate: params.earliestDate.toJSDate(),
      latestDate: params.latestDate.toJSDate(),
      status: "WAITING",
      professionalId: params.professionalId,
      preferredTimeOfDay: params.preferredTimeOfDay,
    },
  });
  await recordEvent("WAITLIST_JOINED", {
    patientId: params.patientId,
    metadata: { service: params.serviceId, entryId: entry.id },
  });
  return entry;
}

/**
 * Siguiente candidato compatible en lista de espera para un hueco concreto,
 * por orden de llegada (FIFO) entre los igualmente compatibles — ver
 * src/domain/waitlistMatching.ts para las reglas de compatibilidad
 * (servicio, rango de fechas, profesional preferido, franja horaria).
 */
export async function nextWaitingCandidate(
  serviceId: string,
  slotStart: DateTime,
  slotProfessionalId: string | null
) {
  const waiting = await prisma.waitlistEntry.findMany({
    where: { service: serviceId, status: "WAITING" },
    orderBy: { createdAt: "asc" },
    include: { patient: true },
  });
  return waiting.find((entry) => isCandidateCompatible(entry, slotStart, slotProfessionalId)) ?? null;
}

export async function markOffered(entryId: string, slotStart: DateTime, slotEnd: DateTime) {
  const expires = DateTime.now().plus({ minutes: clinicConfig.waitlistOfferWindowMinutes });
  return prisma.waitlistEntry.update({
    where: { id: entryId },
    data: {
      status: "OFFERED",
      offeredSlotStart: slotStart.toJSDate(),
      offeredEndAt: slotEnd.toJSDate(),
      offerExpiresAt: expires.toJSDate(),
    },
  });
}

/**
 * Compare-and-swap: solo pasa de OFFERED a ACCEPTING si sigue en OFFERED en
 * ese instante. Evita que dos aceptaciones simultáneas (o una aceptación a
 * la vez que expira la oferta) procesen el mismo hueco dos veces — ver
 * README, "Idempotencia y protección contra dobles reservas".
 */
export async function tryClaimOffer(entryId: string): Promise<boolean> {
  const result = await prisma.waitlistEntry.updateMany({
    where: { id: entryId, status: "OFFERED" },
    data: { status: "ACCEPTING" },
  });
  return result.count === 1;
}

export async function markBooked(entryId: string) {
  return prisma.waitlistEntry.update({ where: { id: entryId }, data: { status: "BOOKED" } });
}

export async function markExpired(entryId: string) {
  return prisma.waitlistEntry.updateMany({
    where: { id: entryId, status: { in: ["OFFERED", "ACCEPTING"] } },
    data: { status: "EXPIRED" },
  });
}

/** Vuelve a poner una entrada en WAITING (p.ej. si el hold expiró antes de poder reservar). */
export async function markBackToWaiting(entryId: string) {
  return prisma.waitlistEntry.update({
    where: { id: entryId },
    data: { status: "WAITING", offeredSlotStart: null, offeredEndAt: null, offerExpiresAt: null },
  });
}

export async function cancelWaitlistEntry(entryId: string, patientId: string) {
  const entry = await prisma.waitlistEntry.findUnique({ where: { id: entryId } });
  if (!entry || entry.patientId !== patientId) throw new Error("No encuentro esa lista de espera para este paciente.");
  return prisma.waitlistEntry.update({ where: { id: entryId }, data: { status: "CANCELLED" } });
}


export async function listWaitlistForPatient(patientId: string) {
  return prisma.waitlistEntry.findMany({
    where: { patientId, status: { in: ["WAITING", "OFFERED"] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function listAllActiveWaitlist() {
  return prisma.waitlistEntry.findMany({
    where: { status: { in: ["WAITING", "OFFERED", "ACCEPTING"] } },
    include: { patient: true, Professional: true },
    orderBy: { createdAt: "asc" },
  });
}
