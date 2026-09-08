import { delay, type AnyMessageContent, type MiscMessageGenerationOptions, type WAMessageKey, type WAUrlInfo } from '@whiskeysockets/baileys';
import type { AudioMessage, ContactMessage, DocumentMessage, ForwardMessage, GifMessage, ImageMessage, LocationMessage, PinMessage, PollMessage, ReactionMessage, StatusPresence, StickerMessage, TextMessage, VideoMessage } from '../../../shared/types.js';
import { normalizeJid } from '../../../shared/guards.js';
import { SocketController, RequestError, type ControllerDependencies, type ControllerResult } from './base.js';
import { downloadPublicMedia } from './remote-media.js';
import { linkPreviewService } from '../../link-preview/service.js';

type Options = Record<string, any> | undefined;
type MessageDependencies = ControllerDependencies & { fetchMedia?: (url: string) => Promise<Buffer>; getLinkPreview?: (connection: string, text: string) => Promise<WAUrlInfo | null> };
export default class MessagesController extends SocketController {
  private readonly jid: string;
  private readonly typingDelay: number | string;
  private readonly fetchMedia: (url: string) => Promise<Buffer>;
  private readonly getLinkPreview: (connection: string, text: string) => Promise<WAUrlInfo | null>;
  constructor(owner: string, instanceName: string, jid: string, typingDelay: number | string = 0, dependencies: MessageDependencies = {}) {
    super(owner, instanceName, dependencies);
    const normalized = normalizeJid(jid);
    if (!normalized) throw new RequestError(400, 'Invalid remoteJid.');
    this.jid = normalized;
    this.typingDelay = typingDelay;
    this.fetchMedia = dependencies.fetchMedia ?? downloadPublicMedia;
    this.getLinkPreview = dependencies.getLinkPreview ?? ((connection, text) => linkPreviewService.preview(connection, text));
  }
  async filterOptions(rawOptions: Options): Promise<MiscMessageGenerationOptions> {
    const options: MiscMessageGenerationOptions = {};
    if (rawOptions?.quoted) options.quoted = await this.stored(String(rawOptions.quoted), this.jid);
    return options;
  }
  private metadata(message: object, keys: string[]): Record<string, any> { return Object.fromEntries(keys.filter(key => (message as Record<string, unknown>)[key] !== undefined).map(key => [key, (message as Record<string, unknown>)[key]])); }
  private mediaBuffer(url: string): Promise<Buffer> { void this.sock; return this.fetchMedia(url); }
  async sendMessageText(message: TextMessage, options?: Options) { return this.sendMessage({ text: message.text, ...this.metadata(message, ['mentions']) }, await this.filterOptions(options)); }
  async sendMessageLocation(message: LocationMessage, options?: Options) { return this.sendMessage({ location: { degreesLatitude: message.location.degreesLatitude, degreesLongitude: message.location.degreesLongitude, ...this.metadata(message.location, ['name', 'address']) } }, await this.filterOptions(options)); }
  async sendMessageContact(message: ContactMessage, options?: Options) {
    const escape = (text: string) => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/[\r\n]+/g, ' ');
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${escape(message.displayName)}\nTEL;type=CELL;type=VOICE;waid=${message.waid}:${escape(message.phoneNumber)}\nEND:VCARD`;
    return this.sendMessage({ contacts: { displayName: message.displayName, contacts: [{ vcard }] } }, await this.filterOptions(options));
  }
  async sendMessageReaction(reaction: ReactionMessage) {
    const target = await this.stored(reaction.messageId, this.jid);
    return this.sendMessage({ react: { text: reaction.emoji, key: target.key } });
  }
  async sendMessagePoll(message: PollMessage, options?: Options) { return this.sendMessage({ poll: { name: message.poll.name, values: message.poll.values, selectableCount: message.poll.selectableCount, ...this.metadata(message.poll, ['toAnnouncementGroup']) } }, await this.filterOptions(options)); }
  async sendMessageImage(message: ImageMessage, options?: Options) { return this.sendMessage({ image: await this.mediaBuffer(message.image.url), ...this.metadata(message, ['caption', 'viewOnce']) }, await this.filterOptions(options)); }
  async sendMessageVideo(message: VideoMessage, options?: Options) { return this.sendMessage({ video: await this.mediaBuffer(message.video.url), ...this.metadata(message, ['caption', 'viewOnce', 'ptv']) }, await this.filterOptions(options)); }
  async sendMessageGif(message: GifMessage, options?: Options) { return this.sendMessage({ video: await this.mediaBuffer(message.video.url), gifPlayback: true, ...this.metadata(message, ['caption', 'viewOnce', 'ptv']) }, await this.filterOptions(options)); }
  async sendMessageAudio(message: AudioMessage, options?: Options) { return this.sendMessage({ audio: await this.mediaBuffer(message.audio.url), mimetype: message.mimetype, ...this.metadata(message, ['ptt', 'viewOnce']) }, await this.filterOptions(options)); }
  async sendMessageDocument(message: DocumentMessage, options?: Options) { return this.sendMessage({ document: await this.mediaBuffer(message.document.url), mimetype: message.mimetype, fileName: message.fileName }, await this.filterOptions(options)); }
  async sendMessageSticker(message: StickerMessage, options?: Options) { return this.sendMessage({ sticker: await this.mediaBuffer(message.sticker.url), ...this.metadata(message, ['isAnimated']) }, await this.filterOptions(options)); }
  async sendMessageForward(message: ForwardMessage, options?: Options) { return this.sendMessage({ forward: await this.stored(message.forward) }, await this.filterOptions(options)); }
  async sendMessagePin(message: PinMessage) {
    const target = await this.stored(String(message.pin.key.id), this.jid);
    return this.sendMessage({ pin: target.key, type: message.pin.type as 1 | 2, time: message.pin.time as 86400 | 604800 | 2592000 });
  }
  async editMessage(messageId: string, text: string) {
    const target = await this.stored(messageId, this.jid);
    if (!target.key.fromMe) throw new RequestError(403, 'Only messages sent by this account can be edited.');
    return this.sendMessage({ text, edit: target.key });
  }
  async sendMessage(message: AnyMessageContent, options?: MiscMessageGenerationOptions): Promise<ControllerResult> {
    const result = await this.perform('Message sent successfully.', async sock => {
      const text = ('text' in message ? message.text : 'caption' in message ? message.caption : '') ?? '';
      // Always provide a ready preview or null: undefined enables the provider's downloader.
      let linkPreview: WAUrlInfo | null = null;
      if ('text' in message) {
        try { linkPreview = await this.getLinkPreview(this.instance, message.text) ?? null; }
        catch { /* A failed preview must never prevent sending the original text. */ }
      }
      await this.simulateTyping('audio' in message ? 'recording' : 'composing', text);
      if (this.sock !== sock) throw new RequestError(409, 'Instance connection changed before sending.');
      const content = 'text' in message ? { ...message, linkPreview } : message;
      const sent = await sock.sendMessage(this.jid, content, options);
      if (!sent?.key?.id) throw new RequestError(502, 'WhatsApp did not return a message identifier.');
      // A confirmed send must not become a failure that invites duplicate retries if persistence is unavailable.
      let syncPending = false;
      try { await this.persistSent(sent); } catch { syncPending = true; }
      return { sent, syncPending };
    });
    if (!result.success) return result;
    const sent = result.data.sent;
    return { success: true, message: result.message ?? 'Message sent successfully.', messageId: sent.key.id, key: sent.key, data: sent, ...(result.data.syncPending ? { syncPending: true } : {}) };
  }
  async deleteMessage(key: WAMessageKey, forEveryone: boolean): Promise<ControllerResult> {
    const target = await this.stored(String(key.id), this.jid);
    return this.perform('Message deleted successfully.', async sock => {
      if (forEveryone) await sock.sendMessage(this.jid, { delete: target.key });
      else await sock.chatModify({ deleteForMe: { deleteMedia: true, key: target.key, timestamp: Number(target.messageTimestamp ?? Math.floor(Date.now() / 1000)) } }, this.jid);
    });
  }
  async readMessage(key: WAMessageKey): Promise<ControllerResult> {
    const target = await this.stored(String(key.id), this.jid);
    return this.perform('Message marked as read successfully.', async sock => { await sock.readMessages([target.key]); });
  }
  async readMessages(messageIds: string[]): Promise<ControllerResult> {
    // Validate the complete batch against this instance AND chat before sending a receipt.
    const targets = await Promise.all([...new Set(messageIds)].map(id => this.stored(id, this.jid)));
    const keys = targets.filter(message => !message.key.fromMe).map(message => message.key);
    return this.perform('Messages marked as read successfully.', async sock => { if (keys.length) await sock.readMessages(keys); });
  }
  async unStar(messageId: string, remoteJid: string, star: boolean): Promise<ControllerResult> {
    const target = await this.stored(messageId, this.jid);
    return this.perform('Message star status changed successfully.', async sock => { await sock.chatModify({ star: { messages: [{ id: target.key.id!, fromMe: Boolean(target.key.fromMe) }], star } }, this.jid); });
  }
  formatJid(jid: string): string { const value = normalizeJid(jid); if (!value) throw new RequestError(400, 'Invalid remoteJid.'); return value; }
  calculateDelay(text: string): number { return Math.min(30_000, Math.ceil(text.trim().split(/\s+/).filter(Boolean).length / 40 * 60_000)); }
  async simulateTyping(presence: StatusPresence, text: string): Promise<void> {
    const duration = this.typingDelay === 'auto' ? this.calculateDelay(text) : typeof this.typingDelay === 'number' ? Math.min(Math.max(this.typingDelay, 0), 30_000) : 0;
    if (!duration) return;
    const sock = this.sock;
    await sock.presenceSubscribe(this.jid);
    await sock.sendPresenceUpdate(presence, this.jid);
    try { await delay(duration); } finally { await sock.sendPresenceUpdate('paused', this.jid); }
  }
}
