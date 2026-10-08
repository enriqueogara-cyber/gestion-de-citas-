import express from "express";
import { env, clinicConfig } from "./config";
import { whatsappWebhookRouter } from "./whatsapp/webhook";
import { simulatorRouter } from "./simulator/router";
import { startScheduler } from "./scheduler/reminders";
import { loadServiceCatalog } from "./services/serviceCatalog";
import { logger } from "./lib/logger";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, clinic: clinicConfig.name });
});

app.use(whatsappWebhookRouter);
app.use("/simulator", simulatorRouter);

// Arranque asíncrono: el catálogo de servicios/horario (respaldado por DB,
// ver services/serviceCatalog.ts) tiene que estar cargado en la caché en
// memoria ANTES de aceptar tráfico — si no, la primera petición podría ver
// una lista de servicios vacía mientras se siembra la tabla.
async function main() {
  await loadServiceCatalog();

  app.listen(env.port, () => {
    logger.info("server_started", { clinic: clinicConfig.name, port: env.port });
    logger.info("simulator_ready", { url: `http://localhost:${env.port}/simulator/` });
    startScheduler();
  });
}

main().catch((err) => {
  logger.error("server_start_failed", { err });
  process.exit(1);
});
