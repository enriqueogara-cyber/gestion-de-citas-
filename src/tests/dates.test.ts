import test from "node:test";
import assert from "node:assert/strict";
import { formatLong, formatDateOnly, toClinicTime } from "../lib/dates";
import { clinicConfig } from "../config";

// Bug real que arregla lib/dates.ts: Date.prototype.toISOString() siempre da
// UTC. Antes, el estado del paciente y varias tools le pasaban al modelo esa
// hora UTC cruda; cerca de medianoche, el día de calendario en UTC puede ser
// distinto al día en la clínica (Europe/Madrid, por defecto), así que el
// modelo podía decir el día de la semana equivocado. Estos tests fijan un
// instante conocido que cruza esa frontera y comprueban que el día que se le
// da al modelo es siempre el de la clínica, nunca el de UTC.

test("formatLong: un instante que es lunes en UTC pero martes en la clínica muestra 'martes'", () => {
  // 2026-01-05 23:30 UTC es lunes. En Europe/Madrid (UTC+1 en enero, sin
  // horario de verano) son las 00:30 del DÍA SIGUIENTE: martes.
  const utcInstant = new Date("2026-01-05T23:30:00.000Z");
  const label = formatLong(utcInstant);
  assert.match(label, /^martes/, `esperaba "martes...", obtuve "${label}"`);
});

test("formatDateOnly: el día de la semana coincide con el calculado directamente en la zona de la clínica", () => {
  const utcInstant = new Date("2026-01-05T23:30:00.000Z");
  const expectedWeekday = toClinicTime(utcInstant).toFormat("cccc");
  assert.ok(formatDateOnly(utcInstant).startsWith(expectedWeekday));
});

test("toClinicTime: la zona resultante es siempre la de la clínica, no la del proceso", () => {
  const dt = toClinicTime(new Date("2026-06-15T10:00:00.000Z"));
  assert.equal(dt.zoneName, clinicConfig.timezone);
});

test("formatLong: no revienta con una fecha inválida, produce texto (no lanza)", () => {
  assert.doesNotThrow(() => formatLong(new Date(NaN)));
});
