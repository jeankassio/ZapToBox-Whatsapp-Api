import { downloadMediaMessage, normalizeMessageContent, getContentType, type WAMessage } from '@whiskeysockets/baileys';
import { SocketController, RequestError, type ControllerDependencies, type ControllerResult } from './base.js';

type MediaDependencies = ControllerDependencies & { download?: typeof downloadMediaMessage };
export default class MediaController extends SocketController {
  private readonly download: typeof downloadMediaMessage;
  constructor(owner: string, instanceName: string, dependencies: MediaDependencies = {}) { super(owner, instanceName, dependencies); this.download = dependencies.download ?? downloadMediaMessage; }
  async getMedia(messageId: string, isBase64 = false): Promise<ControllerResult> {
    const result = await this.perform('Media downloaded.', async sock => {
      const original = await this.stored(messageId);
      const content = normalizeMessageContent(original.message);
      const type = content ? getContentType(content) : undefined;
      if (!type || !['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].includes(type)) throw new RequestError(400, 'Message is not downloadable media.');
      const message = { ...original, message: content } as WAMessage;
      const buffer = await this.download(message, 'buffer', {}, { logger: sock.logger, reuploadRequest: msg => sock.updateMediaMessage(msg) });
      if (buffer.length > 50 * 1024 * 1024) throw new RequestError(413, 'Media exceeds 50 MB.');
      const mimeType = String((content as Record<string, any>)[type]?.mimetype ?? 'application/octet-stream');
      return isBase64 ? { base64: `data:${mimeType};base64,${buffer.toString('base64')}` } : { buffer, mimeType };
    });
    return result.success ? { success: true, ...result.data } : result;
  }
}
