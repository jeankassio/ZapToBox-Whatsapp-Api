import { Router } from 'express';
import PrivacyController from '../controllers/privacy.js';
import { boolean, choice, expiration, jid, scopedRoute } from './helpers.js';

export default class PrivacyRoutes {
  private readonly router = Router();
  constructor(factory = (owner: string, name: string) => new PrivacyController(owner, name)) {
    scopedRoute(this.router, 'patch', '/unblock', ({ owner, name, body }) => factory(owner, name).unBlockUser(jid(body.remoteJid), boolean(body.block, 'block')));
    scopedRoute(this.router, 'get', '/privacySettings', ({ owner, name }) => factory(owner, name).getPrivacySettings());
    scopedRoute(this.router, 'get', '/blockList', ({ owner, name }) => factory(owner, name).getBlockList());
    const privacyValues = ['all', 'contacts', 'contact_blacklist', 'none'] as const;
    scopedRoute(this.router, 'patch', '/lastSeen', ({ owner, name, body }) => factory(owner, name).updateLastSeen(choice(body.privacy, privacyValues, 'privacy')));
    scopedRoute(this.router, 'patch', '/online', ({ owner, name, body }) => factory(owner, name).updateOnline(choice(body.privacy, ['all', 'match_last_seen'] as const, 'privacy')));
    scopedRoute(this.router, 'patch', '/picture', ({ owner, name, body }) => factory(owner, name).profilePicture(choice(body.privacy, privacyValues, 'privacy')));
    scopedRoute(this.router, 'patch', '/status', ({ owner, name, body }) => factory(owner, name).status(choice(body.privacy, privacyValues, 'privacy')));
    scopedRoute(this.router, 'patch', '/read', ({ owner, name, body }) => factory(owner, name).markRead(choice(body.privacy, ['all', 'none'] as const, 'privacy')));
    scopedRoute(this.router, 'patch', '/addGroups', ({ owner, name, body }) => factory(owner, name).addGroups(choice(body.privacy, ['all', 'contacts', 'contact_blacklist'] as const, 'privacy')));
    scopedRoute(this.router, 'patch', '/expirationMessage', ({ owner, name, body }) => factory(owner, name).ephemeral(expiration(body.ephemeral)));
    scopedRoute(this.router, 'patch', '/calls', ({ owner, name, body }) => factory(owner, name).calls(choice(body.privacy, ['all', 'known'] as const, 'privacy')));
    scopedRoute(this.router, 'patch', '/messages', ({ owner, name, body }) => factory(owner, name).messages(choice(body.privacy, ['all', 'contacts'] as const, 'privacy')));
    scopedRoute(this.router, 'patch', '/linkPreviews', ({ owner, name, body }) => factory(owner, name).linkPreviews(boolean(body.disabled, 'disabled')));
  }
  get() { return this.router; }
}
