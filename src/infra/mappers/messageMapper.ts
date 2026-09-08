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

/** Baileys message updates store the current body inside an editedMessage wrapper. */
export function isEditedMessage(value: unknown): boolean {
  let body = value;
  for (let depth = 0; depth < 8; depth++) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const message = body as Record<string, any>;
    if (message.editedMessage && typeof message.editedMessage === 'object') return true;
    if (message.protocolMessage && typeof message.protocolMessage === 'object' &&
      (message.protocolMessage as Record<string, unknown>).editedMessage &&
      typeof (message.protocolMessage as Record<string, unknown>).editedMessage === 'object') return true;
    const wrapper = message.ephemeralMessage ?? message.viewOnceMessage ?? message.viewOnceMessageV2
      ?? message.viewOnceMessageV2Extension ?? message.documentWithCaptionMessage;
    body = wrapper && typeof wrapper === 'object' ? wrapper.message : undefined;
  }
  return false;
}

export interface SourceEdit {
  version: number;
  editedAtMs: number;
  sourceUpdatedAt: string;
}

export function sourceEdit(value: unknown): SourceEdit | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const version = Number(data.version), editedAtMs = Number(data.editedAtMs);
  if (!Number.isSafeInteger(version) || version < 1 || !Number.isSafeInteger(editedAtMs) || editedAtMs < 0 ||
    typeof data.sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(data.sourceUpdatedAt))) return null;
  return { version, editedAtMs, sourceUpdatedAt: data.sourceUpdatedAt };
}

/** Extract the edit clock carried by either a protocol update or a stored wrapper. */
export function editTimestampMs(value: unknown, fallback: unknown): number {
  let body = value;
  for (let depth = 0; depth < 8; depth++) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) break;
    const message = body as Record<string, any>;
    const raw = message.protocolMessage?.timestampMs ?? message.editedMessage?.timestampMs;
    if (raw !== undefined && raw !== null) {
      const parsed = messageTimestamp(raw);
      if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
    }
    const wrapper = message.ephemeralMessage ?? message.viewOnceMessage ?? message.viewOnceMessageV2
      ?? message.viewOnceMessageV2Extension ?? message.documentWithCaptionMessage;
    body = wrapper && typeof wrapper === 'object' ? wrapper.message : undefined;
  }
  const parsed = messageTimestamp(fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return 0;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
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
