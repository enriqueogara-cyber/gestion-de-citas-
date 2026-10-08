import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { deleteCalendarEvent, findAvailableSlots } from "../calendar";
import {
  reserveAppointment,
  transitionAppointment,
  getService,
  BookingValidationError,
  SlotTakenError,
} from "../domain/bookingEngine";
import { recordEvent } from "./auditLog";
import { offerFreedSlot } from "./waitlistOrchestrator";
import { resolveServiceProfessionals } from "./professionals";
import { logger } from "../lib/logger";
import { cancelJobsForAppointment } from "../scheduler/persistentJobs";

// Re-exportados para que el resto del código (agent/tools.ts, etc.) siga
// importando desde aquí sin saber que la validación real vive en
// src/domain/bookingEngine.ts.
export { getService, BookingValidationError, SlotTakenError };

export async function getAvailability(
  serviceId: string,
  daysAhead = 14,
  professionalId?: string,
  onDate?: DateTime
) {
  const service = getService(serviceId);
  // Si el paciente pidió un día CONCRETO ("el jueves"), buscamos solo ese
  // día en vez de los próximos N días desde hoy: si ese día cae después de
  // los primeros huecos (limitados por maxSlotsToOffer), una búsqueda
  // genérica nunca los mostraría y el agente concluiría erróneamente que
  // "no hay hueco" cuando en realidad no había mirado ahí.
  //
  // Bug real que corrige el `maxSlots` generoso de aquí: `maxSlotsToOffer`
  // (pensado como cuántos huecos enseñar en un mensaje, no como cuántos
  // CALCULAR) se agotaba dentro del propio bloque de mañana o de los
  // primeros días cuando había mucha disponibilidad, y el resto (la tarde
  // de ese día, o directamente días enteros) nunca llegaba a calcularse —
  // el agente podía decir "no hay hueco" siendo falso, solo porque no
  // había mirado ahí. Esta capa (getAvailability) SIEMPRE calcula el
  // panorama real completo; qué subconjunto enseñarle al paciente es cosa
  // de la capa de presentación (ver agent/slotPresentation.ts), nunca de
  // truncar el motor de disponibilidad en sí.
  const FULL_PICTURE_CAP = 500; // techo de seguridad, no una reducción real
  const baseOpts = onDate
    ? { fromDate: onDate.startOf("day"), daysAhead: 1, maxSlots: FULL_PICTURE_CAP }
    : { daysAhead, maxSlots: FULL_PICTURE_CAP };

  if (professionalId) {
    return findAvailableSlots(service, { ...baseOpts, professionalId });
  }

  // Sin profesional concreto pedido: un hueco cuenta como disponible si
  // AL MENOS UNO de los profesionales cualificados está libre a esa hora,
  // no solo si "no hay ninguna cita a esa hora" en general. Bug real que
  // esto corrige: antes se consultaba sin filtro de profesional, lo que
  // trataba el centro como un único recurso compartido — si Carlos estaba
  // ocupado a las 12:00 pero Laura estaba libre, el sistema decía "no hay
  // hueco a las 12:00" y perdía una reserva posible de verdad.
  const resolved = await resolveServiceProfessionals(serviceId);
  if (resolved.mode === "no-professionals-onboarded") {
    return findAvailableSlots(service, baseOpts);
  }

  // Hay profesionales dados de alta pero NINGUNO cualificado para este
  // servicio: no hay disponibilidad real, nunca "cualquiera puede" por
  // ausencia de relaciones (ver services/professionals.ts,
  // resolveServiceProfessionals — mismo bug que en bookingEngine).
  if (resolved.professionals.length === 0) return [];

  const perProfessional = await Promise.all(
    resolved.professionals.map((p) => findAvailableSlots(service, { ...baseOpts, professionalId: p.id }))
  );

  const seen = new Set<string>();
  const merged: DateTime[] = [];
  for (const slots of perProfessional) {
    for (const s of slots) {
      const key = s.toMillis().toString();
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(s);
      }
    }
  }
  merged.sort((a, b) => a.toMillis() - b.toMillis());
  return merged.slice(0, FULL_PICTURE_CAP);
}

export async function bookAppointment(params: {
  patientId: string;
  patientName: string;
  patientPhone: string;
  serviceId: string;
  start: DateTime;
  professionalId?: string;
  recoveredFromWaitlist?: boolean;
}) {
  return reserveAppointment(params);
}

export async function listUpcomingAppointments(patientId: string) {
  return prisma.appointment.findMany({
    where: {
      patientId,
      startsAt: { gte: new Date() },
      status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] },
    },
    include: { professional: true },
    orderBy: { startsAt: "asc" },
  });
}

/**
 * Cancela una cita: borra el evento de Google si existía, marca el estado
 * (con la máquina de estados protegiendo contra transiciones inválidas) y
 * dispara la lista de espera para intentar rellenar el hueco ya mismo.
 * Centralizado aquí (y no en agent/tools.ts) para que CUALQUIER camino que
 * cancele una cita en el futuro (dashboard, webhook, recordatorio "NO")
 * dispare siempre la misma lógica.
 */
export async function cancelAppointment(appointmentId: string, patientId: string) {
  const result = await transitionAppointment(appointmentId, patientId, "CANCELLED");
  if (!result.ok) throw new BookingValidationError(result.reason, result.code);
  const appt = result.appointment;

  if (appt.googleEventId) {
    try {
      await deleteCalendarEvent(appt.googleEventId);
    } catch (err) {
      await recordEvent("CALENDAR_SYNC_FAILED", {
        appointmentId: appt.id,
        metadata: { action: "delete", message: (err as Error)?.message },
      });
    }
  }

  await recordEvent("APPOINTMENT_CANCELLED", { patientId, appointmentId: appt.id, metadata: { service: appt.service } });

  // Sus recordatorios pendientes ya no tienen sentido.
  await cancelJobsForAppointment(appt.id);

  // Liberar el hueco: si alguien lo esperaba en lista de espera compatible,
  // se le avisa ya mismo (ver services/waitlistOrchestrator.ts).
  await offerFreedSlot(appt.service, DateTime.fromJSDate(appt.startsAt), appt.professionalId);

  return appt;
}

export async function confirmAppointment(appointmentId: string, patientId: string) {
  const result = await transitionAppointment(appointmentId, patientId, "CONFIRMED");
  if (!result.ok) throw new BookingValidationError(result.reason, result.code);
  await recordEvent("APPOINTMENT_CONFIRMED", { patientId, appointmentId });
  return result.appointment;
}

/**
 * Cambia una cita a un horario/servicio/profesional nuevo de forma SEGURA:
 * primero reserva la cita nueva, y solo si eso tiene éxito cancela la
 * vieja. Así, si el nuevo hueco ya no está libre (o cualquier otra
 * validación falla), la cita original queda intacta — nunca "cancelo la
 * vieja y luego resulta que no puedo crear la nueva", que dejaría al
 * paciente sin cita.
 *
 * Si la cancelación de la vieja fallara DESPUÉS de crear la nueva (no
 * debería — ya se comprobó su estado antes — pero por si acaso), hay un
 * segundo nivel de compensación en vez de dejar dos citas activas
 * silenciosamente:
 *  1. Se intenta cancelar la cita NUEVA para volver exactamente al estado
 *     de partida (el paciente conserva la original) y se informa del fallo.
 *  2. Si ni siquiera esa compensación funciona, queda un estado realmente
 *     inconsistente (dos citas activas para el mismo cambio): se registra
 *     un evento `RESCHEDULE_INCONSISTENT` (aparece en "Necesita atención"
 *     del Overview) y se lanza un error — nunca se le dice al paciente que
 *     el cambio salió bien cuando no se sabe con certeza que así fue.
 */
export async function rescheduleAppointment(params: {
  appointmentId: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  newStart: DateTime;
  newServiceId?: string;
  newProfessionalId?: string;
}) {
  const old = await prisma.appointment.findUnique({ where: { id: params.appointmentId } });
  if (!old || old.patientId !== params.patientId) {
    throw new BookingValidationError("No encuentro esa cita para este paciente.", "APPOINTMENT_NOT_FOUND");
  }
  if (!["PENDING_CONFIRMATION", "CONFIRMED"].includes(old.status)) {
    throw new BookingValidationError(
      `Esa cita está en estado "${old.status}", no se puede cambiar de fecha.`,
      "APPOINTMENT_NOT_CANCELLABLE"
    );
  }

  const newAppt = await reserveAppointment({
    patientId: params.patientId,
    patientName: params.patientName,
    patientPhone: params.patientPhone,
    serviceId: params.newServiceId ?? old.service,
    start: params.newStart,
    professionalId: params.newProfessionalId ?? old.professionalId ?? undefined,
    excludeAppointmentId: old.id,
  });

  try {
    await cancelAppointment(old.id, params.patientId);
  } catch (cancelOldErr) {
    logger.error("reschedule_old_cancel_failed", { oldAppointmentId: old.id, newAppointmentId: newAppt.id, err: cancelOldErr });

    let compensated = false;
    try {
      await cancelAppointment(newAppt.id, params.patientId);
      compensated = true;
    } catch (compErr) {
      logger.error("reschedule_compensation_failed", { oldAppointmentId: old.id, newAppointmentId: newAppt.id, err: compErr });
    }

    if (compensated) {
      await recordEvent("AGENT_ERROR", {
        patientId: params.patientId,
        appointmentId: old.id,
        metadata: { phase: "reschedule_compensated", newAppointmentId: newAppt.id },
      });
      throw new BookingValidationError(
        "No se ha podido completar el cambio de cita; tu cita original sigue en pie tal cual estaba.",
        "INVALID_STATE"
      );
    }

    // Compensación también falló: estado de verdad inconsistente (dos
    // citas activas). Un humano tiene que revisarlo — nunca decimos al
    // paciente que el cambio salió bien.
    await recordEvent("RESCHEDULE_INCONSISTENT", {
      patientId: params.patientId,
      appointmentId: newAppt.id,
      metadata: {
        oldAppointmentId: old.id,
        message: "Cancelación de la cita antigua y compensación (cancelar la nueva) fallaron ambas.",
      },
    });
    throw new BookingValidationError(
      "Ha habido un problema cambiando tu cita — el centro va a revisarlo y te contactará si hace falta algo por tu parte.",
      "INVALID_STATE"
    );
  }

  await recordEvent("APPOINTMENT_RESCHEDULED", {
    patientId: params.patientId,
    appointmentId: newAppt.id,
    metadata: { fromAppointmentId: old.id, service: newAppt.service },
  });

  return newAppt;
}

export async function markCompleted(appointmentId: string) {
  const appt = await prisma.appointment.findUnique({ where: { id: appointmentId } });
  if (!appt) return null;
  const result = await transitionAppointment(appointmentId, appt.patientId, "COMPLETED");
  if (result.ok) await recordEvent("APPOINTMENT_COMPLETED", { patientId: appt.patientId, appointmentId });
  return result.ok ? result.appointment : null;
}
