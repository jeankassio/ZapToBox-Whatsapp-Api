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

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" SERIAL NOT NULL,
    "instance" TEXT NOT NULL,
    "name" TEXT,
    "jid" TEXT,
    "lid" TEXT,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" SERIAL NOT NULL,
    "instance" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "data" JSONB NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Message_instance_idx" ON "Message"("instance");

-- CreateIndex
CREATE INDEX "Message_remoteJid_idx" ON "Message"("remoteJid");

-- CreateIndex
CREATE UNIQUE INDEX "Message_instance_messageId_key" ON "Message"("instance", "messageId");

-- CreateIndex
CREATE INDEX "Contact_instance_idx" ON "Contact"("instance");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instance_jid_key" ON "Contact"("instance", "jid");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instance_lid_key" ON "Contact"("instance", "lid");

-- CreateIndex
CREATE INDEX "Chat_instance_idx" ON "Chat"("instance");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_instance_jid_key" ON "Chat"("instance", "jid");
