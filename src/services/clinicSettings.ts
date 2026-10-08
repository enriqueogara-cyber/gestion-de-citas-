import { prisma } from "../db/client";
import { clinicConfig } from "../config";

/**
 * Identidad/branding del centro, con la base de datos como fuente de
 * verdad (ver README, sección "Configuración de clínica en base de
 * datos"). src/config.ts sigue teniendo servicios y horario (no vale la
 * pena moverlos a DB todavía, ver justificación ahí) pero nombre, tagline,
 * color de marca, logo y timezone ya viven en la tabla `Clinic` y son
 * editables en caliente desde /simulator/settings.
 *
 * Un único slug "default" hoy (un solo centro); el resto del modelo ya
 * tiene `clinicId` preparado para cuando haga falta más de una fila.
 */

const DEFAULT_SLUG = "default";

export interface ClinicSettings {
  id: string;
  name: string;
  tagline: string;
  brandColor: string;
  logoUrl: string;
  timezone: string;
}

/** Devuelve la configuración del centro, sembrando la fila la primera vez. */
export async function getClinicSettings(): Promise<ClinicSettings> {
  const existing = await prisma.clinic.findUnique({ where: { slug: DEFAULT_SLUG } });
  if (existing) return existing;

  return prisma.clinic.create({
    data: {
      slug: DEFAULT_SLUG,
      name: clinicConfig.name,
      tagline: clinicConfig.tagline,
      brandColor: clinicConfig.brandColor,
      logoUrl: clinicConfig.logoUrl,
      timezone: clinicConfig.timezone,
    },
  });
}

export async function updateClinicSettings(
  patch: Partial<Pick<ClinicSettings, "name" | "tagline" | "brandColor" | "logoUrl" | "timezone">>
): Promise<ClinicSettings> {
  // Aseguramos que la fila existe antes de actualizar (primer guardado en
  // un entorno recién sembrado).
  await getClinicSettings();

  const data: Record<string, string> = {};
  if (patch.name !== undefined && patch.name.trim()) data.name = patch.name.trim();
  if (patch.tagline !== undefined) data.tagline = patch.tagline.trim();
  if (patch.brandColor !== undefined && /^#[0-9a-fA-F]{6}$/.test(patch.brandColor)) {
    data.brandColor = patch.brandColor;
  }
  if (patch.logoUrl !== undefined) data.logoUrl = patch.logoUrl.trim();
  if (patch.timezone !== undefined && patch.timezone.trim()) data.timezone = patch.timezone.trim();

  return prisma.clinic.update({ where: { slug: DEFAULT_SLUG }, data });
}
