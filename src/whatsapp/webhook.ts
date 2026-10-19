import { Router } from "express";
import { validWebhookSignature } from "../services/staffAuth";
import { enqueueMessage, processInbox } from "./inbox";
import { logger } from "../lib/logger";
import { recordMetaStatus, MetaDeliveryStatus } from "./outbound";
import { isAllowedTestPhone } from "./transport";
export const whatsappWebhookRouter = Router();
whatsappWebhookRouter.get("/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (verifyToken && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken) res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});
whatsappWebhookRouter.post("/webhook", async (req, res, next) => {
  const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!raw || !validWebhookSignature(raw, req.get("X-Hub-Signature-256"), process.env.WHATSAPP_APP_SECRET || "")) { res.sendStatus(403); return; }
  try {
    if (req.body?.object !== "whatsapp_business_account" || !Array.isArray(req.body.entry)) { res.sendStatus(400); return; }
    let hasNewInbound = false;
    for (const entry of req.body?.entry || []) for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!process.env.WHATSAPP_PHONE_NUMBER_ID || value?.metadata?.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID) continue;
      for (const message of value?.messages || []) {
        if (message.type !== "text") continue;
        const sentAt = new Date(Number(message.timestamp) * 1000);
        if (typeof message.id !== "string" || !/^\d{7,15}$/.test(message.from) || typeof message.text?.body !== "string" || !Number.isFinite(sentAt.getTime())) { res.sendStatus(400); return; }
        if (process.env.WHATSAPP_SEND_ENABLED !== "true" || !isAllowedTestPhone(message.from)) continue;
        await enqueueMessage({ id: message.id, phone: message.from, name: value.contacts?.find((c: any) => c.wa_id === message.from)?.profile?.name, text: message.text.body, sentAt });
        hasNewInbound = true;
      }
      for (const status of value?.statuses || []) {
        if (!["sent", "delivered", "read", "failed"].includes(status.status)) continue;
        const occurredAt = new Date(Number(status.timestamp) * 1000);
        if (typeof status.id !== "string" || !Number.isFinite(occurredAt.getTime())) { res.sendStatus(400); return; }
        const code = status.status === "failed" && typeof status.errors?.[0]?.code === "number" ? String(status.errors[0].code) : undefined;
        await recordMetaStatus({ providerMessageId: status.id, status: status.status as MetaDeliveryStatus, occurredAt, errorCode: code });
      }
    }
    res.sendStatus(200);
    if (hasNewInbound) void processInbox().catch(() => logger.error("inbox_tick_failed"));
  } catch (err) { next(err); }
});
