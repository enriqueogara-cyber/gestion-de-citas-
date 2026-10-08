import { prisma } from "../db/client";
import type { Professional } from "@prisma/client";

/**
 * Profesionales del centro (ver punto 5 de la auditoría / README). Simple
 * a propósito: un profesional tiene un nombre y una lista de servicios que
 * sabe hacer (serviceIds, guardado como JSON porque SQLite no soporta
 * listas escalares en Prisma). Si el centro no ha dado de alta ningún
 * profesional, el sistema se comporta como hoy: "cualquiera hace
 * cualquier servicio" (ver getQualifiedProfessionals).
 */

export function parseServiceIds(json: string): string[] {
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export async function listActiveProfessionals(): Promise<Professional[]> {
  return prisma.professional.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } });
}

/** Da de alta un profesional nuevo desde /simulator/settings. Sin servicios asignados = "hace de todo". */
export async function createProfessional(name: string): Promise<Professional> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("El nombre del profesional no puede estar vacío.");
  if (trimmed.length > 80) throw new Error("Ese nombre es demasiado largo.");
  return prisma.professional.create({ data: { name: trimmed, serviceIds: "[]" } });
}

/** Baja lógica: deja de ofrecerse para nuevas citas, pero no borra su historial. */
export async function deactivateProfessional(id: string): Promise<void> {
  await prisma.professional.update({ where: { id }, data: { active: false } });
}

/** Qué servicios puede realizar un profesional (ver FASE 3: reforzar la relación profesional↔servicio). Vacío = "hace de todo". */
export async function setProfessionalServices(id: string, serviceIds: string[]): Promise<void> {
  await prisma.professional.update({ where: { id }, data: { serviceIds: JSON.stringify(serviceIds) } });
}

/**
 * Profesionales que pueden realizar un servicio dado. Si serviceIds está
 * vacío para un profesional, se interpreta como "hace de todo". Si no hay
 * ningún profesional dado de alta en absoluto, devuelve una lista vacía —
 * OJO: eso NO distingue "nadie da este servicio" de "el centro no tiene
 * profesionales todavía". Para decidir si un servicio es reservable, usa
 * `resolveServiceProfessionals`, no esta función directamente (ver abajo).
 */
export async function getQualifiedProfessionals(serviceId: string): Promise<Professional[]> {
  const all = await listActiveProfessionals();
  return all.filter((p) => {
    const ids = parseServiceIds(p.serviceIds);
    return ids.length === 0 || ids.includes(serviceId);
  });
}

/**
 * Resuelve, sin ambigüedad, quién puede atender un servicio — distingue el
 * ÚNICO caso legítimo de "cualquiera puede" (el centro no ha dado de alta
 * NINGÚN profesional todavía, modo MVP de recurso único) del caso
 * peligroso "hay profesionales dados de alta, pero ninguno tiene este
 * servicio marcado" — que antes se trataban igual (`length === 0` en
 * ambos), y eso hacía que un servicio con CERO profesionales cualificados
 * (p.ej. "Implantología" si ni Laura ni Carlos la tienen asignada) se
 * ofreciera igualmente como si "cualquiera" pudiera hacerlo. Bug real
 * corregido en esta ronda — ver bookingEngine.reserveAppointment,
 * appointments.getAvailability y agent/tools.ts (list_professionals).
 *
 * No existe (ni se ha añadido) ningún concepto de
 * `availableToAllProfessionals` a nivel de servicio: el único "cualquiera
 * puede" válido es la ausencia total de profesionales en el centro, que ya
 * era explícito y está documentado aquí.
 */
export async function resolveServiceProfessionals(
  serviceId: string
): Promise<{ mode: "no-professionals-onboarded" } | { mode: "qualified"; professionals: Professional[] }> {
  const all = await listActiveProfessionals();
  if (all.length === 0) return { mode: "no-professionals-onboarded" };
  const qualified = all.filter((p) => {
    const ids = parseServiceIds(p.serviceIds);
    return ids.length === 0 || ids.includes(serviceId);
  });
  return { mode: "qualified", professionals: qualified };
}

export async function findProfessionalById(id: string): Promise<Professional | null> {
  return prisma.professional.findUnique({ where: { id } });
}

/** Busca un profesional por nombre (coincidencia parcial, insensible a mayúsculas) — lo usa el agente cuando el paciente pide a alguien por su nombre. */
export async function findProfessionalByName(name: string): Promise<Professional | null> {
  const all = await listActiveProfessionals();
  const needle = name.trim().toLowerCase();
  return all.find((p) => p.name.toLowerCase().includes(needle)) || null;
}
