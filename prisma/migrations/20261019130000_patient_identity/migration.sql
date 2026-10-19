ALTER TABLE "Appointment" ADD COLUMN "replacementAppointmentId" TEXT;
CREATE INDEX "Appointment_replacementAppointmentId_idx" ON "Appointment"("replacementAppointmentId");
ALTER TABLE "PortalAccess" ADD COLUMN "patientId" TEXT;
-- Staff-issued links already carry a trusted appointment reference. Legacy
-- self-service links lacked phone possession proof and remain unbound.
UPDATE "PortalAccess" SET "patientId" = (
  SELECT "patientId" FROM "Appointment" WHERE "Appointment"."id" = "PortalAccess"."appointmentId"
) WHERE "requestHash" = 'staff' AND "appointmentId" IS NOT NULL;
CREATE TABLE "PhoneVerification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tokenHash" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "salt" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" DATETIME NOT NULL,
  "verifiedAt" DATETIME,
  "consumedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PhoneVerification_tokenHash_createdAt_idx" ON "PhoneVerification"("tokenHash", "createdAt");
CREATE INDEX "PhoneVerification_phone_createdAt_idx" ON "PhoneVerification"("phone", "createdAt");
