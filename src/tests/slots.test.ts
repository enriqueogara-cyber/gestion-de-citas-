import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { clinicConfig } from "../config";
import { computeSlotsFromBusy, isWithinOpeningHours } from "../calendar/slots";

const tz = clinicConfig.timezone;

/** Próximo día con ese weekday de luxon (1=lunes..7=domingo), a las 00:00 hora del centro. */
function nextWeekday(target: number): DateTime {
  let d = DateTime.now().setZone(tz).startOf("day").plus({ days: 1 }); // desde mañana, nunca "hoy"
  while (d.weekday !== target) d = d.plus({ days: 1 });
  return d;
}

const service = { id: "test-service", label: "Test", durationMinutes: 30 };

test("computeSlotsFromBusy: genera huecos dentro del horario de apertura", () => {
  const monday = nextWeekday(1); // lunes: 09:00-14:00, 16:00-20:00
  const slots = computeSlotsFromBusy(service, [], { fromDate: monday, daysAhead: 1, maxSlots: 100 });

  assert.ok(slots.length > 0, "debería haber huecos un lunes");
  for (const s of slots) {
    assert.ok(isWithinOpeningHours(s, s.plus({ minutes: service.durationMinutes })), `slot ${s.toISO()} fuera de horario`);
  }
});

test("computeSlotsFromBusy: no genera huecos en domingo (centro cerrado)", () => {
  const sunday = nextWeekday(7);
  const slots = computeSlotsFromBusy(service, [], { fromDate: sunday, daysAhead: 1, maxSlots: 100 });
  assert.equal(slots.length, 0);
});

test("computeSlotsFromBusy: respeta intervalos ocupados (no solapa)", () => {
  const monday = nextWeekday(1);
  const busyStart = monday.set({ hour: 9, minute: 0 });
  const busyEnd = monday.set({ hour: 14, minute: 0 }); // toda la mañana ocupada
  const slots = computeSlotsFromBusy(service, [{ start: busyStart, end: busyEnd }], {
    fromDate: monday,
    daysAhead: 1,
    maxSlots: 100,
  });

  for (const s of slots) {
    assert.ok(s >= busyEnd || s.plus({ minutes: 30 }) <= busyStart, `slot ${s.toISO()} debería estar bloqueado`);
  }
  // Debe seguir habiendo huecos por la tarde (16:00-20:00), que no está ocupada.
  assert.ok(slots.some((s) => s.hour >= 16));
});

test("computeSlotsFromBusy: un servicio que no cabe en el hueco de tarde de los viernes no genera hueco fantasma", () => {
  const friday = nextWeekday(5); // viernes: solo 09:00-14:00
  const longService = { id: "x", label: "Largo", durationMinutes: 600 }; // 10h, no cabe en ningún bloque
  const slots = computeSlotsFromBusy(longService, [], { fromDate: friday, daysAhead: 1, maxSlots: 100 });
  assert.equal(slots.length, 0);
});

test("isWithinOpeningHours: dentro de horario válido", () => {
  const monday = nextWeekday(1).set({ hour: 10, minute: 0 });
  assert.equal(isWithinOpeningHours(monday, monday.plus({ minutes: 30 })), true);
});

test("isWithinOpeningHours: en el hueco de la comida (14:00-16:00) es inválido", () => {
  const monday = nextWeekday(1).set({ hour: 14, minute: 30 });
  assert.equal(isWithinOpeningHours(monday, monday.plus({ minutes: 30 })), false);
});

test("isWithinOpeningHours: antes de abrir es inválido", () => {
  const monday = nextWeekday(1).set({ hour: 7, minute: 0 });
  assert.equal(isWithinOpeningHours(monday, monday.plus({ minutes: 30 })), false);
});

test("isWithinOpeningHours: domingo cerrado es inválido", () => {
  const sunday = nextWeekday(7).set({ hour: 10, minute: 0 });
  assert.equal(isWithinOpeningHours(sunday, sunday.plus({ minutes: 30 })), false);
});

test("isWithinOpeningHours: cita que cruza el cierre es inválida aunque empiece dentro", () => {
  const monday = nextWeekday(1).set({ hour: 13, minute: 45 }); // termina a las 14:15, después de cerrar a las 14:00
  assert.equal(isWithinOpeningHours(monday, monday.plus({ minutes: 30 })), false);
});

test("computeSlotsFromBusy: bug real — un maxSlots corto se agota en el bloque de mañana y nunca llega al de tarde", () => {
  const monday = nextWeekday(1); // lunes: 09:00-14:00, 16:00-20:00 — dos bloques
  // El límite por defecto de la app (clinicConfig.maxSlotsToOffer = 5) es
  // más que suficiente para agotarse solo en la mañana con un servicio
  // corto, exactamente el bug que se detectó consultando disponibilidad de
  // un día concreto: la tarde (perfectamente abierta) no aparecía nunca.
  const withShortCap = computeSlotsFromBusy(service, [], { fromDate: monday, daysAhead: 1, maxSlots: 5 });
  assert.ok(withShortCap.every((s) => s.hour < 14), "con un límite corto, todos los huecos caen en la mañana");

  // La corrección (getAvailability pasa un maxSlots generoso cuando se
  // pregunta por un día concreto) debe dejar ver la tarde también.
  const withGenerousCap = computeSlotsFromBusy(service, [], { fromDate: monday, daysAhead: 1, maxSlots: 200 });
  assert.ok(withGenerousCap.some((s) => s.hour >= 16), "con un límite generoso, sí aparecen huecos de tarde");
});

test("computeSlotsFromBusy: zona horaria consistente independientemente de la zona del proceso", () => {
  const monday = nextWeekday(1);
  const slots = computeSlotsFromBusy(service, [], { fromDate: monday, daysAhead: 1, maxSlots: 1 });
  assert.equal(slots[0].zoneName, tz);
  assert.equal(slots[0].hour, 9); // el primer hueco del día debe ser justo al abrir, 09:00 hora del centro
});
