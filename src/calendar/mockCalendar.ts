import { DateTime } from "luxon";
import { ServiceDef, clinicConfig } from "../config";
import { prisma } from "../db/client";
import { computeSlotsFromBusy, BusyInterval } from "./slots";

/**
 * Calendario simulado para poder probar el agente de principio a fin sin
 * configurar Google Calendar todavía (lo usa el simulador de chat). Usa las
 * citas ya guardadas en la propia base de datos como "ocupado", así que el
 * comportamiento de disponibilidad/reservas es realista, solo que no toca
 * ningún calendario externo.
 *
 * Nota: esta comprobación es solo para GENERAR las opciones que se le
 * enseñan al paciente. La comprobación que de verdad decide si el hueco se
 * puede reservar vuelve a hacerse, de forma atómica, dentro de la
 * transacción de src/domain/bookingEngine.ts — este módulo nunca es la
 * última palabra sobre si un hueco está libre.
 */

async function getBusyIntervals(
  from: DateTime,
  to: DateTime,
  professionalId?: string
): Promise<BusyInterval[]> {
  const rows = await prisma.appointment.findMany({
    where: {
      status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
      startsAt: { lt: to.toJSDate() },
      endsAt: { gt: from.toJSDate() },
      ...(professionalId ? { professionalId } : {}),
    },
  });
  return rows.map((r) => ({
    start: DateTime.fromJSDate(r.startsAt),
    end: DateTime.fromJSDate(r.endsAt),
  }));
}

export async function findAvailableSlots(
  service: ServiceDef,
  opts: { fromDate?: DateTime; daysAhead?: number; maxSlots?: number; professionalId?: string } = {}
): Promise<DateTime[]> {
  const from = opts.fromDate ?? DateTime.now().setZone(clinicConfig.timezone);
  const daysAhead = opts.daysAhead ?? 14;
  const rangeEnd = from.startOf("day").plus({ days: daysAhead });

  const busy = await getBusyIntervals(from.startOf("day"), rangeEnd, opts.professionalId);
  return computeSlotsFromBusy(service, busy, opts);
}

export async function isSlotFree(
  start: DateTime,
  end: DateTime,
  professionalId?: string
): Promise<boolean> {
  const busy = await getBusyIntervals(start.minus({ minutes: 1 }), end.plus({ minutes: 1 }), professionalId);
  return !busy.some((b) => start < b.end && end > b.start);
}

export async function createCalendarEvent(_params: {
  service: ServiceDef;
  start: DateTime;
  end: DateTime;
  patientName: string;
  patientPhone: string;
}): Promise<string | null> {
  // No hay calendario externo real: no hay id de evento que guardar. La
  // cita "vive" únicamente en la base de datos local del agente.
  return null;
}

export async function deleteCalendarEvent(_eventId: string): Promise<void> {
  // No hay nada externo que borrar en modo simulado.
}
