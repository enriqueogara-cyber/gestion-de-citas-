import { DateTime } from "luxon";
import { clinicConfig, ServiceDef } from "../config";
import { getOpeningHoursSync } from "../services/serviceCatalog";

export interface BusyInterval {
  start: DateTime;
  end: DateTime;
}

/**
 * Lógica pura de generación de huecos: cruza el horario de apertura del
 * centro con una lista de intervalos ocupados. La usan tanto el backend
 * real de Google Calendar como el calendario simulado del demo, para que
 * el comportamiento sea idéntico en ambos casos.
 */
export function computeSlotsFromBusy(
  service: ServiceDef,
  busy: BusyInterval[],
  opts: { fromDate?: DateTime; daysAhead?: number; maxSlots?: number } = {}
): DateTime[] {
  const tz = clinicConfig.timezone;
  const from = (opts.fromDate ?? DateTime.now().setZone(tz)).plus({
    minutes: clinicConfig.minBookingNoticeMinutes,
  });
  const daysAhead = opts.daysAhead ?? 14;
  const maxSlots = opts.maxSlots ?? clinicConfig.maxSlotsToOffer;
  const rangeStart = from.startOf("day");

  const slots: DateTime[] = [];
  const openingHours = getOpeningHoursSync();

  for (let dayOffset = 0; dayOffset < daysAhead && slots.length < maxSlots; dayOffset++) {
    const day = rangeStart.plus({ days: dayOffset });
    const weekday = day.weekday % 7; // luxon: 1=lunes..7=domingo -> pasamos a 0=domingo..6=sábado
    const ranges = openingHours[weekday];
    if (!ranges) continue;

    for (const range of ranges) {
      const [sh, sm] = range.start.split(":").map(Number);
      const [eh, em] = range.end.split(":").map(Number);
      let cursor = day.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
      const rangeEndTime = day.set({ hour: eh, minute: em, second: 0, millisecond: 0 });

      while (
        cursor.plus({ minutes: service.durationMinutes }) <= rangeEndTime &&
        slots.length < maxSlots
      ) {
        if (cursor >= from) {
          const slotEnd = cursor.plus({ minutes: service.durationMinutes });
          const overlaps = busy.some((b) => cursor < b.end && slotEnd > b.start);
          if (!overlaps) slots.push(cursor);
        }
        cursor = cursor.plus({ minutes: clinicConfig.slotGranularityMinutes });
      }
    }
  }

  return slots;
}

/**
 * Comprueba si un [start, end) concreto cae dentro del horario de apertura
 * del centro, sin generar la lista completa de huecos. La usa el booking
 * engine para validar de forma determinista lo que proponga el modelo:
 * el LLM puede sugerir una hora, pero nunca decide si es válida (ver
 * src/domain/bookingEngine.ts).
 */
export function isWithinOpeningHours(start: DateTime, end: DateTime): boolean {
  if (!start.isValid || !end.isValid || end <= start) return false;
  if (!start.hasSame(end, "day")) return false; // MVP: no citas que crucen medianoche

  const weekday = start.weekday % 7; // 1=lunes..7=domingo -> 0=domingo..6=sábado
  const ranges = getOpeningHoursSync()[weekday];
  if (!ranges) return false;

  return ranges.some((range) => {
    const [sh, sm] = range.start.split(":").map(Number);
    const [eh, em] = range.end.split(":").map(Number);
    const rangeStart = start.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
    const rangeEnd = start.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
    return start >= rangeStart && end <= rangeEnd;
  });
}
