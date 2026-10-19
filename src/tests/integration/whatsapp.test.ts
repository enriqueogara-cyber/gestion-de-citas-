import test, { before, beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { app } from "../../index";
import { prisma } from "../../db/client";
import { cleanTransactionalData } from "./setup";
import { sendTemplate, sendText } from "../../whatsapp/client";
import { enqueueMessage, processInbox } from "../../whatsapp/inbox";
import { MetaSendError, markStaleMetaSendsUnknown, recordMetaStatus } from "../../whatsapp/outbound";
import { graphApiVersion, setMetaTransportForTests } from "../../whatsapp/transport";
import { configuredTemplate } from "../../whatsapp/templates";
import { DateTime } from "luxon";
import { ensureCatalogReady } from "./setup";
import { handleWaitlistOfferExpiredJob, offerFreedSlot } from "../../services/waitlistOrchestrator";

const phone = "34900000123"; // Ficticio; el transporte simulado nunca hace HTTP externo.
const original = {
  secret: process.env.WHATSAPP_APP_SECRET, numberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
  allowlist: process.env.WHATSAPP_ALLOWED_TEST_NUMBERS, enabled: process.env.WHATSAPP_SEND_ENABLED,
  version: process.env.WHATSAPP_GRAPH_VERSION,
};
let calls: Array<{ url: string; body: Record<string, unknown> }> = [];

describe("WhatsApp Cloud API simulada", () => {
  before(ensureCatalogReady);
  beforeEach(async () => {
    await cleanTransactionalData();
    calls = [];
    process.env.WHATSAPP_APP_SECRET = "test-secret-not-real";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "test-number-id";
    process.env.WHATSAPP_ALLOWED_TEST_NUMBERS = phone;
    process.env.WHATSAPP_SEND_ENABLED = "false";
    delete process.env.WHATSAPP_GRAPH_VERSION;
    setMetaTransportForTests(async (url, body) => { calls.push({ url, body }); return { messages: [{ id: `wamid.mock-${calls.length}` }] }; });
  });
  after(() => {
    setMetaTransportForTests(null);
    for (const [name, value] of Object.entries({
      WHATSAPP_APP_SECRET: original.secret, WHATSAPP_PHONE_NUMBER_ID: original.numberId,
      WHATSAPP_ALLOWED_TEST_NUMBERS: original.allowlist, WHATSAPP_SEND_ENABLED: original.enabled,
      WHATSAPP_GRAPH_VERSION: original.version,
    })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  });

  test("versión vigente configurable y aceptación HTTP separada de entrega", async () => {
    assert.equal(graphApiVersion(), "v26.0");
    process.env.WHATSAPP_GRAPH_VERSION = "v20.0";
    assert.throws(() => graphApiVersion(), /Versión/);
    delete process.env.WHATSAPP_GRAPH_VERSION;
    const first = await sendTemplate(phone, "recordatorio_cita_24h", "es", ["martes 10:00"], "reminder:one");
    assert.equal(first.status, "ACCEPTED");
    assert.ok(first.acceptedAt);
    assert.equal(first.statusAt, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v26\.0\/test-number-id\/messages$/);
    assert.equal((await sendTemplate(phone, "recordatorio_cita_24h", "es", ["martes 10:00"], "reminder:one")).id, first.id);
    assert.equal(calls.length, 1);
    await assert.rejects(() => sendTemplate(phone, "recordatorio_cita_24h", "es", ["miércoles"], "reminder:one"), /Clave de envío/);
  });

  test("estados firmados se persisten, deduplican y respetan el orden temporal", async () => {
    const row = await sendTemplate(phone, "recordatorio_cita_24h", "es", ["martes"], "reminder:status");
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (status: string, timestamp: number, valid = true, code?: number) => {
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "test-number-id" }, statuses: [{ id: row.providerMessageId, status, timestamp: String(timestamp), ...(code ? { errors: [{ code }] } : {}) }] } }] }] });
      const signature = "sha256=" + createHmac("sha256", "test-secret-not-real").update(body).digest("hex");
      return fetch(base + "/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": valid ? signature : "sha256=invalid" }, body });
    };
    try {
      assert.equal((await post("sent", 1000, false)).status, 403);
      assert.equal(await prisma.whatsAppStatusEvent.count(), 0);
      for (const [status, time] of [["sent", 1000], ["delivered", 1001], ["read", 1002]] as const) {
        assert.equal((await post(status, time)).status, 200);
        assert.equal((await prisma.whatsAppOutbound.findUniqueOrThrow({ where: { id: row.id } })).status, status.toUpperCase());
      }
      assert.equal((await post("delivered", 1001)).status, 200);
      assert.equal(await prisma.whatsAppStatusEvent.count(), 3);
      assert.equal((await post("failed", 999, true, 131026)).status, 200);
      assert.equal((await prisma.whatsAppOutbound.findUniqueOrThrow({ where: { id: row.id } })).status, "READ");
      assert.equal(await prisma.whatsAppStatusEvent.count(), 4);
    } finally { await new Promise<void>((r, reject) => server.close(err => err ? reject(err) : r())); }
  });

  test("un fallo firmado queda FAILED sin borrar la aceptación previa", async () => {
    const row = await sendTemplate(phone, "oferta_lista_espera", "es", ["martes", "20"], "offer:failed");
    await recordMetaStatus({ providerMessageId: row.providerMessageId!, status: "failed", occurredAt: new Date(), errorCode: "131026" });
    const failed = await prisma.whatsAppOutbound.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(failed.status, "FAILED"); assert.ok(failed.acceptedAt); assert.equal(failed.errorCode, "131026");
    await assert.rejects(() => sendTemplate(phone, "oferta_lista_espera", "es", ["martes", "20"], "offer:failed"), (err: unknown) => err instanceof MetaSendError && err.outcome === "unknown");
    assert.equal(calls.length, 1);
  });

  test("un estado adelantado a la respuesta HTTP se reconcilia sin perderse", async () => {
    setMetaTransportForTests(async () => {
      await recordMetaStatus({ providerMessageId: "wamid.early", status: "delivered", occurredAt: new Date() });
      return { messages: [{ id: "wamid.early" }] };
    });
    const row = await sendTemplate(phone, "confirmacion_cita", "es", ["martes"], "early:status");
    assert.equal(row.status, "DELIVERED");
    assert.ok(row.acceptedAt);
    assert.equal(await prisma.whatsAppStatusEvent.count(), 1);
  });

  test("webhook firmado guarda una entrada una sola vez y descarta teléfonos ajenos", async () => {
    await prisma.patient.create({ data: { phone, name: "Paciente ficticio", aiPaused: true } });
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (from: string, id: string) => {
      const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "test-number-id" }, messages: [{ id, from, type: "text", timestamp: String(Math.floor(Date.now() / 1000)), text: { body: "Hola" } }] } }] }] });
      const signature = "sha256=" + createHmac("sha256", "test-secret-not-real").update(body).digest("hex");
      return fetch(base + "/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature }, body });
    };
    try {
      assert.equal((await post(phone, "wamid.disabled-test")).status, 200);
      assert.equal(await prisma.inboundMessage.count(), 0);
      process.env.WHATSAPP_SEND_ENABLED = "true"; // Solo transporte simulado instalado; no sale HTTP externo.
      assert.equal((await post(phone, "wamid.inbound-test")).status, 200);
      assert.equal((await post(phone, "wamid.inbound-test")).status, 200);
      assert.equal((await post("34900000999", "wamid.other")).status, 200);
      await processInbox();
      assert.equal(await prisma.inboundMessage.count(), 1);
      let row = await prisma.inboundMessage.findUniqueOrThrow({ where: { id: "wamid.inbound-test" } });
      for (let attempt = 0; attempt < 30 && row.status !== "COMPLETED"; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 20));
        row = await prisma.inboundMessage.findUniqueOrThrow({ where: { id: "wamid.inbound-test" } });
      }
      assert.ok(row.sentAt);
      assert.equal(row.status, "COMPLETED");
      assert.equal(calls.length, 0);
    } finally { await new Promise<void>((r, reject) => server.close(err => err ? reject(err) : r())); }
  });

  test("timeout, HTTP 5xx y respuesta sin id quedan UNKNOWN; reintentar no duplica", async () => {
    for (const failure of ["timeout", "server", "missing-id"]) {
      setMetaTransportForTests(async () => {
        calls.push({ url: failure, body: {} });
        if (failure === "timeout") throw new Error("simulated timeout");
        if (failure === "server") throw { response: { status: 503 } };
        return { messages: [] };
      });
      const key = `ambiguous:${failure}`;
      await assert.rejects(() => sendTemplate(phone, "recordatorio_cita_2h", "es", ["12:00"], key), (err: unknown) => err instanceof MetaSendError && err.outcome === "unknown");
      const count = calls.length;
      await assert.rejects(() => sendTemplate(phone, "recordatorio_cita_2h", "es", ["12:00"], key), MetaSendError);
      assert.equal(calls.length, count);
      assert.equal((await prisma.whatsAppOutbound.findUniqueOrThrow({ where: { idempotencyKey: key } })).status, "UNKNOWN");
    }
  });

  test("HTTP 400 queda REJECTED y un SENDING interrumpido se recupera como UNKNOWN", async () => {
    setMetaTransportForTests(async () => { calls.push({ url: "400", body: {} }); throw { response: { status: 400, data: { error: { code: 132001 } } } }; });
    await assert.rejects(() => sendTemplate(phone, "plantilla", "es", [], "rejected:key"), (err: unknown) => err instanceof MetaSendError && err.outcome === "rejected");
    assert.equal((await prisma.whatsAppOutbound.findUniqueOrThrow({ where: { idempotencyKey: "rejected:key" } })).errorCode, "132001");
    const stale = await prisma.whatsAppOutbound.create({ data: { idempotencyKey: "stale:key", payloadHash: "hash", phone, kind: "template", status: "SENDING", updatedAt: new Date(Date.now() - 180_000) } });
    await markStaleMetaSendsUnknown();
    assert.equal((await prisma.whatsAppOutbound.findUniqueOrThrow({ where: { id: stale.id } })).status, "UNKNOWN");
  });

  test("la ventana de 24h exige un mensaje entrante real; la plantilla no", async () => {
    await assert.rejects(() => sendText(phone, "Hola", "text:closed"), /Ventana/);
    await enqueueMessage({ id: "wamid.old", phone, text: "Hola", sentAt: new Date(Date.now() - 25 * 3600_000) });
    await assert.rejects(() => sendText(phone, "Hola", "text:old"), /Ventana/);
    await enqueueMessage({ id: "wamid.current", phone, text: "Hola", sentAt: new Date() });
    assert.equal((await sendText(phone, "Hola", "text:open")).status, "ACCEPTED");
    assert.equal((await sendTemplate(phone, "oferta_caducada", "es", [], "template:empty")).status, "ACCEPTED");
    assert.equal((calls.at(-1)!.body.template as Record<string, unknown>).components, undefined);
    assert.equal(configuredTemplate("WAITLIST_OFFER").name, "oferta_lista_espera");
  });

  test("sin activación ni lista blanca no puede salir tráfico real", async () => {
    setMetaTransportForTests(null);
    await assert.rejects(() => sendTemplate(phone, "recordatorio_cita_24h", "es", ["martes"], "blocked:key"), /desactivados/);
    assert.equal(await prisma.whatsAppOutbound.count(), 0);
  });

  test("oferta y caducidad de lista de espera usan plantillas sin datos del servicio", async () => {
    const patient = await prisma.patient.create({ data: { phone, name: "Paciente ficticio" } });
    let slot = DateTime.now().setZone("Europe/Madrid").plus({ days: 2 }).startOf("day").set({ hour: 10 });
    while (slot.weekday !== 2) slot = slot.plus({ days: 1 });
    const entry = await prisma.waitlistEntry.create({ data: { patientId: patient.id, service: "revision", earliestDate: slot.startOf("day").toJSDate(), latestDate: slot.endOf("day").toJSDate(), status: "WAITING" } });
    assert.equal(await offerFreedSlot("revision", slot), true);
    assert.equal(calls.length, 1);
    const first = calls[0].body.template as { name: string; components: Array<{ parameters: Array<{ text: string }> }> };
    assert.equal(first.name, "oferta_lista_espera");
    assert.equal(first.components[0].parameters.length, 2);
    assert.ok(!JSON.stringify(first).includes("revision"));
    await handleWaitlistOfferExpiredJob(entry.id);
    assert.equal(calls.length, 2);
    assert.equal((calls[1].body.template as { name: string }).name, "oferta_caducada");
    assert.equal(await prisma.slotHold.count(), 0);
  });
});
