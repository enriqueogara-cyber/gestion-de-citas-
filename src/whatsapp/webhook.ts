import { Router, Request, Response } from "express";
import { env } from "../config";
import { markAsRead, sendText } from "./client";
import { findOrCreatePatient } from "../services/patients";
import { handleIncomingMessage } from "../agent/claude";
import { logger } from "../lib/logger";

export const whatsappWebhookRouter = Router();

// --- Verificación del webhook (Meta la llama una vez al configurar la URL) ---
whatsappWebhookRouter.get("/webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === env.whatsappVerifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// --- Recepción de mensajes ---
whatsappWebhookRouter.post("/webhook", async (req: Request, res: Response) => {
  // Respondemos 200 de inmediato: Meta reintenta si no contestamos rápido,
  // y no queremos duplicados si Claude tarda unos segundos en responder.
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value;
        const messages = value?.messages || [];
        const contacts = value?.contacts || [];

        for (const message of messages) {
          if (message.type !== "text") continue; // MVP: solo texto libre

          const phone: string = message.from; // ya viene en formato E.164 sin "+"
          const text: string = message.text?.body ?? "";
          const contactName: string | undefined = contacts.find(
            (c: any) => c.wa_id === phone
          )?.profile?.name;

          markAsRead(message.id).catch(() => {});

          const patient = await findOrCreatePatient(phone, contactName);
          const result = await handleIncomingMessage(
            { patientId: patient.id, phone: patient.phone, name: patient.name || "" },
            text
          );
          await sendText(phone, result.reply);
        }
      }
    }
  } catch (err) {
    logger.error("whatsapp_webhook_failed", { err });
  }
});
