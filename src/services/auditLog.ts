import { prisma } from "../db/client";
import { logger } from "../lib/logger";

/**
 * Rastro de auditoría de los eventos importantes del negocio. Alimenta el
 * "event feed" del dashboard (/simulator/dashboard) y sirve para depurar o
 * demostrar el flujo sin leer logs de servidor.
 *
 * Regla de privacidad (ver README "Privacidad por diseño"): metadata debe
 * ser siempre pequeña y libre de datos clínicos/sensibles — ids, importes,
 * nombres de servicio, nunca el contenido de una conversación ni detalles
 * médicos.
 */
export type AuditEventType =
  | "APPOINTMENT_ARRIVED"
  | "PAYMENT_RECORDED"
  | "HUMAN_HANDOFF_CLAIMED"
  | "HUMAN_HANDOFF_RESOLVED"
  | "HUMAN_REPLY_SENT"
  | "PATIENT_MESSAGE_RECEIVED"
  | "AI_TOOL_CALLED"
  | "AVAILABILITY_CHECKED"
  | "APPOINTMENT_CREATED"
  | "APPOINTMENT_RESCHEDULED"
  | "APPOINTMENT_CONFIRMED"
  | "APPOINTMENT_CANCELLED"
  | "APPOINTMENT_COMPLETED"
  | "APPOINTMENT_NO_SHOW"
  | "WAITLIST_JOINED"
  | "WAITLIST_OFFER_CREATED"
  | "WAITLIST_OFFER_ACCEPTED"
  | "WAITLIST_OFFER_EXPIRED"
  | "SLOT_RECOVERED"
  | "REMINDER_SENT"
  | "CALENDAR_SYNC_FAILED"
  | "HUMAN_HANDOFF_REQUESTED"
  | "AGENT_ERROR"
  // Crítico: un reschedule dejó dos citas activas porque tanto la
  // cancelación de la vieja como la compensación (cancelar la nueva)
  // fallaron. Requiere revisión humana — ver "Necesita atención".
  | "RESCHEDULE_INCONSISTENT"
  // Un job programado (recordatorio, caducidad de oferta) agotó sus
  // reintentos sin éxito — ver scheduler/persistentJobs.ts.
  | "SCHEDULED_JOB_FAILED";

export async function recordEvent(
  type: AuditEventType,
  params: { patientId?: string; appointmentId?: string; metadata?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        type,
        patientId: params.patientId,
        appointmentId: params.appointmentId,
        metadata: JSON.stringify(params.metadata ?? {}),
      },
    });
  } catch (err) {
    // La auditoría nunca debe tumbar el flujo principal: si falla, se
    // registra en logs y seguimos.
    logger.error("audit_log_write_failed", { type, err });
  }
}

export interface AuditEventView {
  id: string;
  type: AuditEventType;
  patientId: string | null;
  appointmentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export async function listRecentEvents(limit = 25): Promise<AuditEventView[]> {
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((r) => ({
    id: r.id,
    type: r.type as AuditEventType,
    patientId: r.patientId,
    appointmentId: r.appointmentId,
    metadata: safeParse(r.metadata),
    createdAt: r.createdAt,
  }));
}


/** Derivaciones y trabajos fallidos se consultan por su estado actual. */
export async function listAttentionItems(hours = 24): Promise<AuditEventView[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await prisma.auditLog.findMany({
    where: { type: { in: ["CALENDAR_SYNC_FAILED", "RESCHEDULE_INCONSISTENT"] }, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  const patients = await prisma.patient.findMany({ where: { aiPaused: true, clinicId: "default" }, take: 20, orderBy: { handoffRequestedAt: "asc" } });
  const jobs = await prisma.scheduledJob.findMany({ where: { status: "FAILED" }, take: 20, orderBy: { updatedAt: "desc" } });
  return [...patients.map(p => ({ id: p.id, type: "HUMAN_HANDOFF_REQUESTED" as AuditEventType, patientId: p.id, appointmentId: null, metadata: { reason: p.handoffReason || "Atención del equipo" }, createdAt: p.handoffRequestedAt || p.createdAt })), ...jobs.map(j => ({ id: j.id, type: "SCHEDULED_JOB_FAILED" as AuditEventType, patientId: null, appointmentId: j.appointmentId, metadata: {}, createdAt: j.updatedAt })), ...rows.map((r) => ({
    id: r.id,
    type: r.type as AuditEventType,
    patientId: r.patientId,
    appointmentId: r.appointmentId,
    metadata: safeParse(r.metadata),
    createdAt: r.createdAt,
  }))];
}

function safeParse(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
