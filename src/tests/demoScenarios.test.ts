import test from "node:test";
import assert from "node:assert/strict";
import { getRecoverySlotDemoService } from "../services/demoScenarios";
import { clinicConfig } from "../config";

// Bug real que arregla esto: el escenario de demo elegía "el primer
// servicio con priceEur", que dependía del orden de clinicConfig.services y
// podía no coincidir con el precio que anunciaba el botón del dashboard
// (bug observado: el botón decía "85 €" pero el escenario recuperaba un
// servicio de 40 €). Ahora se elige siempre el de mayor precio, de forma
// determinista, y el dashboard pinta el precio real de ESTE mismo servicio.

test("getRecoverySlotDemoService: elige siempre el servicio de mayor precio, no el primero con precio", () => {
  const chosen = getRecoverySlotDemoService();
  const maxPrice = Math.max(...clinicConfig.services.map((s) => s.priceEur ?? -1));
  assert.equal(chosen.priceEur, maxPrice);
});

test("getRecoverySlotDemoService: es determinista (llamadas repetidas dan siempre el mismo servicio)", () => {
  const a = getRecoverySlotDemoService();
  const b = getRecoverySlotDemoService();
  assert.equal(a.id, b.id);
});
