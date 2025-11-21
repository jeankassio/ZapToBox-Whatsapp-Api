import { Prisma, PrismaClient } from "@prisma/client";
import { JsonValue } from "@prisma/client/runtime/library";
import { Contact } from "../../shared/types";
import { WAMessage } from "@whiskeysockets/baileys";
import { MessageMapper } from "../../infra/mappers/messageMapper";
import { ContactMapper } from "../../infra/mappers/contactMapper";

export default class PrismaConnection {

    private static conn: PrismaClient =  new PrismaClient();;
    
    static async saveMessages(instance: string, msg: any): Promise<any> {

        const key = msg.key;
        
        if(!key || !key.id){
            return;
        }

        const updateData: any = {
            content: msg,
        };

        if (msg.pushName !== undefined && msg.pushName !== null) updateData.pushName = msg.pushName;
        if (msg?.status !== undefined && msg?.status !== null) updateData.status = msg.status.toString();
        if (msg.messageTimestamp !== undefined && msg.messageTimestamp !== null) updateData.messageTimestamp = BigInt(msg.messageTimestamp);

        return PrismaConnection.conn.message.upsert({
            where: {
                instance_messageId: {
                    instance,
                    messageId: key.id,
                },
            },
            update: updateData,
            create: {
                instance,
                messageId: key.id,
                remoteJid: key.remoteJid!,
                senderLid: key?.senderLid || null,
                fromMe: !!key.fromMe,
                pushName: msg.pushName || null,
                content: msg,
                status: msg?.status?.toString() || null,
                messageTimestamp: BigInt(msg.messageTimestamp || 0),
            },
        });

    }

    static async saveManyMessages(instance: string, msgs: any[]): Promise<void>{

        for(const msg of msgs){
            await this.saveMessages(instance, msg);
        }

    }

    static async saveContact(instance: string, contact: Contact): Promise<any> {
        const { id, lid, name } = contact;

        try{

            const createData = {
                instance,
                name: name ?? null,
                jid: id ?? null,
                lid: lid ?? null,
            };

            const updateData: any = { instance };
            
            if (name !== undefined && name !== null) updateData.name = name;
            if (id !== undefined && id !== null) updateData.jid = id;
            if (lid !== undefined && lid !== null) updateData.lid = lid;

            if(id){
                return await PrismaConnection.conn.contact.upsert({
                    where: {
                        instance_jid: { instance, jid: id }
                    },
                    update: updateData,
                    create: createData
                });
            }else if(lid){
                return await PrismaConnection.conn.contact.upsert({
                    where: {
                        instance_lid: { instance, lid }
                    },
                    update: updateData,
                    create: createData
                });
            }

        }catch(err){
            console.log(err);
            return false;
        }

    }

    static async saveManyContacts(instance: string, contacts: Contact[]): Promise<void>{
        for(const contact of contacts){
            await this.saveContact(instance, contact);
        }
    }

    static async deleteByInstance(instance: string): Promise<Prisma.BatchPayload>{
        PrismaConnection.conn.message.deleteMany({
            where: { instance },
        });
        PrismaConnection.conn.chat.deleteMany({
            where: { instance },
        });
        return PrismaConnection.conn.contact.deleteMany({
            where: { instance },
        });
    }

    static async getMessageByInstance(instance: string): Promise<JsonValue[] | undefined> {
        const allData = await PrismaConnection.conn.message.findMany({
            where: { instance },
            orderBy: { messageTimestamp: "desc" },
        });
        return await Promise.all(allData?.map(async (data) => data.content));
    }

    static async getMessageById(messageId: string): Promise<WAMessage | undefined> {
        const allData = await PrismaConnection.conn.message.findFirst({
            where: { messageId }
        });

        if(!allData){
            return undefined;
        }

        return MessageMapper.toWAMessage(allData);

    }
    
    static async getLastMessageByInstance(instance: string, remoteJid: string): Promise<WAMessage | undefined> {
        const allData = await PrismaConnection.conn.message.findFirst({
            where: { 
                AND: [
                    { instance },
                    { remoteJid }
                ]
            },
            orderBy: { messageTimestamp: "desc" },
        });

        if(!allData){
            return undefined;
        }

        return MessageMapper.toWAMessage(allData);

    }
    
    static async getContactById(instance: string, id: string): Promise<Contact | undefined> {
        const allData = await PrismaConnection.conn.contact.findFirst({
            where: { 
                instance,
                OR: [
                    { jid: id },
                    { lid: id }
                ]
            }
        });

        if(!allData){
            return undefined;
        }

        return ContactMapper.toContact(allData);

    }
    

}