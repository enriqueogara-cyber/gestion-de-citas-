import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "../db/client";

// VACUUM INTO produces a consistent SQLite snapshot, including committed WAL pages.
export async function createBackup() {
  const directory = path.resolve(process.env.BACKUP_DIR || "backups");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `clinic-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.db`);
  await prisma.$executeRawUnsafe(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  await fs.chmod(destination, 0o600);
  // Only remove snapshots created by this function, directly inside this directory.
  const snapshots = (await fs.readdir(directory)).filter(name => /^clinic-\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9-]+\.db$/.test(name)).sort().reverse();
  for (const name of snapshots.slice(30)) {
    const candidate = path.resolve(directory, name);
    if (path.dirname(candidate) === directory) await fs.unlink(candidate);
  }
  return destination;
}
