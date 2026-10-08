import { prisma } from "../db/client";
import { clinicConfig, ServiceDef } from "../config";
import { logger } from "../lib/logger";

/**
 * Servicios y horario de apertura, respaldados por DB (`Service`,
 * `OpeningHoursRule`) pero expuestos de forma SÍNCRONA a través de una
 * caché en memoria — igual que `clinicConfig` funcionaba antes.
 *
 * Por qué caché y no leer la DB en cada sitio: el horario y los servicios
 * se leen en rutas muy calientes y hoy síncronas (construir el system
 * prompt en cada mensaje, calcular huecos). Convertir eso a async habría
 * significado tocar prácticamente todos los archivos del dominio para
 * enhebrar `await` — mucho riesgo de regresión para el mismo resultado.
 * En su lugar: la caché se carga una vez al arrancar (`loadServiceCatalog`,
 * llamado desde `src/index.ts`) y se recarga tras cada escritura desde
 * Settings — sigue siendo "solo una fila" de latencia de más en la
 * siguiente petición, invisible para un centro con un puñado de servicios.
 *
 * Los tests unitarios que no llaman a `loadServiceCatalog()` (no tienen
 * servidor arrancado) siguen viendo los valores por defecto de
 * `src/config.ts`, que es también la semilla con la que se rellena la
 * tabla `Service`/`OpeningHoursRule` la primera vez.
 */

export interface OpeningHours {
  [weekday: number]: { start: string; end: string }[];
}

let cachedServices: ServiceDef[] = clinicConfig.services.map((s) => ({ ...s }));
let cachedAllServices: (ServiceDef & { active: boolean })[] = clinicConfig.services.map((s) => ({
  ...s,
  active: true,
}));
let cachedOpeningHours: OpeningHours = { ...clinicConfig.openingHours };

function toServiceDef(row: {
  slug: string;
  name: string;
  durationMinutes: number;
  priceEur: number | null;
  active: boolean;
}): ServiceDef & { active: boolean } {
  return {
    id: row.slug,
    label: row.name,
    durationMinutes: row.durationMinutes,
    priceEur: row.priceEur ?? undefined,
    active: row.active,
  };
}

// Promesa en curso del sembrado, compartida por llamadas concurrentes (ver
// bug real detectado por los integration tests: dos `loadServiceCatalog()`
// casi simultáneas en un arranque en frío podían ver la tabla vacía las
// dos y las dos intentar `createMany`, violando la unicidad de `slug`).
// Memoizar la promesa en curso, en vez de una comprobación previa suelta,
// hace que la segunda llamada espere el resultado de la primera en lugar
// de repetir el trabajo.
let seedPromise: Promise<void> | null = null;

async function seedIfEmpty(): Promise<void> {
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    const count = await prisma.service.count();
    if (count === 0) {
      await prisma.service.createMany({
        data: clinicConfig.services.map((s) => ({
          slug: s.id,
          name: s.label,
          durationMinutes: s.durationMinutes,
          priceEur: s.priceEur ?? null,
          active: true,
        })),
      });
    }

    const hoursCount = await prisma.openingHoursRule.count();
    if (hoursCount === 0) {
      const rows = Object.entries(clinicConfig.openingHours).flatMap(([weekday, ranges]) =>
        ranges.map((r) => ({ weekday: Number(weekday), startTime: r.start, endTime: r.end }))
      );
      if (rows.length > 0) await prisma.openingHoursRule.createMany({ data: rows });
    }
  })();

  try {
    await seedPromise;
  } finally {
    seedPromise = null;
  }
}

/** Recarga la caché en memoria desde la base de datos. Llamar al arrancar y tras cualquier escritura. */
export async function loadServiceCatalog(): Promise<void> {
  try {
    await seedIfEmpty();

    const services = await prisma.service.findMany({ orderBy: { createdAt: "asc" } });
    cachedAllServices = services.map(toServiceDef);
    cachedServices = cachedAllServices.filter((s) => s.active).map(({ active, ...rest }) => rest);

    const hours = await prisma.openingHoursRule.findMany({ orderBy: [{ weekday: "asc" }, { startTime: "asc" }] });
    const next: OpeningHours = {};
    for (const h of hours) {
      (next[h.weekday] ??= []).push({ start: h.startTime, end: h.endTime });
    }
    cachedOpeningHours = next;

    logger.info("service_catalog_loaded", { services: cachedServices.length, hourRules: hours.length });
  } catch (err) {
    logger.error("service_catalog_load_failed", { err });
    // Nos quedamos con lo que ya hubiera en caché (los defaults de
    // config.ts en el peor caso) en vez de dejar la app sin servicios.
  }
}

/** Servicios activos, para reservar/mostrar al paciente. */
export function getServicesSync(): ServiceDef[] {
  return cachedServices;
}

/** Todos los servicios (activos e inactivos) — para traducir el slug de una cita histórica a un nombre legible aunque el servicio ya no se ofrezca. */
export function getAllServicesSync(): (ServiceDef & { active: boolean })[] {
  return cachedAllServices;
}

export function getOpeningHoursSync(): OpeningHours {
  return cachedOpeningHours;
}

// --- Escritura (Settings) ---

export class ServiceValidationError extends Error {}

function validateServiceInput(input: { name: string; durationMinutes: number; priceEur: number | null }) {
  if (!input.name.trim()) throw new ServiceValidationError("El nombre del servicio no puede estar vacío.");
  if (input.name.trim().length > 80) throw new ServiceValidationError("Ese nombre es demasiado largo.");
  if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
    throw new ServiceValidationError("La duración tiene que ser un número de minutos mayor que 0.");
  }
  if (input.durationMinutes > 8 * 60) {
    throw new ServiceValidationError("Esa duración es enorme (más de 8 horas) — revísala.");
  }
  if (input.priceEur != null && (!Number.isFinite(input.priceEur) || input.priceEur < 0)) {
    throw new ServiceValidationError("El precio no puede ser negativo.");
  }
}

function slugify(name: string): string {
  const base = name
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // acentos (tras normalizar a forma descompuesta)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "servicio";
}

export async function createService(input: {
  name: string;
  durationMinutes: number;
  priceEur: number | null;
}): Promise<void> {
  validateServiceInput(input);
  let slug = slugify(input.name);
  let suffix = 1;
  while (await prisma.service.findUnique({ where: { slug } })) {
    suffix += 1;
    slug = `${slugify(input.name)}_${suffix}`;
  }
  await prisma.service.create({
    data: { slug, name: input.name.trim(), durationMinutes: input.durationMinutes, priceEur: input.priceEur },
  });
  await loadServiceCatalog();
}

/**
 * `id` aquí es el identificador que usa TODO el resto del sistema para un
 * servicio (`ServiceDef.id`, ver `toServiceDef` arriba) — que en realidad
 * es el `slug` de la fila, no su `id` interno de Prisma (cuid). Es lo que
 * manda la UI de Settings (`s.id` en settingsPage.ts) y lo que llega por
 * `req.params.id` en el router. Bug real encontrado y corregido en esta
 * ronda: buscar por `{ id }` en vez de `{ slug: id }` hacía que "Editar" y
 * "Desactivar" servicio fallaran siempre con "registro no encontrado" en
 * cuanto el cuid interno no coincidía con el slug (o sea, siempre) — no lo
 * pilló ningún test porque el único test existente que tocaba
 * `setServiceActive` pasaba el cuid real directamente, no el slug que la
 * UI de verdad envía.
 */
export async function updateService(
  id: string,
  input: { name: string; durationMinutes: number; priceEur: number | null }
): Promise<void> {
  validateServiceInput(input);
  await prisma.service.update({
    where: { slug: id },
    data: { name: input.name.trim(), durationMinutes: input.durationMinutes, priceEur: input.priceEur },
  });
  await loadServiceCatalog();
}

export async function setServiceActive(id: string, active: boolean): Promise<void> {
  await prisma.service.update({ where: { slug: id }, data: { active } });
  await loadServiceCatalog();
}

export class OpeningHoursValidationError extends Error {}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Reemplaza el horario completo de un día. Valida formato, fin>inicio, y que los bloques no se solapen entre sí. */
export async function replaceOpeningHoursForDay(
  weekday: number,
  ranges: { start: string; end: string }[]
): Promise<void> {
  if (weekday < 0 || weekday > 6) throw new OpeningHoursValidationError("Día de la semana inválido.");

  const normalized = ranges.filter((r) => r.start && r.end);
  for (const r of normalized) {
    if (!TIME_RE.test(r.start) || !TIME_RE.test(r.end)) {
      throw new OpeningHoursValidationError(`Formato de hora inválido: "${r.start}"–"${r.end}" (usa HH:mm).`);
    }
    if (toMinutes(r.end) <= toMinutes(r.start)) {
      throw new OpeningHoursValidationError(`El bloque ${r.start}–${r.end} termina antes (o igual) de empezar.`);
    }
  }
  const sorted = [...normalized].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i].start) < toMinutes(sorted[i - 1].end)) {
      throw new OpeningHoursValidationError(`Los bloques ${sorted[i - 1].start}–${sorted[i - 1].end} y ${sorted[i].start}–${sorted[i].end} se solapan.`);
    }
  }

  await prisma.$transaction([
    prisma.openingHoursRule.deleteMany({ where: { weekday } }),
    ...(sorted.length
      ? [prisma.openingHoursRule.createMany({ data: sorted.map((r) => ({ weekday, startTime: r.start, endTime: r.end })) })]
      : []),
  ]);
  await loadServiceCatalog();
}
