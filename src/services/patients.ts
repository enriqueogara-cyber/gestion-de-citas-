import { prisma } from "../db/client";

export async function findOrCreatePatient(phoneE164: string, name?: string) {
  const existing = await prisma.patient.findUnique({ where: { phone: phoneE164 } });
  if (existing) {
    if (name && !existing.name) {
      return prisma.patient.update({ where: { id: existing.id }, data: { name } });
    }
    return existing;
  }
  return prisma.patient.create({ data: { phone: phoneE164, name } });
}
