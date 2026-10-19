import axios from "axios";
import { env } from "../config";

type MetaPost = (url: string, body: Record<string, unknown>) => Promise<unknown>;
let testPost: MetaPost | null = null;

// Only integration tests install this in-memory replacement. No HTTP endpoint
// exposes it, and the default remains the real Meta transport behind a gate.
export function setMetaTransportForTests(post: MetaPost | null) {
  if (post && process.env.NODE_ENV !== "test") throw new Error("El transporte simulado solo se permite en pruebas.");
  testPost = post;
}

export function graphApiVersion() {
  const version = process.env.WHATSAPP_GRAPH_VERSION || "v26.0";
  const match = /^v(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 25) throw new Error("Versión de Meta Graph API no admitida.");
  return version;
}

export function pilotSendLimit() {
  const raw = process.env.WHATSAPP_TEST_SEND_LIMIT;
  const limit = Number(raw);
  if (!raw || !Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("WHATSAPP_TEST_SEND_LIMIT debe estar entre 1 y 5 para la prueba bidireccional.");
  }
  return limit;
}

export function assertPilotTestConfiguration() {
  if (process.env.WHATSAPP_SEND_ENABLED !== "true") return;
  if (process.env.DATABASE_URL !== "file:./test.db") throw new Error("WhatsApp solo puede activarse con prisma/test.db durante el piloto.");
  if (process.env.PUBLIC_BOOKING_ENABLED !== "false") throw new Error("El portal público debe seguir desactivado durante el piloto.");
  const allowed = (process.env.WHATSAPP_ALLOWED_TEST_NUMBERS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (allowed.length !== 1 || !/^[1-9]\d{7,14}$/.test(allowed[0])) throw new Error("El piloto requiere exactamente un número de prueba autorizado.");
  pilotSendLimit();
}

export function assertWhatsAppSendAllowed(phone: string) {
  if (!/^[1-9]\d{7,14}$/.test(phone)) throw new Error("Número de WhatsApp inválido.");
  if (testPost) return;
  assertPilotTestConfiguration();
  if (process.env.WHATSAPP_SEND_ENABLED !== "true" || !isAllowedTestPhone(phone)) {
    throw new Error("Envíos de WhatsApp desactivados o número fuera de la lista de prueba.");
  }
}

export function isAllowedTestPhone(phone: string) {
  return (process.env.WHATSAPP_ALLOWED_TEST_NUMBERS || "").split(",").map(x => x.trim()).includes(phone);
}

export async function postMetaMessage(phone: string, body: Record<string, unknown>): Promise<unknown> {
  assertWhatsAppSendAllowed(phone);
  const numberId = testPost ? (process.env.WHATSAPP_PHONE_NUMBER_ID || "test-number-id") : env.whatsappPhoneNumberId();
  const url = `https://graph.facebook.com/${graphApiVersion()}/${numberId}/messages`;
  if (testPost) return testPost(url, body);
  const response = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${env.whatsappToken()}` }, timeout: 30_000,
  });
  return response.data;
}

export async function postMetaReadReceipt(messageId: string): Promise<void> {
  if (process.env.WHATSAPP_SEND_ENABLED !== "true" && !testPost) throw new Error("Envíos de WhatsApp desactivados.");
  const numberId = testPost ? (process.env.WHATSAPP_PHONE_NUMBER_ID || "test-number-id") : env.whatsappPhoneNumberId();
  const url = `https://graph.facebook.com/${graphApiVersion()}/${numberId}/messages`;
  const body = { messaging_product: "whatsapp", status: "read", message_id: messageId };
  if (testPost) { await testPost(url, body); return; }
  await axios.post(url, body, { headers: { Authorization: `Bearer ${env.whatsappToken()}` }, timeout: 30_000 });
}
