CREATE TABLE "HistoryRescanJob" (
  "id" TEXT NOT NULL,
  "instance" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "activeInstance" TEXT,
  "runId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'queued',
  "state" JSONB NOT NULL,
  "pending" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "HistoryRescanJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HistoryRescanJob_activeInstance_key" ON "HistoryRescanJob"("activeInstance");
CREATE UNIQUE INDEX "HistoryRescanJob_runId_key" ON "HistoryRescanJob"("runId");
CREATE UNIQUE INDEX "HistoryRescanJob_instance_idempotencyKey_key" ON "HistoryRescanJob"("instance", "idempotencyKey");
CREATE INDEX "HistoryRescanJob_status_nextAttemptAt_leaseUntil_idx" ON "HistoryRescanJob"("status", "nextAttemptAt", "leaseUntil");
CREATE INDEX "Contact_instance_id_idx" ON "Contact"("instance", "id");
CREATE INDEX "Chat_instance_id_idx" ON "Chat"("instance", "id");
CREATE INDEX "Message_instance_id_idx" ON "Message"("instance", "id");
