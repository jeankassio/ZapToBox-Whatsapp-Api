CREATE TABLE "AuthState" (
  "instance" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" JSONB NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthState_pkey" PRIMARY KEY ("instance", "type", "key")
);
CREATE INDEX "AuthState_instance_idx" ON "AuthState"("instance");
