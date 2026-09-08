import { Router } from 'express';
import GroupController from '../controllers/group.js';
import { boolean, choice, expiration, groupJid, invitation, jid, messageId, participants, scopedRoute, text } from './helpers.js';

export default class GroupRoutes {
  private readonly router = Router();
  constructor(factory = (owner: string, name: string) => new GroupController(owner, name)) {
    scopedRoute(this.router, 'post', '/create', ({ owner, name, body }) => factory(owner, name).create(text(body.groupName, 'groupName', 100), participants(body.participants)));
    scopedRoute(this.router, 'patch', '/participantsUpdate', ({ owner, name, body }) => factory(owner, name).participantsUpdate(groupJid(body.groupJid), participants(body.participants), choice(body.method, ['add', 'remove', 'demote', 'promote'] as const, 'method')));
    scopedRoute(this.router, 'patch', '/subject', ({ owner, name, body }) => factory(owner, name).updateSubject(groupJid(body.groupJid), text(body.subject, 'subject', 100)));
    scopedRoute(this.router, 'patch', '/description', ({ owner, name, body }) => factory(owner, name).updateDescription(groupJid(body.groupJid), text(body.description, 'description', 2048, true)));
    scopedRoute(this.router, 'patch', '/setting', ({ owner, name, body }) => factory(owner, name).updateSetting(groupJid(body.groupJid), choice(body.setting, ['announcement', 'not_announcement', 'locked', 'unlocked'] as const, 'setting')));
    scopedRoute(this.router, 'post', '/leave', ({ owner, name, body }) => factory(owner, name).leave(groupJid(body.groupJid)));
    scopedRoute(this.router, 'post', '/getInviteCode', ({ owner, name, body }) => factory(owner, name).getInviteCode(groupJid(body.groupJid)));
    scopedRoute(this.router, 'post', '/revokeInviteCode', ({ owner, name, body }) => factory(owner, name).revokeInviteCode(groupJid(body.groupJid)));
    scopedRoute(this.router, 'post', '/join', ({ owner, name, body }) => factory(owner, name).join(invitation(body.code)));
    scopedRoute(this.router, 'post', '/joinByInviteMessage', ({ owner, name, body }) => factory(owner, name).joinByInviteMessage(groupJid(body.groupJid), messageId(body.messageId)));
    scopedRoute(this.router, 'post', '/infoByCode', ({ owner, name, body }) => factory(owner, name).getInfoByCode(invitation(body.code)));
    scopedRoute(this.router, 'post', '/metadata', ({ owner, name, body }) => factory(owner, name).queryMetadata(groupJid(body.groupJid)));
    scopedRoute(this.router, 'post', '/participantsList', ({ owner, name, body }) => factory(owner, name).participantsList(groupJid(body.groupJid)));
    scopedRoute(this.router, 'get', '/allParticipantsGroups', ({ owner, name }) => factory(owner, name).fetchAllParticipants());
    scopedRoute(this.router, 'patch', '/requestParticipants', ({ owner, name, body }) => factory(owner, name).requestParticipants(groupJid(body.groupJid), participants(body.participants), choice(body.action, ['approve', 'reject'] as const, 'action')));
    scopedRoute(this.router, 'patch', '/expirationMessage', ({ owner, name, body }) => factory(owner, name).ephemeralMessages(groupJid(body.groupJid), expiration(body.time)));
    scopedRoute(this.router, 'patch', '/addMode', ({ owner, name, body }) => factory(owner, name).addMode(groupJid(body.groupJid), boolean(body.onlyAdmin, 'onlyAdmin')));
    scopedRoute(this.router, 'patch', '/joinApproval', ({ owner, name, body }) => factory(owner, name).joinApproval(groupJid(body.groupJid), boolean(body.enabled, 'enabled')));
    scopedRoute(this.router, 'post', '/revokeInviteMessage', ({ owner, name, body }) => factory(owner, name).revokeInviteMessage(groupJid(body.groupJid), jid(body.invitedJid, 'invitedJid')));
  }
  get() { return this.router; }
}
