/**
 * Semilla de datos de demo (npm run prisma:seed). La lógica real vive en
 * src/services/demoScenarios.ts para poder reutilizarla también desde el
 * botón "Sembrar datos de demo" de /simulator/settings.
 */
import { seedDemoData } from "../src/services/demoScenarios";
import { prisma } from "../src/db/client";

seedDemoData()
  .then((result) => {
    console.log(`Seed completado: ${result.professionals} profesional(es), ${result.patients} paciente(s) de ejemplo.`);
  })
  .catch((err) => {
    console.error("Seed falló:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
