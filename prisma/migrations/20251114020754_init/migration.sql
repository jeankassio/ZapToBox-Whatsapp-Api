-- CreateTable
CREATE TABLE "Message" (
    "id" SERIAL NOT NULL,
    "instance" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "remoteJid" TEXT NOT NULL,
    "senderLid" TEXT,
    "fromMe" BOOLEAN NOT NULL,
    "pushName" TEXT,
    "content" JSONB NOT NULL,
    "status" TEXT,
    "messageTimestamp" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_instance_idx" ON "Message"("instance");

-- CreateIndex
CREATE UNIQUE INDEX "Message_instance_messageId_key" ON "Message"("instance", "messageId");
