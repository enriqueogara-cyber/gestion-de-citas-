import { Router } from "express";
import { env } from "../config";
import { validWebhookSignature } from "../services/staffAuth";
import { enqueueMessage, processInbox } from "./inbox";
import { logger } from "../lib/logger";
export const whatsappWebhookRouter = Router();
whatsappWebhookRouter.get("/webhook", (req, res) => {
  if (env.whatsappVerifyToken && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === env.whatsappVerifyToken) res.status(200).send(req.query["hub.challenge"]);
  else res.sendStatus(403);
});
whatsappWebhookRouter.post("/webhook", async (req, res, next) => {
  const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
  if (!raw || !validWebhookSignature(raw, req.get("X-Hub-Signature-256"), process.env.WHATSAPP_APP_SECRET || "")) { res.sendStatus(403); return; }
  try {
    for (const entry of req.body?.entry || []) for (const change of entry.changes || []) {
      const value = change.value;
      for (const message of value?.messages || []) {
        if (message.type !== "text") continue;
        if (typeof message.id !== "string" || !/^\d{7,15}$/.test(message.from) || typeof message.text?.body !== "string") { res.sendStatus(400); return; }
        await enqueueMessage({ id: message.id, phone: message.from, name: value.contacts?.find((c: any) => c.wa_id === message.from)?.profile?.name, text: message.text.body });
      }
    }
    res.sendStatus(200);
    void processInbox().catch(() => logger.error("inbox_tick_failed"));
  } catch (err) { next(err); }
});
