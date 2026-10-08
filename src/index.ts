import { authRouter, staffAccess, bootstrapStaff } from "./services/staffAuth";
import { operationsRouter } from "./simulator/operationsRouter";
import { processInbox } from "./whatsapp/inbox";
import { createBackup } from "./services/backups";
import cron from "node-cron";
import { getClinicSettings } from "./services/clinicSettings";
import express from "express";
import { env, clinicConfig } from "./config";
import { whatsappWebhookRouter } from "./whatsapp/webhook";
import { simulatorRouter } from "./simulator/router";
import { startScheduler } from "./scheduler/reminders";
import { loadServiceCatalog } from "./services/serviceCatalog";
import { logger } from "./lib/logger";
import { patientRouter } from "./patient/router";

export const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "same-origin"); res.setHeader("Cache-Control", "no-store"); next(); });
app.use(express.json({ limit: "256kb", verify: (req, _res, buf) => { (req as typeof req & { rawBody: Buffer }).rawBody = Buffer.from(buf); } }));
app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use("/auth", authRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true, clinic: clinicConfig.name });
});

app.use(whatsappWebhookRouter);
app.use("/reservar", patientRouter);
app.use("/simulator", staffAccess, operationsRouter, simulatorRouter);
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { logger.error("request_failed", { err }); res.status(500).json({ error: "No se pudo completar la solicitud." }); });

// Arranque asíncrono: el catálogo de servicios/horario (respaldado por DB,
// ver services/serviceCatalog.ts) tiene que estar cargado en la caché en
// memoria ANTES de aceptar tráfico — si no, la primera petición podría ver
// una lista de servicios vacía mientras se siembra la tabla.
async function main() {
  await loadServiceCatalog();
  await getClinicSettings();
  await bootstrapStaff();

  app.listen(env.port, () => {
    logger.info("server_started", { clinic: clinicConfig.name, port: env.port });
    logger.info("simulator_ready", { url: `http://localhost:${env.port}/simulator/` });
    startScheduler();
    void processInbox().catch(() => logger.error("inbox_start_failed"));
    setInterval(() => { void processInbox().catch(() => logger.error("inbox_tick_failed")); }, 30_000);
    cron.schedule("0 3 * * *", () => { void createBackup().catch(() => logger.error("backup_failed")); }, { timezone: clinicConfig.timezone });
  });
}

if (require.main === module) main().catch((err) => {
  logger.error("server_start_failed", { err });
  process.exit(1);
});
