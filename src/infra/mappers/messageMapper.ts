import { BufferJSON, type MinimalMessage, type WAMessage } from '@whiskeysockets/baileys';
import type { Message as PrismaMessage } from '@prisma/client';

/** JSON suitable for SQL/webhooks, preserving binary keys and 64-bit integers. */
export function serializeBaileys(value: unknown): any {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item?.type === 'Buffer' && typeof item.data === 'string') return item;
    return BufferJSON.replacer(key, item);
  }));
}

const legacyByteFields = new Set([
  'mediaKey', 'fileSha256', 'fileEncSha256', 'jpegThumbnail', 'thumbnailSha256',
  'thumbnailEncSha256', 'messageSecret', 'senderKeyDistributionMessage',
  'encPayload', 'encIv', 'pollEncKey', 'waveform', 'midQualityFileSha256',
]);

/** Old releases stored proto byte fields as plain base64 strings. */
export function deserializeBaileys(value: unknown): any {
  return JSON.parse(JSON.stringify(value), (key, item) => {
    if (legacyByteFields.has(key) && typeof item === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item)) {
      return Buffer.from(item, 'base64');
    }
    return BufferJSON.reviver(key, item);
  });
}

export function messageTimestamp(value: unknown): number {
  if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') return value.toNumber();
  if (value && typeof value === 'object' && 'low' in value && 'high' in value) {
    return Number(BigInt(Number(value.high) >>> 0) * 4294967296n + BigInt(Number(value.low) >>> 0));
  }
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export class MessageMapper {
  static toMinimalMessage(row: PrismaMessage): MinimalMessage {
    const message = this.toWAMessage(row);
    return { key: message.key, messageTimestamp: message.messageTimestamp ?? null };
  }

  static toWAMessage(row: PrismaMessage): WAMessage {
    const content = deserializeBaileys(row.content) ?? {};
    return {
      ...content,
      key: { remoteJid: row.remoteJid, fromMe: row.fromMe, id: row.messageId, ...content.key },
      messageTimestamp: messageTimestamp(row.messageTimestamp),
      ...(content.pushName === undefined && row.pushName ? { pushName: row.pushName } : {}),
      ...(content.status === undefined && row.status && /^\d+$/.test(row.status) ? { status: Number(row.status) } : {}),
    };
  }
}
