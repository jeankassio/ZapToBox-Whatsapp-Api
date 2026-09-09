import { downloadMediaMessage, normalizeMessageContent, getContentType, getUrlFromDirectPath, type WAMessage } from '@whiskeysockets/baileys';
import { SocketController, RequestError, type ControllerDependencies, type ControllerResult } from './base.js';
import { reuploadHistoricalMedia } from '../../baileys/media-reupload.js';

type MediaDependencies = ControllerDependencies & { download?: typeof downloadMediaMessage; reupload?: typeof reuploadHistoricalMedia };

function upstreamStatus(error: unknown): number | undefined {
  const failure = error as { status?: number; output?: { statusCode?: number } } | null;
  return failure?.output?.statusCode ?? failure?.status;
}

export default class MediaController extends SocketController {
  private readonly download: typeof downloadMediaMessage;
  private readonly reupload: typeof reuploadHistoricalMedia;
  constructor(owner: string, instanceName: string, dependencies: MediaDependencies = {}) { super(owner, instanceName, dependencies); this.download = dependencies.download ?? downloadMediaMessage; this.reupload = dependencies.reupload ?? reuploadHistoricalMedia; }
  async getMedia(messageId: string, isBase64 = false): Promise<ControllerResult> {
    const result = await this.perform('Media downloaded.', async sock => {
      const original = await this.stored(messageId);
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
      try {
        try {
          buffer = await this.download(message, 'buffer', {}, { logger: sock.logger, reuploadRequest: renew });
        } catch (error) {
          // rc14 checks error.status, while its HTTP downloader throws Boom
          // with output.statusCode. Renew once for those real expired URLs too.
          if (renewed || ![404, 410].includes(upstreamStatus(error) ?? 0)) throw error;
          message = await renew(message);
          buffer = await this.download(message, 'buffer', {});
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
    });
    return result.success ? { success: true, ...result.data } : result;
  }
}
