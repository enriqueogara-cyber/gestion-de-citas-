import test, { before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { bookAppointment, cancelAppointment } from "../../services/appointments";
import { processDueJobs } from "../../scheduler/persistentJobs";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

describe("scheduler.test.ts", () => {
before(ensureCatalogReady);
beforeEach(async () => { await cleanTransactionalData(); await makeProfessional("Profesional de prueba"); });

test("reservar una cita programa sus dos jobs de recordatorio (24h y 2h)", async () => {
  const patient = await makePatient("sched-1");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });

  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: slot });

  const jobs = await prisma.scheduledJob.findMany({ where: { appointmentId: appt.id }, orderBy: { type: "asc" } });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((j) => j.type).sort(), ["REMINDER_24H", "REMINDER_2H"]);
  assert.ok(jobs.every((j) => j.status === "PENDING"));
});

test("cancelar una cita cancela sus jobs de recordatorio pendientes", async () => {
  const patient = await makePatient("sched-2");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });

  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: slot });
  await cancelAppointment(appt.id, patient.id);

  const jobs = await prisma.scheduledJob.findMany({ where: { appointmentId: appt.id } });
  assert.ok(jobs.every((j) => j.status === "CANCELLED"), "los recordatorios de una cita cancelada no deben seguir pendientes");
});

test("un job programado en el pasado se procesa en el siguiente tick (recuperación tras reinicio)", async () => {
  const patient = await makePatient("sched-3");
  const slot = nextWeekday(3).set({ hour: 10, minute: 0 });
  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: slot });

  // Simulamos que ya tocaba mandar el recordatorio de 2h (como si el
  // proceso hubiera estado caído hasta ahora, dentro de la ventana
  // razonable de tolerancia).
  await prisma.scheduledJob.updateMany({
    where: { appointmentId: appt.id, type: "REMINDER_2H" },
    data: { scheduledAt: DateTime.now().minus({ minutes: 10 }).toJSDate() },
  });

  let handled = false;
  const { processed } = await processDueJobs({
    REMINDER_24H: async () => {},
    REMINDER_2H: async () => { handled = true; },
    WAITLIST_OFFER_EXPIRED: async () => {},
  });

  assert.ok(handled, "el job vencido debe procesarse en el tick, no perderse");
  assert.ok(processed >= 1);

  const job = await prisma.scheduledJob.findFirstOrThrow({ where: { appointmentId: appt.id, type: "REMINDER_2H" } });
  assert.equal(job.status, "COMPLETED");
});

test("un job MUY vencido (fuera de la ventana razonable) se cancela en vez de procesarse tarde", async () => {
  const patient = await makePatient("sched-4");
  const slot = nextWeekday(4).set({ hour: 10, minute: 0 });
  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: slot });

  // El recordatorio de 2h tolera hasta 1h de retraso (ver persistentJobs.ts) — simulamos 3h.
  await prisma.scheduledJob.updateMany({
    where: { appointmentId: appt.id, type: "REMINDER_2H" },
    data: { scheduledAt: DateTime.now().minus({ hours: 3 }).toJSDate() },
  });

  let handled = false;
  await processDueJobs({
    REMINDER_24H: async () => {},
    REMINDER_2H: async () => { handled = true; },
    WAITLIST_OFFER_EXPIRED: async () => {},
  });

  assert.equal(handled, false, "no debería enviarse un recordatorio de 2h con 3h de retraso");
  const job = await prisma.scheduledJob.findFirstOrThrow({ where: { appointmentId: appt.id, type: "REMINDER_2H" } });
  assert.equal(job.status, "CANCELLED");
});

});
