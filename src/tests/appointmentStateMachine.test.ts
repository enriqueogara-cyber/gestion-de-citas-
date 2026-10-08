import test from "node:test";
import assert from "node:assert/strict";
import { canTransition, assertTransition, InvalidTransitionError } from "../domain/appointmentStateMachine";

test("PENDING_CONFIRMATION puede pasar a CONFIRMED, CANCELLED o NO_SHOW", () => {
  assert.equal(canTransition("PENDING_CONFIRMATION", "CONFIRMED"), true);
  assert.equal(canTransition("PENDING_CONFIRMATION", "CANCELLED"), true);
  assert.equal(canTransition("PENDING_CONFIRMATION", "NO_SHOW"), true);
});

test("CONFIRMED puede pasar a CANCELLED, COMPLETED o NO_SHOW", () => {
  assert.equal(canTransition("CONFIRMED", "CANCELLED"), true);
  assert.equal(canTransition("CONFIRMED", "COMPLETED"), true);
  assert.equal(canTransition("CONFIRMED", "NO_SHOW"), true);
});

test("una cita CANCELLED nunca puede volver a CONFIRMED (ni a ningún otro estado)", () => {
  assert.equal(canTransition("CANCELLED", "CONFIRMED"), false);
  assert.equal(canTransition("CANCELLED", "PENDING_CONFIRMATION"), false);
  assert.equal(canTransition("CANCELLED", "COMPLETED"), false);
});

test("COMPLETED y NO_SHOW son estados terminales", () => {
  assert.equal(canTransition("COMPLETED", "CONFIRMED"), false);
  assert.equal(canTransition("NO_SHOW", "CONFIRMED"), false);
});

test("assertTransition lanza InvalidTransitionError en una transición no permitida", () => {
  assert.throws(() => assertTransition("CANCELLED", "CONFIRMED"), InvalidTransitionError);
});

test("assertTransition no lanza en una transición permitida", () => {
  assert.doesNotThrow(() => assertTransition("PENDING_CONFIRMATION", "CONFIRMED"));
});
