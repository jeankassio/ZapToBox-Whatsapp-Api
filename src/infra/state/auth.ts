import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import UserConfig from '../config/env.js';
import { validateIdentity } from '../../shared/identity.js';

export interface AuthScope { admin: boolean; owner?: string; instanceName?: string }
declare global { namespace Express { interface Request { auth?: AuthScope } } }

export function requireScope(req: Request, owner: string, instanceName?: string): boolean {
  const scope = req.auth;
  return !!scope && (scope.admin || (scope.owner === owner && (!scope.instanceName || scope.instanceName === instanceName)));
}

export default class Token {
  constructor(private readonly secret: string = UserConfig.jwtToken) {}

  verify = (req: Request, res: Response, next: NextFunction): void => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    const token = match?.[1];
    if (!token || !this.secret) { res.status(401).json({ error: 'Invalid Token' }); return; }
    try {
      const hash = (value: string) => createHash('sha256').update(value).digest();
      if (timingSafeEqual(hash(token), hash(this.secret))) req.auth = { admin: true };
      else {
        const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
        if (typeof payload === 'string') throw new Error('Invalid scope');
        const owner = validateIdentity(payload.owner, 'owner');
        const instanceName = payload.instanceName === undefined ? undefined : validateIdentity(payload.instanceName, 'instanceName');
        req.auth = { admin: false, owner, ...(instanceName ? { instanceName } : {}) };
      }
      next();
    } catch { res.status(401).json({ error: 'Invalid Token' }); }
  };
}
