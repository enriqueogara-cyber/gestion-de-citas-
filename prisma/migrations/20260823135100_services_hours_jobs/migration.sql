-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "priceEur" REAL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "bufferBeforeMinutes" INTEGER NOT NULL DEFAULT 0,
    "bufferAfterMinutes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OpeningHoursRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "weekday" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ScheduledJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "type" TEXT NOT NULL,
    "appointmentId" TEXT,
    "waitlistEntryId" TEXT,
    "scheduledAt" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "lastAttemptAt" DATETIME,
    "processedAt" DATETIME,
    "lastError" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Service_slug_key" ON "Service"("slug");

-- CreateIndex
CREATE INDEX "Service_clinicId_active_idx" ON "Service"("clinicId", "active");

-- CreateIndex
CREATE INDEX "OpeningHoursRule_clinicId_weekday_idx" ON "OpeningHoursRule"("clinicId", "weekday");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledJob_idempotencyKey_key" ON "ScheduledJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ScheduledJob_status_scheduledAt_idx" ON "ScheduledJob"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledJob_clinicId_idx" ON "ScheduledJob"("clinicId");
