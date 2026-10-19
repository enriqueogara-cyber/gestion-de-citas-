import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { findOrCreatePatient } from "../services/patients";
import { handleIncomingMessage } from "../agent/claude";
import { sendText } from "./client";
import { markStaleMetaSendsUnknown, MetaSendError } from "./outbound";
import { logger } from "../lib/logger";
export async function enqueueMessage(message: { id: string; phone: string; name?: string; text: string; sentAt?: Date }) {
  await prisma.inboundMessage.upsert({ where: { id: message.id }, update: {}, create: message });
}
let running = false;
export async function processInbox() {
  if (running) return; running = true;
  try {
    await markStaleMetaSendsUnknown();
    // Do not blindly rerun agent actions interrupted before the reply was persisted.
    const stale = await prisma.inboundMessage.findMany({ where: { status: "PROCESSING", lastAttemptAt: { lt: new Date(Date.now() - 10 * 60_000) } } });
    for (const row of stale) await prisma.inboundMessage.updateMany({ where: { id: row.id, status: "PROCESSING", claimToken: row.claimToken }, data: { status: row.reply !== null ? "PENDING" : "FAILED", claimToken: null, lastError: row.reply !== null ? null : "Procesamiento interrumpido; revisar antes de reintentar." } });
    const due = await prisma.inboundMessage.findMany({ where: { status: "PENDING", nextAttemptAt: { lte: new Date() } }, orderBy: { createdAt: "asc" }, take: 50 });
    for (const row of due) {
      const token = randomUUID();
      const claim = await prisma.inboundMessage.updateMany({ where: { id: row.id, status: "PENDING" }, data: { status: "PROCESSING", claimToken: token, lastAttemptAt: new Date(), attempts: { increment: 1 } } });
      if (!claim.count) continue;
      let generated = row.reply;
      try {
        if (generated === null) {
          const patient = await findOrCreatePatient(row.phone, row.name || undefined);
          generated = (await handleIncomingMessage({ patientId: patient.id, phone: patient.phone, name: patient.name || "", identitySource: "signed_whatsapp" }, row.text)).reply;
          await prisma.inboundMessage.updateMany({ where: { id: row.id, claimToken: token }, data: { reply: generated } });
        }
        if (generated) await sendText(row.phone, generated, `inbox:${row.id}`);
        // COMPLETED means the reply was accepted by Meta (or no reply was
        // needed). Delivery is tracked separately by signed status webhooks.
        await prisma.inboundMessage.updateMany({ where: { id: row.id, claimToken: token }, data: { status: "COMPLETED", claimToken: null, lastError: null } });
      } catch (error) {
        logger.error("inbox_processing_failed", { id: row.id });
        const providerOutcome = error instanceof MetaSendError ? error.outcome : null;
        await prisma.inboundMessage.updateMany({ where: { id: row.id, claimToken: token }, data: { status: generated === null || providerOutcome || row.attempts >= 4 ? "FAILED" : "PENDING", claimToken: null, lastError: providerOutcome === "unknown" ? "Resultado de Meta desconocido; revisar antes de reenviar." : "No se pudo procesar o aceptar el mensaje.", nextAttemptAt: new Date(Date.now() + 60_000 * (row.attempts + 1)) } });
      }
    }
  } finally { running = false; }
}
