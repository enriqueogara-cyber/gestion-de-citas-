import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { bookAppointment, rescheduleAppointment } from "../../services/appointments";
import { ensureCatalogReady, makeProfessional, makePatient, cleanTransactionalData } from "./setup";

const tz = clinicConfig.timezone;

function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 });
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

before(ensureCatalogReady);
beforeEach(cleanTransactionalData);

// TEST 5 — reschedule correcto: vieja CANCELLED, nueva activa, evento correcto.
test("TEST 5: reschedule exitoso cancela la vieja, activa la nueva y registra un único evento", async () => {
  const patient = await makePatient("t5");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });

  const original = await bookAppointment({
    patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday,
  });

  const newStart = monday.plus({ hours: 1 });
  const moved = await rescheduleAppointment({
    appointmentId: original.id, patientId: patient.id, patientName: "X", patientPhone: patient.phone, newStart,
  });

  const [oldRow, newRow] = await Promise.all([
    prisma.appointment.findUniqueOrThrow({ where: { id: original.id } }),
    prisma.appointment.findUniqueOrThrow({ where: { id: moved.id } }),
  ]);
  assert.equal(oldRow.status, "CANCELLED");
  assert.equal(newRow.status, "PENDING_CONFIRMATION");
  assert.equal(newRow.startsAt.getTime(), newStart.toJSDate().getTime());

  const events = await prisma.auditLog.findMany({ where: { type: "APPOINTMENT_RESCHEDULED", appointmentId: moved.id } });
  assert.equal(events.length, 1);
});

// TEST 6 — falla la creación de la nueva (hueco ocupado) -> la cita original queda intacta, sin tocar.
test("TEST 6: si el hueco nuevo no está libre, la cita original no se toca", async () => {
  const patient = await makePatient("t6");
  const other = await makePatient("t6-other");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  const busySlot = monday.plus({ hours: 2 });

  const original = await bookAppointment({
    patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday,
  });
  // Ocupamos el hueco al que se quiere mover, con OTRO paciente/profesional=cualquiera.
  await bookAppointment({
    patientId: other.id, patientName: "Y", patientPhone: other.phone, serviceId: "revision", start: busySlot,
  });

  await assert.rejects(() =>
    rescheduleAppointment({
      appointmentId: original.id, patientId: patient.id, patientName: "X", patientPhone: patient.phone, newStart: busySlot,
    })
  );

  const stillThere = await prisma.appointment.findUniqueOrThrow({ where: { id: original.id } });
  assert.equal(stillThere.status, "PENDING_CONFIRMATION");
  assert.equal(stillThere.startsAt.getTime(), monday.toJSDate().getTime());
});

/**
 * TEST 7/8 — caminos de compensación cuando cancelar la cita VIEJA falla
 * DESPUÉS de haber creado la nueva.
 *
 * Para forzar ese fallo de forma determinista sin tocar código de
 * producción (nada de mocking de módulo propio ni de inyectar
 * dependencias solo para tests), se mockea `prisma.appointment.updateMany`
 * — una dependencia EXTERNA real (el cliente de base de datos), no lógica
 * interna de `rescheduleAppointment`. Es el mismo método que usa
 * `transitionAppointment` (compare-and-swap) para cualquier cambio de
 * estado, así que interceptarlo simula fielmente "la escritura a BD ha
 * fallado en este paso concreto" y deja pasar sin tocar todo lo demás
 * (crear la cita nueva usa `tx.appointment.create` dentro de una
 * transacción, un cliente distinto — no se ve afectado).
 *
 * `t.mock.method` (la utilidad "oficial" de node:test) no sirve aquí: los
 * delegados de modelo de Prisma exponen `updateMany` por su PROTOTIPO
 * compartido, no como propiedad propia de la instancia, y
 * `MockTracker.method` exige una propiedad propia — falla con "must be a
 * method". La alternativa igual de legítima (sigue mockeando el cliente de
 * BD, no lógica propia) es sustituir la función a mano y restaurarla en un
 * `finally`, que es exactamente lo que hace `t.mock.method` por dentro.
 */
test("TEST 7: si cancelar la cita vieja falla tras crear la nueva, se compensa cancelando la nueva y la original queda intacta", async () => {
  const patient = await makePatient("t7");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });

  const original = await bookAppointment({
    patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday,
  });
  const newStart = monday.plus({ hours: 1 });

  const originalUpdateMany = prisma.appointment.updateMany.bind(prisma.appointment);
  (prisma.appointment as any).updateMany = async (args: any) => {
    // Falla SOLO al cancelar la cita ORIGINAL (el paso que
    // rescheduleAppointment hace justo después de reservar la nueva).
    // Cualquier otra llamada (incluida la propia compensación) usa la
    // implementación real.
    if (args?.where?.id === original.id && args?.data?.status === "CANCELLED") {
      throw new Error("DB write failed (simulado)");
    }
    return originalUpdateMany(args);
  };

  try {
    await assert.rejects(
      () =>
        rescheduleAppointment({
          appointmentId: original.id, patientId: patient.id, patientName: "X", patientPhone: patient.phone, newStart,
        }),
      /No se ha podido completar el cambio/
    );

    // La cita ORIGINAL sigue activa tal cual estaba.
    const oldRow = await prisma.appointment.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(oldRow.status, "PENDING_CONFIRMATION");
    assert.equal(oldRow.startsAt.getTime(), monday.toJSDate().getTime());

    // La cita nueva que se llegó a crear quedó cancelada por la
    // compensación: no debe quedar ninguna cita activa en el hueco nuevo.
    const activeAtNewSlot = await prisma.appointment.findFirst({
      where: { patientId: patient.id, startsAt: newStart.toJSDate(), status: { in: ["PENDING_CONFIRMATION", "CONFIRMED"] } },
    });
    assert.equal(activeAtNewSlot, null);

    const compensatedEvents = await prisma.auditLog.findMany({ where: { type: "AGENT_ERROR", appointmentId: original.id } });
    assert.equal(compensatedEvents.length, 1);
    assert.equal(JSON.parse(compensatedEvents[0].metadata).phase, "reschedule_compensated");
  } finally {
    (prisma.appointment as any).updateMany = originalUpdateMany;
  }
});

// TEST 8 — el peor caso: cancelar la vieja falla Y la propia compensación
// (cancelar la nueva) también falla. Nunca se debe fingir éxito: tiene que
// quedar un evento explícito de revisión humana.
test("TEST 8: si además falla la propia compensación, se registra RESCHEDULE_INCONSISTENT y nunca se dice que salió bien", async () => {
  const patient = await makePatient("t8");
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });

  const original = await bookAppointment({
    patientId: patient.id, patientName: "X", patientPhone: patient.phone, serviceId: "revision", start: monday,
  });
  const newStart = monday.plus({ hours: 1 });

  const originalUpdateMany = prisma.appointment.updateMany.bind(prisma.appointment);
  (prisma.appointment as any).updateMany = async (args: any) => {
    // Falla CUALQUIER cancelación (la de la vieja y la de la compensación).
    if (args?.data?.status === "CANCELLED") {
      throw new Error("DB write failed (simulado)");
    }
    return originalUpdateMany(args);
  };

  try {
    await assert.rejects(
      () =>
        rescheduleAppointment({
          appointmentId: original.id, patientId: patient.id, patientName: "X", patientPhone: patient.phone, newStart,
        }),
      /el centro va a revisarlo/
    );

    // Estado real inconsistente (la vieja sigue activa, la nueva también
    // pudo quedar creada) — pero eso es justo lo que se está verificando:
    // nunca se ha registrado un evento de éxito, y sí uno explícito de
    // "revisión necesaria".
    const oldRow = await prisma.appointment.findUniqueOrThrow({ where: { id: original.id } });
    assert.equal(oldRow.status, "PENDING_CONFIRMATION");

    const successEvents = await prisma.auditLog.findMany({ where: { type: "APPOINTMENT_RESCHEDULED", patientId: patient.id } });
    assert.equal(successEvents.length, 0, "nunca se debe registrar éxito si el estado quedó inconsistente");

    const inconsistentEvents = await prisma.auditLog.findMany({ where: { type: "RESCHEDULE_INCONSISTENT", patientId: patient.id } });
    assert.equal(inconsistentEvents.length, 1);
    const meta = JSON.parse(inconsistentEvents[0].metadata);
    assert.equal(meta.oldAppointmentId, original.id);
  } finally {
    (prisma.appointment as any).updateMany = originalUpdateMany;
  }
});
