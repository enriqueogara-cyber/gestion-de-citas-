import test, { before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../../db/client";
import {
  createService,
  updateService,
  setServiceActive,
  replaceOpeningHoursForDay,
  OpeningHoursValidationError,
  getServicesSync,
  getAllServicesSync,
  getOpeningHoursSync,
} from "../../services/serviceCatalog";
import { setProfessionalServices, parseServiceIds } from "../../services/professionals";
import { ensureCatalogReady, makeProfessional, cleanTransactionalData } from "./setup";

/**
 * TEST 5E — regresión de Settings (servicios, asignaciones
 * profesional↔servicio, horario de apertura). No prueba HTML/JS del
 * simulador (eso se verifica a mano en el navegador — ver README, "QA
 * manual"), pero sí verifica que las funciones que la UI llama por debajo
 * (las mismas que usan los endpoints de src/simulator/router.ts) persisten
 * correctamente en una base de datos real, incluyendo tras recargar el
 * catálogo en memoria (getServicesSync/getAllServicesSync/getOpeningHoursSync)
 * — que es justo lo que un refresco de página en el simulador dispara.
 */

before(ensureCatalogReady);
beforeEach(cleanTransactionalData);

test("crear un servicio lo persiste y aparece en el catálogo en memoria tras recargar", async () => {
  const countBefore = getServicesSync().length;
  await createService({ name: "Test Settings Service", durationMinutes: 25, priceEur: 33 });

  const all = getAllServicesSync();
  const created = all.find((s) => s.label === "Test Settings Service");
  assert.ok(created, "el servicio nuevo debe estar en el catálogo recargado");
  assert.equal(created!.durationMinutes, 25);
  assert.equal(created!.priceEur, 33);
  assert.equal(getServicesSync().length, countBefore + 1);

  // Limpieza para no contaminar otros tests que asumen el catálogo semilla.
  await prisma.service.delete({ where: { slug: created!.id } });
});

test("editar un servicio actualiza nombre/duración/precio y se refleja tras recargar", async () => {
  await createService({ name: "Edit Me", durationMinutes: 10, priceEur: 5 });
  const created = getAllServicesSync().find((s) => s.label === "Edit Me")!;

  await updateService(created.id, { name: "Edit Me Renamed", durationMinutes: 15, priceEur: 8 });
  const updated = getAllServicesSync().find((s) => s.id === created.id)!;
  assert.equal(updated.label, "Edit Me Renamed");
  assert.equal(updated.durationMinutes, 15);
  assert.equal(updated.priceEur, 8);

  await prisma.service.delete({ where: { slug: created.id } });
});

test("desactivar un servicio lo saca de getServicesSync (activos) pero lo conserva en getAllServicesSync", async () => {
  await createService({ name: "Deactivate Me", durationMinutes: 20, priceEur: 12 });
  const created = getAllServicesSync().find((s) => s.label === "Deactivate Me")!;

  await setServiceActive(created.id, false);

  assert.ok(!getServicesSync().some((s) => s.id === created.id), "no debe aparecer entre los activos");
  const stillListed = getAllServicesSync().find((s) => s.id === created.id);
  assert.ok(stillListed, "debe seguir existiendo para no perder su historial/configuración");
  assert.equal(stillListed!.active, false);

  await prisma.service.delete({ where: { slug: created.id } });
});

test("asignar servicios a un profesional persiste exactamente el mismo conjunto (ida y vuelta)", async () => {
  const services = getServicesSync();
  const [svcA, svcB] = services;
  const laura = await makeProfessional("Laura Settings", []);

  await setProfessionalServices(laura.id, [svcA.id, svcB.id]);
  let row = await prisma.professional.findUniqueOrThrow({ where: { id: laura.id } });
  assert.deepEqual(new Set(parseServiceIds(row.serviceIds)), new Set([svcA.id, svcB.id]));

  // Quitar uno: el estado guardado debe reflejar EXACTAMENTE la nueva selección.
  await setProfessionalServices(laura.id, [svcB.id]);
  row = await prisma.professional.findUniqueOrThrow({ where: { id: laura.id } });
  assert.deepEqual(parseServiceIds(row.serviceIds), [svcB.id]);

  // Vaciar del todo (vacío = cualquier servicio, ver hint en la UI).
  await setProfessionalServices(laura.id, []);
  row = await prisma.professional.findUniqueOrThrow({ where: { id: laura.id } });
  assert.deepEqual(parseServiceIds(row.serviceIds), []);
});

test("reemplazar el horario de un día persiste los tramos y se refleja tras recargar", async () => {
  await replaceOpeningHoursForDay(1, [
    { start: "09:00", end: "13:00" },
    { start: "16:00", end: "19:00" },
  ]);
  const hours = getOpeningHoursSync();
  const monday = hours[1] ?? [];
  assert.equal(monday.length, 2);
  assert.deepEqual(
    monday.map((r) => `${r.start}-${r.end}`).sort(),
    ["09:00-13:00", "16:00-19:00"]
  );
});

test("el backend rechaza un horario con tramos solapados y NO persiste el cambio", async () => {
  await replaceOpeningHoursForDay(2, [{ start: "09:00", end: "13:00" }]);

  await assert.rejects(
    () => replaceOpeningHoursForDay(2, [
      { start: "09:00", end: "13:00" },
      { start: "12:00", end: "15:00" }, // se solapa con el anterior
    ]),
    (err: unknown) => err instanceof OpeningHoursValidationError
  );

  // El horario previo (válido) debe seguir intacto: el intento fallido no
  // debe haber dejado el día a medias ni haber persistido nada.
  const hours = getOpeningHoursSync();
  const tuesday = hours[2] ?? [];
  assert.equal(tuesday.length, 1);
  assert.equal(`${tuesday[0].start}-${tuesday[0].end}`, "09:00-13:00");
});

test("el backend rechaza un tramo con fin <= inicio", async () => {
  await assert.rejects(
    () => replaceOpeningHoursForDay(3, [{ start: "10:00", end: "10:00" }]),
    (err: unknown) => err instanceof OpeningHoursValidationError
  );
  await assert.rejects(
    () => replaceOpeningHoursForDay(3, [{ start: "10:00", end: "09:00" }]),
    (err: unknown) => err instanceof OpeningHoursValidationError
  );
});
