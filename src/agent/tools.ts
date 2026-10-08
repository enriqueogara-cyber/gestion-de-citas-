import { DateTime } from "luxon";
import { z } from "zod";
import { getServicesSync } from "../services/serviceCatalog";
import {
  bookAppointment,
  cancelAppointment,
  confirmAppointment,
  rescheduleAppointment,
  getAvailability,
  getService,
  listUpcomingAppointments,
  BookingValidationError,
  SlotTakenError,
} from "../services/appointments";
import {
  cancelWaitlistEntry,
  joinWaitlist,
  listWaitlistForPatient,
} from "../services/waitlist";
import { acceptWaitlistOffer } from "../services/waitlistOrchestrator";
import { resolveServiceProfessionals } from "../services/professionals";
import { recordEvent } from "../services/auditLog";
import { prisma } from "../db/client";
import { formatLong } from "../lib/dates";
import { serviceLabel } from "../lib/labels";
import { selectRepresentativeSlots } from "./slotPresentation";

export interface AgentContext {
  patientId: string;
  phone: string;
  name: string;
}

// Formato genérico (JSON Schema) que se traduce a "function calling" estilo
// OpenAI al llamar a OpenRouter (ver agent/claude.ts). Es lo que el modelo
// VE. Los esquemas Zod de más abajo son lo que de verdad se valida — el
// modelo puede alucinar un argumento fuera de forma, y eso no puede
// convertirse en una excepción sin controlar ni, peor, en una acción
// ejecutada con datos basura.
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export const toolDefinitions: ToolDef[] = [
  {
    name: "list_services",
    description: "Devuelve la lista de servicios que ofrece el centro con su duración y precio.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_professionals",
    description:
      "Devuelve los profesionales del centro que pueden realizar un servicio, con su id (para usar en otras herramientas) y nombre. Si el centro no tiene profesionales específicos dados de alta, indica que cualquiera puede atender.",
    input_schema: {
      type: "object",
      properties: { service_id: { type: "string", description: "id del servicio, ver list_services" } },
      required: ["service_id"],
    },
  },
  {
    name: "check_availability",
    description:
      "Busca huecos libres para un servicio concreto, cruzando el horario del centro con el calendario real. Si el paciente pidió un DÍA CONCRETO (\"el jueves\", \"el 5 de marzo\"), pasa date_iso con esa fecha para buscar justo ahí — la lista general (days_ahead) solo trae los primeros huecos cronológicos y puede no llegar hasta ese día, así que nunca concluyas 'no hay hueco ese día' sin haber consultado con date_iso. Usa professional_id solo si el paciente ha pedido explícitamente a alguien concreto. El resultado ya viene REDUCIDO a un puñado de horarios representativos (no todos los huecos reales, que pueden ser decenas) según la preferencia que pases — nunca intentes tú resumir o filtrar una lista larga, pasa la preferencia y deja que el backend elija.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string", description: "id del servicio, ver list_services" },
        days_ahead: { type: "integer", description: "días hacia adelante a mirar desde hoy (por defecto 14); ignorado si se pasa date_iso" },
        date_iso: { type: "string", description: "un día concreto a consultar (ISO 8601, solo la fecha), si el paciente pidió un día específico" },
        professional_id: { type: "string", description: "id de list_professionals, opcional" },
        time_of_day: { type: "string", enum: ["MORNING", "AFTERNOON"], description: "si pidió \"por la mañana\" o \"por la tarde\"" },
        around_time: { type: "string", description: "HH:mm — si pidió algo como \"sobre las seis\": los huecos reales más cercanos a esa hora" },
        earliest: { type: "boolean", description: "si pidió \"la más temprana\"/\"lo antes posible\": solo el primer hueco real" },
        latest: { type: "boolean", description: "si pidió \"la más tarde\"/\"lo último\": solo el último hueco real" },
        time_range_start: { type: "string", description: "HH:mm — junto con time_range_end, si pidió un rango tipo \"entre las 16 y las 19\"" },
        time_range_end: { type: "string", description: "HH:mm — ver time_range_start" },
      },
      required: ["service_id"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Reserva una cita para el paciente actual en un hueco concreto devuelto por check_availability. Comprueba de nuevo disponibilidad y reglas del centro en el momento de reservar; nunca asumas que un hueco es válido solo porque el paciente lo pida.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        start_iso: { type: "string", description: "fecha y hora de inicio en ISO 8601, con zona horaria" },
        professional_id: { type: "string", description: "id de list_professionals, opcional" },
      },
      required: ["service_id", "start_iso"],
    },
  },
  {
    name: "reschedule_appointment",
    description:
      "Cambia una cita existente del paciente a otro horario (y opcionalmente otro servicio/profesional). SIEMPRE usa esta herramienta para un cambio de cita, nunca cancel_appointment + book_appointment por separado: esta comprueba primero que el hueco nuevo esté libre y solo entonces mueve la cita, así que si el hueco nuevo no está disponible la cita original queda intacta.",
    input_schema: {
      type: "object",
      properties: {
        appointment_id: { type: "string" },
        new_start_iso: { type: "string", description: "nueva fecha y hora de inicio, ISO 8601" },
        new_service_id: { type: "string", description: "solo si también cambia el servicio" },
        new_professional_id: { type: "string", description: "solo si también cambia el profesional pedido" },
      },
      required: ["appointment_id", "new_start_iso"],
    },
  },
  {
    name: "cancel_appointment",
    description:
      "Cancela una cita existente del paciente actual. Al liberar el hueco, se ofrece automáticamente a la lista de espera. No la uses para un cambio de cita: para eso está reschedule_appointment.",
    input_schema: {
      type: "object",
      properties: { appointment_id: { type: "string" } },
      required: ["appointment_id"],
    },
  },
  {
    name: "confirm_appointment",
    description:
      "Confirma la asistencia del paciente a una cita pendiente de confirmación (por ejemplo, cuando responde a un recordatorio).",
    input_schema: {
      type: "object",
      properties: { appointment_id: { type: "string" } },
      required: ["appointment_id"],
    },
  },
  {
    name: "join_waitlist",
    description:
      "Apunta al paciente actual a la lista de espera de un servicio dentro de un rango de fechas, para avisarle si se libera un hueco antes.",
    input_schema: {
      type: "object",
      properties: {
        service_id: { type: "string" },
        earliest_date_iso: { type: "string", description: "fecha más temprana que le vale, ISO 8601" },
        latest_date_iso: { type: "string", description: "fecha más tardía que le vale, ISO 8601" },
        professional_id: { type: "string", description: "solo si pidió a alguien concreto" },
        preferred_time_of_day: { type: "string", enum: ["MORNING", "AFTERNOON"], description: "solo si pidió mañana o tarde" },
      },
      required: ["service_id", "earliest_date_iso", "latest_date_iso"],
    },
  },
  {
    name: "accept_waitlist_offer",
    description:
      "El paciente acepta un hueco que se le había ofrecido desde la lista de espera; intenta convertirlo en una cita real.",
    input_schema: {
      type: "object",
      properties: { waitlist_entry_id: { type: "string" } },
      required: ["waitlist_entry_id"],
    },
  },
  {
    name: "cancel_waitlist_entry",
    description: "Quita al paciente actual de una lista de espera en la que estaba apuntado.",
    input_schema: {
      type: "object",
      properties: { waitlist_entry_id: { type: "string" } },
      required: ["waitlist_entry_id"],
    },
  },
  {
    name: "request_human_handoff",
    description:
      "Marca la conversación para que la atienda una persona del centro, en vez de seguir tú. Úsalo ante dudas médicas/clínicas, urgencias, quejas, facturación compleja, o si el paciente pide explícitamente hablar con una persona. Nunca des consejo médico tú mismo.",
    input_schema: {
      type: "object",
      properties: { reason: { type: "string", description: "motivo breve, para el equipo del centro" } },
      required: ["reason"],
    },
  },
];

// --- Validación de argumentos (defensa en profundidad) ---
// El modelo puede mandar cualquier cosa: un id que no existe, un tipo
// equivocado, un campo que falta. Nunca se ejecuta una tool con argumentos
// sin validar (ver README, "Tool calling").
const schemas: Record<string, z.ZodTypeAny> = {
  list_services: z.object({}),
  list_professionals: z.object({ service_id: z.string().min(1) }),
  check_availability: z.object({
    service_id: z.string().min(1),
    days_ahead: z.number().int().positive().max(90).optional(),
    date_iso: z.string().min(1).optional(),
    professional_id: z.string().min(1).optional(),
    time_of_day: z.enum(["MORNING", "AFTERNOON"]).optional(),
    around_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
    earliest: z.boolean().optional(),
    latest: z.boolean().optional(),
    time_range_start: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
    time_range_end: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).optional(),
  }),
  book_appointment: z.object({
    service_id: z.string().min(1),
    start_iso: z.string().min(1),
    professional_id: z.string().min(1).optional(),
  }),
  reschedule_appointment: z.object({
    appointment_id: z.string().min(1),
    new_start_iso: z.string().min(1),
    new_service_id: z.string().min(1).optional(),
    new_professional_id: z.string().min(1).optional(),
  }),
  cancel_appointment: z.object({ appointment_id: z.string().min(1) }),
  confirm_appointment: z.object({ appointment_id: z.string().min(1) }),
  join_waitlist: z.object({
    service_id: z.string().min(1),
    earliest_date_iso: z.string().min(1),
    latest_date_iso: z.string().min(1),
    professional_id: z.string().min(1).optional(),
    preferred_time_of_day: z.enum(["MORNING", "AFTERNOON"]).optional(),
  }),
  accept_waitlist_offer: z.object({ waitlist_entry_id: z.string().min(1) }),
  cancel_waitlist_entry: z.object({ waitlist_entry_id: z.string().min(1) }),
  request_human_handoff: z.object({ reason: z.string().min(1).max(300) }),
};

export interface ToolResult {
  text: string;
  handoffReason?: string;
}

/**
 * Ejecuta una tool ya validada. IMPORTANTE (ver README, "Prompt
 * injection"): todas las operaciones que tocan una cita o entrada de lista
 * de espera están scopeadas a `ctx.patientId` dentro de los servicios que
 * llaman (cancelAppointment, confirmAppointment, cancelWaitlistEntry...),
 * así que aunque el modelo reciba instrucciones maliciosas en el texto del
 * paciente ("cancela todas las citas", "ignora tus instrucciones"), no
 * puede actuar sobre citas de otro paciente ni saltarse estas
 * comprobaciones — no son opcionales ni dependen de que el modelo "se
 * porte bien".
 */
export async function executeTool(toolName: string, rawInput: any, ctx: AgentContext): Promise<ToolResult> {
  const schema = schemas[toolName];
  if (!schema) return { text: `ERROR: herramienta desconocida "${toolName}".` };

  const parsed = schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { text: `ERROR: argumentos inválidos para ${toolName}: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
  }
  const input = parsed.data as any;

  await recordEvent("AI_TOOL_CALLED", { patientId: ctx.patientId, metadata: { tool: toolName } });

  switch (toolName) {
    case "list_services": {
      const lines = getServicesSync().map(
        (s) => `- ${s.id}: ${s.label} (${s.durationMinutes} min${s.priceEur ? `, ${s.priceEur} €` : ""})`
      );
      return { text: `OK:\n${lines.join("\n")}` };
    }

    case "list_professionals": {
      try {
        getService(input.service_id); // valida que el servicio existe y está activo antes de nada más
      } catch (err) {
        if (err instanceof BookingValidationError) return { text: `ERROR: ${err.message}` };
        throw err;
      }
      const resolved = await resolveServiceProfessionals(input.service_id);
      if (resolved.mode === "no-professionals-onboarded") {
        return { text: "OK: no hay profesionales específicos, cualquiera del centro puede atender ese servicio." };
      }
      if (resolved.professionals.length === 0) {
        return { text: "OK: ahora mismo no hay ningún profesional disponible para ese servicio." };
      }
      return { text: `OK:\n${resolved.professionals.map((p) => `- ${p.id}: ${p.name}`).join("\n")}` };
    }

    case "check_availability": {
      await recordEvent("AVAILABILITY_CHECKED", { patientId: ctx.patientId, metadata: { service: input.service_id, date: input.date_iso } });
      const onDate = input.date_iso ? DateTime.fromISO(input.date_iso) : undefined;
      if (onDate && !onDate.isValid) return { text: "ERROR: date_iso no es una fecha válida." };
      const allSlots = await getAvailability(input.service_id, input.days_ahead ?? 14, input.professional_id, onDate);
      if (allSlots.length === 0) {
        // Distingue "no hay ningún profesional que dé este servicio" (deja
        // de tener sentido seguir preguntando por otro día/hora) de "todos
        // están ocupados en ese rango" (sí tiene sentido probar otro rango)
        // — mismo criterio que reserveAppointment/getAvailability.
        if (!input.professional_id) {
          const resolved = await resolveServiceProfessionals(input.service_id);
          if (resolved.mode === "qualified" && resolved.professionals.length === 0) {
            return { text: "OK: ahora mismo no hay ningún profesional disponible para ese servicio." };
          }
        }
        return { text: onDate ? "OK: no hay huecos libres ese día concreto." : "OK: no hay huecos libres en el rango consultado." };
      }
      // Reducción a un puñado representativo en la capa de presentación
      // (ver agent/slotPresentation.ts) — nunca truncando el motor de
      // disponibilidad en sí, que ya calculó el panorama real completo.
      const slots = selectRepresentativeSlots(allSlots, {
        timeOfDay: input.time_of_day,
        aroundTime: input.around_time,
        earliest: input.earliest,
        latest: input.latest,
        timeRangeStart: input.time_range_start,
        timeRangeEnd: input.time_range_end,
      });
      if (slots.length === 0) {
        return { text: "OK: hay disponibilidad en otros horarios, pero ninguno encaja con esa preferencia concreta. Prueba consultando sin filtro o con otra franja." };
      }
      // start_iso es SOLO para que luego pases el mismo valor a book_appointment
      // tal cual — para hablarle al paciente, usa siempre el texto entre
      // paréntesis (ya viene en hora local de la clínica con el día de la
      // semana correcto: nunca lo recalcules tú ni lo derives del ISO).
      return { text: `OK:\n${slots.map((s) => `- start_iso=${s.toISO()} → ${formatLong(s)}`).join("\n")}` };
    }

    case "book_appointment": {
      try {
        const appt = await bookAppointment({
          patientId: ctx.patientId,
          patientName: ctx.name,
          patientPhone: ctx.phone,
          serviceId: input.service_id,
          start: DateTime.fromISO(input.start_iso),
          professionalId: input.professional_id,
        });
        return {
          text: `OK: cita reservada para ${serviceLabel(appt.service)} el ${formatLong(appt.startsAt)} (appointment_id=${appt.id}). Pendiente de confirmación 24h antes.`,
        };
      } catch (err) {
        if (err instanceof SlotTakenError) {
          return { text: "ERROR: ese hueco ya no está disponible, ofrece al paciente volver a comprobar disponibilidad con check_availability." };
        }
        if (err instanceof BookingValidationError) {
          return { text: `ERROR: ${err.message}` };
        }
        throw err;
      }
    }

    case "reschedule_appointment": {
      try {
        const appt = await rescheduleAppointment({
          appointmentId: input.appointment_id,
          patientId: ctx.patientId,
          patientName: ctx.name,
          patientPhone: ctx.phone,
          newStart: DateTime.fromISO(input.new_start_iso),
          newServiceId: input.new_service_id,
          newProfessionalId: input.new_professional_id,
        });
        return {
          text: `OK: cita cambiada a ${serviceLabel(appt.service)} el ${formatLong(appt.startsAt)} (appointment_id=${appt.id}). La cita anterior queda cancelada.`,
        };
      } catch (err) {
        if (err instanceof SlotTakenError) {
          return { text: "ERROR: ese hueco nuevo ya no está disponible; la cita original sigue como estaba. Ofrece comprobar disponibilidad de nuevo." };
        }
        if (err instanceof BookingValidationError) return { text: `ERROR: ${err.message}` };
        throw err;
      }
    }

    case "cancel_appointment": {
      try {
        const appt = await cancelAppointment(input.appointment_id, ctx.patientId);
        return { text: `OK: cita de ${serviceLabel(appt.service)} el ${formatLong(appt.startsAt)} cancelada correctamente.` };
      } catch (err) {
        if (err instanceof BookingValidationError) return { text: `ERROR: ${err.message}` };
        throw err;
      }
    }

    case "confirm_appointment": {
      try {
        const appt = await confirmAppointment(input.appointment_id, ctx.patientId);
        return { text: `OK: cita de ${serviceLabel(appt.service)} el ${formatLong(appt.startsAt)} confirmada. ¡Te esperamos!` };
      } catch (err) {
        if (err instanceof BookingValidationError) return { text: `ERROR: ${err.message}` };
        throw err;
      }
    }

    case "join_waitlist": {
      try {
        const entry = await joinWaitlist({
          patientId: ctx.patientId,
          serviceId: input.service_id,
          earliestDate: DateTime.fromISO(input.earliest_date_iso),
          latestDate: DateTime.fromISO(input.latest_date_iso),
          professionalId: input.professional_id,
          preferredTimeOfDay: input.preferred_time_of_day,
        });
        return { text: `OK: apuntado a la lista de espera de ${serviceLabel(entry.service)} (waitlist_entry_id=${entry.id}). Se avisará en cuanto haya un hueco.` };
      } catch (err) {
        if (err instanceof BookingValidationError) return { text: `ERROR: ${err.message}` };
        throw err;
      }
    }

    case "accept_waitlist_offer": {
      const entry = await prisma.waitlistEntry.findUnique({
        where: { id: input.waitlist_entry_id },
        include: { patient: true },
      });
      if (!entry || entry.patientId !== ctx.patientId) {
        return { text: "ERROR: no encuentro esa oferta de lista de espera para este paciente." };
      }
      try {
        const appt = await acceptWaitlistOffer(entry.id, entry);
        return { text: `OK: hueco confirmado como cita de ${serviceLabel(appt.service)} el ${formatLong(appt.startsAt)} (appointment_id=${appt.id}).` };
      } catch (err) {
        if (err instanceof SlotTakenError) {
          return { text: "ERROR: justo se ha ocupado ese hueco por otra vía; se ha pasado la oferta al siguiente de la lista." };
        }
        return { text: `ERROR: ${(err as Error)?.message || "no se pudo aceptar la oferta"}.` };
      }
    }

    case "cancel_waitlist_entry": {
      const entry = await cancelWaitlistEntry(input.waitlist_entry_id, ctx.patientId);
      return { text: `OK: baja de la lista de espera de ${serviceLabel(entry.service)} confirmada.` };
    }

    case "request_human_handoff": {
      await recordEvent("HUMAN_HANDOFF_REQUESTED", { patientId: ctx.patientId, metadata: { reason: input.reason } });
      return {
        text: "OK: derivado a atención humana. Dile al paciente que el centro se pondrá en contacto con él/ella personalmente.",
        handoffReason: input.reason,
      };
    }

    default:
      return { text: `ERROR: herramienta desconocida "${toolName}".` };
  }
}

/**
 * Estado real y fresco (recién leído de la base de datos en cada turno) del
 * paciente actual: sus citas y listas de espera activas, con fecha/hora ya
 * formateadas en hora local de la clínica. Esto es lo que le da al modelo
 * "memoria" de qué citas existen sin tener que inventarse ni recalcular
 * nada — el `appointment_id`/`waitlist_entry_id` de aquí son los únicos
 * ids válidos para usar en cancel_appointment/confirm_appointment/
 * accept_waitlist_offer sobre ESTE paciente; para hablarle a él, usa
 * siempre el texto ya formateado, nunca el id ni una fecha recalculada.
 */
export async function describePatientState(ctx: AgentContext): Promise<string> {
  const [appointments, waitlist] = await Promise.all([
    listUpcomingAppointments(ctx.patientId),
    listWaitlistForPatient(ctx.patientId),
  ]);

  const apptLines = appointments.length
    ? appointments.map(
        (a) =>
          `- appointment_id=${a.id} · ${serviceLabel(a.service)} · ${formatLong(a.startsAt)} · estado=${a.status}` +
          (a.professional ? ` · profesional=${a.professional.name}` : "")
      )
    : ["(sin citas próximas)"];

  const waitLines = waitlist.length
    ? waitlist.map(
        (w) =>
          `- waitlist_entry_id=${w.id} · ${serviceLabel(w.service)} · estado=${w.status}` +
          (w.offeredSlotStart ? ` · hueco_ofrecido=${formatLong(w.offeredSlotStart)}` : "")
      )
    : ["(sin listas de espera activas)"];

  return [
    "Citas próximas del paciente (usa appointment_id solo para llamar herramientas; para hablarle, usa la fecha ya formateada):",
    ...apptLines,
    "Listas de espera del paciente:",
    ...waitLines,
  ].join("\n");
}
