import { createHash } from "node:crypto";
import { prisma } from "../db/client";
import { assertWhatsAppSendAllowed, pilotSendLimit, postMetaMessage } from "./transport";
import { logger } from "../lib/logger";

export type MetaDeliveryStatus = "sent" | "delivered" | "read" | "failed";
const statusMap: Record<MetaDeliveryStatus, string> = { sent: "SENT", delivered: "DELIVERED", read: "READ", failed: "FAILED" };
const rank: Record<MetaDeliveryStatus, number> = { sent: 1, failed: 2, delivered: 3, read: 4 };

export class MetaSendError extends Error {
  constructor(public outcome: "unknown" | "rejected", public code?: string) {
    super(outcome === "unknown" ? "Resultado del envío desconocido; requiere revisión, no se reenvía automáticamente." : "Meta rechazó el mensaje; requiere revisión.");
    this.name = "MetaSendError";
  }
}

export class PilotSendLimitError extends Error {
  constructor() {
    super("Cupo de envíos de la prueba agotado; revisar antes de continuar.");
    this.name = "PilotSendLimitError";
  }
}

export async function pilotSendLimitReached() {
  if (process.env.WHATSAPP_SEND_ENABLED !== "true") return false;
  return (await prisma.whatsAppOutbound.count()) >= pilotSendLimit();
}

function providerError(error: unknown) {
  const response = (error as { response?: { status?: number; data?: { error?: { code?: number } } } })?.response;
  const status = response?.status;
  const code = response?.data?.error?.code;
  return { outcome: status && status >= 400 && status < 500 && status !== 429 ? "rejected" as const : "unknown" as const,
    code: typeof code === "number" ? String(code) : undefined };
}

function payloadDigest(payload: Record<string, unknown>) { return createHash("sha256").update(JSON.stringify(payload)).digest("hex"); }

export async function sendTracked(phone: string, kind: "text" | "template", key: string, payload: Record<string, unknown>) {
  assertWhatsAppSendAllowed(phone);
  if (!key || key.length > 200) throw new Error("Clave de envío inválida.");
  const payloadHash = payloadDigest(payload);
  let row;
  try {
    row = await prisma.$transaction(async tx => {
      const created = await tx.whatsAppOutbound.create({ data: { idempotencyKey: key, payloadHash, phone, kind, status: "SENDING" } });
      if (process.env.WHATSAPP_SEND_ENABLED === "true" && await tx.whatsAppOutbound.count() > pilotSendLimit()) throw new PilotSendLimitError();
      return created;
    });
  } catch (error) {
    const existing = await prisma.whatsAppOutbound.findUnique({ where: { idempotencyKey: key } });
    if (!existing) {
      if (error instanceof PilotSendLimitError) logger.warn("whatsapp_pilot_send_limit_reached");
      throw error;
    }
    if (existing.phone !== phone || existing.kind !== kind || existing.payloadHash !== payloadHash) throw new Error("Clave de envío reutilizada con otro mensaje.");
    if (["ACCEPTED", "SENT", "DELIVERED", "READ"].includes(existing.status)) return existing;
    if (existing.status === "REJECTED") throw new MetaSendError("rejected", existing.errorCode || undefined);
    throw new MetaSendError("unknown", existing.errorCode || undefined);
  }

  let response: unknown;
  try {
    response = await postMetaMessage(phone, payload);
  } catch (error) {
    const classified = providerError(error);
    await prisma.whatsAppOutbound.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: classified.outcome === "rejected" ? "REJECTED" : "UNKNOWN", errorCode: classified.code } });
    logger.warn("whatsapp_provider_send_failed", { outcome: classified.outcome, ...(classified.code ? { code: classified.code } : {}) });
    throw new MetaSendError(classified.outcome, classified.code);
  }
  const providerMessageId = (response as { messages?: Array<{ id?: unknown }> })?.messages?.[0]?.id;
  if (typeof providerMessageId !== "string" || !providerMessageId) {
    await prisma.whatsAppOutbound.updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "UNKNOWN" } });
    logger.warn("whatsapp_provider_send_failed", { outcome: "unknown" });
    throw new MetaSendError("unknown");
  }
  row = await prisma.whatsAppOutbound.update({ where: { id: row.id }, data: { status: "ACCEPTED", providerMessageId, acceptedAt: new Date() } });
  await reconcileMetaStatus(providerMessageId);
  return prisma.whatsAppOutbound.findUniqueOrThrow({ where: { id: row.id } });
}

export async function recordMetaStatus(event: { providerMessageId: string; status: MetaDeliveryStatus; occurredAt: Date; errorCode?: string }) {
  if (!event.providerMessageId || !statusMap[event.status] || !Number.isFinite(event.occurredAt.getTime())) throw new Error("Estado de Meta inválido.");
  try { await prisma.whatsAppStatusEvent.create({ data: event }); }
  catch (error) { if ((error as { code?: string }).code !== "P2002") throw error; }
  await reconcileMetaStatus(event.providerMessageId);
}

export async function reconcileMetaStatus(providerMessageId: string) {
  const outbound = await prisma.whatsAppOutbound.findUnique({ where: { providerMessageId } });
  if (!outbound) return;
  const events = await prisma.whatsAppStatusEvent.findMany({ where: { providerMessageId }, orderBy: { occurredAt: "asc" } });
  if (!events.length) return;
  const latest = events.reduce((selected, event) => {
    if (event.occurredAt > selected.occurredAt) return event;
    if (event.occurredAt.getTime() === selected.occurredAt.getTime() && rank[event.status as MetaDeliveryStatus] > rank[selected.status as MetaDeliveryStatus]) return event;
    return selected;
  });
  await prisma.whatsAppOutbound.updateMany({
    where: { id: outbound.id, OR: [{ statusAt: null }, { statusAt: { lte: latest.occurredAt } }] },
    data: { status: statusMap[latest.status as MetaDeliveryStatus], statusAt: latest.occurredAt, errorCode: latest.status === "failed" ? latest.errorCode : null },
  });
}

// A process crash or a timeout can leave a send in SENDING. Never resend it
// automatically: the request may have reached Meta before the crash.
export async function markStaleMetaSendsUnknown() {
  return prisma.whatsAppOutbound.updateMany({ where: { status: "SENDING", updatedAt: { lt: new Date(Date.now() - 2 * 60_000) } }, data: { status: "UNKNOWN" } });
}
