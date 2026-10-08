-- CreateTable
CREATE TABLE "Clinic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "brandColor" TEXT NOT NULL,
    "logoUrl" TEXT NOT NULL DEFAULT '',
    "timezone" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Professional" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "serviceIds" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SlotHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "serviceId" TEXT NOT NULL,
    "professionalId" TEXT,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "patientId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "type" TEXT NOT NULL,
    "patientId" TEXT,
    "appointmentId" TEXT,
    "metadata" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Appointment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "patientId" TEXT NOT NULL,
    "professionalId" TEXT,
    "service" TEXT NOT NULL,
    "startsAt" DATETIME NOT NULL,
    "endsAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CONFIRMATION',
    "priceEurAtBooking" REAL,
    "recoveredFromWaitlist" BOOLEAN NOT NULL DEFAULT false,
    "googleEventId" TEXT,
    "reminder24hSentAt" DATETIME,
    "reminder2hSentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Appointment_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Appointment_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Professional" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Appointment" ("createdAt", "endsAt", "googleEventId", "id", "patientId", "reminder24hSentAt", "reminder2hSentAt", "service", "startsAt", "status", "updatedAt") SELECT "createdAt", "endsAt", "googleEventId", "id", "patientId", "reminder24hSentAt", "reminder2hSentAt", "service", "startsAt", "status", "updatedAt" FROM "Appointment";
DROP TABLE "Appointment";
ALTER TABLE "new_Appointment" RENAME TO "Appointment";
CREATE INDEX "Appointment_startsAt_idx" ON "Appointment"("startsAt");
CREATE INDEX "Appointment_status_idx" ON "Appointment"("status");
CREATE INDEX "Appointment_professionalId_startsAt_idx" ON "Appointment"("professionalId", "startsAt");
CREATE INDEX "Appointment_clinicId_idx" ON "Appointment"("clinicId");
CREATE TABLE "new_Patient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Patient" ("createdAt", "id", "name", "phone") SELECT "createdAt", "id", "name", "phone" FROM "Patient";
DROP TABLE "Patient";
ALTER TABLE "new_Patient" RENAME TO "Patient";
CREATE UNIQUE INDEX "Patient_phone_key" ON "Patient"("phone");
CREATE INDEX "Patient_clinicId_idx" ON "Patient"("clinicId");
CREATE TABLE "new_WaitlistEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "patientId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "earliestDate" DATETIME NOT NULL,
    "latestDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "professionalId" TEXT,
    "preferredTimeOfDay" TEXT,
    "offeredSlotStart" DATETIME,
    "offeredEndAt" DATETIME,
    "offerExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WaitlistEntry_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WaitlistEntry_professionalId_fkey" FOREIGN KEY ("professionalId") REFERENCES "Professional" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_WaitlistEntry" ("createdAt", "earliestDate", "id", "latestDate", "offerExpiresAt", "offeredSlotStart", "patientId", "service", "status", "updatedAt") SELECT "createdAt", "earliestDate", "id", "latestDate", "offerExpiresAt", "offeredSlotStart", "patientId", "service", "status", "updatedAt" FROM "WaitlistEntry";
DROP TABLE "WaitlistEntry";
ALTER TABLE "new_WaitlistEntry" RENAME TO "WaitlistEntry";
CREATE INDEX "WaitlistEntry_status_idx" ON "WaitlistEntry"("status");
CREATE INDEX "WaitlistEntry_clinicId_idx" ON "WaitlistEntry"("clinicId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Clinic_slug_key" ON "Clinic"("slug");

-- CreateIndex
CREATE INDEX "Professional_clinicId_active_idx" ON "Professional"("clinicId", "active");

-- CreateIndex
CREATE INDEX "SlotHold_startsAt_endsAt_idx" ON "SlotHold"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "SlotHold_expiresAt_idx" ON "SlotHold"("expiresAt");

-- CreateIndex
CREATE INDEX "AuditLog_clinicId_createdAt_idx" ON "AuditLog"("clinicId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_type_idx" ON "AuditLog"("type");
