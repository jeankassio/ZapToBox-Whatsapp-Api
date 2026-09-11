import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { WASocket } from '@whiskeysockets/baileys';
import express from 'express';
import jwt from 'jsonwebtoken';
import ProfileController from '../src/infra/http/controllers/profile.js';
import ProfileRoutes from '../src/infra/http/routes/profile.js';
import Token from '../src/infra/state/auth.js';

const pn = '5511999999999@s.whatsapp.net', secret = 'presence-test-no-production-secret-123456';
const empty = (id = pn) => ({ id, presences: {}, observedAt: null, expiresAt: null });

test('presence route retains tenant authentication, normalizes individual identifiers and returns unknown honestly', async t => {
  const calls: string[][] = []; const socket = {} as WASocket;
  const app = express(); app.use(express.json()); app.use(new Token(secret).verify);
  app.use('/profile', new ProfileRoutes((owner, name) => new ProfileController(owner, name, { socket, presenceSubscribe: async (id, expected) => { assert.equal(expected, socket); calls.push([owner, name, id]); return empty(id); } })).get());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = jwt.sign({ owner: 'owner', instanceName: 'one' }, secret, { algorithm: 'HS256', expiresIn: 60 });
  const request = async (remoteJid: unknown, authorization: string | null = token, suffix = '/owner/one') => {
    const response = await fetch(`${origin}/profile/presenceSubscribe${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify({ remoteJid }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request(pn, null)).status, 401);
  assert.equal((await request(pn, token, '/owner/other')).status, 403);
  assert.equal((await request(pn, token, '/other/one')).status, 403);
  for (const value of ['status@broadcast', '120363123456@g.us', '120363123456@newsletter', 'invalid', {}]) assert.equal((await request(value)).status, 400);
  assert.equal(calls.length, 0);
  const result = await request(pn.replace('@', ':7@'));
  assert.equal(result.status, 200); assert.deepEqual(result.body.data, empty()); assert.deepEqual(calls, [['owner', 'one', pn]]);
});

test('profile presence awaits subscription and refuses an otherwise successful response after disconnection', async () => {
  let resolve!: () => void, entered!: () => void;
  const accepted = new Promise<void>(r => { entered = r; }), pending = new Promise<void>(r => { resolve = r; });
  const socket = { ws: { isOpen: true } };
  const operation = new ProfileController('owner', 'one', { socket: socket as WASocket, presenceSubscribe: async () => { entered(); await pending; return empty(); } }).presenceSubscribe(pn);
  await accepted; socket.ws.isOpen = false; resolve();
  const result = await operation; assert.equal(result.success, false); assert.equal(result.statusCode, 409); assert.equal(result.data, undefined);
  let calls = 0;
  const offline = await new ProfileController('owner', 'one', { socket: socket as WASocket, presenceSubscribe: async () => { calls++; return empty(); } }).presenceSubscribe(pn);
  assert.equal(offline.statusCode, 409); assert.equal(calls, 0);
});
