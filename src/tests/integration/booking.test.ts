import test, { before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { getAvailability, bookAppointment } from "../../services/appointments";
import { BookingValidationError } from "../../domain/bookingEngine";
import { setServiceActive } from "../../services/serviceCatalog";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

describe("booking.test.ts", () => {
before(ensureCatalogReady);
beforeEach(cleanTransactionalData);

// TEST 1 — Carlos ocupado, Laura libre, ambos hacen el servicio -> el hueco
// sigue apareciendo disponible (unión por profesional, no recurso único).
test("TEST 1: si un profesional está ocupado pero otro cualificado está libre, el hueco sigue disponible", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  const carlos = await makeProfessional("Carlos", ["limpieza"]);
  const patientA = await makePatient("t1-a");
  const patientB = await makePatient("t1-b");

  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });

  // Ocupamos a Carlos a esa hora.
  await bookAppointment({
    patientId: patientA.id,
    patientName: "A",
    patientPhone: patientA.phone,
    serviceId: "limpieza",
    start: monday,
    professionalId: carlos.id,
  });

  const slots = await getAvailability("limpieza", 10);
  assert.ok(
    slots.some((s) => s.toMillis() === monday.toMillis()),
    "el hueco de las 10:00 debe seguir disponible porque Laura está libre"
  );

  // Y de verdad se puede reservar (con Laura, la única libre a esa hora).
  const appt = await bookAppointment({
    patientId: patientB.id,
    patientName: "B",
    patientPhone: patientB.phone,
    serviceId: "limpieza",
    start: monday,
  });
  assert.equal(appt.professionalId, laura.id);
});

// TEST 2 — ambos ocupados -> no disponible.
test("TEST 2: si TODOS los profesionales cualificados están ocupados, el hueco no está disponible", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  const carlos = await makeProfessional("Carlos", ["limpieza"]);
  const patientA = await makePatient("t2-a");
  const patientB = await makePatient("t2-b");
  const patientC = await makePatient("t2-c");

  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });

  await bookAppointment({ patientId: patientA.id, patientName: "A", patientPhone: patientA.phone, serviceId: "limpieza", start: monday, professionalId: laura.id });
  await bookAppointment({ patientId: patientB.id, patientName: "B", patientPhone: patientB.phone, serviceId: "limpieza", start: monday, professionalId: carlos.id });

  const slots = await getAvailability("limpieza", 10);
  assert.ok(!slots.some((s) => s.toMillis() === monday.toMillis()), "no debería quedar ese hueco libre");

  await assert.rejects(
    () => bookAppointment({ patientId: patientC.id, patientName: "C", patientPhone: patientC.phone, serviceId: "limpieza", start: monday }),
    (err: unknown) => err instanceof Error && err.name === "SlotTakenError"
  );
});

// TEST 3 — dos pacientes distintos, mismo horario, profesionales distintos -> AMBAS válidas. El centro NO es un recurso único.
test("TEST 3: dos citas a la misma hora con profesionales distintos son ambas válidas", async () => {
  const laura = await makeProfessional("Laura", ["revision"]);
  const carlos = await makeProfessional("Carlos", ["revision"]);
  const patientA = await makePatient("t3-a");
  const patientB = await makePatient("t3-b");
  const monday = nextWeekday(1).set({ hour: 11, minute: 0 });

  const apptA = await bookAppointment({ patientId: patientA.id, patientName: "A", patientPhone: patientA.phone, serviceId: "revision", start: monday, professionalId: laura.id });
  const apptB = await bookAppointment({ patientId: patientB.id, patientName: "B", patientPhone: patientB.phone, serviceId: "revision", start: monday, professionalId: carlos.id });

  const both = await prisma.appointment.findMany({ where: { id: { in: [apptA.id, apptB.id] } } });
  assert.equal(both.length, 2);
  assert.ok(both.every((a) => a.status === "PENDING_CONFIRMATION"));
});

// TEST 4 — mañana y tarde abiertas -> availability devuelve ambas (sin límite corto ocultando la tarde, ver bug real de la ronda anterior).
test("TEST 4: la disponibilidad de un día concreto incluye mañana y tarde", async () => {
  await makeProfessional("Profesional de prueba");
  const tuesday = nextWeekday(2); // martes: 09:00-14:00, 16:00-20:00
  const slots = await getAvailability("consulta_general", 1, undefined, tuesday);
  assert.ok(slots.some((s) => s.hour < 14), "debe haber huecos de mañana");
  assert.ok(slots.some((s) => s.hour >= 16), "debe haber huecos de tarde");
});

// TEST 10 — servicio desactivado no puede recibir reservas nuevas.
test("TEST 10: un servicio desactivado no admite reservas nuevas", async () => {
  // setServiceActive espera el slug (lo mismo que manda la UI de Settings
  // y lo mismo que usa el resto del dominio como serviceId), no el id
  // interno de Prisma — ver comentario en services/serviceCatalog.ts.
  await setServiceActive("revision", false);
  try {
    const patient = await makePatient("t10");
    const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
    await assert.rejects(
      () => bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday }),
      (err: unknown) => err instanceof BookingValidationError && err.code === "SERVICE_INACTIVE"
    );
  } finally {
    await setServiceActive("revision", true); // no dejamos el catálogo compartido roto para el resto de tests
  }
});

});
