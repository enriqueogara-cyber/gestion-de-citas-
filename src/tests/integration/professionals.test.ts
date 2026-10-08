import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { bookAppointment } from "../../services/appointments";
import { BookingValidationError } from "../../domain/bookingEngine";
import { deactivateProfessional, getQualifiedProfessionals } from "../../services/professionals";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

before(ensureCatalogReady);
beforeEach(cleanTransactionalData);

// TEST 11 — un profesional desactivado no puede recibir citas nuevas, ni
// pedido explícitamente ni por asignación automática.
test("TEST 11: un profesional desactivado no admite reservas nuevas, ni explícitas ni automáticas", async () => {
  const laura = await makeProfessional("Laura", ["limpieza"]);
  await deactivateProfessional(laura.id);

  const patient = await makePatient("t11");
  const slot = nextWeekday(1).set({ hour: 10, minute: 0 });

  // Pedida explícitamente: rechazada.
  await assert.rejects(
    () => bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "limpieza", start: slot, professionalId: laura.id }),
    (err: unknown) => err instanceof BookingValidationError && err.code === "PROFESSIONAL_NOT_AVAILABLE"
  );

  // Ni tampoco aparece como cualificada para asignación automática.
  const qualified = await getQualifiedProfessionals("limpieza");
  assert.ok(!qualified.some((p) => p.id === laura.id));
});

// Complementario: dar de baja a un profesional no borra el historial de sus citas ya hechas.
test("Dar de baja a un profesional no borra ni desvincula sus citas históricas", async () => {
  const laura = await makeProfessional("Laura", ["revision"]);
  const patient = await makePatient("t11b");
  const slot = nextWeekday(2).set({ hour: 10, minute: 0 });

  const appt = await bookAppointment({ patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: slot, professionalId: laura.id });

  await deactivateProfessional(laura.id);

  const stillLinked = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, include: { professional: true } });
  assert.equal(stillLinked.professionalId, laura.id);
  assert.equal(stillLinked.professional?.name, "Laura");
});
