import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { selectRepresentativeSlots } from "../agent/slotPresentation";

// Un día con mañana (09:00-14:00) y tarde (16:00-20:00) a intervalos de 15
// min — el mismo patrón real que genera calendar/slots.ts.
function buildDaySlots(dateIso: string, ranges: { start: string; end: string }[]): DateTime[] {
  const slots: DateTime[] = [];
  for (const r of ranges) {
    let cursor = DateTime.fromISO(`${dateIso}T${r.start}`);
    const end = DateTime.fromISO(`${dateIso}T${r.end}`);
    while (cursor < end) {
      slots.push(cursor);
      cursor = cursor.plus({ minutes: 15 });
    }
  }
  return slots;
}

const fullDay = buildDaySlots("2026-03-05", [
  { start: "09:00", end: "14:00" },
  { start: "16:00", end: "20:00" },
]);

test("sin preferencia: nunca devuelve más de maxResults, aunque el pool tenga decenas de huecos", () => {
  const picked = selectRepresentativeSlots(fullDay);
  assert.ok(picked.length > 0);
  assert.ok(picked.length <= 6);
});

test("sin preferencia: si hay mañana y tarde disponibles, el resultado incluye de ambas franjas", () => {
  const picked = selectRepresentativeSlots(fullDay);
  assert.ok(picked.some((s) => s.hour < 14), "debe haber algo de mañana");
  assert.ok(picked.some((s) => s.hour >= 16), "debe haber algo de tarde");
});

test("nunca inventa un hueco: todo lo devuelto es un elemento real de allSlots", () => {
  const picked = selectRepresentativeSlots(fullDay, { maxResults: 6 });
  const allMillis = new Set(fullDay.map((s) => s.toMillis()));
  assert.ok(picked.every((s) => allMillis.has(s.toMillis())));
});

test("time_of_day=MORNING: solo huecos de mañana", () => {
  const picked = selectRepresentativeSlots(fullDay, { timeOfDay: "MORNING" });
  assert.ok(picked.length > 0);
  assert.ok(picked.every((s) => s.hour < 14));
});

test("time_of_day=AFTERNOON: solo huecos de tarde", () => {
  const picked = selectRepresentativeSlots(fullDay, { timeOfDay: "AFTERNOON" });
  assert.ok(picked.length > 0);
  assert.ok(picked.every((s) => s.hour >= 14));
});

test("earliest: el primer hueco real, no un valor inventado", () => {
  const picked = selectRepresentativeSlots(fullDay, { earliest: true });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].toMillis(), fullDay[0].toMillis());
});

test("latest: el último hueco real", () => {
  const picked = selectRepresentativeSlots(fullDay, { latest: true });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].toMillis(), fullDay[fullDay.length - 1].toMillis());
});

test("around_time='18:00': los huecos devueltos son los más cercanos a esa hora", () => {
  const picked = selectRepresentativeSlots(fullDay, { aroundTime: "18:00", maxResults: 3 });
  assert.equal(picked.length, 3);
  for (const s of picked) {
    const diffMinutes = Math.abs(s.hour * 60 + s.minute - 18 * 60);
    assert.ok(diffMinutes <= 45, `hueco ${s.toFormat("HH:mm")} debería estar cerca de las 18:00`);
  }
});

test("time_range 16:00-19:00: excluye todo lo de fuera del rango", () => {
  const picked = selectRepresentativeSlots(fullDay, { timeRangeStart: "16:00", timeRangeEnd: "19:00" });
  assert.ok(picked.length > 0);
  assert.ok(picked.every((s) => s.hour >= 16 && s.hour <= 19));
});

test("preferencia imposible (franja sin ningún hueco real) devuelve vacío, no inventa nada", () => {
  const morningOnly = buildDaySlots("2026-03-06", [{ start: "09:00", end: "11:00" }]);
  const picked = selectRepresentativeSlots(morningOnly, { timeOfDay: "AFTERNOON" });
  assert.deepEqual(picked, []);
});

test("maxResults se respeta con around_time también", () => {
  const picked = selectRepresentativeSlots(fullDay, { aroundTime: "10:00", maxResults: 2 });
  assert.equal(picked.length, 2);
});
