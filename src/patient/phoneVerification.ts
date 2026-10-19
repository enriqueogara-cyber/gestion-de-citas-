import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db/client";
import { withConversation } from "../lib/conversationLock";

// Delivery is deliberately unconfigured. Tests inject an in-memory provider;
// wiring a real provider requires a separate rollout and privacy review.
export interface PhoneCodeProvider {
  sendCode(phone: string, code: string): Promise<void>;
}
let provider: PhoneCodeProvider | null = null;
export function setPhoneCodeProvider(next: PhoneCodeProvider | null) { provider = next; }

export const phoneSchema = z.string().transform(s => s.replace(/[\s()+-]/g, "")).pipe(z.string().regex(/^[1-9]\d{7,14}$/));
const requestTokenHash = (token: string) => {
  return createHash("sha256").update(z.string().regex(/^[a-f0-9]{64}$/).parse(token)).digest("hex");
};
const codeSchema = z.string().regex(/^\d{6}$/);
const MAX_ATTEMPTS = 5;
const EXPIRES_MS = 10 * 60_000;

export async function requestPhoneCode(token: string, rawPhone: string) {
  const key = requestTokenHash(token), phone = phoneSchema.parse(rawPhone);
  const delivery = provider;
  if (!delivery) throw new Error("La verificación telefónica todavía no está disponible. Contacta con recepción.");
  return withConversation("phone-token:" + key, () => withConversation("phone:" + phone, async () => {
    const now = new Date();
    const existing = await prisma.phoneVerification.findFirst({ where: { tokenHash: key }, orderBy: { createdAt: "desc" } });
    if (existing && existing.expiresAt > now) {
      if (existing.phone !== phone) throw new Error("Esta solicitud está vinculada a otro teléfono. Empieza otra reserva.");
      return { ok: true, expiresAt: existing.expiresAt };
    }
    const recent = await prisma.phoneVerification.findMany({ where: { phone, createdAt: { gte: new Date(now.getTime() - 3600_000) } }, orderBy: { createdAt: "desc" }, take: 3 });
    if (recent.length >= 3 || (recent[0] && now.getTime() - recent[0].createdAt.getTime() < 60_000)) throw new Error("Espera antes de pedir otro código.");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const salt = randomBytes(16).toString("hex");
    const row = await prisma.phoneVerification.create({ data: { tokenHash: key, phone, salt, codeHash: scryptSync(code, salt, 32).toString("hex"), expiresAt: new Date(now.getTime() + EXPIRES_MS) } });
    try { await delivery.sendCode(phone, code); }
    catch { await prisma.phoneVerification.update({ where: { id: row.id }, data: { expiresAt: new Date(0) } }); throw new Error("No se pudo entregar el código. Inténtalo más tarde."); }
    return { ok: true, expiresAt: row.expiresAt };
  }));
}

export async function verifyPhoneCode(token: string, rawCode: string) {
  const key = requestTokenHash(token), code = codeSchema.parse(rawCode);
  return withConversation("verify:" + key, async () => {
    const row = await prisma.phoneVerification.findFirst({ where: { tokenHash: key }, orderBy: { createdAt: "desc" } });
    const now = new Date();
    if (!row || row.expiresAt <= now || row.consumedAt || row.attempts >= MAX_ATTEMPTS) throw new Error("Código caducado o sin intentos. Solicita uno nuevo.");
    const received = scryptSync(code, row.salt, 32);
    if (!timingSafeEqual(received, Buffer.from(row.codeHash, "hex"))) {
      await prisma.phoneVerification.updateMany({ where: { id: row.id, attempts: { lt: MAX_ATTEMPTS }, verifiedAt: null }, data: { attempts: { increment: 1 } } });
      throw new Error("Código incorrecto.");
    }
    if (row.verifiedAt) return { ok: true };
    const changed = await prisma.phoneVerification.updateMany({ where: { id: row.id, attempts: { lt: MAX_ATTEMPTS }, verifiedAt: null, expiresAt: { gt: now } }, data: { verifiedAt: now } });
    if (!changed.count) throw new Error("Código caducado o sin intentos. Solicita uno nuevo.");
    return { ok: true };
  });
}

export async function verifiedChallenge(tokenHash: string, phone: string) {
  const row = await prisma.phoneVerification.findFirst({ where: { tokenHash }, orderBy: { createdAt: "desc" } });
  if (!row || row.phone !== phone || !row.verifiedAt || row.expiresAt <= new Date() || row.consumedAt || row.attempts >= MAX_ATTEMPTS) {
    throw new Error("Verifica este teléfono antes de continuar.");
  }
  return row;
}
