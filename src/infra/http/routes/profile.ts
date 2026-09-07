import { Router } from 'express';
import ProfileController from '../controllers/profile.js';
import { isMediaUrl } from '../../../shared/guards.js';
import { RequestError } from '../controllers/base.js';
import { jid, scopedRoute, text } from './helpers.js';

export default class ProfileRoutes {
  private readonly router = Router();
  constructor(factory = (owner: string, name: string) => new ProfileController(owner, name)) {
    scopedRoute(this.router, 'post', '/onWhatsapp', ({ owner, name, body }) => factory(owner, name).onWhatsapp(jid(body.id ?? body.remoteJid, 'id')));
    scopedRoute(this.router, 'post', '/fetchStatus', ({ owner, name, body }) => factory(owner, name).fetchStatus(jid(body.remoteJid)));
    scopedRoute(this.router, 'post', '/fetchProfilePicture', ({ owner, name, body }) => factory(owner, name).fetchProfilePicture(jid(body.remoteJid)));
    scopedRoute(this.router, 'post', '/fetchBusinessProfile', ({ owner, name, body }) => factory(owner, name).fetchBusinessProfile(jid(body.remoteJid)));
    scopedRoute(this.router, 'post', '/presenceSubscribe', ({ owner, name, body }) => factory(owner, name).presenceSubscribe(jid(body.remoteJid)));
    scopedRoute(this.router, 'patch', '/profileName', ({ owner, name, body }) => factory(owner, name).profileName(text(body.name, 'name', 25)));
    scopedRoute(this.router, 'patch', '/profileStatus', ({ owner, name, body }) => factory(owner, name).profileStatus(text(body.status, 'status', 139, true)));
    scopedRoute(this.router, 'put', '/profilePicture', ({ owner, name, body }) => {
      const remoteJid = jid(body.jid ?? body.remoteJid);
      const controller = factory(owner, name);
      if (body.url === undefined || body.url === null || body.url === '') return controller.removeProfilePicture(remoteJid);
      if (!isMediaUrl(body.url)) throw new RequestError(400, 'Invalid image URL.');
      return controller.updateProfilePicture(remoteJid, body.url);
    });
  }
  get() { return this.router; }
}
