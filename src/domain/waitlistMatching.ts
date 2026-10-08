import { DateTime } from "luxon";

/**
 * Lógica pura (sin DB) de compatibilidad entre una entrada de lista de
 * espera y un hueco liberado. Separada del servicio para poder testearla
 * sin tocar la base de datos (ver src/services/__tests__).
 */

export type TimeOfDay = "MORNING" | "AFTERNOON";

export function timeOfDayOf(dt: DateTime): TimeOfDay {
  return dt.hour < 14 ? "MORNING" : "AFTERNOON";
}

export interface WaitlistCandidateFacts {
  earliestDate: Date;
  latestDate: Date;
  professionalId: string | null;
  preferredTimeOfDay: string | null;
}

export function isCandidateCompatible(
  entry: WaitlistCandidateFacts,
  slotStart: DateTime,
  slotProfessionalId: string | null
): boolean {
  if (slotStart < DateTime.fromJSDate(entry.earliestDate)) return false;
  if (slotStart > DateTime.fromJSDate(entry.latestDate)) return false;

  if (entry.professionalId && entry.professionalId !== slotProfessionalId) return false;

  if (entry.preferredTimeOfDay && entry.preferredTimeOfDay !== timeOfDayOf(slotStart)) return false;

  return true;
}
