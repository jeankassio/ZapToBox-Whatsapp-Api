/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Message` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Message` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Message" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt";

-- CreateTable
CREATE TABLE "Contact" (
    "id" SERIAL NOT NULL,
    "instance" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
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
CREATE INDEX "Contact_instance_idx" ON "Contact"("instance");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instance_jid_key" ON "Contact"("instance", "jid");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instance_lid_key" ON "Contact"("instance", "lid");

-- CreateIndex
CREATE INDEX "Chat_instance_idx" ON "Chat"("instance");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_instance_jid_key" ON "Chat"("instance", "jid");

-- CreateIndex
CREATE INDEX "Message_remoteJid_idx" ON "Message"("remoteJid");
