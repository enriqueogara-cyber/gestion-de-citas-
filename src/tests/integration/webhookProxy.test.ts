import test, { beforeEach, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AddressInfo } from "node:net";
import { app } from "../../index";
import { prisma } from "../../db/client";
import { logger } from "../../lib/logger";
import { cleanTransactionalData } from "./setup";

const { createWebhookProxy } = require("../../../scripts/webhookProxy.js") as {
  createWebhookProxy: (options: { backendPort: number }) => import("node:http").Server;
};

const envNames = ["WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_ALLOWED_TEST_NUMBERS", "WHATSAPP_SEND_ENABLED", "WHATSAPP_INBOUND_PROBE_ENABLED"] as const;
const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
const secret = "proxy-test-secret-only";
const fakePhone = "34900000123";

describe("proxy local dedicado al webhook", () => {
  beforeEach(async () => {
    await cleanTransactionalData();
    process.env.WHATSAPP_APP_SECRET = secret;
    process.env.WHATSAPP_VERIFY_TOKEN = "proxy-test-verify-only";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "proxy-test-number-id";
    process.env.WHATSAPP_ALLOWED_TEST_NUMBERS = fakePhone;
    process.env.WHATSAPP_SEND_ENABLED = "false";
    process.env.WHATSAPP_INBOUND_PROBE_ENABLED = "false";
  });
  after(() => {
    for (const name of envNames) {
      const value = saved[name];
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });

  test("expone solo GET/POST /webhook, preserva el cuerpo y no filtra rutas internas", async () => {
    const backend = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => backend.once("listening", resolve));
    const proxy = createWebhookProxy({ backendPort: (backend.address() as AddressInfo).port });
    proxy.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => proxy.once("listening", resolve));
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      for (const path of ["/", "/health", "/reservar", "/simulator/dashboard", "/simulator/api/operations", "/auth/login", "/webhook/", "/webhook%2F", "/foo/webhook"]) {
        assert.equal((await fetch(url + path)).status, 404, path);
      }
      for (const path of ["/reservar", "/simulator/api/operations", "/auth/login"]) {
        assert.equal((await fetch(url + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404, `POST ${path}`);
      }
      assert.equal((await fetch(url + "/webhook", { method: "PUT" })).status, 405);
      assert.equal((await fetch(url + "/webhook?x=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 404);
      assert.equal((await fetch(url + "/webhook", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
      assert.equal((await fetch(url + "/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(256 * 1024 + 1) })).status, 413);

      const verify = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "proxy-test-verify-only", "hub.challenge": "challenge-ok" });
      const get = await fetch(url + "/webhook?" + verify);
      assert.equal(get.status, 200);
      assert.equal(await get.text(), "challenge-ok");
      verify.set("hub.verify_token", "wrong");
      assert.equal((await fetch(url + "/webhook?" + verify)).status, 403);

      // Whitespace is intentional: reserialization would break the HMAC.
      const raw = Buffer.from('{ "object" : "whatsapp_business_account", "entry" : [{"changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"proxy-test-number-id"},"statuses":[{"id":"wamid.proxy-test","status":"delivered","timestamp":"1760000000"}]}}]}]}');
      const signature = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
      const send = (body: Buffer, sig: string) => fetch(url + "/webhook", { method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body });
      assert.equal((await send(raw, "sha256=invalid")).status, 403);
      assert.equal((await send(Buffer.from(raw.toString().replace("delivered", "read")), signature)).status, 403);
      assert.equal(await prisma.whatsAppStatusEvent.count(), 0);
      assert.equal((await send(raw, signature)).status, 200);
      assert.equal((await send(raw, signature)).status, 200);
      assert.equal(await prisma.whatsAppStatusEvent.count(), 1);

      const inbound = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "proxy-test-number-id" }, messages: [{ id: "wamid.disabled", from: fakePhone, type: "text", timestamp: "1760000000", text: { body: "Hola" } }] } }] }] }));
      const inboundSig = "sha256=" + createHmac("sha256", secret).update(inbound).digest("hex");
      const observed: Array<{ event: string; meta?: Record<string, unknown> }> = [];
      const originalInfo = logger.info;
      logger.info = (event, meta) => { if (event === "whatsapp_test_inbound_received") observed.push({ event, meta }); else originalInfo(event, meta); };
      process.env.WHATSAPP_INBOUND_PROBE_ENABLED = "true";
      try {
        assert.equal((await send(inbound, "sha256=invalid")).status, 403);
        assert.equal((await send(inbound, inboundSig)).status, 200);
        const other = Buffer.from(inbound.toString().replace(fakePhone, "34900000999"));
        const otherSig = "sha256=" + createHmac("sha256", secret).update(other).digest("hex");
        assert.equal((await send(other, otherSig)).status, 200);
        assert.deepEqual(observed, [{ event: "whatsapp_test_inbound_received", meta: { count: 1 } }]);
        assert.equal(await prisma.inboundMessage.count(), 0); // Piloto apagado.
      } finally {
        logger.info = originalInfo;
        process.env.WHATSAPP_INBOUND_PROBE_ENABLED = "false";
      }
    } finally {
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
    }
  });
});
