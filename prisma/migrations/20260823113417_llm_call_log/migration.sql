-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clinicId" TEXT NOT NULL DEFAULT 'default',
    "model" TEXT NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "toolCallCount" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LlmCallLog_clinicId_createdAt_idx" ON "LlmCallLog"("clinicId", "createdAt");
