import { getAllServicesSync } from "../services/serviceCatalog";

/**
 * Traduce ids/slugs internos ("consulta_general") a lo que debe ver un
 * humano ("Consulta general"). Nunca se debe imprimir `Appointment.service`
 * o similar directamente en una pantalla comercial (chat, dashboard,
 * waitlist) — siempre pasa por aquí. El slug interno sigue existiendo y
 * viajando por el código; es solo la fuga hacia la UI lo que se cierra.
 *
 * Busca entre TODOS los servicios (activos e inactivos): una cita antigua
 * de un servicio ya desactivado tiene que seguir mostrando su nombre real,
 * no "servicio desconocido".
 */
export function serviceLabel(serviceId: string): string {
  return getAllServicesSync().find((s) => s.id === serviceId)?.label ?? serviceId;
}

export function servicePriceEur(serviceId: string): number | null {
  return getAllServicesSync().find((s) => s.id === serviceId)?.priceEur ?? null;
}

export const APPOINTMENT_STATUS_LABEL: Record<string, string> = {
  CONFIRMED: "Confirmada",
  PENDING_CONFIRMATION: "Pendiente de confirmar",
  CANCELLED: "Cancelada",
  COMPLETED: "Completada",
  NO_SHOW: "No-show",
};

export const APPOINTMENT_STATUS_BADGE_CLASS: Record<string, string> = {
  CONFIRMED: "badge-confirmed",
  PENDING_CONFIRMATION: "badge-pending",
  CANCELLED: "badge-cancelled",
  COMPLETED: "badge-completed",
  NO_SHOW: "badge-noshow",
};

/**
 * Etiqueta humana para un tipo de evento de auditoría (ver
 * services/auditLog.ts). Compartida entre el dashboard y el panel de
 * estado del chat. Sin emoji decorativo delante de cada una a propósito —
 * ver auditoría visual, punto 58 ("evitar aspecto AI-generated": emoji
 * delante de cada título es justo el patrón a evitar). La jerarquía y el
 * color (severidad) los da el CSS de cada pantalla, no un emoji por tipo.
 */
export const AUDIT_EVENT_LABEL: Record<string, string> = {
  PATIENT_MESSAGE_RECEIVED: "Mensaje recibido",
  AI_TOOL_CALLED: "Acción del agente",
  AVAILABILITY_CHECKED: "Consultó disponibilidad",
  APPOINTMENT_CREATED: "Cita creada",
  APPOINTMENT_RESCHEDULED: "Cita cambiada de fecha",
  APPOINTMENT_CONFIRMED: "Cita confirmada",
  APPOINTMENT_CANCELLED: "Cita cancelada",
  APPOINTMENT_COMPLETED: "Cita completada",
  APPOINTMENT_NO_SHOW: "No-show",
  WAITLIST_JOINED: "Apuntado a lista de espera",
  WAITLIST_OFFER_CREATED: "Oferta enviada a lista de espera",
  WAITLIST_OFFER_ACCEPTED: "Oferta aceptada",
  WAITLIST_OFFER_EXPIRED: "Oferta caducada",
  SLOT_RECOVERED: "Hueco recuperado",
  REMINDER_SENT: "Recordatorio enviado",
  CALENDAR_SYNC_FAILED: "Fallo sincronizando calendario",
  HUMAN_HANDOFF_REQUESTED: "Derivado a atención humana",
  RESCHEDULE_INCONSISTENT: "Reschedule requiere revisión manual",
  SCHEDULED_JOB_FAILED: "Job programado fallido",
  AGENT_ERROR: "Error del agente",
};
