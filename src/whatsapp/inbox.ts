import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { findOrCreatePatient } from "../services/patients";
import { handleIncomingMessage } from "../agent/claude";
import { sendText } from "./client";
import { logger } from "../lib/logger";
export async function enqueueMessage(message: { id: string; phone: string; name?: string; text: string }) {
  await prisma.inboundMessage.upsert({ where: { id: message.id }, update: {}, create: message });
}
let running = false;
export async function processInbox() {
  if (running) return; running = true;
  try {
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
          generated = (await handleIncomingMessage({ patientId: patient.id, phone: patient.phone, name: patient.name || "" }, row.text)).reply;
          await prisma.inboundMessage.updateMany({ where: { id: row.id, claimToken: token }, data: { reply: generated } });
        }
        if (generated) await sendText(row.phone, generated);
        await prisma.inboundMessage.updateMany({ where: { id: row.id, claimToken: token }, data: { status: "COMPLETED", claimToken: null, lastError: null } });
      } catch {
        logger.error("inbox_processing_failed", { id: row.id });
        await prisma.inboundMessage.updateMany({ where: { id: row.id, claimToken: token }, data: { status: generated === null || row.attempts >= 4 ? "FAILED" : "PENDING", claimToken: null, lastError: "No se pudo procesar o entregar el mensaje.", nextAttemptAt: new Date(Date.now() + 60_000 * (row.attempts + 1)) } });
      }
    }
  } finally { running = false; }
}
