import { downloadMediaMessage, normalizeMessageContent, getContentType, getUrlFromDirectPath, type WAMessage } from '@whiskeysockets/baileys';
import { SocketController, RequestError, type ControllerDependencies, type ControllerResult } from './base.js';
import { reuploadHistoricalMedia } from '../../baileys/media-reupload.js';
import { collectMedia, mediaDownloadBudget, untilAborted, trackMediaDownload } from './media-budget.js';
import { messageTimestamp } from '../../mappers/messageMapper.js';
import PrismaConnection from '../../../core/connection/prisma.js';
import { embeddedJpegThumbnail } from '../../mappers/thumbnail.js';
import { isMessageId, isJid } from '../../../shared/guards.js';

export type MediaDependencies = ControllerDependencies & { download?: typeof downloadMediaMessage; reupload?: typeof reuploadHistoricalMedia;
  thumbnailPayloads?: typeof PrismaConnection.getMessageThumbnailPayloads };

function upstreamStatus(error: unknown): number | undefined {
  const failure = error as { status?: number; output?: { statusCode?: number } } | null;
  return failure?.output?.statusCode ?? failure?.status;
}

export default class MediaController extends SocketController {
  private readonly download: typeof downloadMediaMessage;
  private readonly reupload: typeof reuploadHistoricalMedia;
  private readonly thumbnailPayloads: typeof PrismaConnection.getMessageThumbnailPayloads;
  constructor(owner: string, instanceName: string, dependencies: MediaDependencies = {}) { super(owner, instanceName, dependencies); this.download = dependencies.download ?? downloadMediaMessage; this.reupload = dependencies.reupload ?? reuploadHistoricalMedia; this.thumbnailPayloads = dependencies.thumbnailPayloads ?? PrismaConnection.getMessageThumbnailPayloads; }
  async thumbnails(messageIds: string[], remoteJid?: string): Promise<ControllerResult> {
    if (!Array.isArray(messageIds) || messageIds.length < 1 || messageIds.length > 40 || !messageIds.every(isMessageId) || (remoteJid !== undefined && !isJid(remoteJid))) return { success: false, statusCode: 400, error: 'Invalid thumbnail query.' };
    const ids = [...new Set(messageIds)];
    // Deliberately independent of the socket: cached thumbnails remain usable
    // offline and this path never requests/decrypts an original media file.
    const rows = await this.thumbnailPayloads(this.instance, ids, remoteJid);
    const indexed = new Map(rows.map(row => [row.messageId, row.content]));
    const items = [];
    for (const messageId of ids) items.push({ messageId, thumbnail: await embeddedJpegThumbnail(indexed.get(messageId)) });
    return { success: true, data: { items } };
  }
  async getMedia(messageId: string, isBase64 = false, remoteJid?: string): Promise<ControllerResult> {
    const result = await this.perform('Media downloaded.', async sock => mediaDownloadBudget.run(async () => {
      const abort = new AbortController();
      const releaseTracking = trackMediaDownload(this.instance, abort);
      const timer = setTimeout(() => abort.abort(), 45_000);
      try {
      const original = await this.stored(messageId, remoteJid);
      if (remoteJid && original.key.remoteJid !== remoteJid) throw new RequestError(404, 'Message not found in the requested chat.');
      if (original.key.remoteJid === 'status@broadcast') {
        const timestamp = messageTimestamp(original.messageTimestamp) * 1000;
        if (!timestamp || timestamp > Date.now() + 60_000 || Date.now() >= timestamp + 86_400_000) throw new RequestError(410, 'WhatsApp status has expired.');
      }
      const content = normalizeMessageContent(original.message);
      const type = content ? getContentType(content) : undefined;
      if (!type || !['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type)) throw new RequestError(400, 'Message is not downloadable media.');
      const media = (content as Record<string, any>)[type];
      // Some history payloads have only directPath. The provider downloader can
      // resolve it, but its message-level guard still requires the url property.
      let message = { ...original, message: { ...content, [type]: { ...media,
        ...(!media.url && media.directPath ? { url: getUrlFromDirectPath(media.directPath) } : {}),
      } } } as WAMessage;
      let renewed = false;
      const renew = async (candidate: WAMessage): Promise<WAMessage> => {
        renewed = true;
        if (this.sock !== sock) throw new RequestError(409, 'Instance not connected.');
        return this.reupload(sock, candidate);
      };
      let buffer: Buffer;
      const download = async (candidate: WAMessage, context?: Parameters<typeof downloadMediaMessage>[3]) => {
        const stream = await untilAborted(this.download(candidate, 'stream', { options: { signal: abort.signal } }, context), abort.signal);
        return untilAborted(collectMedia(stream, 50 * 1024 * 1024, abort.signal), abort.signal);
      };
      try {
        try {
          buffer = await download(message, { logger: sock.logger, reuploadRequest: renew });
        } catch (error) {
          // rc14 checks error.status, while its HTTP downloader throws Boom
          // with output.statusCode. Renew once for those real expired URLs too.
          if (renewed || ![404, 410].includes(upstreamStatus(error) ?? 0)) throw error;
          message = await untilAborted(renew(message), abort.signal);
          buffer = await download(message);
        }
      } catch (error) {
        // A disconnect is recoverable without exhausting a media retry queue.
        if (this.sock !== sock) throw new RequestError(409, 'Instance not connected.');
        if ([404, 410].includes(upstreamStatus(error) ?? 0)) throw new RequestError(410, 'Media is no longer available from WhatsApp.');
        throw error;
      }
      if (buffer.length > 50 * 1024 * 1024) throw new RequestError(413, 'Media exceeds 50 MB.');
      const mimeType = String((content as Record<string, any>)[type]?.mimetype ?? (type === 'stickerMessage' ? 'image/webp' : 'application/octet-stream'));
      return isBase64 ? { base64: `data:${mimeType};base64,${buffer.toString('base64')}` } : { buffer, mimeType };
      } finally { clearTimeout(timer); releaseTracking(); abort.abort(); }
    }));
    return result.success ? { success: true, ...result.data } : result;
  }
}
