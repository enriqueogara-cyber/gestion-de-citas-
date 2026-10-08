import fs from "fs";
import { google, calendar_v3 } from "googleapis";
import { DateTime } from "luxon";
import { env, clinicConfig, ServiceDef } from "../config";
import { computeSlotsFromBusy, BusyInterval } from "./slots";

let calendarClient: calendar_v3.Calendar | null = null;

function getClient(): calendar_v3.Calendar {
  if (calendarClient) return calendarClient;

  const keyFile = env.googleServiceAccountPath;
  if (!fs.existsSync(keyFile)) {
    throw new Error(
      `No se encuentra el fichero de credenciales de Google en "${keyFile}". ` +
        `Descarga la clave JSON de la cuenta de servicio y comparte el calendario del centro con su email.`
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  calendarClient = google.calendar({ version: "v3", auth });
  return calendarClient;
}

/** Consulta los periodos ocupados del calendario del centro en un rango. */
export async function getBusyIntervals(from: DateTime, to: DateTime): Promise<BusyInterval[]> {
  const client = getClient();
  const res = await client.freebusy.query({
    requestBody: {
      timeMin: from.toISO(),
      timeMax: to.toISO(),
      timeZone: clinicConfig.timezone,
      items: [{ id: env.googleCalendarId }],
    },
  });

  const busy = res.data.calendars?.[env.googleCalendarId]?.busy || [];
  return busy.map((b) => ({
    start: DateTime.fromISO(b.start as string),
    end: DateTime.fromISO(b.end as string),
  }));
}

/**
 * Genera los huecos libres para un servicio dado, cruzando el horario de
 * apertura del centro con lo que ya está ocupado en Google Calendar.
 */
/**
 * Limitación conocida (documentada, no un olvido): con un único calendario
 * de Google compartido por todo el centro, no hay forma de saber qué
 * profesional concreto está ocupado, solo si el centro lo está. Por eso
 * `opts.professionalId` se ignora aquí — la disponibilidad por profesional
 * de verdad (usada en el simulador) vive en mockCalendar.ts, que sí puede
 * cruzar por professionalId porque las citas están en nuestra propia DB.
 * Para producción con varios profesionales, la vía natural es un calendario
 * de Google por profesional; no se ha construido todavía porque no aporta
 * nada a la demo actual (ver README, "Qué falta para producción").
 */
export async function findAvailableSlots(
  service: ServiceDef,
  opts: { fromDate?: DateTime; daysAhead?: number; maxSlots?: number; professionalId?: string } = {}
): Promise<DateTime[]> {
  const tz = clinicConfig.timezone;
  const from = (opts.fromDate ?? DateTime.now().setZone(tz)).plus({
    minutes: clinicConfig.minBookingNoticeMinutes,
  });
  const daysAhead = opts.daysAhead ?? 14;
  const rangeStart = from.startOf("day");
  const rangeEnd = rangeStart.plus({ days: daysAhead });

  const busy = await getBusyIntervals(rangeStart, rangeEnd);
  const { prisma } = await import("../db/client");
  const local = await prisma.appointment.findMany({ where: { status: { in: ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"] }, startsAt: { lt: rangeEnd.toJSDate() }, endsAt: { gt: rangeStart.toJSDate() }, ...(opts.professionalId ? { professionalId: opts.professionalId } : {}) } });
  const blocks = await prisma.availabilityBlock.findMany({ where: { startsAt: { lt: rangeEnd.toJSDate() }, endsAt: { gt: rangeStart.toJSDate() }, ...(opts.professionalId ? { OR: [{ professionalId: null }, { professionalId: opts.professionalId }] } : {}) } });
  const holds = await prisma.slotHold.findMany({ where: { expiresAt: { gt: new Date() }, startsAt: { lt: rangeEnd.toJSDate() }, endsAt: { gt: rangeStart.toJSDate() }, ...(opts.professionalId ? { OR: [{ professionalId: null }, { professionalId: opts.professionalId }] } : {}) } });
  busy.push(...[...local, ...blocks, ...holds].map(r => ({ start: DateTime.fromJSDate(r.startsAt), end: DateTime.fromJSDate(r.endsAt) })));
  return computeSlotsFromBusy(service, busy, opts);
}

/** Comprueba si un hueco concreto sigue libre justo antes de confirmar la reserva. */
export async function isSlotFree(start: DateTime, end: DateTime, _professionalId?: string): Promise<boolean> {
  const busy = await getBusyIntervals(start.minus({ minutes: 1 }), end.plus({ minutes: 1 }));
  return !busy.some((b) => start < b.end && end > b.start);
}

export async function createCalendarEvent(params: {
  service: ServiceDef;
  start: DateTime;
  end: DateTime;
  patientName: string;
  patientPhone: string;
}): Promise<string> {
  const client = getClient();
  const res = await client.events.insert({
    calendarId: env.googleCalendarId,
    requestBody: {
      summary: `${params.service.label} - ${params.patientName || params.patientPhone}`,
      description: `Reservado por el agente de WhatsApp.\nPaciente: ${params.patientName || "(sin nombre)"}\nTeléfono: ${params.patientPhone}`,
      start: { dateTime: params.start.toISO(), timeZone: clinicConfig.timezone },
      end: { dateTime: params.end.toISO(), timeZone: clinicConfig.timezone },
    },
  });
  if (!res.data.id) throw new Error("Google Calendar no devolvió un id de evento");
  return res.data.id;
}

export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const client = getClient();
  try {
    await client.events.delete({ calendarId: env.googleCalendarId, eventId });
  } catch (err: any) {
    // Si ya no existe (410/404), lo damos por borrado.
    if (err?.response?.status !== 410 && err?.response?.status !== 404) throw err;
  }
}
