import test, { before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { bookAppointment, cancelAppointment } from "../../services/appointments";
import { joinWaitlist } from "../../services/waitlist";
import { acceptWaitlistOffer, handleWaitlistOfferExpiredJob } from "../../services/waitlistOrchestrator";
import { timeOfDayOf } from "../../domain/waitlistMatching";
import { runRecoverSlotScenario } from "../../services/demoScenarios";
import { getDashboardStats } from "../../services/reportingService";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

/**
 * TEST 5D — regresión de lista de espera (NO se reconstruye nada de la
 * lógica; solo se verifica que sigue funcionando tras los cambios de esta
 * ronda). Cubre: oferta al cancelar, aceptación, caducidad + siguiente
 * candidato, doble aceptación simultánea (protección CAS), y que el
 * escenario de demo "recuperar hueco" nunca duplica cita/oferta/ingreso
 * aunque se ejecute más de una vez.
 */

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

describe("waitlist.test.ts", () => {
before(ensureCatalogReady);
beforeEach(async () => { await cleanTransactionalData(); await makeProfessional("Profesional de prueba"); });

test("cancelar una cita ofrece el hueco al primero compatible en lista de espera, y aceptar lo convierte en cita real", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  const marta = await makePatient("wl1-marta");
  const lucia = await makePatient("wl1-lucia");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });

  const martaAppt = await bookAppointment({
    patientId: marta.id, patientName: "Marta", patientPhone: marta.phone, serviceId: "limpieza", start: slot, professionalId: laura.id,
  });
  await joinWaitlist({
    patientId: lucia.id, serviceId: "limpieza",
    earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 3 }),
    preferredTimeOfDay: timeOfDayOf(slot),
  });

  await cancelAppointment(martaAppt.id, marta.id);

  const offer = await prisma.waitlistEntry.findFirst({ where: { patientId: lucia.id, status: "OFFERED" }, include: { patient: true } });
  assert.ok(offer, "a Lucía se le debe haber ofrecido el hueco liberado");
  assert.equal(offer!.offeredSlotStart?.getTime(), slot.toJSDate().getTime());

  const hold = await prisma.slotHold.findFirst({ where: { patientId: lucia.id, reason: "WAITLIST_OFFER" } });
  assert.ok(hold, "debe existir un SlotHold que reserve el hueco mientras Lucía decide");

  const appt = await acceptWaitlistOffer(offer!.id, offer! as any);
  assert.equal(appt.recoveredFromWaitlist, true);
  assert.equal(appt.startsAt.getTime(), slot.toJSDate().getTime());

  const entryAfter = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: offer!.id } });
  assert.equal(entryAfter.status, "BOOKED");

  // El job de caducidad de la oferta ya no debe seguir pendiente.
  const pendingExpiry = await prisma.scheduledJob.findMany({ where: { type: "WAITLIST_OFFER_EXPIRED", status: "PENDING" } });
  assert.equal(pendingExpiry.length, 0);
});

test("si la oferta caduca sin respuesta, pasa al siguiente candidato compatible sin duplicar ofertas activas", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  const marta = await makePatient("wl2-marta");
  const lucia = await makePatient("wl2-lucia");
  const pedro = await makePatient("wl2-pedro");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });

  const martaAppt = await bookAppointment({
    patientId: marta.id, patientName: "Marta", patientPhone: marta.phone, serviceId: "limpieza", start: slot, professionalId: laura.id,
  });
  // Lucía se apunta primero (FIFO): debe ser la primera en recibir la oferta.
  await joinWaitlist({
    patientId: lucia.id, serviceId: "limpieza",
    earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 3 }), preferredTimeOfDay: timeOfDayOf(slot),
  });
  await joinWaitlist({
    patientId: pedro.id, serviceId: "limpieza",
    earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 3 }), preferredTimeOfDay: timeOfDayOf(slot),
  });

  await cancelAppointment(martaAppt.id, marta.id);
  const luciaOffer = await prisma.waitlistEntry.findFirstOrThrow({ where: { patientId: lucia.id, status: "OFFERED" } });

  // Simula que se cumple la ventana sin respuesta (el mismo handler que
  // dispara el job persistente WAITLIST_OFFER_EXPIRED, ver
  // scheduler/persistentJobs.ts — aquí se invoca directamente para no
  // depender de temporizadores reales en el test).
  await handleWaitlistOfferExpiredJob(luciaOffer.id);

  const luciaAfter = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: luciaOffer.id } });
  assert.equal(luciaAfter.status, "EXPIRED");

  const luciaHold = await prisma.slotHold.findFirst({ where: { patientId: lucia.id, reason: "WAITLIST_OFFER" } });
  assert.equal(luciaHold, null, "el hold de Lucía debe liberarse al caducar");

  const pedroOffer = await prisma.waitlistEntry.findFirst({ where: { patientId: pedro.id, status: "OFFERED" } });
  assert.ok(pedroOffer, "el hueco debe pasar a Pedro, el siguiente candidato compatible");

  // Nunca debe haber más de una oferta activa a la vez para el mismo hueco.
  const activeOffers = await prisma.waitlistEntry.findMany({ where: { status: "OFFERED", service: "limpieza" } });
  assert.equal(activeOffers.length, 1);
});

test("dos aceptaciones simultáneas de la misma oferta: solo una gana, la otra falla explícitamente (sin doble cita)", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  const marta = await makePatient("wl3-marta");
  const lucia = await makePatient("wl3-lucia");
  const slot = nextWeekday(3).set({ hour: 10, minute: 0 });

  const martaAppt = await bookAppointment({
    patientId: marta.id, patientName: "Marta", patientPhone: marta.phone, serviceId: "limpieza", start: slot, professionalId: laura.id,
  });
  await joinWaitlist({
    patientId: lucia.id, serviceId: "limpieza",
    earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 3 }), preferredTimeOfDay: timeOfDayOf(slot),
  });
  await cancelAppointment(martaAppt.id, marta.id);

  const offer = await prisma.waitlistEntry.findFirstOrThrow({ where: { patientId: lucia.id, status: "OFFERED" }, include: { patient: true } });

  const results = await Promise.allSettled([
    acceptWaitlistOffer(offer.id, offer as any),
    acceptWaitlistOffer(offer.id, offer as any),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1, "solo una de las dos aceptaciones simultáneas debe ganar");
  assert.equal(rejected.length, 1);

  const activeAppts = await prisma.appointment.findMany({
    where: { patientId: lucia.id, startsAt: slot.toJSDate(), status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] } },
  });
  assert.equal(activeAppts.length, 1, "nunca debe quedar más de una cita activa para la misma oferta aceptada dos veces");
});

test("el escenario de demo 'recuperar hueco' ejecutado dos veces no duplica cita, oferta ni ingreso recuperado", async () => {
  const first = await runRecoverSlotScenario();
  const statsAfterFirst = await getDashboardStats();

  const second = await runRecoverSlotScenario();
  const statsAfterSecond = await getDashboardStats();

  // La segunda ejecución debe dar el mismo resultado observable (mismo
  // servicio/precio), no acumular un segundo hueco recuperado encima.
  assert.equal(second.serviceLabel, first.serviceLabel);
  assert.equal(second.priceEur, first.priceEur);
  assert.notEqual(second.newAppointmentId, first.newAppointmentId, "la 2ª ejecución limpia y recrea su propio escenario, no reutiliza el id");

  assert.equal(statsAfterSecond.recoveredSlots, statsAfterFirst.recoveredSlots, "no debe crecer con cada ejecución del mismo escenario demo");
  assert.equal(statsAfterSecond.recoveredRevenueEur, statsAfterFirst.recoveredRevenueEur);

  // Y no debe quedar ninguna cita "fantasma" de la primera ejecución.
  const staleFirstAppt = await prisma.appointment.findUnique({ where: { id: first.newAppointmentId } });
  assert.equal(staleFirstAppt, null, "la cita de la 1ª ejecución se limpia al volver a correr el escenario");
});

});
