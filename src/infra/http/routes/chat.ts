import { Router } from 'express';
import ChatController from '../controllers/chat.js';
import { boolean, choice, jid, messageId, scopedRoute } from './helpers.js';

export default class ChatRoutes {
  private readonly router = Router();
  constructor(factory = (owner: string, name: string) => new ChatController(owner, name)) {
    scopedRoute(this.router, 'patch', '/rejectCall', ({ owner, name, body }) => factory(owner, name).rejectCall(messageId(body.callId), jid(body.callFrom, 'callFrom')));
    scopedRoute(this.router, 'post', '/sendPresence', ({ owner, name, body }) => factory(owner, name).sendPresence(choice(body.presence, ['available', 'unavailable', 'composing', 'recording', 'paused'] as const, 'presence'), body.remoteJid === undefined ? undefined : jid(body.remoteJid)));
    scopedRoute(this.router, 'patch', '/archiveChat', ({ owner, name, body }) => factory(owner, name).arquiveChat(jid(body.remoteJid), boolean(body.archive, 'archive')));
    scopedRoute(this.router, 'patch', '/mute', ({ owner, name, body }) => factory(owner, name).muteChat(jid(body.remoteJid), choice(body.mute, [0, 1, 2] as const, 'mute')));
    scopedRoute(this.router, 'patch', '/markChatAsRead', ({ owner, name, body }) => factory(owner, name).markChatAsRead(jid(body.remoteJid), boolean(body.markAsRead, 'markAsRead')));
    scopedRoute(this.router, 'delete', '/deleteChat', ({ owner, name, body }) => factory(owner, name).deleteChat(jid(body.remoteJid)));
    scopedRoute(this.router, 'patch', '/unpin', ({ owner, name, body }) => factory(owner, name).pinChat(jid(body.remoteJid), boolean(body.pin, 'pin')));
  }
  get() { return this.router; }
}
