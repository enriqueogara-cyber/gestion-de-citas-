import { DateTime } from "luxon";
import { timeOfDayOf, TimeOfDay } from "../domain/waitlistMatching";

/**
 * Reduce la lista COMPLETA y real de huecos (nunca truncada por el motor
 * de disponibilidad, ver services/appointments.ts → getAvailability) a un
 * puñado representativo para enseñar en el chat — determinista, en el
 * backend, nunca dejado a criterio del LLM (ver README, "Presentación de
 * disponibilidad"). El LLM solo traduce lo que pidió el paciente
 * ("por la mañana", "sobre las seis"...) a esta preferencia estructurada.
 */
export interface SlotPreference {
  timeOfDay?: TimeOfDay;
  /** "HH:mm" — se buscan los huecos reales más cercanos a esta hora. */
  aroundTime?: string;
  earliest?: boolean;
  latest?: boolean;
  /** "HH:mm" ambos, para "entre las 16 y las 19". */
  timeRangeStart?: string;
  timeRangeEnd?: string;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 6;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOfDay(dt: DateTime): number {
  return dt.hour * 60 + dt.minute;
}

function toMinutes(hhmm: string): number | null {
  if (!TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** Reparte índices uniformemente sobre `slots` para coger `count` "representativos" (primero, último y repartidos entremedias), no los N primeros cronológicos. */
function pickSpread(slots: DateTime[], count: number): DateTime[] {
  if (slots.length <= count) return slots;
  if (count <= 1) return [slots[0]];
  const picks: DateTime[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const idx = Math.round((i * (slots.length - 1)) / (count - 1));
    if (!seen.has(idx)) {
      seen.add(idx);
      picks.push(slots[idx]);
    }
  }
  return picks;
}

export function selectRepresentativeSlots(allSlots: DateTime[], pref: SlotPreference = {}): DateTime[] {
  const maxResults = pref.maxResults ?? DEFAULT_MAX_RESULTS;
  let pool = [...allSlots].sort((a, b) => a.toMillis() - b.toMillis());

  const rangeStart = pref.timeRangeStart ? toMinutes(pref.timeRangeStart) : null;
  const rangeEnd = pref.timeRangeEnd ? toMinutes(pref.timeRangeEnd) : null;
  if (rangeStart != null && rangeEnd != null) {
    pool = pool.filter((s) => minutesOfDay(s) >= rangeStart && minutesOfDay(s) <= rangeEnd);
  } else if (pref.timeOfDay) {
    pool = pool.filter((s) => timeOfDayOf(s) === pref.timeOfDay);
  }

  if (pool.length === 0) return [];

  if (pref.earliest) return [pool[0]];
  if (pref.latest) return [pool[pool.length - 1]];

  const aroundMinutes = pref.aroundTime ? toMinutes(pref.aroundTime) : null;
  if (aroundMinutes != null) {
    return [...pool]
      .sort((a, b) => Math.abs(minutesOfDay(a) - aroundMinutes) - Math.abs(minutesOfDay(b) - aroundMinutes))
      .slice(0, maxResults)
      .sort((a, b) => a.toMillis() - b.toMillis());
  }

  // Sin preferencia concreta: unos pocos huecos representativos por
  // día/franja, no cada incremento de granularidad — ver ejemplo en el
  // README ("mañana: 09:00 · 10:30 · 12:00 / tarde: 16:00 · 17:30 · 19:00").
  const byDay = new Map<string, DateTime[]>();
  for (const s of pool) {
    const key = s.toISODate() ?? s.toString();
    const arr = byDay.get(key);
    if (arr) arr.push(s);
    else byDay.set(key, [s]);
  }

  const result: DateTime[] = [];
  for (const daySlots of byDay.values()) {
    if (result.length >= maxResults) break;
    const morning = daySlots.filter((s) => timeOfDayOf(s) === "MORNING");
    const afternoon = daySlots.filter((s) => timeOfDayOf(s) === "AFTERNOON");
    const perGroup = morning.length && afternoon.length ? 3 : Math.min(5, maxResults);
    for (const group of [morning, afternoon]) {
      if (group.length === 0) continue;
      result.push(...pickSpread(group, perGroup));
    }
  }

  return result.slice(0, maxResults).sort((a, b) => a.toMillis() - b.toMillis());
}
