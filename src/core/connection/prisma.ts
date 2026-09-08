import { Prisma, PrismaClient } from "@prisma/client";
import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";
import type { Contact } from "../../shared/types.js";
import { MessageMapper, editTimestampMs, isEditedMessage, sourceEdit } from "../../infra/mappers/messageMapper.js";
import { ContactMapper } from "../../infra/mappers/contactMapper.js";
import { jsonValue, timestampBigInt } from "../../shared/serialization.js";

export const prisma = new PrismaClient();
const writes = new Map<string, Promise<unknown>>();
async function serialized<T>(instance: string, work: () => Promise<T>): Promise<T> {
  const prior = writes.get(instance) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(work);
  writes.set(instance, next);
  try { return await next; } finally { if (writes.get(instance) === next) writes.delete(instance); }
}

export default class PrismaConnection {
  private static async chatWhere(instance:string,remoteJid:string):Promise<Prisma.MessageWhereInput> {
    const contact=await prisma.contact.findFirst({where:{instance,OR:[{jid:remoteJid},{lid:remoteJid}]}});
    const aliases=[...new Set([remoteJid,contact?.jid,contact?.lid].filter((value):value is string=>!!value))];
    return {instance,OR:[{remoteJid:{in:aliases}},...aliases.map(alias=>({content:{path:['key','remoteJidAlt'],equals:alias}}))]};
  }
  static async saveManyChats(instance:string, chats: {id:string;[key:string]:unknown}[]): Promise<void> {
    await serialized(instance, async () => {
      for (const chat of chats) {
        if (!chat.id) continue;
        const previous = await prisma.chat.findUnique({where:{instance_chat_jid:{instance,jid:chat.id}}});
        const data = jsonValue<Prisma.InputJsonObject>({...previous?.data as object,...chat});
        await prisma.chat.upsert({where:{instance_chat_jid:{instance,jid:chat.id}},create:{instance,jid:chat.id,data},update:{data}});
      }
    });
  }
  static async deleteChats(instance:string, ids:string[]): Promise<void> {
    await serialized(instance, async()=>{await prisma.chat.deleteMany({where:{instance,jid:{in:ids}}});});
  }
  static async deleteMessages(instance:string, deletion:{keys?:WAMessageKey[];jid?:string;all?:boolean}): Promise<void> {
    if (!instance) throw new Error("Instance is required");
    await serialized(instance, async()=>{
      if (deletion.all && deletion.jid) await prisma.message.deleteMany({where:await this.chatWhere(instance,deletion.jid)});
      else if(deletion.keys?.length) {
        const ids:string[]=[];
        for (const key of deletion.keys) if(key.id && key.remoteJid && await this.getMessageById(key.id,instance,key.remoteJid)) ids.push(key.id);
        await prisma.message.deleteMany({where:{instance,messageId:{in:ids}}});
      }
    });
  }
  static async saveMessages(instance: string, msg: WAMessage): Promise<unknown> {
    if (!instance || !msg.key?.id || !msg.key.remoteJid) return;
    return serialized(instance, async () => {
      const previous = await prisma.message.findUnique({where:{instance_messageId:{instance,messageId:msg.key.id!}}});
      const old = previous?.content as Record<string, unknown> | undefined;
      const mergedKey={...(old?.key as object),...msg.key};
      if(previous && previous.remoteJid!==msg.key.remoteJid && !mergedKey.remoteJidAlt) mergedKey.remoteJidAlt=previous.remoteJid;
      // An edit update carries its edit time in messageTimestamp. Retain the
      // original send time so a future history replay does not reorder the chat.
      const edited = isEditedMessage(msg.message);
      const originalTimestamp = previous && previous.messageTimestamp > 0n && edited ? previous.messageTimestamp : null;
      const timestamp = originalTimestamp ?? (msg.messageTimestamp != null ? timestampBigInt(msg.messageTimestamp) : (previous?.messageTimestamp ?? 0n));
      const priorSourceEdit = sourceEdit(old?.sourceEdit);
      const bodyChanged = edited && JSON.stringify(old?.message ?? null) !== JSON.stringify(msg.message ?? null);
      const currentSourceEdit = bodyChanged ? {
        version: (priorSourceEdit?.version ?? 0) + 1,
        editedAtMs: editTimestampMs(msg.message, msg.messageTimestamp),
        sourceUpdatedAt: new Date().toISOString(),
      } : priorSourceEdit;
      const content = jsonValue<Prisma.InputJsonObject>({...old, ...msg, key:mergedKey,
        ...(currentSourceEdit ? { sourceEdit: currentSourceEdit } : {}),
        ...(originalTimestamp !== null ? { messageTimestamp: originalTimestamp } : {})});
      const status = msg.status != null ? String(msg.status) : previous?.status ?? null;
      return prisma.message.upsert({
        where:{instance_messageId:{instance,messageId:msg.key.id!}},
        update:{content,remoteJid:msg.key.remoteJid!, status, messageTimestamp:timestamp, ...(msg.pushName != null ? {pushName:msg.pushName}: {})},
        create:{instance,messageId:msg.key.id!,remoteJid:msg.key.remoteJid!,senderLid:msg.key.participantAlt ?? msg.key.remoteJidAlt ?? null,
          fromMe:!!msg.key.fromMe,pushName:msg.pushName ?? null,content,status,messageTimestamp:timestamp}
      });
    });
  }
  static async saveManyMessages(instance: string, msgs: WAMessage[]): Promise<void> {
    for (const msg of msgs) await this.saveMessages(instance,msg);
  }
  static async saveContact(instance: string, contact: Contact & {phoneNumber?:string;notify?:string}): Promise<unknown> {
    const id = contact.id;
    const jid = id?.endsWith("@lid") ? contact.phoneNumber : (id ?? contact.phoneNumber);
    const lid = id?.endsWith("@lid") ? id : contact.lid;
    if (!jid && !lid) return;
    return serialized(instance, () => prisma.$transaction(async tx => {
      const rows = await tx.contact.findMany({where:{instance,OR:[...(jid?[{jid}]:[]),...(lid?[{lid}]:[])]}, orderBy:{id:"asc"}});
      const found = rows[0];
      // The oldest row may be an unnamed PN placeholder while the LID row owns the name.
      const data = {instance,name:contact.name ?? contact.notify ?? rows.find(row=>row.name)?.name ?? null,jid:jid ?? found?.jid ?? null,lid:lid ?? found?.lid ?? null};
      if (found) {
        if (rows.length > 1) await tx.contact.deleteMany({where:{instance,id:{in:rows.slice(1).map(row=>row.id)}}});
        return tx.contact.update({where:{id:found.id},data});
      }
      return tx.contact.create({data});
    }));
  }
  static async saveManyContacts(instance: string, contacts: Contact[]): Promise<void> {
    for (const contact of contacts) await this.saveContact(instance,contact);
  }
  static async deleteByInstance(instance: string): Promise<Prisma.BatchPayload> {
    return serialized(instance, () => prisma.$transaction(async tx => {
      await tx.message.deleteMany({where:{instance}});
      await tx.chat.deleteMany({where:{instance}});
      return tx.contact.deleteMany({where:{instance}});
    }));
  }
  static async getMessageByInstance(instance: string): Promise<Prisma.JsonValue[]> {
    return (await prisma.message.findMany({where:{instance},orderBy:{messageTimestamp:"desc"}})).map(row=>row.content);
  }
  static async getMessageById(messageId: string, instance: string, remoteJid?:string): Promise<WAMessage | undefined> {
    if (!instance || !messageId) return undefined;
    const row = await prisma.message.findUnique({where:{instance_messageId:{instance,messageId}}});
    if (!row) return undefined;
    const msg = MessageMapper.toWAMessage(row);
    if (remoteJid && row.remoteJid !== remoteJid && msg.key.remoteJidAlt !== remoteJid) {
      const mapping = await prisma.contact.findFirst({where:{instance,OR:[{jid:remoteJid,lid:row.remoteJid},{lid:remoteJid,jid:row.remoteJid}]}});
      if (!mapping) return undefined;
    }
    return msg;
  }
  static async getLastMessageByInstance(instance: string, remoteJid: string): Promise<WAMessage | undefined> {
    const row = await prisma.message.findFirst({where:await this.chatWhere(instance,remoteJid),orderBy:[{messageTimestamp:"desc"},{id:"desc"}]});
    return row ? MessageMapper.toWAMessage(row) : undefined;
  }
  static async getContactById(instance: string,id:string): Promise<Contact | undefined> {
    const row = await prisma.contact.findFirst({where:{instance,OR:[{jid:id},{lid:id}]}});
    return row ? ContactMapper.toContact(row) : undefined;
  }
  /** Caller must first rule out duplicate legacy owner_name keys in the session inventory. */
  static async migrateLegacyInstanceKey(owner:string, name:string): Promise<void> {
    const legacy = owner + "_" + name;
    const instance = owner + "/" + name;
    await prisma.$transaction(async tx => {
      await tx.message.updateMany({where:{instance:legacy},data:{instance}});
      await tx.contact.updateMany({where:{instance:legacy},data:{instance}});
      await tx.chat.updateMany({where:{instance:legacy},data:{instance}});
    });
  }
}
