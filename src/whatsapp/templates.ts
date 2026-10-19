export type TemplateKind = "REMINDER_24H" | "REMINDER_2H" | "CONFIRMATION" | "WAITLIST_OFFER" | "WAITLIST_EXPIRED";

const defaults: Record<TemplateKind, { envName: string; name: string }> = {
  REMINDER_24H: { envName: "WHATSAPP_TEMPLATE_REMINDER_24H", name: "recordatorio_cita_24h" },
  REMINDER_2H: { envName: "WHATSAPP_TEMPLATE_REMINDER_2H", name: "recordatorio_cita_2h" },
  CONFIRMATION: { envName: "WHATSAPP_TEMPLATE_CONFIRMATION", name: "confirmacion_cita" },
  WAITLIST_OFFER: { envName: "WHATSAPP_TEMPLATE_WAITLIST_OFFER", name: "oferta_lista_espera" },
  WAITLIST_EXPIRED: { envName: "WHATSAPP_TEMPLATE_WAITLIST_EXPIRED", name: "oferta_caducada" },
};

export function configuredTemplate(kind: TemplateKind) {
  const name = process.env[defaults[kind].envName] || defaults[kind].name;
  const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "es";
  if (!/^[a-z][a-z0-9_]{0,511}$/.test(name) || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(languageCode)) throw new Error("Configuración de plantilla de WhatsApp inválida.");
  return { name, languageCode };
}
