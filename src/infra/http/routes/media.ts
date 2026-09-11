import { Router } from 'express';
import MediaController from '../controllers/media.js';
import { boolean, jid, messageId, scopedRoute } from './helpers.js';
import { RequestError } from '../controllers/base.js';
export default class MediaRoutes {
  private readonly router = Router();
  constructor(factory = (owner: string, name: string) => new MediaController(owner, name)) {
    scopedRoute(this.router, 'post', '/download', ({ owner, name, body }) => factory(owner, name).getMedia(messageId(body.messageId), body.isBase64 === undefined ? false : boolean(body.isBase64, 'isBase64'), body.remoteJid === undefined ? undefined : jid(body.remoteJid)));
    scopedRoute(this.router, 'post', '/thumbnails', ({ owner, name, body }) => {
      if (!Array.isArray(body.messageIds) || body.messageIds.length < 1 || body.messageIds.length > 40) throw new RequestError(400, 'messageIds must contain 1 to 40 IDs.');
      return factory(owner, name).thumbnails(body.messageIds.map(messageId), body.remoteJid === undefined ? undefined : jid(body.remoteJid));
    });
  }
  get() { return this.router; }
}
