import { normalizeMessageContent, type ParticipantAction } from '@whiskeysockets/baileys';
import { SocketController, RequestError } from './base.js';

export default class GroupController extends SocketController {
  create(groupName: string, participants: string[]) { return this.perform('Group created successfully.', sock => sock.groupCreate(groupName, participants)); }
  participantsUpdate(remoteJid: string, participants: string[], method: ParticipantAction) { return this.perform('Participants update processed.', sock => sock.groupParticipantsUpdate(remoteJid, participants, method)); }
  updateSubject(remoteJid: string, subject: string) { return this.perform('Group subject changed successfully.', async sock => { await sock.groupUpdateSubject(remoteJid, subject); }); }
  updateDescription(remoteJid: string, description: string) { return this.perform('Group description changed successfully.', async sock => { await sock.groupUpdateDescription(remoteJid, description); }); }
  updateSetting(remoteJid: string, setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked') { return this.perform('Group setting changed successfully.', async sock => { await sock.groupSettingUpdate(remoteJid, setting); }); }
  leave(remoteJid: string) { return this.perform('Group left successfully.', async sock => { await sock.groupLeave(remoteJid); }); }
  getInviteCode(remoteJid: string) { return this.perform('Invite code fetched successfully.', async sock => { const code = await sock.groupInviteCode(remoteJid); if (!code) throw new RequestError(502, 'Invite code unavailable.'); return { code, link: `https://chat.whatsapp.com/${code}` }; }); }
  revokeInviteCode(remoteJid: string) { return this.perform('Invite code revoked successfully.', async sock => { const code = await sock.groupRevokeInvite(remoteJid); if (!code) throw new RequestError(502, 'Invite code unavailable.'); return { code, link: `https://chat.whatsapp.com/${code}` }; }); }
  join(code: string) { return this.perform('Group invite accepted.', async sock => ({ response: await sock.groupAcceptInvite(code.replace('https://chat.whatsapp.com/', '')) })); }
  joinByInviteMessage(groupJid: string, messageId: string) {
    return this.perform('Group invite accepted.', async sock => {
      const stored = await this.stored(messageId);
      const invite = normalizeMessageContent(stored.message)?.groupInviteMessage;
      if (!invite || invite.groupJid !== groupJid) throw new RequestError(404, 'Group invite not found in this instance.');
      return { response: await sock.groupAcceptInviteV4(stored.key, invite) };
    });
  }
  getInfoByCode(code: string) { return this.perform('Group information fetched.', async sock => ({ response: await sock.groupGetInviteInfo(code.replace('https://chat.whatsapp.com/', '')) })); }
  queryMetadata(groupJid: string) { return this.perform('Group metadata fetched.', async sock => ({ response: await sock.groupMetadata(groupJid) })); }
  participantsList(groupJid: string) { return this.perform('Pending join requests fetched.', async sock => ({ response: await sock.groupRequestParticipantsList(groupJid) })); }
  requestParticipants(groupJid: string, participants: string[], action: 'approve' | 'reject') { return this.perform('Join requests processed.', async sock => ({ response: await sock.groupRequestParticipantsUpdate(groupJid, participants, action) })); }
  fetchAllParticipants() { return this.perform('Participating groups fetched.', async sock => ({ response: await sock.groupFetchAllParticipating() })); }
  ephemeralMessages(groupJid: string, time: number) { return this.perform('Message expiration defined.', async sock => { await sock.groupToggleEphemeral(groupJid, time); }); }
  addMode(groupJid: string, onlyAdmin: boolean) { return this.perform('Group add mode defined.', async sock => { await sock.groupMemberAddMode(groupJid, onlyAdmin ? 'admin_add' : 'all_member_add'); }); }
  joinApproval(groupJid: string, enabled: boolean) { return this.perform('Group join approval defined.', async sock => { await sock.groupJoinApprovalMode(groupJid, enabled ? 'on' : 'off'); }); }
  revokeInviteMessage(groupJid: string, invitedJid: string) { return this.perform('Group invitation revoked.', async sock => ({ response: await sock.groupRevokeInviteV4(groupJid, invitedJid) })); }
}
