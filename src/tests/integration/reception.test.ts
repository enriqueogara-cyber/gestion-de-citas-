import test, { before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { readFile, rm } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { prisma } from "../../db/client";
import { clinicConfig } from "../../config";
import { ensureCatalogReady, cleanTransactionalData, makeProfessional, makePatient } from "./setup";
import { bookAppointment, getAvailability, cancelAppointment, confirmAppointment } from "../../services/appointments";
import { recordAttendance, recordPayment, createBlock, requestHandoff, setHandoff, staffReply } from "../../services/reception";
import { getDashboardStats } from "../../services/reportingService";
import { processDueJobs } from "../../scheduler/persistentJobs";
import { handleIncomingMessage } from "../../agent/claude";
import { createBackup } from "../../services/backups";
import { hashPassword, validWebhookSignature } from "../../services/staffAuth";
import { enqueueMessage, processInbox } from "../../whatsapp/inbox";
import { resetAllDemoData } from "../../services/demoScenarios";
import { app } from "../../index";
import { PrismaClient } from "@prisma/client";
import { listAttentionItems } from "../../services/auditLog";

function future() { let date = DateTime.now().setZone(clinicConfig.timezone).plus({ days: 1 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 }); while (date.weekday !== 2) date = date.plus({ days: 1 }); return date; }
async function book(recovered = false) { const pro = await makeProfessional("Recepción", ["revision"]); const p = await makePatient("reception"); const a = await bookAppointment({ patientId: p.id, patientName: "Test", patientPhone: p.phone, serviceId: "revision", professionalId: pro.id, start: future(), recoveredFromWaitlist: recovered }); return { a, p, pro }; }
describe("Recepción, seguridad y recuperación", () => {
  before(ensureCatalogReady); beforeEach(cleanTransactionalData);
  test("quitar asignaciones o desactivar todos los profesionales cierra la disponibilidad", async () => {
    const p = await makeProfessional("Sin asignaciones", []);
    assert.deepEqual(await getAvailability("revision", 10, p.id), []);
    await prisma.professional.update({ where: { id: p.id }, data: { serviceIds: '["revision"]', active: false } });
    const patient = await makePatient("inactive");
    await assert.rejects(() => bookAppointment({ patientId: patient.id, patientName: "", patientPhone: patient.phone, serviceId: "revision", start: future() }));
  });
  test("bloqueos impiden ofrecer y reservar; no se puede bloquear encima de una cita", async () => {
    const { a, p, pro } = await book();
    await assert.rejects(() => createBlock({ professionalId: pro.id, startsAt: a.startsAt.toISOString(), endsAt: a.endsAt.toISOString(), reason: "Descanso" }));
    const start = future().plus({ hours: 1 });
    await createBlock({ professionalId: pro.id, startsAt: start.toISO()!, endsAt: start.plus({ hours: 1 }).toISO()!, reason: "Descanso" });
    assert.ok(!(await getAvailability("revision", 1, pro.id, start)).some(d => d.toMillis() === start.toMillis()));
    await assert.rejects(() => bookAppointment({ patientId: p.id, patientName: "", patientPhone: p.phone, serviceId: "revision", professionalId: pro.id, start }));
  });
  test("la asistencia se registra manualmente y conserva estados terminales", async () => {
    const { a, p } = await book(); await confirmAppointment(a.id, p.id);
    await assert.rejects(() => recordAttendance(a.id, "NO_SHOW"));
    await recordAttendance(a.id, "ARRIVED");
    const arrived = await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } }); assert.ok(arrived.arrivedAt);
    await recordAttendance(a.id, "COMPLETED"); await assert.rejects(() => recordAttendance(a.id, "ARRIVED"));
  });
  test("métricas separan reservado, atendido y cobrado y excluyen cancelaciones", async () => {
    const { a } = await book(true);
    let stats = await getDashboardStats("all"); assert.equal(stats.recoveredRevenueEur, 25); assert.equal(stats.recoveredPaidEur, 0); assert.equal(stats.recoveredAttended, 0);
    await assert.rejects(() => recordPayment(a.id, 2500));
    await recordAttendance(a.id, "COMPLETED"); await recordPayment(a.id, 2100);
    stats = await getDashboardStats("all"); assert.equal(stats.recoveredAttendedValueEur, 25); assert.equal(stats.recoveredPaidEur, 21);
    const patient = await makePatient("cancelled-recovery");
    const other = await bookAppointment({ patientId: patient.id, patientName: "", patientPhone: patient.phone, serviceId: "revision", start: future().plus({ hours: 1 }), recoveredFromWaitlist: true });
    await cancelAppointment(other.id, patient.id);
    assert.equal((await getDashboardStats("all")).recoveredSlots, 1);
  });
  test("la IA queda pausada y recepción responde hasta resolver la derivación", async () => {
    const patient = await makePatient("handoff"); await requestHandoff(patient.id, "Necesito ayuda");
    const reply = await handleIncomingMessage({ patientId: patient.id, name: "Test", phone: patient.phone }, "Hola"); assert.equal(reply.reply, "");
    assert.equal(await prisma.llmCallLog.count(), 0);
    await assert.rejects(() => staffReply(patient.id, "Hola", "staff"));
    await setHandoff(patient.id, true, "staff"); await staffReply(patient.id, "Te atiendo", "staff");
    await assert.rejects(() => setHandoff(patient.id, true, "another-staff"));
    assert.ok((await listAttentionItems()).some(item => item.patientId === patient.id));
    assert.equal(await prisma.conversationMessage.count({ where: { patientId: patient.id, content: "Te atiendo" } }), 1);
    await setHandoff(patient.id, false, "staff"); assert.equal((await prisma.patient.findUniqueOrThrow({ where: { id: patient.id } })).aiPaused, false);
    assert.ok(!(await listAttentionItems()).some(item => item.patientId === patient.id));
  });
  test("los resultados mensuales no incluyen citas de otros meses", async () => {
    const { a } = await book(true);
    const old = DateTime.now().setZone(clinicConfig.timezone).minus({ months: 2 }).startOf("month");
    await prisma.appointment.update({ where: { id: a.id }, data: { startsAt: old.toJSDate(), endsAt: old.plus({ minutes: 20 }).toJSDate(), status: "COMPLETED", paidCents: 2500 } });
    assert.equal((await getDashboardStats("month")).recoveredPaidEur, 0);
    assert.equal((await getDashboardStats("all")).recoveredPaidEur, 25);
  });
  test("recupera un trabajo interrumpido, sin repetir un trabajo completado", async () => {
    const { a } = await book();
    const job = await prisma.scheduledJob.findFirstOrThrow({ where: { appointmentId: a.id, type: "REMINDER_2H" } });
    await prisma.scheduledJob.update({ where: { id: job.id }, data: { scheduledAt: new Date(Date.now() - 60_000), status: "PROCESSING", lastAttemptAt: new Date(Date.now() - 11 * 60_000), claimToken: "old", attempts: 1 } });
    let calls = 0; const handlers = { REMINDER_24H: async () => {}, REMINDER_2H: async () => { calls++; }, WAITLIST_OFFER_EXPIRED: async () => {} };
    await processDueJobs(handlers); await processDueJobs(handlers); assert.equal(calls, 1);
  });
  test("mensajes repetidos se persisten una vez; los interrumpidos sin respuesta requieren revisión", async () => {
    const message = { id: "wamid-test", phone: "34600111222", text: "Hola" }; await enqueueMessage(message); await enqueueMessage(message); assert.equal(await prisma.inboundMessage.count(), 1);
    await prisma.inboundMessage.update({ where: { id: message.id }, data: { status: "PROCESSING", lastAttemptAt: new Date(Date.now() - 11 * 60_000), claimToken: "old" } });
    await processInbox(); assert.equal((await prisma.inboundMessage.findUniqueOrThrow({ where: { id: message.id } })).status, "FAILED");
  });
  test("reiniciar demo conserva pacientes y auditoría reales y borra sus trabajos huérfanos", async () => {
    const { p } = await book(); const real = await prisma.patient.create({ data: { phone: "34600999888" } }); await prisma.auditLog.create({ data: { type: "PATIENT_MESSAGE_RECEIVED", patientId: real.id } });
    await resetAllDemoData(); assert.equal(await prisma.scheduledJob.count(), 0); assert.equal(await prisma.patient.count({ where: { id: p.id } }), 0); assert.equal(await prisma.auditLog.count({ where: { patientId: real.id } }), 1);
  });
  test("copia SQLite consistente conserva datos y cabecera válida", async () => {
    await book(); process.env.BACKUP_DIR = "backups/test"; const file = await createBackup();
    const restored = new PrismaClient({ datasources: { db: { url: "file:" + file.replace(/\\/g, "/") } } });
    try { const bytes = await readFile(file); assert.equal(bytes.subarray(0, 15).toString(), "SQLite format 3"); assert.ok(bytes.length > 4096); assert.equal(await restored.appointment.count(), 1); assert.equal(await restored.scheduledJob.count(), 2); } finally { await restored.$disconnect(); await rm(file); delete process.env.BACKUP_DIR; }
  });
  test("HTTP exige login, CSRF y permisos; webhook rechaza firmas falsas", async () => {
    await prisma.staffUser.create({ data: { email: "reception@example.test", passwordHash: hashPassword("testing-password-2026"), role: "RECEPTION" } });
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      assert.equal((await fetch(base + "/simulator/api/operations")).status, 401);
      const login = await (await fetch(base + "/auth/login")).text(); const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(login)![1];
      const session = await fetch(base + "/auth/login", { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "reception@example.test", password: "testing-password-2026", csrf }) }); assert.equal(session.status, 302);
      const cookie = session.headers.get("set-cookie")!.split(";")[0];
      const page = await (await fetch(base + "/simulator/operations", { headers: { Cookie: cookie } })).text(); const token = /const clinicCsrf="([a-f0-9]+)"/.exec(page)![1];
      assert.equal((await fetch(base + "/simulator/api/blocks", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: "{}" })).status, 403);
      assert.equal((await fetch(base + "/simulator/api/staff", { method: "POST", headers: { Cookie: cookie, "X-Clinic-CSRF": token, "Content-Type": "application/json" }, body: "{}" })).status, 403);
      assert.equal((await fetch(base + "/webhook", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
      const raw = Buffer.from("{}"); const sig = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex"); assert.ok(validWebhookSignature(raw, sig, "secret")); assert.ok(!validWebhookSignature(Buffer.from("{ }"), sig, "secret"));
    } finally { await new Promise<void>((r, reject) => server.close(err => err ? reject(err) : r())); }
  });
});
