import { MinimalMessage, WAMessage } from "@whiskeysockets/baileys";
import { Message as PrismaMessage } from "@prisma/client";

export class MessageMapper {

    static toMinimalMessage(row: any): MinimalMessage {
        const content = row.content as any;

        return {
            key: {
                remoteJid: row?.remoteJid,
                fromMe: row?.fromMe,
                id: row?.messageId
            },
            messageTimestamp: Number(row?.messageTimestamp)
        };
    }

    static toWAMessage(row: PrismaMessage): WAMessage {
        const content = row.content as any;

        return {
            key: {
                remoteJid: row?.remoteJid,
                fromMe: row?.fromMe,
                id: row?.messageId
            },
            messageTimestamp: Number(row.messageTimestamp),
            message: content?.message
        };
    }

}
