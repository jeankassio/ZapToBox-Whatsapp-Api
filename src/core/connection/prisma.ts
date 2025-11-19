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
                status: msg?.status || null,
                messageTimestamp: BigInt(msg.messageTimestamp || 0),
            },
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
        const { jid, lid, name } = contact;

        if (!jid && !lid) return;

        try{

            const data = {
                instance,
                name: name ?? null,
                jid: jid ?? null,
                lid: lid ?? null,
            };

            if(jid){
                return await PrismaConnection.conn.contact.upsert({
                    where: {
                        instance_jid: { instance, jid }
                    },
                    update: data,
                    create: data
                });
            }else if(lid){
                return await PrismaConnection.conn.contact.upsert({
                    where: {
                        instance_lid: { instance, lid }
                    },
                    update: data,
                    create: data
                });
            }

        }catch(err){
            console.error(err);
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