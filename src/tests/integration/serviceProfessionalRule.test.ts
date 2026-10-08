import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { clinicConfig } from "../../config";
import { getAvailability, bookAppointment } from "../../services/appointments";
import { BookingValidationError } from "../../domain/bookingEngine";
import { resolveServiceProfessionals } from "../../services/professionals";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

/**
 * Regla servicio ↔ profesional: un servicio solo es reservable si existe
 * AL MENOS un profesional activo, del centro, explícitamente cualificado
 * para ese servicio y libre en ese horario. Nunca se infiere "cualquiera
 * puede" por ausencia de relaciones cuando YA hay profesionales dados de
 * alta — el único "cualquiera puede" legítimo es que el centro no tenga
 * NINGÚN profesional en absoluto (modo MVP de recurso único, ver
 * services/professionals.ts -> resolveServiceProfessionals).
 */

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

before(ensureCatalogReady);
beforeEach(cleanTransactionalData);

// Caso A — el servicio está activo, hay profesionales dados de alta en el
// centro, pero NINGUNO de ellos tiene este servicio marcado: ni
// disponibilidad ni reserva, nunca "cualquiera puede" por defecto.
test("Caso A: servicio activo sin ningún profesional cualificado -> sin disponibilidad y sin reserva posible", async () => {
  // Laura y Carlos existen, pero ninguno hace "revision" (ambos solo hacen
  // "limpieza") — el servicio queda, a efectos prácticos, sin nadie.
  await makeProfessional("Laura", ["limpieza"]);
  await makeProfessional("Carlos", ["limpieza"]);

  const resolved = await resolveServiceProfessionals("revision");
  assert.equal(resolved.mode, "qualified");
  assert.equal(resolved.mode === "qualified" ? resolved.professionals.length : -1, 0);

  const slots = await getAvailability("revision", 10);
  assert.equal(slots.length, 0, "no debe ofrecerse ningún hueco para un servicio sin profesional cualificado");

  const patient = await makePatient("rule-a");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  await assert.rejects(
    () => bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday }),
    (err: unknown) =>
      err instanceof BookingValidationError &&
      err.code === "PROFESSIONAL_NOT_AVAILABLE" &&
      /no hay ningún profesional disponible/.test(err.message)
  );
});

// Caso B — Carlos es el único que hace el servicio y está libre: sí hay disponibilidad y sí se puede reservar (con él).
test("Caso B: servicio con un único profesional cualificado y libre -> disponible y reservable", async () => {
  const carlos = await makeProfessional("Carlos", ["revision"]);
  await makeProfessional("Laura", ["limpieza"]); // existe pero no hace este servicio

  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  const slots = await getAvailability("revision", 10);
  assert.ok(slots.some((s) => s.toMillis() === monday.toMillis()));

  const patient = await makePatient("rule-b");
  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday });
  assert.equal(appt.professionalId, carlos.id);
});

// Caso C — Carlos es el único cualificado y está ocupado: NO hay
// disponibilidad, aunque Laura esté completamente libre (ella no hace este servicio).
test("Caso C: único profesional cualificado ocupado -> sin disponibilidad aunque otro (no cualificado) esté libre", async () => {
  const carlos = await makeProfessional("Carlos", ["revision"]);
  await makeProfessional("Laura", ["limpieza"]);

  const other = await makePatient("rule-c-other");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  await bookAppointment({ patientId: other.id, patientName: "Y", patientPhone: other.phone, serviceId: "revision", start: monday, professionalId: carlos.id });

  const slots = await getAvailability("revision", 10);
  assert.ok(!slots.some((s) => s.toMillis() === monday.toMillis()), "el hueco no debe aparecer: Laura no puede cubrirlo, no hace ese servicio");

  const patient = await makePatient("rule-c");
  await assert.rejects(
    () => bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday })
  );
});

// Caso D — Laura y Carlos hacen el servicio; Carlos ocupado, Laura libre -> disponible con Laura.
test("Caso D: dos profesionales cualificados, uno ocupado -> disponible con el que está libre", async () => {
  const carlos = await makeProfessional("Carlos", ["revision"]);
  const laura = await makeProfessional("Laura", ["revision"]);

  const other = await makePatient("rule-d-other");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  await bookAppointment({ patientId: other.id, patientName: "Y", patientPhone: other.phone, serviceId: "revision", start: monday, professionalId: carlos.id });

  const slots = await getAvailability("revision", 10);
  assert.ok(slots.some((s) => s.toMillis() === monday.toMillis()), "Laura sigue libre a esa hora, el hueco debe seguir apareciendo");

  const patient = await makePatient("rule-d");
  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday });
  assert.equal(appt.professionalId, laura.id, "debe asignarse automáticamente al único libre (Laura), nunca a Carlos");
});

// Caso E — se pide explícitamente un professionalId incompatible con el servicio: el backend lo rechaza, nunca confía en lo que proponga el LLM.
test("Caso E: professionalId incompatible pedido explícitamente -> el backend lo rechaza siempre", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]); // NO hace "revision"
  await makeProfessional("Carlos", ["revision"]);

  const patient = await makePatient("rule-e");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  await assert.rejects(
    () => bookAppointment({
      patientId: patient.id, patientName: "X", patientPhone: patient.phone,
      serviceId: "revision", start: monday, professionalId: laura.id,
    }),
    (err: unknown) => err instanceof BookingValidationError && err.code === "PROFESSIONAL_NOT_AVAILABLE"
  );
});

// Complementario — modo MVP legítimo: si el centro no tiene NINGÚN
// profesional dado de alta, el servicio SIGUE siendo reservable (recurso
// único), no se activa el rechazo del Caso A.
test("Sin ningún profesional dado de alta en el centro (modo MVP): el servicio sigue siendo reservable", async () => {
  const resolved = await resolveServiceProfessionals("revision");
  assert.equal(resolved.mode, "no-professionals-onboarded");

  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  const slots = await getAvailability("revision", 10);
  assert.ok(slots.some((s) => s.toMillis() === monday.toMillis()));

  const patient = await makePatient("rule-mvp");
  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday });
  assert.equal(appt.professionalId, null);
});
