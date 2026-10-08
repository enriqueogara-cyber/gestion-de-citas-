import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { clinicConfig } from "../../config";
import { bookAppointment } from "../../services/appointments";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

before(ensureCatalogReady);
beforeEach(cleanTransactionalData);

// TEST 9 — dos requests concurrentes, mismo profesional, mismo slot: como
// máximo una gana. Esta es LA prueba de la protección contra dobles
// reservas (ver README, "Idempotencia y dobles reservas") con concurrencia
// real, no solo teórica.
test("TEST 9: dos reservas concurrentes para el mismo profesional y el mismo hueco — solo una gana", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  const patientA = await makePatient("t9-a");
  const patientB = await makePatient("t9-b");
  const slot = nextWeekday(3).set({ hour: 10, minute: 0 });

  const attempt = (patientId: string, name: string, phone: string) =>
    bookAppointment({ patientId, patientName: name, patientPhone: phone, serviceId: "limpieza", start: slot, professionalId: laura.id })
      .then(() => "ok" as const)
      .catch(() => "rejected" as const);

  const [r1, r2] = await Promise.all([
    attempt(patientA.id, "A", patientA.phone),
    attempt(patientB.id, "B", patientB.phone),
  ]);

  const outcomes = [r1, r2];
  assert.equal(outcomes.filter((o) => o === "ok").length, 1, "exactamente una reserva debe ganar");
  assert.equal(outcomes.filter((o) => o === "rejected").length, 1, "la otra debe fallar, no colarse");
});

// Repetido con más concurrencia (5 intentos a la vez) para no depender de
// que 2 sea "casualmente" seguro.
test("TEST 9b: cinco reservas concurrentes para el mismo hueco — solo una gana", async () => {
  const carlos = await makeProfessional("Carlos", ["revision"]);
  const patients = await Promise.all([0, 1, 2, 3, 4].map((i) => makePatient(`t9b-${i}`)));
  const slot = nextWeekday(4).set({ hour: 11, minute: 0 });

  const results = await Promise.all(
    patients.map((p) =>
      bookAppointment({ patientId: p.id, patientName: p.id, patientPhone: p.phone, serviceId: "revision", start: slot, professionalId: carlos.id })
        .then(() => "ok" as const)
        .catch(() => "rejected" as const)
    )
  );
  assert.equal(results.filter((r) => r === "ok").length, 1);
});
