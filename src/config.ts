import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Falta la variable de entorno ${name} (revisa tu .env)`);
  return v;
}

// --- Configuración del centro ---
// Esto es lo único que cambia entre una clínica dental, un fisio, un centro
// de estética o una peluquería: los servicios, la duración de cada uno y el
// horario de apertura. Todo lo demás (agente, recordatorios, lista de espera)
// es igual para cualquier vertical.
export interface ServiceDef {
  id: string;
  label: string;
  durationMinutes: number;
  // Precio orientativo en euros. Opcional: si no se pone, el servicio sigue
  // funcionando igual, solo que no contribuye al KPI de "ingresos
  // recuperados" del dashboard (ver src/services/reportingService.ts).
  priceEur?: number;
  // Ids de ResourceDef que este servicio puede necesitar (gabinete, máquina
  // láser, cabina...). Es solo un enganche preparado para el futuro: hoy
  // ningún servicio del seed lo usa y no hay reserva de recursos todavía
  // (ver ResourceDef más abajo y el punto 6 de la auditoría en README).
  resourceIds?: string[];
}

// Recurso físico compartido que un servicio puede necesitar además de un
// profesional (un gabinete, una máquina de láser, una cabina de estética...).
// De momento es solo una interfaz + lista de ejemplo: no hay motor de
// reservas de recursos todavía. Implementarlo de verdad implicaría cruzar
// disponibilidad de recurso además de la de profesional/calendario, lo cual
// para un MVP de un único centro añade complejidad sin aportar demo value
// todavía; se deja modelado para cuando haga falta.
export interface ResourceDef {
  id: string;
  label: string;
}

export const clinicConfig = {
  name: process.env.CLINIC_NAME || "Clínica Ejemplo",
  timezone: process.env.CLINIC_TIMEZONE || "Europe/Madrid",

  // --- Identidad visual (opcional) ---
  // Estos 3 campos + name/timezone son solo los valores por defecto con los
  // que se siembra la fila `Clinic` en base de datos la primera vez que
  // arranca (ver src/services/clinicSettings.ts). A partir de ahí, la
  // fuente de verdad es la DB y se puede editar en caliente desde
  // /simulator/settings sin tocar .env ni reiniciar el servidor.
  brandColor: process.env.CLINIC_BRAND_COLOR || "#0f766e",
  logoUrl: process.env.CLINIC_LOGO_URL || "",
  tagline: process.env.CLINIC_TAGLINE || "Asistente virtual de citas",

  services: [
    { id: "consulta_general", label: "Consulta general", durationMinutes: 30, priceEur: 40 },
    { id: "limpieza", label: "Limpieza / higiene", durationMinutes: 45, priceEur: 65 },
    { id: "revision", label: "Revisión", durationMinutes: 20, priceEur: 25 },
  ] as ServiceDef[],

  // Recursos físicos del centro (ver ResourceDef arriba). Lista de ejemplo,
  // hoy no se usa en ninguna validación de reservas.
  resources: [] as ResourceDef[],

  // Horario semanal en hora local del centro. 0 = domingo ... 6 = sábado.
  openingHours: {
    1: [{ start: "09:00", end: "14:00" }, { start: "16:00", end: "20:00" }],
    2: [{ start: "09:00", end: "14:00" }, { start: "16:00", end: "20:00" }],
    3: [{ start: "09:00", end: "14:00" }, { start: "16:00", end: "20:00" }],
    4: [{ start: "09:00", end: "14:00" }, { start: "16:00", end: "20:00" }],
    5: [{ start: "09:00", end: "14:00" }],
  } as Record<number, { start: string; end: string }[]>,

  // Cada cuánto se pueden ofrecer huecos (granularidad de la agenda).
  slotGranularityMinutes: 15,

  // Cuántos huecos alternativos como máximo se ofrecen en una respuesta.
  maxSlotsToOffer: 5,

  // Antelación mínima para poder reservar (en minutos).
  minBookingNoticeMinutes: 60,

  // Ventana de recordatorios anti-plantón.
  reminder24hHoursBefore: 24,
  reminder2hHoursBefore: 2,

  // Cuánto tiempo tiene un paciente en lista de espera para responder a un
  // hueco ofrecido antes de pasar al siguiente.
  waitlistOfferWindowMinutes: 15,
};

export const env = {
  port: Number(process.env.PORT || 3000),

  whatsappToken: () => required("WHATSAPP_TOKEN"),
  whatsappPhoneNumberId: () => required("WHATSAPP_PHONE_NUMBER_ID"),
  whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || "",
  whatsappBusinessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || "",

  // Modelo vía OpenRouter (openrouter.ai): un solo API key, pago con tarjeta
  // normal (sin IBAN ni datos de empresa), acceso a Claude, GPT, Gemini, etc.
  openRouterApiKey: () => required("OPENROUTER_API_KEY"),
  openRouterModel: process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4.5",

  googleServiceAccountPath:
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || "./google-service-account.json",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || "primary",
};
