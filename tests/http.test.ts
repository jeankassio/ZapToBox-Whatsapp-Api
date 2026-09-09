import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import jwt from 'jsonwebtoken';
import type Instance from '../src/infra/baileys/services.js';
import { createApp } from '../src/app.js';
import UserConfig from '../src/infra/config/env.js';
import InstancesRepository from '../src/core/repositories/instances.js';
import { instances, instanceConnection, instanceStatus } from '../src/shared/constants.js';
import { instanceKey } from '../src/shared/identity.js';

const secret = 'http-fixture-only-secret-not-a-real-deployment-key';
const scoped = (owner = 'owner', instanceName?: string) => jwt.sign({ owner, ...(instanceName ? { instanceName } : {}) }, secret, { algorithm: 'HS256', expiresIn: 60 });

test('startup readiness blocks application routes until initialization completes',async t=>{
  let ready=false;
  const app=createApp({token:secret,isReady:()=>ready,ready:async()=>{if(!ready)throw new Error('Starting');}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers={authorization:`Bearer ${secret}`};
  assert.equal((await fetch(base+'/health')).status,200);
  assert.equal((await fetch(base+'/health/ready',{headers})).status,503);
  assert.equal((await fetch(base+'/not-a-route',{headers})).status,503);
  ready=true;
  assert.equal((await fetch(base+'/health/ready',{headers})).status,200);
  assert.equal((await fetch(base+'/not-a-route',{headers})).status,404);
});

async function fixture(t: TestContext, ready: () => Promise<void> = async () => {}) {
  const previousLimit = UserConfig.bodyLimit;
  UserConfig.bodyLimit = '1kb';
  const app = createApp({ token: secret, ready });
  UserConfig.bodyLimit = previousLimit;
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, options: { method?: string; body?: unknown; rawBody?: string; token?: string | null; authorization?: string; idempotencyKey?: string | null } = {}) {
    const token = options.token === undefined ? secret : options.token;
    const response = await fetch(base + path, {
      method: options.method ?? 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.authorization ? { authorization: options.authorization } : {}),
        ...(path === '/instances/create' && options.idempotencyKey !== null ? { 'idempotency-key': options.idempotencyKey ?? randomUUID() } : {}) },
      ...(options.rawBody !== undefined ? { body: options.rawBody } : options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { request };
}

function fakeInstance(t: TestContext, owner = 'owner', name = 'session') {
  const key = instanceKey(owner, name);
  let reconnects = 0, sends = 0, deletes = 0, disconnects = 0;
  const instance = {
    reconnect: async () => { reconnects++; return { instance: { owner, instanceName: name, connectionStatus: 'OFFLINE' }, qrCode: 'data:image/png;base64,cXI=' }; },
    getSock: () => ({ ws: { isOpen: true }, sendMessage: async () => { sends++; throw new Error('A fake socket must never send'); } }),
    clearInstance: async () => { deletes++; },
    disconnect: async () => { disconnects++; return { instance: { owner, instanceName: name, connectionStatus: 'REMOVED', instanceJid: null } }; },
  } as unknown as Instance;
  const original = instances[key];
  const oldStatus = instanceStatus.get(key);
  instances[key] = instance;
  instanceStatus.set(key, 'OFFLINE');
  t.after(() => { if (original) instances[key] = original; else delete instances[key]; if (oldStatus) instanceStatus.set(key, oldStatus); else instanceStatus.delete(key); });
  return { key, get reconnects() { return reconnects; }, get sends() { return sends; }, get deletes() { return deletes; }, get disconnects() { return disconnects; } };
}

test('public liveness and authenticated readiness expose only controlled states', async t => {
  let healthy = true;
  const f = await fixture(t, async () => { if (!healthy) throw new Error('private database detail'); });
  const live = await f.request('/health', { token: null });
  assert.equal(live.status, 200);
  assert.equal(live.body.status, 'ok');
  assert.equal(live.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(live.headers.get('cache-control'), 'no-store');
  assert.equal(live.headers.get('x-powered-by'), null);
  assert.equal((await f.request('/health/ready', { token: null })).status, 401);
  assert.deepEqual((await f.request('/health/ready')).body, { status: 'ready' });
  healthy = false;
  const failed = await f.request('/health/ready');
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { status: 'unavailable' });
});

test('malformed, expired, unscoped and wrong-algorithm tokens are rejected', async t => {
  const f = await fixture(t);
  const tokens: Array<string | null> = [
    null, 'malformed', 'wrong-static-token',
    jwt.sign({ owner: 'owner' }, 'another-signing-secret', { algorithm: 'HS256' }),
    jwt.sign({ owner: 'owner' }, secret, { algorithm: 'HS256', expiresIn: -1 }),
    jwt.sign({ admin: true }, secret, { algorithm: 'HS256' }),
    jwt.sign({ owner: '../escape' }, secret, { algorithm: 'HS256' }),
    jwt.sign({ owner: 'owner', instanceName: {} }, secret, { algorithm: 'HS256' }),
    jwt.sign({ owner: 'owner' }, secret, { algorithm: 'HS512' }),
  ];
  for (const token of tokens) {
    const result = await f.request('/health/ready', { token });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'Invalid Token' });
  }
  for (const authorization of [`Basic ${secret}`, `Bearer ${secret} extra`]) assert.equal((await f.request('/health/ready', { authorization })).status, 401);
  assert.equal((await f.request('/health/ready', { authorization: `bearer ${secret}` })).status, 200);
});

test('JWT scope is enforced on every instance mutation and cannot promote admin', async t => {
  const local = fakeInstance(t);
  const foreign = fakeInstance(t, 'other', 'session');
  const f = await fixture(t);
  const token = jwt.sign({ owner: 'owner', instanceName: 'session', admin: true }, secret, { algorithm: 'HS256' });
  const attempts = [
    { path: '/instances/connect/other/session', method: 'GET' },
    { path: '/instances/connect/owner/other', method: 'POST' },
    { path: '/instances/delete/other/session', method: 'DELETE' },
    { path: '/instances/disconnect/other/session', method: 'POST' },
    { path: '/instances/disconnect/owner/other', method: 'POST' },
    { path: '/instances/create', method: 'POST', body: { owner: 'other', instanceName: 'new' } },
    { path: '/instances/get?owner=other', method: 'GET' },
    { path: '/webhooks/queue', method: 'GET' },
    { path: '/webhooks/queue/replay', method: 'POST' },
  ];
  for (const { path, ...options } of attempts) assert.equal((await f.request(path, { ...options, token })).status, 403, path);
  assert.equal(local.reconnects + foreign.reconnects + foreign.deletes, 0);
  assert.equal((await f.request('/instances/connect/owner/session', { token })).status, 200);
  assert.equal((await f.request('/instances/connect/other/session')).status, 200, 'the configured static token remains an explicit administrator');
});

test('scoped disconnect revokes a device without deleting the instance or history', async t => {
  const local = fakeInstance(t); const f = await fixture(t);
  const result = await f.request('/instances/disconnect/owner/session', { method: 'POST', token: scoped('owner', 'session') });
  assert.equal(result.status, 200); assert.equal(result.body.success, true);
  assert.equal(result.body.instance.connectionStatus, 'REMOVED'); assert.equal(local.disconnects, 1); assert.equal(local.deletes, 0);
  assert.equal((await f.request('/instances/disconnect/owner/session', { method: 'POST', token: null })).status, 401);
  assert.equal(local.disconnects, 1);
});

test('instance listing filters both owner and optional instance JWT scope', async t => {
  const rows = [
    { owner: 'owner', instanceName: 'session', connectionStatus: 'ONLINE' as const, instanceJid: null },
    { owner: 'owner', instanceName: 'another', connectionStatus: 'OFFLINE' as const, instanceJid: null },
    { owner: 'other', instanceName: 'foreign', connectionStatus: 'OFFLINE' as const, instanceJid: null },
  ];
  const requestedOwners: Array<string | undefined> = [];
  t.mock.method(InstancesRepository.prototype, 'list', async (owner?: string) => { requestedOwners.push(owner); return rows.filter(row => !owner || row.owner === owner); });
  const f = await fixture(t);
  const own = await f.request('/instances/get', { token: scoped() });
  assert.equal(own.status, 200);
  assert.deepEqual(own.body.data.map((row: any) => row.instanceName), ['session', 'another']);
  const session = await f.request('/instances/get', { token: scoped('owner', 'session') });
  assert.deepEqual(session.body.data.map((row: any) => row.instanceName), ['session']);
  const all = await f.request('/instances/get');
  assert.equal(all.body.data.length, 3);
  assert.deepEqual(requestedOwners, ['owner', 'owner', undefined]);
});

test('invalid create requests never register or start a WhatsApp instance', async t => {
  const f = await fixture(t);
  const before = Object.keys(instances);
  const bodies = [undefined, [], {}, { owner: {}, instanceName: 'session' }, { owner: 'owner', instanceName: '../escape' }, { owner: 'CON', instanceName: 'session' }, { owner: 'owner', instanceName: 'session', phoneNumber: 'not-a-phone' }, { owner: 'owner', instanceName: 'session', phoneNumber: 5511999999999 }];
  for (const body of bodies) assert.equal((await f.request('/instances/create', { method: 'POST', ...(body === undefined ? {} : { body }) })).status, 400);
  assert.deepEqual(Object.keys(instances), before);
  const existing = fakeInstance(t);
  const duplicate = await f.request('/instances/create', { method: 'POST', body: { owner: 'owner', instanceName: 'session' } });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.idempotent, true);
  assert.equal(duplicate.body.instance.instanceName, 'session');
  assert.equal(existing.reconnects, 0);
});

test('create requires a UUID v4 key and exact instance lookup is scoped without reconnecting', async t => {
  const existing = fakeInstance(t);
  const f = await fixture(t);
  const body = { owner: 'owner', instanceName: 'session' };
  assert.equal((await f.request('/instances/create', { method: 'POST', body, idempotencyKey: null })).status, 400);
  assert.equal((await f.request('/instances/create', { method: 'POST', body, idempotencyKey: 'guessable' })).status, 400);
  const found = await f.request('/instances/status/owner/session', { token: scoped('owner', 'session') });
  assert.equal(found.status, 200);
  assert.equal(found.body.exists, true);
  assert.equal(found.body.data.instanceName, 'session');
  assert.equal(existing.reconnects, 0);
  assert.equal((await f.request('/instances/status/other/session', { token: scoped('owner') })).status, 403);
});

test('create replays a persisted identity after restart without opening a duplicate socket', async t => {
  const stored = { owner: 'owner', instanceName: 'persisted', connectionStatus: 'OFFLINE' as const, instanceJid: null };
  t.mock.method(InstancesRepository.prototype, 'find', async (owner: string, name: string) => owner === 'owner' && name === 'persisted' ? stored : null);
  const before = Object.keys(instances);
  const f = await fixture(t);
  const result = await f.request('/instances/create', { method: 'POST', body: { owner: 'owner', instanceName: 'persisted' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.idempotent, true);
  assert.deepEqual(result.body.instance, stored);
  assert.deepEqual(Object.keys(instances), before);
});

test('list, status and repeated create expose public instance fields even with a circular authenticated socket', async t => {
  const instance = fakeInstance(t);
  const previous = instanceConnection[instance.key];
  const authStore = UserConfig.authStore;
  UserConfig.authStore = 'filesystem';
  t.mock.method(InstancesRepository.prototype, 'getOwnersPath', async () => []);
  const socket: any = { authState: { creds: { privateKey: 'private-session-material' } } };
  socket.self = socket;
  instanceConnection[instance.key] = { owner: 'owner', instanceName: 'session', connectionStatus: 'ONLINE', profilePictureUrl: 'https://example.com/photo.jpg', instanceJid: '5511999999999@s.whatsapp.net', socket };
  t.after(() => {
    UserConfig.authStore = authStore;
    if (previous) instanceConnection[instance.key] = previous;
    else delete instanceConnection[instance.key];
  });
  const f = await fixture(t);
  const listed = await f.request('/instances/get', { token: scoped() });
  const connectionUpdatedAt = listed.body.data[0].connectionUpdatedAt;
  assert.ok(Number.isFinite(Date.parse(connectionUpdatedAt)));
  const expected = { owner: 'owner', instanceName: 'session', connectionStatus: 'ONLINE', connectionUpdatedAt, profilePictureUrl: 'https://example.com/photo.jpg', instanceJid: '5511999999999@s.whatsapp.net' };
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data, [expected]);
  const found = await f.request('/instances/status/owner/session', { token: scoped() });
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.data, expected);
  assert.ok(Date.parse(found.body.observedAt) >= Date.parse(connectionUpdatedAt));
  const replay = await f.request('/instances/create', { method: 'POST', body: { owner: 'owner', instanceName: 'session' }, token: scoped() });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.instance, expected);
  assert.equal(instance.reconnects, 0);
  assert.doesNotMatch(JSON.stringify([listed.body, found.body, replay.body]), /socket|authState|private-session-material/);
  socket.ws = { isOpen: false };
  const disconnected = await f.request('/instances/status/owner/session', { token: scoped() });
  assert.equal(disconnected.body.data.connectionStatus, 'OFFLINE', 'a closed socket overrides an old queued ONLINE snapshot');
  assert.ok(Date.parse(disconnected.body.data.connectionUpdatedAt) > Date.parse(connectionUpdatedAt));
  assert.ok(Date.parse(disconnected.body.observedAt) >= Date.parse(disconnected.body.data.connectionUpdatedAt));
  const disconnectedList = await f.request('/instances/get', { token: scoped() });
  assert.equal(disconnectedList.body.data[0].connectionStatus, 'OFFLINE');
  assert.equal(disconnectedList.body.data[0].connectionUpdatedAt, disconnected.body.data.connectionUpdatedAt);
});

test('legacy GET connect and POST connect return the existing cached QR instance', async t => {
  const instance = fakeInstance(t);
  const f = await fixture(t);
  const initial = instances[instance.key];
  for (const method of ['GET', 'GET', 'POST']) {
    const result = await f.request('/instances/connect/owner/session', { method, token: scoped('owner', 'session') });
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.qrCode, 'data:image/png;base64,cXI=');
    assert.equal(result.body.instance.instanceName, 'session');
    assert.equal(instances[instance.key], initial);
  }
  assert.equal(instance.reconnects, 3);
  assert.equal(instance.sends, 0);
});

test('open transport before WhatsApp authentication cannot send a message', async t => {
  const instance = fakeInstance(t);
  const f = await fixture(t);
  const result = await f.request('/messages/sendText/owner/session', { method: 'POST', body: { remoteJid: '5511999999999@s.whatsapp.net', text: 'Never sent' } });
  assert.equal(result.status, 409);
  assert.equal(result.body.success, false);
  assert.equal(instance.sends, 0);
});

test('malformed JSON, oversized bodies and missing routes return stable HTTP errors', async t => {
  const f = await fixture(t);
  const malformed = await f.request('/instances/create', { method: 'POST', rawBody: '{"private":' });
  assert.equal(malformed.status, 400);
  assert.deepEqual(malformed.body, { success: false, error: 'Invalid JSON' });
  const oversized = await f.request('/instances/create', { method: 'POST', body: { payload: 'x'.repeat(2000) } });
  assert.equal(oversized.status, 413);
  assert.deepEqual(oversized.body, { success: false, error: 'Request body too large' });
  const unauthenticated = await f.request('/instances/create', { method: 'POST', rawBody: '{', token: null });
  assert.equal(unauthenticated.status, 401, 'authentication runs before parsing sensitive API input');
  const missing = await f.request('/a-route-that-does-not-exist');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { success: false, error: 'Route not found' });
});
