import test, { before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { publicCreate, portalAppointment, manageAppointment, digest } from "../../patient/service";
import { rescheduleAppointment } from "../../services/appointments";
import { ensureCatalogReady, cleanTransactionalData, makeProfessional } from "./setup";
import { app } from "../../index";

const key = () => randomBytes(32).toString("hex");
function future() { let d = DateTime.now().setZone(clinicConfig.timezone).plus({ days: 2 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }); while (d.weekday !== 2) d = d.plus({ days: 1 }); return d; }
async function input() { const pro = await makeProfessional("Profesional portal", ["revision"]); return { name: "Paciente portal", phone: "34900000123", serviceId: "revision", professionalId: pro.id, startsAt: future().toISO()! }; }
describe("Portal de pacientes y tareas de recepción", () => {
  before(ensureCatalogReady); beforeEach(cleanTransactionalData);
  test("reintentos concurrentes con la misma clave crean una sola cita", async () => {
    const b = await input(), token = key();
    const [a, again] = await Promise.all([publicCreate(token, "booking", b), publicCreate(token, "booking", b)]);
    assert.equal(a.appointmentId, again.appointmentId); assert.equal(await prisma.appointment.count(), 1); assert.equal(await prisma.scheduledJob.count(), 2);
    await assert.rejects(() => publicCreate(token, "booking", { ...b, name: "Otro" }));
    assert.equal((await prisma.portalAccess.findUniqueOrThrow({ where: { tokenHash: digest(token) } })).status, "READY");
  });
  test("dos solicitudes distintas no ocupan el mismo hueco", async () => {
    const b = await input();
    const results = await Promise.allSettled([publicCreate(key(), "booking", b), publicCreate(key(), "booking", { ...b, phone: "34900000456" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(await prisma.appointment.count(), 1);
    assert.equal(await prisma.portalAccess.count({ where: { status: "REVIEW" } }), 1);
  });
  test("confirmar, cambiar y cancelar conserva un enlace y admite reintentos", async () => {
    const b = await input(), token = key(); await publicCreate(token, "booking", b);
    const old = await portalAppointment(token); await manageAppointment(token, "confirm"); await manageAppointment(token, "confirm");
    assert.equal((await portalAppointment(token)).status, "CONFIRMED");
    const nextTime = future().plus({ hours: 1 }).toISO()!;
    await manageAppointment(token, "change", nextTime); await manageAppointment(token, "change", nextTime);
    const next = await portalAppointment(token); assert.notEqual(next.id, old.id); assert.equal(await prisma.appointment.count(), 2);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: old.id } })).status, "CANCELLED");
    await manageAppointment(token, "cancel"); await manageAppointment(token, "cancel"); assert.equal((await portalAppointment(token)).status, "CANCELLED");
  });
  test("cambiar a un hueco ocupado conserva la cita original", async () => {
    const b = await input(), token = key(); await publicCreate(token, "booking", b);
    await publicCreate(key(), "booking", { ...b, phone: "34900000456", startsAt: future().plus({ hours: 1 }).toISO()! });
    const old = await portalAppointment(token);
    await assert.rejects(() => manageAppointment(token, "change", future().plus({ hours: 1 }).toISO()!));
    assert.equal((await portalAppointment(token)).id, old.id); assert.equal((await portalAppointment(token)).status, "PENDING_CONFIRMATION");
  });
  test("el cambio desde recepción también actualiza el enlace del paciente", async () => {
    const b = await input(), token = key(); await publicCreate(token, "booking", b); const old = await portalAppointment(token);
    const next = await rescheduleAppointment({ appointmentId: old.id, patientId: old.patientId, patientName: b.name, patientPhone: b.phone, newStart: future().plus({ hours: 2 }) });
    assert.equal((await portalAppointment(token)).id, next.id);
    await assert.rejects(() => portalAppointment(key()));
    await prisma.portalAccess.update({ where: { tokenHash: digest(token) }, data: { expiresAt: new Date(0) } });
    await assert.rejects(() => manageAppointment(token, "cancel"));
    await prisma.portalAccess.update({ where: { tokenHash: digest(token) }, data: { expiresAt: new Date(Date.now()+60000), revokedAt: new Date() } });
    await assert.rejects(() => portalAppointment(token));
  });
  test("lista de espera persiste preferencias una sola vez y valida profesional", async () => {
    const b = await input(), token = key(); const w = { ...b, fromDate: future().toISODate(), toDate: future().plus({ days: 1 }).toISODate(), preferredTimeOfDay: "MORNING" };
    await publicCreate(token, "waitlist", w); await publicCreate(token, "waitlist", w);
    assert.equal(await prisma.waitlistEntry.count(), 1); assert.equal(await prisma.appointment.count(), 0);
    assert.equal((await prisma.waitlistEntry.findFirstOrThrow()).preferredTimeOfDay, "MORNING");
    await assert.rejects(() => publicCreate(key(), "waitlist", { ...w, professionalId: "missing" }));
  });
  test("API pública limita datos, exige cabecera y conecta solicitudes con recepción", async () => {
    const b = await input(), token = key(); await publicCreate(token, "booking", b);
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const headers = { "Content-Type": "application/json", "X-Patient-Request": "1" };
    try {
      const earliest = Date.now() + clinicConfig.minBookingNoticeMinutes * 60_000;
      const query = new URLSearchParams({ serviceId: b.serviceId, professionalId: b.professionalId, date: DateTime.now().setZone(clinicConfig.timezone).toISODate()! });
      const available = await (await fetch(base+"/reservar/api/slots?"+query)).json() as any;
      assert.ok(Array.isArray(available.slots)); assert.ok(available.slots.every((s: any) => Date.parse(s.iso) > earliest));
      assert.equal((await fetch(base+"/reservar/api/appointment")).status, 400);
      const info = await (await fetch(base+"/reservar/api/appointment", { headers: { Authorization: "Bearer "+token } })).json() as any;
      assert.equal(info.serviceId, "revision"); assert.equal(info.phone, undefined); assert.equal(info.patientId, undefined); assert.equal(info.name, undefined);
      const body = JSON.stringify({ name: "Consulta web", phone: "34900000789", message: "Quiero información del horario" });
      assert.equal((await fetch(base+"/reservar/api/contact", { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 403);
      assert.equal((await fetch(base+"/reservar/api/contact", { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "cross-site" }, body })).status, 403);
      for(let i=0;i<2;i++) assert.equal((await fetch(base+"/reservar/api/contact", { method: "POST", headers, body })).status, 200);
      assert.equal(await prisma.contactRequest.count(), 1);
      const tasks = await (await fetch(base+"/simulator/api/today")).json() as any; assert.equal(tasks.requests.length, 1);
      const page = await (await fetch(base+"/simulator/dashboard")).text();
      const csrf = /const clinicCsrf="([a-f0-9]+)"/.exec(page)![1];
      assert.equal((await fetch(base+"/simulator/api/contacts/"+tasks.requests[0].id+"/resolve", { method:"POST", headers: {...headers, "X-Clinic-CSRF": csrf}, body:"{}" })).status, 200);
      const patients = await (await fetch(base+"/simulator/api/patients/search?q=portal")).json() as any; assert.equal(patients.patients.length, 1); assert.ok(patients.patients[0].next);
      assert.equal((await prisma.contactRequest.findFirstOrThrow()).status, "RESOLVED");
    } finally { await new Promise<void>((r,j) => server.close(e => e ? j(e) : r())); }
  });
});
