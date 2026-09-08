import { Router, type Request, type Response } from 'express';
import { requireScope } from '../../state/auth.js';
import { instanceKey } from '../../../shared/identity.js';
import { isBoolean, isGroupJid, isMessageId, isNonEmptyString, isObject, normalizeJid } from '../../../shared/guards.js';
import { RequestError, type ControllerResult } from '../controllers/base.js';

export type RouteContext = { owner: string; name: string; body: Record<string, any>; req: Request };
export function scopedRoute(router: Router, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string,
  action: (context: RouteContext) => Promise<ControllerResult>) {
  router[method](`${path}/:owner/:instanceName`, async (req: Request, res: Response) => {
    try {
      const owner = String(req.params.owner ?? '');
      const name = String(req.params.instanceName ?? '');
      try { instanceKey(owner, name); } catch { throw new RequestError(400, 'Invalid owner or instanceName.'); }
      if (!req.auth) throw new RequestError(401, 'Authentication required.');
      if (!requireScope(req, owner, name)) throw new RequestError(403, 'Token is not authorized for this instance.');
      if (req.body !== undefined && !isObject(req.body)) throw new RequestError(400, 'Request body must be a JSON object.');
      const result = await action({ owner, name, body: req.body ?? {}, req });
      const { statusCode, ...body } = result;
      if (result.success && Buffer.isBuffer(result.buffer)) {
        res.setHeader('Content-Type', /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(String(result.mimeType)) ? String(result.mimeType) : 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Disposition', 'attachment');
        res.send(result.buffer);
      } else res.status(statusCode ?? (result.success ? 200 : 502)).json(body);
    } catch (error) {
      res.status(error instanceof RequestError ? error.statusCode : 500).json({ success: false, error: error instanceof RequestError ? error.message : 'Unable to process this request.' });
    }
  });
}
export function text(value: unknown, field: string, max = 65_536, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) throw new RequestError(400, `Invalid ${field}.`);
  return value;
}
export function jid(value: unknown, field = 'remoteJid'): string {
  const normalized = normalizeJid(value);
  if (!normalized) throw new RequestError(400, `Invalid ${field}.`);
  return normalized;
}
export function groupJid(value: unknown): string {
  if (!isGroupJid(value)) throw new RequestError(400, 'Invalid groupJid.');
  return value;
}
export function messageId(value: unknown): string {
  if (!isMessageId(value)) throw new RequestError(400, 'Invalid messageId.');
  return value;
}
export function boolean(value: unknown, field: string): boolean {
  if (!isBoolean(value)) throw new RequestError(400, `${field} must be a boolean.`);
  return value;
}
export function choice<T extends string | number>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value as T)) throw new RequestError(400, `Invalid ${field}.`);
  return value as T;
}
export function participants(value: unknown, minimum = 1): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 1024) throw new RequestError(400, 'Invalid participants list.');
  return [...new Set(value.map(entry => jid(entry, 'participant')))];
}
export function invitation(value: unknown): string {
  if (!isNonEmptyString(value, 200)) throw new RequestError(400, 'Invalid invite code.');
  let code = value;
  if (value.startsWith('https://chat.whatsapp.com/')) {
    const url = new URL(value);
    code = url.pathname.slice(1);
  }
  if (!/^[a-zA-Z0-9_-]{10,100}$/.test(code)) throw new RequestError(400, 'Invalid invite code.');
  return code;
}
export function expiration(value: unknown): number {
  const times: Record<string, number> = { '0': 0, '24h': 86_400, '7d': 604_800, '90d': 7_776_000 };
  if (typeof value === 'number' && Object.values(times).includes(value)) return value;
  if (typeof value === 'string' && Object.hasOwn(times, value)) return times[value]!;
  throw new RequestError(400, 'Expiration must be 0, 24h, 7d or 90d.');
}
