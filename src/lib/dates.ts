import { DateTime } from "luxon";
import { clinicConfig } from "../config";

/**
 * Formateo de fechas centralizado — todo lo que se le enseña a un humano
 * (paciente en el chat, o el propio LLM al leer un resultado de tool) pasa
 * por aquí. Nunca se le da a nadie una fecha en UTC crudo para que la
 * reinterprete.
 *
 * Bug real que esto arregla: `Date.prototype.toISOString()` SIEMPRE
 * devuelve UTC. Antes de este módulo, el estado del paciente
 * (`describePatientState`) y los resultados de varias tools le pasaban al
 * modelo cosas como `2026-08-24T08:30:00.000Z` para una cita que en
 * realidad es a las 10:30 hora de Madrid — y encima, cerca de medianoche,
 * la fecha en UTC puede caer en un día de calendario distinto al de la
 * clínica. El modelo tenía que "adivinar" la conversión de zona horaria él
 * mismo para poder decir el día de la semana correcto, y a veces fallaba.
 * Con este módulo, el backend calcula siempre la hora/día local de la
 * clínica con Luxon (que sí conoce reglas de horario de verano etc.) y el
 * modelo solo tiene que leerlo y repetirlo.
 */

export function toClinicTime(d: Date | DateTime): DateTime {
  const dt = d instanceof DateTime ? d : DateTime.fromJSDate(d);
  return dt.setZone(clinicConfig.timezone).setLocale("es");
}

/** "lunes 25 de agosto a las 10:30" — para hablarle al paciente o al LLM de un instante concreto. */
export function formatLong(d: Date | DateTime): string {
  return toClinicTime(d).toFormat("cccc d 'de' LLLL 'a las' HH:mm");
}

/** "lunes 25 de agosto" — sin hora. */
export function formatDateOnly(d: Date | DateTime): string {
  return toClinicTime(d).toFormat("cccc d 'de' LLLL");
}

/** "10:30" */
export function formatTimeOnly(d: Date | DateTime): string {
  return toClinicTime(d).toFormat("HH:mm");
}

/** "25 ago, 10:30" — compacto, para tablas (dashboard/agenda/waitlist). */
export function formatShort(d: Date | DateTime): string {
  return toClinicTime(d).toFormat("d LLL, HH:mm");
}

/** "lun 25 ago" — compacto sin hora, para rangos de fecha (waitlist). */
export function formatDayShort(d: Date | DateTime): string {
  return toClinicTime(d).toFormat("ccc d LLL");
}

/** ISO 8601 con el offset de la clínica (para pasarle a las tools como referencia interna, nunca al paciente). */
export function toClinicIso(d: Date | DateTime): string {
  return toClinicTime(d).toISO() ?? "";
}
