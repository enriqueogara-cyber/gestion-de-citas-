import { prisma } from "../../db/client";
import { loadServiceCatalog } from "../../services/serviceCatalog";
import { findOrCreatePatient } from "../../services/patients";

/**
 * Helpers compartidos por los integration tests. Corren contra
 * prisma/test.db (ver scripts/runIntegrationTests.js), nunca contra
 * dev.db — cada test dueño de sus propios datos, con nombres únicos por
 * caso para poder correr en paralelo sin pisarse.
 */

let ready = false;

/** Asegura que el catálogo de servicios/horario está cargado (siembra Service/OpeningHoursRule la primera vez, ver serviceCatalog.ts). */
export async function ensureCatalogReady(): Promise<void> {
  if (ready) return;
  await loadServiceCatalog();
  ready = true;
}

export async function makeProfessional(name: string, serviceSlugs: string[] = ["consulta_general", "limpieza", "revision"]) {
  return prisma.professional.create({ data: { name, serviceIds: JSON.stringify(serviceSlugs) } });
}

export async function makePatient(phoneSuffix: string, name = "Test") {
  // Prefijo "demo-" a propósito (igual que el simulador real, ver
  // notifications/notify.ts -> isDemoPhone): así cualquier aviso proactivo
  // (oferta de lista de espera, recordatorio...) que un test dispare de
  // verdad se guarda como mensaje de conversación en vez de intentar
  // mandarse por la API real de WhatsApp (que no tiene credenciales en
  // este entorno de test y no tiene sentido tocar aquí).
  return findOrCreatePatient(`demo-test-${phoneSuffix}-${Date.now()}-${Math.round(Math.random() * 1e6)}`, name);
}

/** Borra todo lo transaccional (no toca Service/OpeningHoursRule/Clinic, que son el catálogo compartido entre tests). */
export async function cleanTransactionalData(): Promise<void> {
  await prisma.portalAccess.deleteMany({});
  await prisma.contactRequest.deleteMany({});
  await prisma.staffSession.deleteMany({});
  await prisma.staffUser.deleteMany({});
  await prisma.inboundMessage.deleteMany({});
  await prisma.availabilityBlock.deleteMany({});
  await prisma.conversationMessage.deleteMany({});
  await prisma.waitlistEntry.deleteMany({});
  await prisma.slotHold.deleteMany({});
  await prisma.scheduledJob.deleteMany({});
  await prisma.appointment.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.professional.deleteMany({});
  await prisma.patient.deleteMany({});
}
