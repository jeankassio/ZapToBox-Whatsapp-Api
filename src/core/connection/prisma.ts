import { PrismaClient } from "@prisma/client";

export default class PrismaConnection {

    private static conn: PrismaClient =  new PrismaClient();;
    
    static async addUpdate(instance: string, msg: any){

        const key = msg.key;

        if(!key || !key.id) return;{
            console.error("Message key or id is missing, skiping...");
        }

        return PrismaConnection.conn.message.upsert({
            where: {
                instance_messageId: {
                    instance,
                    messageId: key.id,
                },
            },
            update: {
                content: msg,
                pushName: msg.pushName || null,
                status: msg.status || null,
                messageTimestamp: BigInt(msg.messageTimestamp || 0),
            },
            create: {
                instance,
                messageId: key.id,
                remoteJid: key.remoteJid,
                senderLid: key.senderLid || null,
                fromMe: !!key.fromMe,
                pushName: msg.pushName || null,
                content: msg,
                status: msg.status || null,
                messageTimestamp: BigInt(msg.messageTimestamp || 0),
            },
        });

    }

    static async deleteByInstance(instance: string) {
        return PrismaConnection.conn.message.deleteMany({
            where: { instance },
        });
    }

    static async getMessageByInstance(instance: string) {
        const allData = await PrismaConnection.conn.message.findMany({
            where: { instance },
            orderBy: { messageTimestamp: "desc" },
        });
        return await Promise.all(allData.map(async (data) => data.content));
    }

    static async getMessageById(messageId: string) {
        const allData = await PrismaConnection.conn.message.findFirst({
            where: { messageId }
        });
        return allData?.content;
    }
}