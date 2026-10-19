import test from "node:test";
import assert from "node:assert/strict";
import { containsClinicalText, minimizeForModel } from "../agent/privacy";

test("las consultas clínicas se derivan sin pasar el texto al modelo", () => {
  const text = "Tengo dolor y tomo medicación. Mi teléfono es +34 612 345 678";
  assert.equal(containsClinicalText(text), true);
  assert.equal(minimizeForModel(text), "[consulta clínica omitida; derivar a una persona]");
});

test("los identificadores directos se eliminan del contexto del modelo", () => {
  const safe = minimizeForModel("Me llamo Ana Pérez, escríbeme a ana@example.com o al +34 612 345 678. Tengo cita mañana.");
  assert.doesNotMatch(safe, /Ana|example|612 345 678/);
  assert.match(safe, /cita mañana/);
});
