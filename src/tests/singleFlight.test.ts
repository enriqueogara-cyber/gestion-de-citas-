import test from "node:test";
import assert from "node:assert/strict";
import { singleFlight, AlreadyRunningError } from "../lib/singleFlight";

// Esto es lo que garantiza que "pulsar dos veces el botón de demo" (seed,
// reset, recuperar hueco) no pueda ejecutar la acción dos veces en paralelo
// ni, por tanto, contar ingresos recuperados por duplicado.

function delayed<T>(value: T, ms = 20): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

test("singleFlight: una segunda llamada con la misma clave mientras la primera sigue en curso se rechaza", async () => {
  const first = singleFlight("demo:x", () => delayed("ok-1", 30));
  await new Promise((r) => setTimeout(r, 5)); // aseguramos que "first" ya ha arrancado
  await assert.rejects(() => singleFlight("demo:x", () => delayed("ok-2", 5)), AlreadyRunningError);
  assert.equal(await first, "ok-1");
});

test("singleFlight: tras terminar, la misma clave se puede volver a ejecutar (reset -> demo -> reset -> demo)", async () => {
  const r1 = await singleFlight("demo:y", () => delayed("primera", 10));
  const r2 = await singleFlight("demo:y", () => delayed("segunda", 10));
  assert.equal(r1, "primera");
  assert.equal(r2, "segunda");
});

test("singleFlight: claves distintas no se bloquean entre sí", async () => {
  const [a, b] = await Promise.all([
    singleFlight("demo:a", () => delayed("a", 20)),
    singleFlight("demo:b", () => delayed("b", 20)),
  ]);
  assert.equal(a, "a");
  assert.equal(b, "b");
});

test("singleFlight: si la acción lanza, la clave queda libre para el siguiente intento", async () => {
  await assert.rejects(() =>
    singleFlight("demo:z", async () => {
      throw new Error("boom");
    })
  );
  const result = await singleFlight("demo:z", () => delayed("recuperado", 5));
  assert.equal(result, "recuperado");
});
