/**
 * Transiciones de estado válidas de una cita. Esto es lo único que decide
 * si un cambio de estado se puede aplicar — nadie debe hacer
 * `prisma.appointment.update({ data: { status: ... } })` a mano sin pasar
 * por aquí, para que sea imposible que (por ejemplo) una cita CANCELLED
 * vuelva "sin querer" a CONFIRMED.
 */
export type AppointmentStatus =
  | "PENDING_CONFIRMATION"
  | "CONFIRMED"
  | "ARRIVED"
  | "CANCELLED"
  | "NO_SHOW"
  | "COMPLETED";

const TRANSITIONS: Record<AppointmentStatus, AppointmentStatus[]> = {
  PENDING_CONFIRMATION: ["CONFIRMED", "ARRIVED", "COMPLETED", "CANCELLED", "NO_SHOW"],
  CONFIRMED: ["ARRIVED", "CANCELLED", "COMPLETED", "NO_SHOW"],
  ARRIVED: ["COMPLETED"],
  CANCELLED: [],
  NO_SHOW: [],
  COMPLETED: [],
};

export class InvalidTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Transición de estado no permitida: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: string, to: AppointmentStatus): void {
  if (!canTransition(from as AppointmentStatus, to)) {
    throw new InvalidTransitionError(from, to);
  }
}
