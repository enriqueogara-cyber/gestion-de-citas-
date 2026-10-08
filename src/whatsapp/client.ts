import axios from "axios";
import { env } from "../config";

const GRAPH_VERSION = "v20.0";

function apiUrl(path: string) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

function authHeaders() {
  return { Authorization: `Bearer ${env.whatsappToken()}` };
}

/**
 * Envía un mensaje de texto libre. Solo funciona dentro de la ventana de
 * 24h desde el último mensaje del paciente (política de Meta). Para avisos
 * fuera de esa ventana (p.ej. recordatorio 24h antes de una cita si el
 * paciente lleva días sin escribir) hay que usar sendTemplate con una
 * plantilla aprobada por Meta.
 */
export async function sendText(toPhoneE164: string, body: string): Promise<void> {
  await axios.post(
    apiUrl(`${env.whatsappPhoneNumberId()}/messages`),
    {
      messaging_product: "whatsapp",
      to: toPhoneE164,
      type: "text",
      text: { body, preview_url: false },
    },
    { headers: authHeaders(), timeout: 30_000 }
  );
}

/**
 * Envía un mensaje de plantilla previamente aprobada en Meta Business
 * Manager (necesario para iniciar conversación fuera de la ventana de 24h:
 * recordatorios de cita, avisos de hueco liberado, etc.)
 *
 * Ejemplo de plantilla a crear en Meta:
 *   name: "recordatorio_cita_24h"
 *   body: "Hola {{1}}, te recordamos tu cita de {{2}} el {{3}} a las {{4}}.
 *          Responde SI para confirmar o NO para cancelar."
 */
export async function sendTemplate(
  toPhoneE164: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[]
): Promise<void> {
  await axios.post(
    apiUrl(`${env.whatsappPhoneNumberId()}/messages`),
    {
      messaging_product: "whatsapp",
      to: toPhoneE164,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "body",
            parameters: bodyParams.map((text) => ({ type: "text", text })),
          },
        ],
      },
    },
    { headers: authHeaders(), timeout: 30_000 }
  );
}

/** Marca un mensaje entrante como leído (doble check azul). */
export async function markAsRead(messageId: string): Promise<void> {
  await axios.post(
    apiUrl(`${env.whatsappPhoneNumberId()}/messages`),
    {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    },
    { headers: authHeaders(), timeout: 30_000 }
  );
}
