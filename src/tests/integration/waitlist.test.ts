import test, { before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { bookAppointment, cancelAppointment } from "../../services/appointments";
import { joinWaitlist, cancelWaitlistEntry } from "../../services/waitlist";
import { acceptWaitlistOffer, cleanupExpiredSlotHolds, handleWaitlistOfferExpiredJob, offerFreedSlot } from "../../services/waitlistOrchestrator";
import { timeOfDayOf } from "../../domain/waitlistMatching";
import { runRecoverSlotScenario } from "../../services/demoScenarios";
import { getDashboardStats } from "../../services/reportingService";
import { reserveAppointment } from "../../domain/bookingEngine";
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

test("si falla crear el hold, la oferta y su caducidad no quedan a medias", async () => {
  const patient = await makePatient("hold-failure");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });
  const entry = await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  const originalTransaction = prisma.$transaction.bind(prisma);
  (prisma as any).$transaction = (fn: any) => originalTransaction((tx: any) => fn(new Proxy(tx, {
    get(target, property) {
      if (property === "slotHold") return new Proxy(target.slotHold, {
        get(model, method) {
          if (method === "create") return async () => { throw new Error("hold fallido simulado"); };
          return Reflect.get(model, method);
        },
      });
      return Reflect.get(target, property);
    },
  })));
  try {
    await assert.rejects(() => offerFreedSlot("revision", slot), /hold fallido/);
    assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status, "WAITING");
    assert.equal(await prisma.scheduledJob.count({ where: { waitlistEntryId: entry.id } }), 0);
  } finally {
    (prisma as any).$transaction = originalTransaction;
  }
});

test("reintentar la oferta del mismo hueco no crea dos holds ni dos avisos", async () => {
  const patientA = await makePatient("offer-once-a");
  const patientB = await makePatient("offer-once-b");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });
  for (const patient of [patientA, patientB]) {
    await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  }
  const attempts = await Promise.allSettled([offerFreedSlot("revision", slot), offerFreedSlot("revision", slot)]);
  assert.equal(attempts.filter(r => r.status === "fulfilled" && r.value === true).length, 1);
  assert.equal(await offerFreedSlot("revision", slot), false);
  assert.equal(await prisma.slotHold.count({ where: { startsAt: slot.toJSDate(), reason: "WAITLIST_OFFER" } }), 1);
  assert.equal(await prisma.conversationMessage.count({ where: { patientId: { in: [patientA.id, patientB.id] } } }), 1);
});

test("un job de caducidad fallido no deja el hueco retenido tras la recuperación", async () => {
  const firstPatient = await makePatient("failed-job-a");
  const nextPatient = await makePatient("failed-job-b");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: firstPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await joinWaitlist({ patientId: nextPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  const expiredAt = new Date(Date.now() - 1000);
  await prisma.waitlistEntry.update({ where: { id: first.id }, data: { offerExpiresAt: expiredAt } });
  await prisma.slotHold.updateMany({ where: { patientId: firstPatient.id, startsAt: slot.toJSDate() }, data: { expiresAt: expiredAt } });
  await prisma.scheduledJob.updateMany({ where: { waitlistEntryId: first.id }, data: { status: "FAILED", scheduledAt: new Date(Date.now() - 1000) } });
  await cleanupExpiredSlotHolds();
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first.id } })).status, "EXPIRED");
  assert.equal(await prisma.slotHold.count({ where: { patientId: firstPatient.id } }), 0);
  assert.equal(await prisma.waitlistEntry.count({ where: { patientId: nextPatient.id, status: "OFFERED" } }), 1);
  await cleanupExpiredSlotHolds();
  assert.equal(await prisma.slotHold.count({ where: { startsAt: slot.toJSDate(), reason: "WAITLIST_OFFER" } }), 1);
});

test("si falla el aviso de caducidad, el hueco pasa al siguiente candidato en el reintento", async () => {
  const patientA = await makePatient("expiry-a");
  const patientB = await makePatient("expiry-b");
  const slot = nextWeekday(3).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: patientA.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await joinWaitlist({ patientId: patientB.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  const originalCreate = prisma.conversationMessage.create.bind(prisma.conversationMessage);
  let failed = false;
  (prisma.conversationMessage as any).create = async (args: any) => {
    if (!failed && args?.data?.patientId === patientA.id) { failed = true; throw new Error("aviso fallido simulado"); }
    return originalCreate(args);
  };
  try {
    await handleWaitlistOfferExpiredJob(first.id).catch(() => undefined);
  } finally {
    (prisma.conversationMessage as any).create = originalCreate;
  }
  await handleWaitlistOfferExpiredJob(first.id);
  assert.equal(await prisma.waitlistEntry.count({ where: { patientId: patientB.id, status: "OFFERED" } }), 1);
  assert.equal(await prisma.slotHold.count({ where: { patientId: patientA.id, reason: "WAITLIST_OFFER" } }), 0);
});

test("un fallo del aviso de oferta conserva hold y caducidad; al vencer libera y pasa al siguiente", async () => {
  const firstPatient = await makePatient("notify-fail-a");
  const nextPatient = await makePatient("notify-fail-b");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: firstPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await joinWaitlist({ patientId: nextPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  const originalCreate = prisma.conversationMessage.create.bind(prisma.conversationMessage);
  (prisma.conversationMessage as any).create = async (args: any) => {
    if (args?.data?.patientId === firstPatient.id) throw new Error("envío fallido simulado");
    return originalCreate(args);
  };
  try {
    assert.equal(await offerFreedSlot("revision", slot), true);
  } finally {
    (prisma.conversationMessage as any).create = originalCreate;
  }
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first.id } })).status, "OFFERED");
  assert.equal(await prisma.slotHold.count({ where: { patientId: firstPatient.id, reason: "WAITLIST_OFFER" } }), 1);
  assert.equal(await prisma.scheduledJob.count({ where: { waitlistEntryId: first.id, status: "PENDING" } }), 1);
  await handleWaitlistOfferExpiredJob(first.id);
  assert.equal(await prisma.slotHold.count({ where: { patientId: firstPatient.id, reason: "WAITLIST_OFFER" } }), 0);
  assert.equal(await prisma.waitlistEntry.count({ where: { patientId: nextPatient.id, status: "OFFERED" } }), 1);
});

test("si falla ofrecer al siguiente después de EXPIRED, el reintento continúa una sola vez", async () => {
  const firstPatient = await makePatient("forward-a");
  const nextPatient = await makePatient("forward-b");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: firstPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await joinWaitlist({ patientId: nextPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  const originalFindMany = prisma.waitlistEntry.findMany.bind(prisma.waitlistEntry);
  let failed = false;
  (prisma.waitlistEntry as any).findMany = async (args: any) => {
    if (!failed && args?.where?.status === "WAITING") { failed = true; throw new Error("búsqueda fallida simulada"); }
    return originalFindMany(args);
  };
  try {
    await assert.rejects(() => handleWaitlistOfferExpiredJob(first.id), /búsqueda fallida/);
  } finally {
    (prisma.waitlistEntry as any).findMany = originalFindMany;
  }
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first.id } })).status, "EXPIRED");
  assert.equal(await prisma.slotHold.count({ where: { patientId: firstPatient.id } }), 0);
  await handleWaitlistOfferExpiredJob(first.id);
  await handleWaitlistOfferExpiredJob(first.id);
  assert.equal(await prisma.waitlistEntry.count({ where: { patientId: nextPatient.id, status: "OFFERED" } }), 1);
  assert.equal(await prisma.slotHold.count({ where: { startsAt: slot.toJSDate(), reason: "WAITLIST_OFFER" } }), 1);
});

test("reintentar una caducidad antigua no borra el nuevo hold del mismo paciente y hueco", async () => {
  const patient = await makePatient("same-patient-reoffer");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  const second = await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  await handleWaitlistOfferExpiredJob(first.id);
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: second.id } })).status, "OFFERED");
  await handleWaitlistOfferExpiredJob(first.id);
  assert.equal(await prisma.slotHold.count({ where: { patientId: patient.id, startsAt: slot.toJSDate() } }), 1);
});

test("si BOOKED falla tras reservar, el reintento recupera la misma cita sin duplicarla", async () => {
  const patient = await makePatient("booked-fail");
  const slot = nextWeekday(3).set({ hour: 10, minute: 0 });
  const entry = await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  const offered = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { patient: true } });
  const originalUpdate = prisma.waitlistEntry.update.bind(prisma.waitlistEntry);
  (prisma.waitlistEntry as any).update = async (args: any) => {
    if (args?.data?.status === "BOOKED") throw new Error("BOOKED fallido simulado");
    return originalUpdate(args);
  };
  try {
    await assert.rejects(() => acceptWaitlistOffer(entry.id, offered), /BOOKED fallido/);
  } finally {
    (prisma.waitlistEntry as any).update = originalUpdate;
  }
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status, "ACCEPTING");
  const recovered = await acceptWaitlistOffer(entry.id, offered);
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status, "BOOKED");
  assert.equal(await prisma.appointment.count({ where: { patientId: patient.id, startsAt: slot.toJSDate(), recoveredFromWaitlist: true } }), 1);
  assert.equal(recovered.id, (await prisma.appointment.findFirstOrThrow({ where: { patientId: patient.id, startsAt: slot.toJSDate() } })).id);
});

test("cancelar una oferta libera el hold y encadena el hueco sin duplicarlo en la caducidad", async () => {
  const firstPatient = await makePatient("cancel-offer-a");
  const nextPatient = await makePatient("cancel-offer-b");
  const slot = nextWeekday(4).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: firstPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await joinWaitlist({ patientId: nextPatient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  await cancelWaitlistEntry(first.id, firstPatient.id);
  assert.equal(await prisma.slotHold.count({ where: { patientId: firstPatient.id } }), 0);
  assert.equal(await prisma.waitlistEntry.count({ where: { patientId: nextPatient.id, status: "OFFERED" } }), 1);
  await handleWaitlistOfferExpiredJob(first.id);
  assert.equal(await prisma.slotHold.count({ where: { startsAt: slot.toJSDate(), reason: "WAITLIST_OFFER" } }), 1);
});

test("la oferta conserva el profesional del hueco al aceptarse", async () => {
  const offeredProfessional = await makeProfessional("Profesional del hueco", ["revision"]);
  const patient = await makePatient("prof-offer");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });
  const entry = await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot, offeredProfessional.id);
  const offered = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { patient: true } });
  assert.equal(offered.offeredProfessionalId, offeredProfessional.id);
  const booked = await acceptWaitlistOffer(entry.id, offered);
  assert.equal(booked.professionalId, offeredProfessional.id);
});

test("una oferta vencida no puede aceptarse antes de que el scheduler la limpie", async () => {
  const patient = await makePatient("late-accept");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });
  const entry = await joinWaitlist({ patientId: patient.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  const expiredAt = new Date(Date.now() - 1000);
  await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { offerExpiresAt: expiredAt } });
  await prisma.slotHold.updateMany({ where: { patientId: patient.id, startsAt: slot.toJSDate() }, data: { expiresAt: expiredAt } });
  const offered = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id }, include: { patient: true } });
  await assert.rejects(() => acceptWaitlistOffer(entry.id, offered), /ya no está disponible/);
  assert.equal(await prisma.appointment.count({ where: { patientId: patient.id } }), 0);
  await cleanupExpiredSlotHolds();
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } })).status, "EXPIRED");
  assert.equal(await prisma.slotHold.count({ where: { patientId: patient.id } }), 0);
});

test("un ACCEPTING abandonado se libera y una cita ya creada se reconcilia como BOOKED", async () => {
  const abandoned = await makePatient("abandoned-accept");
  const next = await makePatient("after-abandoned");
  const slot = nextWeekday(3).set({ hour: 10, minute: 0 });
  const first = await joinWaitlist({ patientId: abandoned.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await joinWaitlist({ patientId: next.id, serviceId: "revision", earliestDate: slot.startOf("day"), latestDate: slot.plus({ days: 1 }) });
  await offerFreedSlot("revision", slot);
  await prisma.waitlistEntry.update({ where: { id: first.id }, data: { status: "ACCEPTING", updatedAt: new Date(Date.now() - 11 * 60_000) } });
  await cleanupExpiredSlotHolds();
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: first.id } })).status, "EXPIRED");
  assert.equal(await prisma.waitlistEntry.count({ where: { patientId: next.id, status: "OFFERED" } }), 1);
  assert.equal(await prisma.slotHold.count({ where: { patientId: abandoned.id } }), 0);

  const bookedPatient = await makePatient("committed-accept");
  const otherSlot = nextWeekday(4).set({ hour: 10, minute: 0 });
  const bookedEntry = await joinWaitlist({ patientId: bookedPatient.id, serviceId: "revision", earliestDate: otherSlot.startOf("day"), latestDate: otherSlot.plus({ days: 1 }) });
  await offerFreedSlot("revision", otherSlot);
  const offer = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: bookedEntry.id } });
  await prisma.waitlistEntry.update({ where: { id: bookedEntry.id }, data: { status: "ACCEPTING" } });
  const appointment = await reserveAppointment({
    patientId: bookedPatient.id, patientName: "Test", patientPhone: bookedPatient.phone,
    serviceId: "revision", start: otherSlot, professionalId: offer.offeredProfessionalId ?? undefined,
    recoveredFromWaitlist: true, waitlistEntryId: bookedEntry.id,
  });
  await prisma.waitlistEntry.update({ where: { id: bookedEntry.id }, data: { updatedAt: new Date(Date.now() - 11 * 60_000) } });
  await cleanupExpiredSlotHolds();
  assert.equal((await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: bookedEntry.id } })).status, "BOOKED");
  assert.equal(await prisma.appointment.count({ where: { patientId: bookedPatient.id, startsAt: otherSlot.toJSDate() } }), 1);
  assert.equal(appointment.recoveredFromWaitlist, true);
});

});
