/**
 * Runner de integration tests (ver README, "Integration tests"): usa una
 * base de datos SQLite de test SEPARADA de dev.db (prisma/test.db),
 * migrada limpia en cada ejecución, para poder probar de verdad cosas que
 * no se pueden probar sin base de datos real: concurrencia, transacciones,
 * disponibilidad por profesional cruzando filas reales.
 *
 * Por qué un script y no un flag de npm test: hay que fijar
 * DATABASE_URL ANTES de que cualquier módulo cargue Prisma (config.ts hace
 * `import "dotenv/config"` en cuanto se importa), así que no vale con
 * pasar una env var al comando de test tal cual — este script la fija y
 * SOLO ENTONCES lanza migrate + los tests, en procesos hijos separados.
 */
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const root = path.join(__dirname, "..");
const testDbPath = path.join(root, "prisma", "test.db");

for (const p of [testDbPath, testDbPath + "-journal"]) {
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

const env = {
  ...process.env,
  DATABASE_URL: "file:./test.db",
  NODE_ENV: "test",
  // Módulos que exigen esto de forma perezosa (env.openRouterApiKey()) no
  // se llaman en los integration tests (no hay llamadas reales al LLM),
  // pero algún import en cascada podría instanciar config.ts igualmente.
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || "test-key-not-used",
};

console.log("→ Migrando base de datos de test (prisma/test.db)...");
execSync("npx prisma migrate deploy", { stdio: "inherit", cwd: root, env });

console.log("→ Ejecutando integration tests...");
execSync(
  "node --require ts-node/register/transpile-only --test src/tests/integration/index.test.ts",
  { stdio: "inherit", cwd: root, env }
);
