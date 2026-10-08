import { DateTime } from "luxon";
import { prisma } from "../db/client";
import { clinicConfig } from "../config";
import { getServicesSync } from "./serviceCatalog";
import { findOrCreatePatient } from "./patients";
import { bookAppointment, cancelAppointment, confirmAppointment, getAvailability } from "./appointments";
import { joinWaitlist } from "./waitlist";
import { acceptWaitlistOffer } from "./waitlistOrchestrator";
import { timeOfDayOf } from "../domain/waitlistMatching";
import { logger } from "../lib/logger";

/**
 * Datos y flujos de demostración (ver README, "Demo mode"). Todo lo que
 * toca aquí son pacientes "demo-*": nunca borra ni toca profesionales,
 * configuración del centro, ni pacientes reales.
 */

const DEMO_PHONE_PREFIX = "demo-seed-";

export async function seedDemoData(): Promise<{ professionals: number; patients: number }> {
  const existingPros = await prisma.professional.count();
  if (existingPros === 0) {
    const services = getServicesSync();
    // Reparto deliberadamente NO simétrico entre servicios (ver FASE 3):
    // deja algo real que demostrar cuando el paciente pide un servicio con
    // un profesional que no lo hace ("quiero limpieza con Carlos").
    const [svcA, svcB, svcC] = services;
    await prisma.professional.createMany({
      data: [
        { name: "Laura", serviceIds: JSON.stringify([svcA?.id, svcB?.id].filter(Boolean)) },
        { name: "Carlos", serviceIds: JSON.stringify([svcB?.id, svcC?.id].filter(Boolean)) },
      ],
    });
  }

  const clinic = await prisma.clinic.findUnique({ where: { slug: "default" } });
  if (!clinic) {
    await prisma.clinic.create({
      data: {
        slug: "default",
        name: clinicConfig.name,
        tagline: clinicConfig.tagline,
        brandColor: clinicConfig.brandColor,
        logoUrl: clinicConfig.logoUrl,
        timezone: clinicConfig.timezone,
      },
    });
  }

  // Un par de pacientes de ejemplo con historial, para que el dashboard no
  // arranque completamente vacío.
  const ana = await findOrCreatePatient(`${DEMO_PHONE_PREFIX}ana`, "Ana");
  const jorge = await findOrCreatePatient(`${DEMO_PHONE_PREFIX}jorge`, "Jorge");

  const service = getServicesSync()[0];
  // Se vuelve a consultar disponibilidad ANTES de cada reserva (no una lista
  // calculada una sola vez): con disponibilidad consciente de profesional,
  // dos huecos consecutivos de una lista chronológica pueden solaparse para
  // el mismo profesional (p.ej. 09:00 y 09:15 con un servicio de 30 min) —
  // re-consultar tras la primera reserva garantiza que el segundo hueco es
  // realmente libre.
  const firstSlots = await getAvailability(service.id, 10);
  if (firstSlots[0]) {
    try {
      const appt = await bookAppointment({
        patientId: ana.id,
        patientName: ana.name || "",
        patientPhone: ana.phone,
        serviceId: service.id,
        start: firstSlots[0],
      });
      await confirmAppointment(appt.id, ana.id);
    } catch (err) {
      logger.warn("seed_demo_appointment_skipped", { err });
    }
  }
  const secondSlots = await getAvailability(service.id, 10);
  if (secondSlots[0]) {
    try {
      await bookAppointment({
        patientId: jorge.id,
        patientName: jorge.name || "",
        patientPhone: jorge.phone,
        serviceId: service.id,
        start: secondSlots[0],
      });
    } catch (err) {
      logger.warn("seed_demo_appointment_skipped", { err });
    }
  }

  return { professionals: await prisma.professional.count(), patients: 2 };
}

/** Borra todos los datos transitorios de demo (pacientes demo-*, sus citas/listas/mensajes, holds y el event feed). No toca profesionales ni configuración del centro. */
export async function resetAllDemoData(): Promise<void> {
  const demoPatients = await prisma.patient.findMany({ where: { phone: { startsWith: "demo-" } } });
  const ids = demoPatients.map((p) => p.id);

  if (ids.length > 0) {
    await prisma.conversationMessage.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.waitlistEntry.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.appointment.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.slotHold.deleteMany({ where: { patientId: { in: ids } } });
    await prisma.patient.deleteMany({ where: { id: { in: ids } } });
  }
  // El resto del event feed (si queda algo sin patientId) también se limpia
  // para que la demo arranque con un feed en blanco.
  await prisma.auditLog.deleteMany({});
}

export interface RecoverSlotScenarioResult {
  serviceLabel: string;
  priceEur: number | null;
  slotStart: string;
  newAppointmentId: string;
}

/**
 * El servicio que usa el escenario de demo, elegido de forma DETERMINISTA
 * (el de mayor precio) — no "el primero que tenga precio", que dependía
 * del orden en clinicConfig.services y podía no coincidir con lo que decía
 * el botón en el dashboard (bug real: el botón anunciaba un precio fijo
 * mientras el escenario podía terminar usando otro servicio más barato).
 * Se exporta para que el dashboard pueda anunciar el precio real en el
 * botón en vez de un número hardcodeado que se puede desincronizar.
 */
export function getRecoverySlotDemoService() {
  return getServicesSync().reduce((best, s) =>
    (s.priceEur ?? -1) > (best.priceEur ?? -1) ? s : best
  );
}

/**
 * Escenario guiado de un clic (ver README, "Momento wow: recuperar
 * hueco"): Marta tiene una cita confirmada; Lucía está en lista de espera
 * para ese mismo hueco; Marta cancela; el sistema ofrece el hueco a Lucía
 * y lo acepta en su nombre. Usa el mismo camino de negocio real (no un
 * atajo de UI), así que demuestra el flujo de verdad de punta a punta.
 */
export async function runRecoverSlotScenario(): Promise<RecoverSlotScenarioResult> {
  const service = getRecoverySlotDemoService();

  const marta = await findOrCreatePatient(`${DEMO_PHONE_PREFIX}marta`, "Marta");
  const lucia = await findOrCreatePatient(`${DEMO_PHONE_PREFIX}lucia`, "Lucía");

  // Limpiamos cualquier resto de una ejecución anterior del escenario.
  await prisma.appointment.deleteMany({ where: { patientId: { in: [marta.id, lucia.id] } } });
  await prisma.waitlistEntry.deleteMany({ where: { patientId: { in: [marta.id, lucia.id] } } });
  await prisma.slotHold.deleteMany({ where: { patientId: { in: [marta.id, lucia.id] } } });

  const slots = await getAvailability(service.id, 14);
  const slotStart = slots[0];
  if (!slotStart) throw new Error("No hay huecos disponibles para montar el escenario de demo ahora mismo.");

  const martaAppt = await bookAppointment({
    patientId: marta.id,
    patientName: marta.name || "",
    patientPhone: marta.phone,
    serviceId: service.id,
    start: slotStart,
  });
  await confirmAppointment(martaAppt.id, marta.id);

  await joinWaitlist({
    patientId: lucia.id,
    serviceId: service.id,
    earliestDate: slotStart.startOf("day"),
    latestDate: slotStart.plus({ days: 3 }),
    preferredTimeOfDay: timeOfDayOf(slotStart),
  });

  // Cancelar dispara offerFreedSlot de verdad: crea el SlotHold, avisa a
  // Lucía (mensaje guardado en su chat de demo) y deja la entrada en OFFERED.
  await cancelAppointment(martaAppt.id, marta.id);

  const offer = await prisma.waitlistEntry.findFirst({
    where: { patientId: lucia.id, status: "OFFERED" },
    include: { patient: true },
  });
  if (!offer) {
    throw new Error("No se generó una oferta de lista de espera para Lucía (¿el hueco no era compatible?).");
  }

  const newAppt = await acceptWaitlistOffer(offer.id, offer);

  return {
    serviceLabel: service.label,
    priceEur: service.priceEur ?? null,
    slotStart: slotStart.toISO() ?? "",
    newAppointmentId: newAppt.id,
  };
}
