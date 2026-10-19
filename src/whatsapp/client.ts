import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";
import { sendTracked } from "./outbound";
import { postMetaReadReceipt } from "./transport";

// Use Meta's message timestamp, not webhook receipt time. A five-minute
// margin avoids sending text at the exact edge of the 24-hour window.
export async function isCustomerServiceWindowOpen(phone: string, now = new Date()) {
  const latest = await prisma.inboundMessage.findFirst({
    where: { phone, sentAt: { gte: new Date(now.getTime() - 23 * 3600_000 - 55 * 60_000), lte: new Date(now.getTime() + 5 * 60_000) } },
    orderBy: { sentAt: "desc" }, select: { id: true },
  });
  return !!latest;
}

export async function sendText(toPhoneE164: string, body: string, key = `adhoc:${randomUUID()}`) {
  if (!(await isCustomerServiceWindowOpen(toPhoneE164))) throw new Error("Ventana de atención cerrada; se requiere una plantilla aprobada.");
  return sendTracked(toPhoneE164, "text", key, {
    messaging_product: "whatsapp", to: toPhoneE164, type: "text", text: { body, preview_url: false },
  });
}

export async function sendTemplate(toPhoneE164: string, templateName: string, languageCode: string, bodyParams: string[], key = `adhoc:${randomUUID()}`) {
  return sendTracked(toPhoneE164, "template", key, {
    messaging_product: "whatsapp", to: toPhoneE164, type: "template",
    template: { name: templateName, language: { code: languageCode }, ...(bodyParams.length ? { components: [{ type: "body", parameters: bodyParams.map(text => ({ type: "text", text })) }] } : {}) },
  });
}

export async function markAsRead(messageId: string) { await postMetaReadReceipt(messageId); }
