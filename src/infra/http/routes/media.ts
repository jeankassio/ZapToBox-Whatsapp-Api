import { Router } from 'express';
import MediaController from '../controllers/media.js';
import { boolean, jid, messageId, scopedRoute } from './helpers.js';
export default class MediaRoutes {
  private readonly router = Router();
  constructor(factory = (owner: string, name: string) => new MediaController(owner, name)) {
    scopedRoute(this.router, 'post', '/download', ({ owner, name, body }) => factory(owner, name).getMedia(messageId(body.messageId), body.isBase64 === undefined ? false : boolean(body.isBase64, 'isBase64'), body.remoteJid === undefined ? undefined : jid(body.remoteJid)));
  }
  get() { return this.router; }
}
