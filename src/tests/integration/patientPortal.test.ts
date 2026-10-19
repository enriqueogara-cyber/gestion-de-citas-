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
import { requestPhoneCode, verifyPhoneCode, setPhoneCodeProvider } from "../../patient/phoneVerification";
import { executeTool, describePatientState } from "../../agent/tools";
import { bookAppointment } from "../../services/appointments";
import { handleIncomingMessage } from "../../agent/claude";
import { makePatient } from "./setup";

const key = () => randomBytes(32).toString("hex");
const delivered = new Map<string, string>();
async function authorize(token: string, phone: string) { await requestPhoneCode(token, phone); await verifyPhoneCode(token, delivered.get(phone)!); }
async function create(token: string, kind: "booking" | "waitlist", data: { phone: string } & Record<string, unknown>) { await authorize(token, data.phone); return publicCreate(token, kind, data); }
function future() { let d = DateTime.now().setZone(clinicConfig.timezone).plus({ days: 2 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 }); while (d.weekday !== 2) d = d.plus({ days: 1 }); return d; }
async function input() { const pro = await makeProfessional("Profesional portal", ["revision"]); return { name: "Paciente portal", phone: "34900000123", serviceId: "revision", professionalId: pro.id, startsAt: future().toISO()! }; }
describe("Portal de pacientes y tareas de recepción", () => {
  before(async () => { await ensureCatalogReady(); setPhoneCodeProvider({ sendCode: async (phone, code) => { delivered.set(phone, code); } }); });
  beforeEach(async () => { delivered.clear(); await cleanTransactionalData(); });
  test("un número conocido no autoriza reservar, consultar ni gestionar citas ajenas", async () => {
    const b = await input(), ownerToken = key(), attackerToken = key();
    await assert.rejects(() => publicCreate(attackerToken, "booking", b), /Verifica/);
    assert.equal(await prisma.portalAccess.count(), 0);
    await create(ownerToken, "booking", b);
    await assert.rejects(() => portalAppointment(attackerToken));
    await assert.rejects(() => manageAppointment(attackerToken, "cancel"));
    await requestPhoneCode(attackerToken, "34900000456");
    await verifyPhoneCode(attackerToken, delivered.get("34900000456")!);
    await assert.rejects(() => publicCreate(attackerToken, "booking", { ...b, startsAt: future().plus({ hours: 1 }).toISO()! }), /Verifica/);
    assert.equal((await portalAppointment(ownerToken)).status, "PENDING_CONFIRMATION");
  });
  test("código equivocado, agotado y caducado no permite reservar", async () => {
    const b = await input(), token = key();
    await requestPhoneCode(token, b.phone);
    const correct = delivered.get(b.phone)!;
    const wrong = correct === "000000" ? "999999" : "000000";
    for (let i = 0; i < 5; i++) await assert.rejects(() => verifyPhoneCode(token, wrong), /incorrecto/);
    await assert.rejects(() => verifyPhoneCode(token, correct), /sin intentos/);
    await assert.rejects(() => publicCreate(token, "booking", b), /Verifica/);
    const expired = key(); await requestPhoneCode(expired, "34900000999");
    await prisma.phoneVerification.updateMany({ where: { tokenHash: digest(expired) }, data: { expiresAt: new Date(0) } });
    await assert.rejects(() => verifyPhoneCode(expired, delivered.get("34900000999")!), /caducado/);
  });
  test("reenvíos y reintentos no crean códigos ni reservas adicionales", async () => {
    const b = await input(), token = key();
    await requestPhoneCode(token, b.phone); await requestPhoneCode(token, b.phone);
    assert.equal(await prisma.phoneVerification.count(), 1);
    await assert.rejects(() => requestPhoneCode(key(), b.phone), /Espera/);
    await verifyPhoneCode(token, delivered.get(b.phone)!);
    await assert.rejects(() => verifyPhoneCode(token, delivered.get(b.phone) === "000000" ? "999999" : "000000"), /incorrecto/);
    const first = await publicCreate(token, "booking", b);
    const again = await publicCreate(token, "booking", b);
    assert.equal(first.appointmentId, again.appointmentId);
    assert.equal(await prisma.appointment.count(), 1);
  });
  test("el límite horario por teléfono bloquea solicitudes distribuidas entre claves", async () => {
    const phone = "34900000666";
    for (let i = 0; i < 3; i++) {
      await requestPhoneCode(key(), phone);
      await prisma.phoneVerification.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - 2 * 60_000) } });
    }
    await assert.rejects(() => requestPhoneCode(key(), phone), /Espera/);
    assert.equal(await prisma.phoneVerification.count({ where: { phone } }), 3);
    const row = await prisma.phoneVerification.findFirstOrThrow({ where: { phone } });
    assert.notEqual(row.codeHash, delivered.get(phone));
  });
  test("un proveedor caído no entrega código ni habilita una reserva", async () => {
    const b = await input(), token = key();
    setPhoneCodeProvider({ sendCode: async () => { throw new Error("fallo simulado"); } });
    try {
      await assert.rejects(() => requestPhoneCode(token, b.phone), /No se pudo entregar/);
      await assert.rejects(() => publicCreate(token, "booking", b), /Verifica/);
      assert.equal(await prisma.appointment.count(), 0);
    } finally { setPhoneCodeProvider({ sendCode: async (phone, code) => { delivered.set(phone, code); } }); }
  });
  test("cada enlace gestiona solo su cita aunque el paciente tenga otra", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
    const linked = await portalAppointment(token);
    const other = await bookAppointment({ patientId: linked.patientId, patientName: b.name, patientPhone: b.phone, serviceId: b.serviceId, professionalId: b.professionalId, start: future().plus({ hours: 1 }) });
    await manageAppointment(token, "cancel");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: linked.id } })).status, "CANCELLED");
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: other.id } })).status, "PENDING_CONFIRMATION");
  });
  test("una consulta clínica no llega al modelo y se deriva a recepción", async () => {
    const patient = await makePatient("medical-privacy");
    const llmCallsBefore = await prisma.llmCallLog.count();
    const result = await handleIncomingMessage({ patientId: patient.id, phone: patient.phone, name: "Demo", identitySource: "local_demo" }, "Tengo dolor y tomo medicación");
    assert.match(result.reply, /equipo del centro/);
    assert.equal(await prisma.llmCallLog.count(), llmCallsBefore);
    assert.equal((await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).aiPaused, true);
  });
  test("las herramientas del agente rechazan identidad ausente o cruzada", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
    const appointment = await portalAppointment(token);
    const ctx = { patientId: appointment.patientId, phone: b.phone, name: b.name };
    assert.match((await executeTool("cancel_appointment", { appointment_id: appointment.id }, ctx)).text, /verifica tu identidad/);
    assert.match(await describePatientState(ctx), /identidad sin verificar/);
    assert.match((await executeTool("confirm_appointment", { appointment_id: appointment.id }, { ...ctx, phone: "34900000456", identitySource: "signed_whatsapp" })).text, /verifica tu identidad/);
    assert.equal((await portalAppointment(token)).status, "PENDING_CONFIRMATION");
  });
  test("un fallo al actualizar portalAccess se recupera por el vínculo de sustitución", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
    const old = await portalAppointment(token);
    const original = prisma.portalAccess.updateMany.bind(prisma.portalAccess);
    (prisma.portalAccess as any).updateMany = async (args: any) => {
      if (args?.where?.appointmentId === old.id) throw new Error("fallo simulado del enlace");
      return original(args);
    };
    try {
      const next = await rescheduleAppointment({ appointmentId: old.id, patientId: old.patientId, patientName: b.name, patientPhone: b.phone, newStart: future().plus({ hours: 2 }) });
      assert.equal((await prisma.portalAccess.findUniqueOrThrow({ where: { tokenHash: digest(token) } })).appointmentId, old.id);
      assert.equal((await portalAppointment(token)).id, next.id, "el enlace funciona incluso mientras la escritura sigue fallando");
      (prisma.portalAccess as any).updateMany = original;
      assert.equal((await portalAppointment(token)).id, next.id);
      assert.equal((await prisma.portalAccess.findUniqueOrThrow({ where: { tokenHash: digest(token) } })).appointmentId, next.id);
    } finally { (prisma.portalAccess as any).updateMany = original; }
  });
  test("si falla registrar la sustitución se compensa la nueva cita", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
    const old = await portalAppointment(token);
    const original = prisma.appointment.updateMany.bind(prisma.appointment);
    (prisma.appointment as any).updateMany = async (args: any) => {
      if (args?.where?.id === old.id && args?.data?.replacementAppointmentId) throw new Error("fallo simulado de persistencia");
      return original(args);
    };
    try {
      await assert.rejects(() => rescheduleAppointment({ appointmentId: old.id, patientId: old.patientId, patientName: b.name, patientPhone: b.phone, newStart: future().plus({ hours: 2 }) }));
    } finally { (prisma.appointment as any).updateMany = original; }
    assert.equal((await portalAppointment(token)).id, old.id);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: old.id } })).status, "PENDING_CONFIRMATION");
    assert.equal(await prisma.appointment.count({ where: { status: "PENDING_CONFIRMATION" } }), 1);
  });
  test("reintentos concurrentes con la misma clave crean una sola cita", async () => {
    const b = await input(), token = key();
    await authorize(token, b.phone);
    const [a, again] = await Promise.all([publicCreate(token, "booking", b), publicCreate(token, "booking", b)]);
    assert.equal(a.appointmentId, again.appointmentId); assert.equal(await prisma.appointment.count(), 1); assert.equal(await prisma.scheduledJob.count(), 2);
    await assert.rejects(() => publicCreate(token, "booking", { ...b, name: "Otro" }));
    assert.equal((await prisma.portalAccess.findUniqueOrThrow({ where: { tokenHash: digest(token) } })).status, "READY");
  });
  test("dos solicitudes distintas no ocupan el mismo hueco", async () => {
    const b = await input();
    const results = await Promise.allSettled([create(key(), "booking", b), create(key(), "booking", { ...b, phone: "34900000456" })]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(await prisma.appointment.count(), 1);
    assert.equal(await prisma.portalAccess.count({ where: { status: "REVIEW" } }), 1);
  });
  test("confirmar, cambiar y cancelar conserva un enlace y admite reintentos", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
    const old = await portalAppointment(token); await manageAppointment(token, "confirm"); await manageAppointment(token, "confirm");
    assert.equal((await portalAppointment(token)).status, "CONFIRMED");
    const nextTime = future().plus({ hours: 1 }).toISO()!;
    await manageAppointment(token, "change", nextTime); await manageAppointment(token, "change", nextTime);
    const next = await portalAppointment(token); assert.notEqual(next.id, old.id); assert.equal(await prisma.appointment.count(), 2);
    assert.equal((await prisma.appointment.findUniqueOrThrow({ where: { id: old.id } })).status, "CANCELLED");
    await manageAppointment(token, "cancel"); await manageAppointment(token, "cancel"); assert.equal((await portalAppointment(token)).status, "CANCELLED");
  });
  test("cambiar a un hueco ocupado conserva la cita original", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
    await create(key(), "booking", { ...b, phone: "34900000456", startsAt: future().plus({ hours: 1 }).toISO()! });
    const old = await portalAppointment(token);
    await assert.rejects(() => manageAppointment(token, "change", future().plus({ hours: 1 }).toISO()!));
    assert.equal((await portalAppointment(token)).id, old.id); assert.equal((await portalAppointment(token)).status, "PENDING_CONFIRMATION");
  });
  test("el cambio desde recepción también actualiza el enlace del paciente", async () => {
    const b = await input(), token = key(); await create(token, "booking", b); const old = await portalAppointment(token);
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
    await create(token, "waitlist", w); await publicCreate(token, "waitlist", w);
    assert.equal(await prisma.waitlistEntry.count(), 1); assert.equal(await prisma.appointment.count(), 0);
    assert.equal((await prisma.waitlistEntry.findFirstOrThrow()).preferredTimeOfDay, "MORNING");
    await assert.rejects(() => create(key(), "waitlist", { ...w, professionalId: "missing" }));
  });
  test("API pública limita datos, exige cabecera y conecta solicitudes con recepción", async () => {
    const b = await input(), token = key(); await create(token, "booking", b);
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
      const codeToken = key(), codePhone = "34900000888";
      const start = await (await fetch(base+"/reservar/api/verification/start", { method: "POST", headers: { ...headers, Authorization: "Bearer "+codeToken }, body: JSON.stringify({ phone: codePhone }) })).json() as any;
      assert.equal(start.ok, true); assert.equal(start.code, undefined); assert.equal(start.phone, undefined);
      assert.equal((await fetch(base+"/reservar/api/verification/confirm", { method: "POST", headers: { ...headers, Authorization: "Bearer "+codeToken }, body: JSON.stringify({ code: delivered.get(codePhone) }) })).status, 200);
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
      const previousNodeEnv = process.env.NODE_ENV;
      const previousBookingFlag = process.env.PUBLIC_BOOKING_ENABLED;
      try {
        process.env.NODE_ENV = "production";
        process.env.PUBLIC_BOOKING_ENABLED = "false";
        assert.equal((await fetch(base+"/reservar/api/appointment", { headers: { Authorization: "Bearer "+token } })).status, 503);
      } finally {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
        if (previousBookingFlag === undefined) delete process.env.PUBLIC_BOOKING_ENABLED; else process.env.PUBLIC_BOOKING_ENABLED = previousBookingFlag;
      }
    } finally { await new Promise<void>((r,j) => server.close(e => e ? j(e) : r())); }
  });
});
