import "dotenv/config";
import { createBackup } from "../src/services/backups";
import { prisma } from "../src/db/client";
createBackup().then(file => console.log(`Copia guardada: ${file}`)).catch(err => { console.error(err); process.exitCode = 1; }).finally(() => prisma.$disconnect());
