import type { WAMessage } from '@whiskeysockets/baileys';
import type { StatusPresence } from '../../../shared/types.js';
import { SocketController, RequestError } from './base.js';

export default class ChatController extends SocketController {
  rejectCall(callId: string, callFrom: string) { return this.perform('Call rejected successfully.', async sock => { await sock.rejectCall(callId, callFrom); }); }
  sendPresence(presence: StatusPresence, jid?: string) { return this.perform('Presence sent successfully.', async sock => { await sock.sendPresenceUpdate(presence, jid); }); }
  private async last(remoteJid: string): Promise<WAMessage> {
    const last = await this.repository!.getLastMessageByInstance(this.instance, remoteJid);
    if (!last) throw new RequestError(404, 'No message found in this instance and chat.');
    return last;
  }
  arquiveChat(remoteJid: string, archive: boolean) { return this.perform('Chat archive status changed successfully.', async sock => { await sock.chatModify({ archive, lastMessages: [await this.last(remoteJid)] }, remoteJid); }); }
  muteChat(remoteJid: string, mute: number) { return this.perform('Chat mute status changed successfully.', async sock => { await sock.chatModify({ mute: mute === 0 ? null : mute === 1 ? 86_400_000 : 604_800_000 }, remoteJid); }); }
  markChatAsRead(remoteJid: string, markRead: boolean) { return this.perform('Chat read status changed successfully.', async sock => { await sock.chatModify({ markRead, lastMessages: [await this.last(remoteJid)] }, remoteJid); }); }
  deleteChat(remoteJid: string) { return this.perform('Chat deleted successfully.', async sock => { await sock.chatModify({ delete: true, lastMessages: [await this.last(remoteJid)] }, remoteJid); }); }
  pinChat(remoteJid: string, pin: boolean) { return this.perform('Chat pin status changed successfully.', async sock => { await sock.chatModify({ pin }, remoteJid); }); }
}
