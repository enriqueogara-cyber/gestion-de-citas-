ALTER TABLE "InboundMessage" ADD COLUMN "sentAt" DATETIME;

CREATE TABLE "WhatsAppOutbound" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "phone" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'SENDING',
  "providerMessageId" TEXT,
  "errorCode" TEXT,
  "acceptedAt" DATETIME,
  "statusAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "WhatsAppOutbound_idempotencyKey_key" ON "WhatsAppOutbound"("idempotencyKey");
CREATE UNIQUE INDEX "WhatsAppOutbound_providerMessageId_key" ON "WhatsAppOutbound"("providerMessageId");
CREATE INDEX "WhatsAppOutbound_status_updatedAt_idx" ON "WhatsAppOutbound"("status", "updatedAt");

CREATE TABLE "WhatsAppStatusEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "providerMessageId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "occurredAt" DATETIME NOT NULL,
  "errorCode" TEXT,
  "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "WhatsAppStatusEvent_providerMessageId_status_occurredAt_key" ON "WhatsAppStatusEvent"("providerMessageId", "status", "occurredAt");
CREATE INDEX "WhatsAppStatusEvent_providerMessageId_occurredAt_idx" ON "WhatsAppStatusEvent"("providerMessageId", "occurredAt");
