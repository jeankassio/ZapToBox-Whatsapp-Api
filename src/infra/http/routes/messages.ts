import { Router } from 'express';
import MessagesController from '../controllers/messages.js';
import { RequestError } from '../controllers/base.js';
import { isAudioMessage, isContactMessage, isDocumentMessage, isForwardMessage, isGifMessage, isImageMessage, isLocationMessage, isObject, isPinMessage, isPollMessage, isReactionMessage, isStickerMessage, isTextMessage, isVideoMessage } from '../../../shared/guards.js';
import { boolean, jid, messageId, scopedRoute, text } from './helpers.js';

type Factory = (owner: string, name: string, jid: string, delay: number | string) => MessagesController;
export default class MessageRoutes {
  private readonly router = Router();
  constructor(factory: Factory = (owner, name, jid, delay) => new MessagesController(owner, name, jid, delay)) {
    const operations = [
      ['sendText', isTextMessage, 'sendMessageText'], ['sendLocation', isLocationMessage, 'sendMessageLocation'], ['sendContact', isContactMessage, 'sendMessageContact'],
      ['sendReaction', isReactionMessage, 'sendMessageReaction'], ['sendPoll', isPollMessage, 'sendMessagePoll'], ['sendImage', isImageMessage, 'sendMessageImage'],
      ['sendVideo', isVideoMessage, 'sendMessageVideo'], ['sendGif', isGifMessage, 'sendMessageGif'], ['sendAudio', isAudioMessage, 'sendMessageAudio'],
      ['sendDocument', isDocumentMessage, 'sendMessageDocument'], ['sendSticker', isStickerMessage, 'sendMessageSticker'], ['sendForward', isForwardMessage, 'sendMessageForward'], ['sendPin', isPinMessage, 'sendMessagePin'],
    ] as const;
    for (const [path, validate, method] of operations) scopedRoute(this.router, 'post', `/${path}`, async ({ owner, name, body }) => {
      const remoteJid = jid(body.remoteJid ?? body.jid);
      const message = path === 'sendText' && body.message === undefined ? { text: body.text, ...(body.mentions === undefined ? {} : { mentions: body.mentions }) } : body.message;
      if (!validate(message)) throw new RequestError(400, 'Invalid message format.');
      const delay = body.delay ?? 0;
      if (delay !== 'auto' && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 30_000)) throw new RequestError(400, 'Delay must be auto or milliseconds between 0 and 30000.');
      if (body.options !== undefined && (!isObject(body.options) || (body.options.quoted !== undefined && typeof body.options.quoted !== 'string'))) throw new RequestError(400, 'Invalid message options.');
      const controller = factory(owner, name, remoteJid, delay);
      return (controller[method] as (content: any, options?: Record<string, any>) => ReturnType<MessagesController['sendMessageText']>).call(controller, message, body.options);
    });
    scopedRoute(this.router, 'patch', '/editMessage', ({ owner, name, body }) => factory(owner, name, jid(body.remoteJid ?? body.jid), 0).editMessage(messageId(body.messageId), text(body.text, 'text')));
    scopedRoute(this.router, 'patch', '/readMessage', ({ owner, name, body }) => {
      const remoteJid = jid(body.remoteJid);
      return factory(owner, name, remoteJid, 0).readMessage({ id: messageId(body.messageId), remoteJid });
    });
    scopedRoute(this.router, 'post', '/readMessages', ({ owner, name, body }) => {
      if (!Array.isArray(body.messageIds) || !body.messageIds.length || body.messageIds.length > 100) throw new RequestError(400, 'Provide between 1 and 100 message IDs.');
      return factory(owner, name, jid(body.remoteJid), 0).readMessages(body.messageIds.map(value => messageId(value)));
    });
    scopedRoute(this.router, 'delete', '/deleteMessage', ({ owner, name, body }) => {
      const remoteJid = jid(body.remoteJid);
      return factory(owner, name, remoteJid, 0).deleteMessage({ id: messageId(body.messageId), remoteJid }, boolean(body.forEveryone, 'forEveryone'));
    });
    scopedRoute(this.router, 'patch', '/unstar', ({ owner, name, body }) => {
      const remoteJid = jid(body.remoteJid);
      return factory(owner, name, remoteJid, 0).unStar(messageId(body.messageId), remoteJid, boolean(body.star, 'star'));
    });
  }
  get() { return this.router; }
}
