import test from "node:test";
import assert from "node:assert/strict";
import { serviceLabel, servicePriceEur } from "../lib/labels";
import { clinicConfig } from "../config";

// Bug real que arregla lib/labels.ts: el dashboard y la lista de espera
// imprimían Appointment.service tal cual ("consulta_general") en vez de
// traducirlo a lo que ve un humano ("Consulta general").

test("serviceLabel: traduce un id conocido a su etiqueta legible, no el slug", () => {
  const first = clinicConfig.services[0];
  const label = serviceLabel(first.id);
  assert.equal(label, first.label);
  assert.notEqual(label, first.id);
});

test("serviceLabel: un id desconocido no revienta, hace fallback al propio id", () => {
  assert.equal(serviceLabel("id-que-no-existe"), "id-que-no-existe");
});

test("servicePriceEur: devuelve el precio configurado o null si no hay", () => {
  const priced = clinicConfig.services.find((s) => s.priceEur != null)!;
  assert.equal(servicePriceEur(priced.id), priced.priceEur);
  assert.equal(servicePriceEur("id-que-no-existe"), null);
});
