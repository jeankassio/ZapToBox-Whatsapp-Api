import type { AudioMessage, ContactMessage, DocumentMessage, ForwardMessage, GifMessage, ImageMessage, LocationMessage, PinMessage, PollMessage, ReactionMessage, StickerMessage, TextMessage, VideoMessage } from './types.js';

export function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
export function isString(value: unknown, max = 65_536): value is string { return typeof value === 'string' && value.length <= max; }
export function isNonEmptyString(value: unknown, max = 65_536): value is string { return isString(value, max) && value.trim().length > 0; }
export function isNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function isBoolean(value: unknown): value is boolean { return typeof value === 'boolean'; }
export function isJid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 180 && /^(?:\d{5,20}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid)|\d{5,30}(?:-\d{1,20})?@g\.us|status@broadcast|\d{5,30}@newsletter)$/.test(value);
}
export function normalizeJid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (isJid(clean)) return clean;
  const number = String(value).trim();
  return /^\+?\d{5,15}$/.test(number) ? number.replace(/^\+/, '') + '@s.whatsapp.net' : undefined;
}
export function isGroupJid(value: unknown): value is string { return isJid(value) && value.endsWith('@g.us'); }
export function isMessageId(value: unknown): value is string { return isNonEmptyString(value, 255) && !/[\x00-\x1f]/.test(value); }
export function isMessageKey(value: unknown): boolean { return isObject(value) && isMessageId(value.id) && (value.remoteJid === undefined || isJid(value.remoteJid)) && (value.fromMe === undefined || isBoolean(value.fromMe)) && (value.participant === undefined || isJid(value.participant)); }
export function isMediaUrl(value: unknown): value is string {
  if (!isNonEmptyString(value, 4096)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && Boolean(url.hostname); } catch { return false; }
}
const optionalBoolean = (obj: Record<string, any>, key: string) => obj[key] === undefined || isBoolean(obj[key]);
const media = (obj: unknown, type: string) => isObject(obj) && isObject(obj[type]) && isMediaUrl(obj[type].url);
const caption = (obj: Record<string, any>) => obj.caption === undefined || isString(obj.caption);
export function isForwardMessage(obj: unknown): obj is ForwardMessage { return isObject(obj) && isMessageId(obj.forward); }
export function isTextMessage(obj: unknown): obj is TextMessage { return isObject(obj) && isNonEmptyString(obj.text) && (obj.mentions === undefined || (Array.isArray(obj.mentions) && obj.mentions.length <= 1024 && obj.mentions.every(isJid))); }
export function isLocationMessage(obj: unknown): obj is LocationMessage {
  if (!isObject(obj) || !isObject(obj.location)) return false;
  const location = obj.location;
  return isNumber(location.degreesLatitude) && Math.abs(location.degreesLatitude) <= 90
    && isNumber(location.degreesLongitude) && Math.abs(location.degreesLongitude) <= 180
    && (location.name === undefined || isString(location.name, 255))
    && (location.address === undefined || isString(location.address, 1024));
}
export function isContactMessage(obj: unknown): obj is ContactMessage { return isObject(obj) && isNonEmptyString(obj.displayName, 120) && !/[\r\n]/.test(obj.displayName) && Number.isSafeInteger(obj.waid) && obj.waid > 0 && isString(obj.phoneNumber, 30) && /^\+?[\d ()-]{5,30}$/.test(obj.phoneNumber); }
export function isReactionMessage(obj: unknown): obj is ReactionMessage { return isObject(obj) && isString(obj.emoji, 32) && isMessageId(obj.messageId); }
export function isPinMessage(obj: unknown): obj is PinMessage { return isObject(obj) && isObject(obj.pin) && [1, 2].includes(obj.pin.type) && [86_400, 604_800, 2_592_000].includes(obj.pin.time) && isMessageKey(obj.pin.key); }
export function isPollMessage(obj: unknown): obj is PollMessage {
  if (!isObject(obj) || !isObject(obj.poll)) return false;
  const poll = obj.poll;
  return isNonEmptyString(poll.name, 255) && Array.isArray(poll.values) && poll.values.length >= 2 && poll.values.length <= 12 && poll.values.every((value: unknown) => isNonEmptyString(value, 100)) && new Set(poll.values).size === poll.values.length && Number.isInteger(poll.selectableCount) && poll.selectableCount >= 1 && poll.selectableCount <= poll.values.length && (poll.toAnnouncementGroup === undefined || isBoolean(poll.toAnnouncementGroup));
}
export function isImageMessage(obj: unknown): obj is ImageMessage { return isObject(obj) && media(obj, 'image') && caption(obj) && optionalBoolean(obj, 'viewOnce'); }
export function isVideoMessage(obj: unknown): obj is VideoMessage { return isObject(obj) && media(obj, 'video') && caption(obj) && optionalBoolean(obj, 'ptv') && optionalBoolean(obj, 'viewOnce'); }
export function isGifMessage(obj: unknown): obj is GifMessage { return isVideoMessage(obj) && (obj as unknown as Record<string, unknown>).gifPlayback === true; }
export function isAudioMessage(obj: unknown): obj is AudioMessage { return isObject(obj) && media(obj, 'audio') && isNonEmptyString(obj.mimetype, 128) && optionalBoolean(obj, 'viewOnce') && optionalBoolean(obj, 'ptt'); }
export function isDocumentMessage(obj: unknown): obj is DocumentMessage { return isObject(obj) && media(obj, 'document') && isNonEmptyString(obj.mimetype, 128) && isNonEmptyString(obj.fileName, 255) && !/[\x00-\x1f]/.test(obj.fileName); }
export function isStickerMessage(obj: unknown): obj is StickerMessage { return isObject(obj) && media(obj, 'sticker') && optionalBoolean(obj, 'isAnimated'); }
