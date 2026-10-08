import { prisma } from "../db/client";
import { sendText, sendTemplate } from "../whatsapp/client";
import { logger } from "../lib/logger";

/**
 * Punto único para mandarle un mensaje "proactivo" a un paciente (aviso de
 * hueco liberado, recordatorio, etc.), es decir, uno que no es la respuesta
 * directa del agente a algo que el paciente acaba de escribir.
 *
 * Bug real que arregla esto: antes, services/waitlistOrchestrator.ts y
 * scheduler/reminders.ts llamaban a sendText() directamente, que llama a la
 * API real de WhatsApp. Para los pacientes del simulador (teléfono
 * "demo-<sessionId>") eso siempre fallaba (no hay token real de Meta
 * configurado) y además no tiene sentido: no existe ningún WhatsApp real al
 * que escribirle. El resultado era que todo el flujo de "se libera un
 * hueco -> se avisa a la lista de espera" estaba roto en el simulador antes
 * de esta capa.
 *
 * Con notify(): si el teléfono es de demo, el aviso se guarda como mensaje
 * del asistente en la conversación de ese paciente (así aparece en su chat
 * del simulador, tal cual vería el WhatsApp real). Si es un teléfono real,
 * se manda de verdad por WhatsApp Cloud API.
 */
export async function notifyPatient(patient: { id: string; phone: string }, text: string): Promise<void> {
  if (isDemoPhone(patient.phone)) {
    await prisma.conversationMessage.create({
      data: { patientId: patient.id, role: "assistant", content: text },
    });
    return;
  }

  try {
    await sendText(patient.phone, text);
  } catch (err) {
    // Registramos el fallo (plantilla no aprobada, ventana de 24h cerrada,
    // token caducado...) y lo relanzamos: quien llame decide si es
    // recuperable (los llamantes actuales ya corren dentro de un try/catch
    // que no tumba el flujo principal, ver agent/claude.ts).
    logger.error("whatsapp_send_failed", { phone: patient.phone, err });
    throw err;
  }
}

export function isDemoPhone(phone: string): boolean {
  return phone.startsWith("demo-");
}

/**
 * Igual que notifyPatient pero para avisos que en WhatsApp real tendrían
 * que ir por plantilla aprobada (recordatorio 24h fuera de la ventana de
 * 24h de servicio al cliente). En el simulador no hay plantillas — se
 * manda directamente el texto legible, que es lo que le llegaría al
 * paciente en la práctica.
 */
export async function notifyPatientTemplate(
  patient: { id: string; phone: string },
  readableFallbackText: string,
  template: { name: string; languageCode: string; bodyParams: string[] }
): Promise<void> {
  if (isDemoPhone(patient.phone)) {
    await prisma.conversationMessage.create({
      data: { patientId: patient.id, role: "assistant", content: readableFallbackText },
    });
    return;
  }

  try {
    await sendTemplate(patient.phone, template.name, template.languageCode, template.bodyParams);
  } catch (err) {
    logger.error("whatsapp_template_send_failed", { phone: patient.phone, template: template.name, err });
    throw err;
  }
}
