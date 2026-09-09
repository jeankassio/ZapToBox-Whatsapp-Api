import {
  assertMediaContent, decryptMediaRetryData, encryptMediaRetryRequest, getUrlFromDirectPath,
  proto, type BaileysEventMap, type WAMessage, type WASocket,
} from '@whiskeysockets/baileys';
import { RequestError } from '../http/controllers/base.js';

/** Raw media-update events are encrypted and do not themselves prove success. */
export function renewedMediaPath(message: WAMessage, result: BaileysEventMap['messages.media-update'][number]): string {
  if (result.error) {
    const status = (result.error as { output?: { statusCode?: number } }).output?.statusCode;
    throw new RequestError(status === 404 || status === 410 ? 410 : 502, 'WhatsApp could not renew the media.');
  }
  const content = assertMediaContent(message.message);
  if (!message.key.id || !content.mediaKey || !result.media) throw new RequestError(502, 'WhatsApp could not renew the media.');
  const media = decryptMediaRetryData(result.media, content.mediaKey, message.key.id);
  if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
    throw new RequestError(media.result === proto.MediaRetryNotification.ResultType.NOT_FOUND ? 410 : 502, 'WhatsApp could not renew the media.');
  }
  if (!media.directPath?.startsWith('/')) throw new RequestError(502, 'WhatsApp returned invalid media metadata.');
  return media.directPath;
}

/** Same provider protocol as updateMediaMessage, with a finite listener lifetime. */
export async function reuploadHistoricalMedia(sock: WASocket, message: WAMessage, timeoutMs = 15_000): Promise<WAMessage> {
  const content = assertMediaContent(message.message);
  const me = sock.authState.creds.me?.id;
  if (!me) throw new RequestError(409, 'Instance not connected.');
  if (!message.key.id || !message.key.remoteJid || !content.mediaKey) throw new RequestError(400, 'Media metadata is incomplete.');
  const mediaKey = content.mediaKey;
  const node = encryptMediaRetryRequest(message.key, mediaKey, me);
  return new Promise<WAMessage>((resolve, reject) => {
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.ev.off('messages.media-update', updated);
      sock.ev.off('connection.update', disconnected);
      if (error) reject(error); else resolve(message);
    };
    const disconnected = (update: BaileysEventMap['connection.update']) => {
      if (update.connection === 'close') finish(new RequestError(409, 'Instance not connected.'));
    };
    const updated = (updates: BaileysEventMap['messages.media-update']) => {
      const result = updates.find(item => item.key.id === message.key.id &&
        (item.key.remoteJid === message.key.remoteJid || (message.key.remoteJidAlt && item.key.remoteJid === message.key.remoteJidAlt)));
      if (!result || finished) return;
      try {
        content.directPath = renewedMediaPath(message, result);
        content.url = getUrlFromDirectPath(content.directPath, sock.getMediaHost());
        // Existing instance event processing persists the refreshed metadata.
        sock.ev.emit('messages.update', [{ key: message.key, update: { message: message.message!, ...{ mediaMetadataOnly: true } } }]);
        finish();
      } catch (error) {
        finish(error instanceof RequestError ? error : new RequestError(502, 'WhatsApp could not renew the media.'));
      }
    };
    const timer = setTimeout(() => finish(new RequestError(504, 'Timed out waiting for WhatsApp to renew the media.')), timeoutMs);
    sock.ev.on('messages.media-update', updated);
    sock.ev.on('connection.update', disconnected);
    void Promise.resolve().then(() => sock.sendNode(node)).catch(() => finish(new RequestError(502, 'Unable to request media renewal.')));
  });
}
