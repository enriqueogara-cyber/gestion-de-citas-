import { prisma } from "../db/client";
import type { Professional } from "@prisma/client";
export function parseServiceIds(json: string): string[] {
  try { const ids = JSON.parse(json); return Array.isArray(ids) ? ids.filter(x => typeof x === "string") : []; } catch { return []; }
}
export async function listActiveProfessionals(): Promise<Professional[]> {
  return prisma.professional.findMany({ where: { active: true, clinicId: "default" }, orderBy: { createdAt: "asc" } });
}
export async function createProfessional(name: string): Promise<Professional> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80) throw new Error("Introduce un nombre de hasta 80 caracteres.");
  return prisma.professional.create({ data: { name: trimmed, serviceIds: "[]" } });
}
export async function deactivateProfessional(id: string): Promise<void> {
  await prisma.professional.update({ where: { id, clinicId: "default" }, data: { active: false } });
}
export async function setProfessionalServices(id: string, serviceIds: string[]): Promise<void> {
  const ids = [...new Set(serviceIds)];
  const count = await prisma.service.count({ where: { clinicId: "default", slug: { in: ids } } });
  if (count !== ids.length) throw new Error("Hay servicios que no pertenecen al centro.");
  await prisma.professional.update({ where: { id, clinicId: "default" }, data: { serviceIds: JSON.stringify(ids) } });
}
export async function getQualifiedProfessionals(serviceId: string): Promise<Professional[]> {
  return (await listActiveProfessionals()).filter(p => parseServiceIds(p.serviceIds).includes(serviceId));
}
export async function resolveServiceProfessionals(serviceId: string): Promise<{ mode: "qualified"; professionals: Professional[] }> {
  return { mode: "qualified", professionals: await getQualifiedProfessionals(serviceId) };
}
export async function findProfessionalById(id: string): Promise<Professional | null> {
  return prisma.professional.findFirst({ where: { id, clinicId: "default" } });
}
export async function findProfessionalByName(name: string): Promise<Professional | null> {
  const needle = name.trim().toLowerCase();
  return (await listActiveProfessionals()).find(p => p.name.toLowerCase().includes(needle)) || null;
}
