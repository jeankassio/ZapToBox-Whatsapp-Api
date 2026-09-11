import { Prisma, PrismaClient, type Message } from "@prisma/client";
import { isDeepStrictEqual } from 'node:util';
import type { WAMessage, WAMessageKey } from "@whiskeysockets/baileys";
import type { Contact } from "../../shared/types.js";
import { MessageMapper, editTimestampMs, isEditedMessage, sourceEdit } from "../../infra/mappers/messageMapper.js";
import { ContactMapper, mergeContactNames } from "../../infra/mappers/contactMapper.js";
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
  static async getMessageThumbnailPayloads(instance: string, messageIds: string[], remoteJid?: string) {
    return prisma.message.findMany({ where: { instance, messageId: { in: messageIds }, ...(remoteJid ? { remoteJid } : {}) }, select: { messageId: true, content: true } });
  }
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
    return serialized(instance, () => this.saveMessageRow(instance, msg));
  }
  /** Caller owns the per-instance write lock. */
  private static async saveMessageRow(instance: string, msg: WAMessage, known?: Message | null): Promise<unknown> {
      const previous = known === undefined ? await prisma.message.findUnique({where:{instance_messageId:{instance,messageId:msg.key.id!}}}) : known;
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
      if (previous && previous.remoteJid === msg.key.remoteJid && previous.status === status && previous.messageTimestamp === timestamp
        && (msg.pushName == null || previous.pushName === msg.pushName) && isDeepStrictEqual(previous.content, content)) return previous;
      return prisma.message.upsert({
        where:{instance_messageId:{instance,messageId:msg.key.id!}},
        update:{content,remoteJid:msg.key.remoteJid!, status, messageTimestamp:timestamp, ...(msg.pushName != null ? {pushName:msg.pushName}: {})},
        create:{instance,messageId:msg.key.id!,remoteJid:msg.key.remoteJid!,senderLid:msg.key.participantAlt ?? msg.key.remoteJidAlt ?? null,
          fromMe:!!msg.key.fromMe,pushName:msg.pushName ?? null,content,status,messageTimestamp:timestamp}
      });
  }
  static async saveManyMessages(instance: string, msgs: WAMessage[]): Promise<void> {
    if (!instance) return;
    // Initial history is predominantly new rows. One lookup and one INSERT per
    // bounded slice replace two DB round trips for every message. Existing rows
    // still use the exact merge path for edits, partial updates and PN/LID keys.
    for (let offset = 0; offset < msgs.length; offset += 100) {
      const batch = msgs.slice(offset, offset + 100).filter(msg => msg.key?.id && msg.key.remoteJid);
      if (!batch.length) continue;
      await serialized(instance, async () => {
        const ids = batch.map(msg => msg.key.id!);
        const existing = await prisma.message.findMany({ where: { instance, messageId: { in: ids } } });
        const known = new Map(existing.map(row => [row.messageId, row]));
        const duplicates = new Set(ids.filter((id, index) => ids.indexOf(id) !== index));
        // Mixed duplicate/new-edit slices must retain their original insert
        // order: physical IDs break ties between messages with equal timestamps.
        if (duplicates.size || batch.some(msg => !known.has(msg.key.id!) && isEditedMessage(msg.message))) {
          for (const msg of batch) await this.saveMessageRow(instance, msg);
          return;
        }
        const inserts = batch.filter(msg => !known.has(msg.key.id!));
        const insertIds = new Set(inserts.map(msg => msg.key.id!));
        if (inserts.length) await prisma.message.createMany({ data: inserts.map(msg => ({
          instance, messageId: msg.key.id!, remoteJid: msg.key.remoteJid!, senderLid: msg.key.participantAlt ?? msg.key.remoteJidAlt ?? null,
          fromMe: !!msg.key.fromMe, pushName: msg.pushName ?? null, content: jsonValue<Prisma.InputJsonObject>(msg),
          status: msg.status != null ? String(msg.status) : null, messageTimestamp: msg.messageTimestamp != null ? timestampBigInt(msg.messageTimestamp) : 0n,
        })) });
        for (const msg of batch) if (!insertIds.has(msg.key.id!)) {
          await this.saveMessageRow(instance, msg, known.get(msg.key.id!) ?? null);
        }
      });
    }
  }
  static async saveContact(instance: string, contact: Contact): Promise<Contact | undefined> {
    const id = contact.id;
    const jid = id?.endsWith("@lid") ? contact.phoneNumber : (id ?? contact.phoneNumber);
    const lid = id?.endsWith("@lid") ? id : contact.lid;
    if (!jid && !lid) return;
    return serialized(instance, () => prisma.$transaction(async tx => {
      const rows = await tx.contact.findMany({where:{instance,OR:[...(jid?[{jid}]:[]),...(lid?[{lid}]:[])]}, orderBy:{id:"asc"}});
      const found = rows[0];
      // The oldest row may be an unnamed PN placeholder while the LID row owns the name.
      const names = mergeContactNames(rows, contact);
      const data = {instance,...names,nameMetadata:jsonValue<Prisma.InputJsonObject>(names.nameMetadata),jid:jid ?? found?.jid ?? null,lid:lid ?? found?.lid ?? null};
      if (found) {
        if (rows.length > 1) await tx.contact.deleteMany({where:{instance,id:{in:rows.slice(1).map(row=>row.id)}}});
        if (found.name === data.name && found.jid === data.jid && found.lid === data.lid && isDeepStrictEqual(found.nameMetadata, data.nameMetadata)) return ContactMapper.event(found, contact);
        return ContactMapper.event(await tx.contact.update({where:{id:found.id},data}), contact);
      }
      return ContactMapper.event(await tx.contact.create({data}), contact);
    }));
  }
  static async saveManyContacts(instance: string, contacts: Contact[]): Promise<Contact[]> {
    const result: Contact[] = [];
    // Adjacent identical replays share a write without changing event order or counts.
    let previous: Contact | undefined, saved: Contact | undefined;
    for (const contact of contacts) {
      if (!previous || !isDeepStrictEqual(previous, contact)) saved = await this.saveContact(instance,contact);
      previous = contact;
      if (saved) result.push(saved);
    }
    return result;
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
