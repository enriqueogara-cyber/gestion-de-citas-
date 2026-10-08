import { DateTime } from "luxon";
import type { Professional, Prisma } from "@prisma/client";
import { prisma } from "../db/client";
import { clinicConfig, ServiceDef } from "../config";
import { getServicesSync, getAllServicesSync } from "../services/serviceCatalog";
import { isWithinOpeningHours } from "../calendar/slots";
import { createCalendarEvent, isSlotFree, isUsingRealGoogleCalendar } from "../calendar";
import { resolveServiceProfessionals } from "../services/professionals";
import { recordEvent } from "../services/auditLog";
import { scheduleReminderJobs } from "../scheduler/persistentJobs";
import { logger } from "../lib/logger";
import { assertTransition, AppointmentStatus } from "./appointmentStateMachine";

/**
 * Capa de dominio para reservas: TODA la lógica que decide si una cita es
 * válida vive aquí, no repartida entre tools/agent/routes (ver README,
 * "Principio fundamental"). El LLM propone (servicio, profesional, fecha);
 * esta capa es quien de verdad decide si se puede reservar.
 */

/**
 * Códigos de error de dominio estables — para que quien llame (tools del
 * agente, futuras rutas) pueda reaccionar por código en vez de parsear el
 * mensaje. El mensaje humano puede cambiar de redacción; el código no.
 */
export type DomainErrorCode =
  | "SLOT_NOT_AVAILABLE"
  | "APPOINTMENT_NOT_FOUND"
  | "APPOINTMENT_NOT_CANCELLABLE"
  | "INVALID_STATE"
  | "OUTSIDE_OPENING_HOURS"
  | "PROFESSIONAL_NOT_AVAILABLE"
  | "SERVICE_NOT_FOUND"
  | "SERVICE_INACTIVE"
  | "PAST_DATE"
  | "MIN_NOTICE_NOT_MET"
  | "INVALID_DATE";

export function getService(serviceId: string): ServiceDef {
  const active = getServicesSync();
  const service = active.find((s) => s.id === serviceId);
  if (service) return service;

  // Existe pero está desactivado (bug real evitado: antes no se distinguía
  // de "no existe", y un servicio recién desactivado a mitad de conversación
  // podía seguir reservándose porque el LLM ya tenía su id en contexto).
  const inactive = getAllServicesSync().find((s) => s.id === serviceId && !s.active);
  if (inactive) {
    throw new BookingValidationError(`El servicio "${inactive.label}" ya no está disponible.`, "SERVICE_INACTIVE");
  }

  const ids = active.map((s) => s.id).join(", ");
  throw new BookingValidationError(`Servicio "${serviceId}" no reconocido. Servicios válidos: ${ids}`, "SERVICE_NOT_FOUND");
}

/** Error del paciente/agente (dato inválido) — distinto de un fallo interno. */
export class BookingValidationError extends Error {
  code: DomainErrorCode;
  constructor(message: string, code: DomainErrorCode = "INVALID_STATE") {
    super(message);
    this.name = "BookingValidationError";
    this.code = code;
  }
}

/** El hueco estaba libre cuando se propuso pero ya no lo está al confirmar. */
export class SlotTakenError extends Error {
  code: DomainErrorCode = "SLOT_NOT_AVAILABLE";
  constructor() {
    super("Ese hueco ya no está disponible, alguien se ha adelantado.");
    this.name = "SlotTakenError";
  }
}

const ACTIVE_APPOINTMENT_STATUSES = ["PENDING_CONFIRMATION", "CONFIRMED", "ARRIVED"];

async function isDbSlotFree(
  tx: Prisma.TransactionClient,
  start: DateTime,
  end: DateTime,
  professionalId: string | null,
  excludePatientId: string,
  excludeAppointmentId?: string
): Promise<boolean> {
  const overlappingAppt = await tx.appointment.count({
    where: {
      status: { in: ACTIVE_APPOINTMENT_STATUSES },
      startsAt: { lt: end.toJSDate() },
      endsAt: { gt: start.toJSDate() },
      ...(professionalId ? { OR: [{ professionalId }, { professionalId: null }] } : {}),
      ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
    },
  });
  if (overlappingAppt > 0) return false;
  const block = await tx.availabilityBlock.count({ where: { clinicId: "default", startsAt: { lt: end.toJSDate() }, endsAt: { gt: start.toJSDate() }, OR: [{ professionalId: null }, { professionalId }] } });
  if (block) return false;

  // Holds activos (huecos "apalabrados" con alguien de la lista de espera,
  // ver waitlistOrchestrator) también cuentan como ocupado para cualquiera
  // que no sea el paciente al que se le ofreció.
  const overlappingHold = await tx.slotHold.count({
    where: {
      startsAt: { lt: end.toJSDate() },
      endsAt: { gt: start.toJSDate() },
      expiresAt: { gt: new Date() },
      patientId: { not: excludePatientId },
      ...(professionalId ? { OR: [{ professionalId }, { professionalId: null }] } : {}),
    },
  });
  return overlappingHold === 0;
}

async function resolveFreeProfessional(
  tx: Prisma.TransactionClient,
  candidates: Professional[],
  requestedProfessional: Professional | null,
  start: DateTime,
  end: DateTime,
  patientId: string,
  excludeAppointmentId?: string
): Promise<{ ok: true; professionalId: string | null } | { ok: false }> {
  if (requestedProfessional) {
    const free = await isDbSlotFree(tx, start, end, requestedProfessional.id, patientId, excludeAppointmentId);
    return free ? { ok: true, professionalId: requestedProfessional.id } : { ok: false };
  }

  for (const p of candidates) {
    if (await isDbSlotFree(tx, start, end, p.id, patientId, excludeAppointmentId)) return { ok: true, professionalId: p.id };
  }
  return { ok: false };
}

export interface BookingRequest {
  patientId: string;
  patientName: string;
  patientPhone: string;
  serviceId: string;
  start: DateTime;
  professionalId?: string;
  /** true si esta reserva nace de aceptar una oferta de lista de espera. */
  recoveredFromWaitlist?: boolean;
  /**
   * Id de una cita del propio paciente a ignorar al comprobar solapamientos.
   * Lo usa domain/reschedule.ts: si el nuevo horario se solapa con la cita
   * VIEJA que se está moviendo (p.ej. mover 10:00→10:15 el mismo día), no
   * tiene sentido que choque contra sí misma.
   */
  excludeAppointmentId?: string;
}

/**
 * Reserva una cita validando reglas de negocio de forma determinista
 * (horario, antelación mínima, solapamientos) y protegiendo contra dobles
 * reservas con una transacción de base de datos: en SQLite las
 * transacciones de escritura se serializan, así que dos reservas
 * concurrentes para el mismo hueco no pueden colarse las dos — la segunda
 * encuentra el hueco ya ocupado dentro de su propia transacción y falla
 * con SlotTakenError. Para migrar a Postgres hay que revisar el aislamiento y añadir
 * protección de solapamientos; un índice normal no evita dobles reservas.
 */
export async function reserveAppointment(req: BookingRequest) {
  const service = getService(req.serviceId);
  const end = req.start.plus({ minutes: service.durationMinutes });
  const now = DateTime.now().setZone(clinicConfig.timezone);

  if (!req.start.isValid) {
    throw new BookingValidationError("No he entendido esa fecha/hora.", "INVALID_DATE");
  }
  if (req.start < now) {
    throw new BookingValidationError("Esa fecha y hora ya han pasado.", "PAST_DATE");
  }
  if (req.start < now.plus({ minutes: clinicConfig.minBookingNoticeMinutes })) {
    throw new BookingValidationError(
      `Hace falta reservar con al menos ${clinicConfig.minBookingNoticeMinutes} minutos de antelación.`,
      "MIN_NOTICE_NOT_MET"
    );
  }
  if (!isWithinOpeningHours(req.start, end)) {
    throw new BookingValidationError("Ese horario está fuera del horario de apertura del centro.", "OUTSIDE_OPENING_HOURS");
  }

  // Comprobación adicional, de mejor esfuerzo, contra el calendario externo
  // real: detecta eventos creados a mano en Google Calendar fuera de la
  // app (algo que nuestra propia base de datos, por definición, no puede
  // saber). No es la protección contra dobles reservas — esa la da la
  // transacción de abajo — es solo para no pisar citas puestas a mano.
  if (isUsingRealGoogleCalendar) {
    const free = await isSlotFree(req.start, end);
    if (!free) throw new SlotTakenError();
  }

  const resolved = await resolveServiceProfessionals(req.serviceId);

  // Servicio sin NINGÚN profesional cualificado (habiendo profesionales
  // dados de alta en el centro): nunca se infiere "cualquiera puede" por
  // ausencia de relaciones — se rechaza de forma explícita y clara, antes
  // de tocar la transacción. El único "cualquiera puede" legítimo es que
  // el centro no tenga NINGÚN profesional dado de alta en absoluto (ver
  // resolveServiceProfessionals).
  if (resolved.mode === "qualified" && resolved.professionals.length === 0) {
    throw new BookingValidationError(
      "Ahora mismo no hay ningún profesional disponible para ese servicio.",
      "PROFESSIONAL_NOT_AVAILABLE"
    );
  }

  const qualifiedList = resolved.mode === "qualified" ? resolved.professionals : [];
  let requestedProfessional: Professional | null = null;
  if (req.professionalId) {
    requestedProfessional = qualifiedList.find((p) => p.id === req.professionalId) ?? null;
    if (!requestedProfessional) {
      throw new BookingValidationError("Ese profesional no existe o no realiza este servicio.", "PROFESSIONAL_NOT_AVAILABLE");
    }
  }
  const candidates = qualifiedList;

  const appointment = await prisma.$transaction(async (tx) => {
    const eligibleNow = await tx.professional.findMany({ where: { clinicId: "default", active: true, id: { in: candidates.map(p => p.id) } } });
    const stillQualified = eligibleNow.filter(p => { try { return JSON.parse(p.serviceIds).includes(req.serviceId); } catch { return false; } });
    if (!stillQualified.length || (requestedProfessional && !stillQualified.some(p => p.id === requestedProfessional!.id))) throw new BookingValidationError("No hay un profesional elegible para ese servicio.", "PROFESSIONAL_NOT_AVAILABLE");
    const resolved = await resolveFreeProfessional(
      tx,
      stillQualified,
      requestedProfessional,
      req.start,
      end,
      req.patientId,
      req.excludeAppointmentId
    );
    if (!resolved.ok) throw new SlotTakenError();

    const created = await tx.appointment.create({
      data: {
        patientId: req.patientId,
        professionalId: resolved.professionalId,
        service: service.id,
        startsAt: req.start.toJSDate(),
        endsAt: end.toJSDate(),
        status: "PENDING_CONFIRMATION",
        priceEurAtBooking: service.priceEur ?? null,
        recoveredFromWaitlist: req.recoveredFromWaitlist ?? false,
      },
    });

    if (req.recoveredFromWaitlist) {
      // El hold que bloqueaba este hueco para este paciente ya cumplió su
      // función: lo liberamos dentro de la misma transacción.
      await tx.slotHold.deleteMany({
        where: { patientId: req.patientId, startsAt: req.start.toJSDate(), endsAt: end.toJSDate() },
      });
    }

    // Reserva y recordatorios se guardan juntos: nunca queda una cita sin jobs.
    await scheduleReminderJobs(created, tx);
    return created;
  });

  // Sincronizar con Google Calendar es un efecto externo, fuera de la
  // transacción: nuestra base de datos ya es la fuente de verdad (ver
  // README, "Google Calendar"). Si falla, la cita sigue siendo válida.
  try {
    const googleEventId = await createCalendarEvent({
      service,
      start: req.start,
      end,
      patientName: req.patientName,
      patientPhone: req.patientPhone,
    });
    if (googleEventId) {
      await prisma.appointment.update({ where: { id: appointment.id }, data: { googleEventId } });
    }
  } catch (err) {
    logger.error("calendar_sync_failed", { appointmentId: appointment.id, err });
    await recordEvent("CALENDAR_SYNC_FAILED", {
      appointmentId: appointment.id,
      metadata: { message: (err as Error)?.message },
    });
  }

  await recordEvent("APPOINTMENT_CREATED", {
    patientId: req.patientId,
    appointmentId: appointment.id,
    metadata: {
      service: service.id,
      professionalId: appointment.professionalId,
      recoveredFromWaitlist: appointment.recoveredFromWaitlist,
    },
  });
  if (appointment.recoveredFromWaitlist) {
    await recordEvent("SLOT_RECOVERED", {
      patientId: req.patientId,
      appointmentId: appointment.id,
      metadata: { service: service.id, priceEur: appointment.priceEurAtBooking },
    });
  }

  // Programa los recordatorios 24h/2h como jobs persistentes (ver
  // scheduler/persistentJobs.ts) — sobreviven a un reinicio del proceso,
  // a diferencia de depender solo de un cron en memoria.


  return appointment;
}

/**
 * Cambia el estado de una cita de forma atómica y solo si la transición es
 * válida (ver appointmentStateMachine). Usa un `updateMany` con el estado
 * de origen en el WHERE como compare-and-swap: si otra petición cambió el
 * estado entre medias (doble clic, dos mensajes seguidos, el scheduler...),
 * esta llamada no afecta a ninguna fila y lo sabemos por el `count`, en vez
 * de pisar un cambio que ya había pasado.
 */
export async function transitionAppointment(
  appointmentId: string,
  patientId: string,
  to: AppointmentStatus
): Promise<
  | { ok: true; appointment: Awaited<ReturnType<typeof prisma.appointment.findUniqueOrThrow>> }
  | { ok: false; reason: string; code: DomainErrorCode }
> {
  const current = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!current || current.patientId !== patientId) {
    return { ok: false, reason: "No encuentro esa cita para este paciente.", code: "APPOINTMENT_NOT_FOUND" };
  }

  try {
    assertTransition(current.status, to);
  } catch {
    return {
      ok: false,
      reason: `Esa cita ya está en estado "${current.status}", no se puede cambiar a "${to}".`,
      code: "APPOINTMENT_NOT_CANCELLABLE",
    };
  }

  const result = await prisma.appointment.updateMany({
    where: { id: appointmentId, patientId, status: current.status },
    data: { status: to },
  });
  if (result.count === 0) {
    return {
      ok: false,
      reason: "Esa cita acaba de cambiar de estado por otra vía, vuelve a comprobarla.",
      code: "INVALID_STATE",
    };
  }

  const appointment = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId } });
  return { ok: true, appointment };
}
