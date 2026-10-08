import test from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { isCandidateCompatible, timeOfDayOf } from "../domain/waitlistMatching";

const base = {
  earliestDate: DateTime.fromISO("2026-03-01T00:00:00").toJSDate(),
  latestDate: DateTime.fromISO("2026-03-10T00:00:00").toJSDate(),
  professionalId: null as string | null,
  preferredTimeOfDay: null as string | null,
};

test("timeOfDayOf: antes de las 14:00 es MORNING, desde las 14:00 es AFTERNOON", () => {
  assert.equal(timeOfDayOf(DateTime.fromISO("2026-03-01T09:00:00")), "MORNING");
  assert.equal(timeOfDayOf(DateTime.fromISO("2026-03-01T13:59:00")), "MORNING");
  assert.equal(timeOfDayOf(DateTime.fromISO("2026-03-01T14:00:00")), "AFTERNOON");
  assert.equal(timeOfDayOf(DateTime.fromISO("2026-03-01T18:00:00")), "AFTERNOON");
});

test("compatible cuando el hueco cae dentro del rango de fechas y no hay más preferencias", () => {
  const slot = DateTime.fromISO("2026-03-05T10:00:00");
  assert.equal(isCandidateCompatible(base, slot, null), true);
});

test("incompatible si el hueco cae fuera del rango de fechas", () => {
  const before = DateTime.fromISO("2026-02-20T10:00:00");
  const after = DateTime.fromISO("2026-03-20T10:00:00");
  assert.equal(isCandidateCompatible(base, before, null), false);
  assert.equal(isCandidateCompatible(base, after, null), false);
});

test("si pidió un profesional concreto, un hueco de otro profesional es incompatible", () => {
  const entry = { ...base, professionalId: "pro-laura" };
  const slot = DateTime.fromISO("2026-03-05T10:00:00");
  assert.equal(isCandidateCompatible(entry, slot, "pro-carlos"), false);
  assert.equal(isCandidateCompatible(entry, slot, "pro-laura"), true);
  assert.equal(isCandidateCompatible(entry, slot, null), false); // no hay profesional asignado a ese hueco
});

test("sin profesional preferido, cualquier profesional (o ninguno) vale", () => {
  const slot = DateTime.fromISO("2026-03-05T10:00:00");
  assert.equal(isCandidateCompatible(base, slot, "pro-cualquiera"), true);
  assert.equal(isCandidateCompatible(base, slot, null), true);
});

test("si pidió franja de mañana, un hueco de tarde es incompatible", () => {
  const entry = { ...base, preferredTimeOfDay: "MORNING" };
  const morningSlot = DateTime.fromISO("2026-03-05T10:00:00");
  const afternoonSlot = DateTime.fromISO("2026-03-05T17:00:00");
  assert.equal(isCandidateCompatible(entry, morningSlot, null), true);
  assert.equal(isCandidateCompatible(entry, afternoonSlot, null), false);
});
