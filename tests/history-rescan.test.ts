import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { HistoryRescanService, zeroCounts, RESCAN_KINDS, type RescanStore, type RescanJob, type RescanKind, type RescanPending, type RescanEvent } from '../src/infra/history-rescan/service.js';
import { PrismaRescanStore } from '../src/infra/history-rescan/prisma-store.js';
import InstanceRoutes from '../src/infra/http/routes/instances.js';
import Token from '../src/infra/state/auth.js';
import { RequestError } from '../src/infra/http/controllers/base.js';
import { WEBHOOK_CHUNK_BYTES } from '../src/infra/webhook/chunks.js';
import { enqueueRescanEvent } from '../src/infra/history-rescan/delivery.js';

type Internal = RescanJob & { active: boolean; token: string | null; until: number; nextAt: number };
class MemoryStore implements RescanStore {
  records = new Map<string, Internal>();
  source = new Map<string, Array<{ id: number; data: any }>>();
  pages: any[] = [];
  failAdvance = false;
  async findByKey(instance: string, key: string) {
    const row = [...this.records.values()].find(job => job.instance === instance && job.idempotencyKey === key);
    return row ? structuredClone(row) : null;
  }
  async findActive(instance: string) {
    const row = [...this.records.values()].find(job => job.instance === instance && job.active);
    return row ? structuredClone(row) : null;
  }
  async findLatestCompleted(instance: string) {
    const row = [...this.records.values()].filter(job => job.instance === instance && job.status === 'completed').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return row ? structuredClone(row) : null;
  }
  add(instance: string, kind: RescanKind, rows: Array<{ id: number; data: any }>) { this.source.set(`${instance}:${kind}`, structuredClone(rows)); }
  async begin(instance: string, key: string, known: boolean, now: Date, connectionUpdatedAt?: string) {
    const prior = [...this.records.values()].find(job => job.instance === instance && job.idempotencyKey === key || job.instance === instance && job.active); if (prior) return { ...structuredClone(prior), reused: true };
    const max = zeroCounts(), available = zeroCounts();
    for (const kind of RESCAN_KINDS) { const rows = this.source.get(`${instance}:${kind}`) ?? []; max[kind] = rows.at(-1)?.id ?? 0; available[kind] = rows.length; }
    if (!known && !Object.values(available).some(Boolean)) throw new RequestError(404, 'Instance history not found.');
    const job: Internal = { id: randomUUID(), instance, idempotencyKey: key, runId: randomUUID(), status: 'queued',
      state: { phase: 'contacts', cursor: zeroCounts(), max, available, scanned: zeroCounts(), counts: zeroCounts(), chunks: 0, sequence: 0, ...(connectionUpdatedAt ? { connectionUpdatedAt } : {}) },
      pending: null, attempts: 0, errorCode: null, createdAt: now, updatedAt: now, completedAt: null, active: true, token: null, until: 0, nextAt: now.getTime() };
    this.records.set(job.id, job); return structuredClone(job);
  }
  async get(instance: string, id: string) { const row = this.records.get(id); return row?.instance === instance ? structuredClone(row) : null; }
  async next(now: Date) { return [...this.records.values()].filter(job => job.active && job.nextAt <= now.getTime() && (job.status === 'queued' || job.status === 'running' && job.until <= now.getTime())).sort((a, b) => a.nextAt - b.nextAt || a.createdAt.getTime() - b.createdAt.getTime())[0]?.id ?? null; }
  async claim(id: string, token: string, until: Date, now: Date) {
    const row = this.records.get(id)!; if (!row.active || row.nextAt > now.getTime() || row.status === 'running' && row.until > now.getTime()) return null;
    Object.assign(row, { status: 'running', token, until: until.getTime() }); return structuredClone(row);
  }
  private owned(id: string, token: string) { const row = this.records.get(id); return row?.token === token && row.status === 'running' ? row : null; }
  async renew(id: string, token: string, until: Date) { const row = this.owned(id, token); if (!row) return false; row.until = until.getTime(); return true; }
  async stage(id: string, token: string, pending: RescanPending) { const row = this.owned(id, token); if (!row || row.pending) return false; row.pending = structuredClone(pending); return true; }
  async advance(id: string, token: string, pending: RescanPending, now: Date) {
    if (this.failAdvance) { this.failAdvance = false; throw new Error('simulated crash after enqueue'); }
    const row = this.owned(id, token); if (!row) return false;
    row.state = structuredClone(pending.after); row.pending = null; row.updatedAt = now;
    if (pending.complete) Object.assign(row, { active: false, status: 'completed', completedAt: now, token: null }); return true;
  }
  async release(id: string, token: string, now: Date) { const row = this.owned(id, token); if (row) Object.assign(row, { status: 'queued', token: null, nextAt: now.getTime(), nextAttemptAt: now }); }
  async fail(id: string, token: string, code: string, retryAt: Date, terminal: boolean) {
    const row = this.owned(id, token); if (row) Object.assign(row, { status: terminal ? 'failed' : 'queued', attempts: row.attempts + 1, errorCode: code, token: null, active: !terminal, nextAt: retryAt.getTime() });
  }
  async page(instance: string, kind: RescanKind, after: number, maximum: number, take: number) {
    this.pages.push({ instance, kind, after, maximum, take });
    return structuredClone((this.source.get(`${instance}:${kind}`) ?? []).filter(row => row.id > after && row.id <= maximum).slice(0, take));
  }
}

function setup(options: { pageSize?: number; pagesPerCycle?: number; emit?: (event: RescanEvent) => Promise<void>; store?: MemoryStore; canProduce?: () => Promise<boolean> } = {}) {
  const store = options.store ?? new MemoryStore(), events: RescanEvent[] = []; let time = Date.parse('2026-09-08T15:00:00Z');
  const service = new HistoryRescanService(store, { exists: async () => true, configured: () => true, now: () => new Date(time),
    emit: async (instance, event) => { assert.equal(instance.owner, 'owner'); events.push(structuredClone(event)); await options.emit?.(event); },
    ...(options.pageSize ? { pageSize: options.pageSize } : {}), ...(options.pagesPerCycle ? { pagesPerCycle: options.pagesPerCycle } : {}), ...(options.canProduce ? { canProduce: options.canProduce } : {}) });
  return { store, events, service, later: (ms = 5000) => { time += ms; } };
}

test('rescan stops before publishing a page if the connection closes during its read', async () => {
  const store = new MemoryStore(); let online = true, delivered = 0;
  store.add('owner/session', 'contacts', [{ id: 1, data: { id: 'kept@lid' } }]);
  const original = store.page.bind(store);
  store.page = async (...args) => { const rows = await original(...args); online = false; return rows; };
  const service = new HistoryRescanService(store, { exists: async () => true, configured: () => true, connected: () => online, emit: async () => { delivered++; } });
  const job = await service.request('owner', 'session', randomUUID()); await service.runOnce();
  const result = await service.status('owner', 'session', job.jobId);
  assert.equal(result.status, 'failed'); assert.equal(result.errorCode, 'HISTORY_CONNECTION_CLOSED'); assert.equal(delivered, 0);
  assert.equal(store.source.get('owner/session:contacts')?.length, 1);
  await assert.rejects(service.request('owner', 'session', randomUUID()), (error: any) => error.statusCode === 409);
  await service.stop();
});

test('rescan cancellation scopes pending data to that connection and excludes jobs created after its close', async () => {
  const calls: any[] = [];
  const store = new PrismaRescanStore({ historyRescanJob: { updateMany: async (query: any) => { calls.push(query); return { count: 1 }; } } } as any);
  const before = new Date('2026-09-09T12:00:00Z');
  await store.cancelInstance('owner/session', before);
  assert.deepEqual(calls[0].where, { instance: 'owner/session', status: { in: ['queued', 'running'] }, createdAt: { lte: before } });
  assert.equal(calls[0].data.status, 'failed'); assert.equal(calls[0].data.errorCode, 'HISTORY_CONNECTION_CLOSED');
  assert.equal(calls[0].data.activeInstance, null); assert.equal(calls[0].data.leaseToken, null);
  assert.ok(calls[0].data.pending);
});

test('rescan exports every captured page once, keeps scopes and freezes an upper ID watermark', async () => {
  const f = setup({ pageSize: 2 });
  f.store.add('owner/session', 'contacts', [{ id: 1, data: { id: 'a@lid', phoneNumber: '5511@s.whatsapp.net' } }]);
  f.store.add('owner/session', 'chats', [{ id: 2, data: { id: '5511@s.whatsapp.net' } }]);
  f.store.add('owner/session', 'messages', Array.from({ length: 5 }, (_, n) => ({ id: n + 3, data: { key: { id: 'm' + n }, message: { conversation: 'texto ' + n } } })));
  f.store.add('other/session', 'messages', [{ id: 1, data: { secret: 'foreign' } }]);
  const key = randomUUID(), queued = await f.service.request('owner', 'session', key);
  f.store.source.get('owner/session:messages')!.push({ id: 100, data: { key: { id: 'new-live-message' } } });
  await f.service.runOnce();
  const done = await f.service.status('owner', 'session', queued.jobId);
  assert.equal(done.status, 'completed'); assert.equal(done.completionMeaning, 'enqueued');
  assert.deepEqual(done.counts, { contacts: 1, chats: 1, messages: 5 }); assert.equal(done.chunks, 5);
  const chunks = f.events.filter(event => event.history);
  assert.equal(new Set(chunks.map(event => event.history!.chunkId)).size, chunks.length);
  assert.equal(chunks.flatMap(event => event.event === 'messages.set' ? event.data as any[] : []).length, 5);
  assert.doesNotMatch(JSON.stringify(f.events), /foreign|new-live-message/);
  assert.ok(f.store.pages.every(page => page.take === 2 && page.instance === 'owner/session'));
  const final = f.events.at(-1)!.data as any; assert.equal(final.phase, 'waiting'); assert.equal(final.expectedChunks, 5); assert.deepEqual(final.expected, done.counts);
  assert.deepEqual(await f.service.request('owner', 'session', key), { ...done, reused: true, reuseMode: 'idempotent' });
  await assert.rejects(f.service.status('other', 'session', queued.jobId), (error: any) => error.statusCode === 404);
  await f.service.stop();
});

test('repeating a key or using another key reuses the active durable job', async () => {
  const f = setup({ canProduce: async () => false }), key = randomUUID();
  const [first, replay] = await Promise.all([f.service.request('owner', 'session', key), f.service.request('owner', 'session', key)]);
  assert.equal(first.jobId, replay.jobId); assert.equal(f.store.records.size, 1);
  assert.equal(first.reuseMode, null); assert.equal(replay.reuseMode, 'idempotent');
  const reused = await f.service.request('owner', 'session', randomUUID());
  assert.equal(reused.jobId, first.jobId); assert.equal(reused.reused, true); assert.equal(reused.reuseMode, 'active'); assert.equal(f.store.records.size, 1);
  await assert.rejects(f.service.request('owner', 'session', 'invalid'), (error: any) => error.statusCode === 400);
  await f.service.stop();
});

test('a crash after enqueue replays the exact frozen page and stable event IDs even if the source changed', async () => {
  const f = setup();
  f.store.add('owner/session', 'contacts', [{ id: 1, data: { id: '5511@s.whatsapp.net', name: 'original' } }]);
  f.store.failAdvance = true;
  const job = await f.service.request('owner', 'session', randomUUID()); await f.service.runOnce();
  assert.equal(f.store.records.get(job.jobId)!.status, 'queued'); assert.ok(f.store.records.get(job.jobId)!.pending);
  const first = structuredClone(f.events);
  f.store.source.get('owner/session:contacts')![0]!.data.name = 'changed-after-enqueue';
  await f.service.stop();
  const restarted = setup({ store: f.store }); restarted.later(); await restarted.service.runOnce();
  assert.deepEqual(restarted.events.slice(0, first.length), first);
  assert.equal((await restarted.service.status('owner', 'session', job.jobId)).status, 'completed');
  assert.doesNotMatch(JSON.stringify(restarted.events), /changed-after-enqueue/);
  await restarted.service.stop();
});

test('shutdown waits for the active enqueue, preserves its pending page and resumes without losing rows', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const f = setup({ emit: async () => { entered(); await gate; } });
  f.store.add('owner/session', 'contacts', [{ id: 1, data: { id: '5511@s.whatsapp.net' } }]);
  const job = await f.service.request('owner', 'session', randomUUID()); await started;
  let stopped = false; const stopping = f.service.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); release(); await stopping;
  assert.equal(f.store.records.get(job.jobId)!.status, 'queued'); assert.ok(f.store.records.get(job.jobId)!.pending);
  const restarted = setup({ store: f.store }); await restarted.service.runOnce();
  assert.equal((await restarted.service.status('owner', 'session', job.jobId)).counts.contacts, 1);
  assert.equal(restarted.events.filter(event => event.event === 'contacts.set').length, 1);
  await restarted.service.stop();
});

test('an old lease cannot advance or overwrite a job reclaimed by another worker', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const first = setup({ emit: async () => { entered(); await gate; } });
  first.store.add('owner/session', 'contacts', [{ id: 1, data: { id: '5511@s.whatsapp.net' } }]);
  const job = await first.service.request('owner', 'session', randomUUID()); await started;
  first.store.records.get(job.jobId)!.until = 0;
  const second = setup({ store: first.store }); await second.service.runOnce();
  const done = await second.service.status('owner', 'session', job.jobId); assert.equal(done.status, 'completed');
  release(); await first.service.runOnce(); assert.deepEqual(await first.service.status('owner', 'session', job.jobId), done);
  await first.service.stop(); await second.service.stop();
});

test('receiver backpressure pauses page reads, and oversized rows fail visibly without deleting source data', async () => {
  let ready = false; const f = setup({ canProduce: async () => ready });
  f.store.add('owner/session', 'messages', [{ id: 1, data: { text: 'x'.repeat(WEBHOOK_CHUNK_BYTES) } }]);
  const job = await f.service.request('owner', 'session', randomUUID()); await f.service.runOnce();
  assert.equal(f.store.pages.length, 0); assert.equal((await f.service.status('owner', 'session', job.jobId)).status, 'queued');
  ready = true; await f.service.runOnce();
  const failed = await f.service.status('owner', 'session', job.jobId);
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'HISTORY_ENTRY_TOO_LARGE');
  assert.equal(f.store.source.get('owner/session:messages')!.length, 1); assert.equal(f.events.length, 0);
  await f.service.stop();
});

test('Prisma page adapter uses ascending instance/id cursors and replays aliases, binary media and edits', async () => {
  const calls: any[] = [];
  const db: any = {
    contact: { findMany: async (query: any) => { calls.push(query); return [{ id: 2, jid: '5511@s.whatsapp.net', lid: '99@lid', name: 'Contato' }]; } },
    chat: { findMany: async (query: any) => { calls.push(query); return [{ id: 3, jid: '99@lid', data: { id: 'stale', archived: true } }]; } },
    message: { findMany: async (query: any) => { calls.push(query); return [
      { id: 4, remoteJid: '5511@s.whatsapp.net', fromMe: false, messageId: 'photo', messageTimestamp: 123n, content: { message: { imageMessage: { jpegThumbnail: { type: 'Buffer', data: 'AQI=' } } } } },
      { id: 5, remoteJid: '5511@s.whatsapp.net', fromMe: false, messageId: 'edit', messageTimestamp: 124n, content: { message: { protocolMessage: { type: 14, key: { id: 'photo' }, editedMessage: { conversation: 'corrigido' } } } } },
      { id: 6, remoteJid: '5511@s.whatsapp.net', fromMe: false, messageId: 'keys', messageTimestamp: 125n, content: { message: { senderKeyDistributionMessage: {} } } },
      { id: 7, remoteJid: '5511@s.whatsapp.net', fromMe: false, messageId: 'original-edited', messageTimestamp: 120n, content: { message: { editedMessage: { message: { conversation: 'correção atual' } } }, sourceEdit: { version: 2, editedAtMs: 999, sourceUpdatedAt: '2026-09-08T15:00:00.000Z' } } },
      { id: 8, remoteJid: '5511@s.whatsapp.net', fromMe: false, messageId: 'deleted', messageTimestamp: 126n, content: { message: null, messageStubType: 1 } },
    ]; } },
  };
  const store = new PrismaRescanStore(db);
  assert.deepEqual((await store.page('owner/session', 'contacts', 1, 6, 5))[0]!.data, { id: '99@lid', phoneNumber: '5511@s.whatsapp.net', legacyName: 'Contato', nameSource: 'legacy' });
  assert.deepEqual((await store.page('owner/session', 'chats', 1, 6, 5))[0]!.data, { id: '99@lid', archived: true });
  const messages = await store.page('owner/session', 'messages', 1, 6, 5);
  assert.deepEqual((messages[0]!.data as any).message.imageMessage.jpegThumbnail, { type: 'Buffer', data: 'AQI=' });
  assert.ok(messages[1]!.data); assert.equal(messages[2]!.data, null);
  assert.equal((messages[3]!.data as any).edited, true);
  assert.equal((messages[3]!.data as any).message.editedMessage.message.conversation, 'correção atual');
  assert.equal((messages[3]!.data as any).messageTimestamp, 120);
  assert.deepEqual((messages[3]!.data as any).sourceEdit, { version: 2, editedAtMs: 999, sourceUpdatedAt: '2026-09-08T15:00:00.000Z' });
  assert.equal(messages[4]!.data, null);
  for (const query of calls) assert.deepEqual(query, { where: { instance: 'owner/session', id: { gt: 1, lte: 6 } }, orderBy: { id: 'asc' }, take: 5 });
});

test('HTTP rescan endpoints enforce authentication, owner/name scope, UUID keys and accepted/status envelopes', async t => {
  const secret = 'history-http-test-secret', calls: any[] = [], jobId = randomUUID();
  const controller = { request: async (...args: any[]) => { calls.push(args); return { jobId, status: 'queued' }; }, status: async (...args: any[]) => { calls.push(args); return { jobId, status: 'completed' }; } };
  const app = express(); app.use(new Token(secret).verify); app.use(express.json()); app.use('/instances', new InstanceRoutes(controller as any).get());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = jwt.sign({ owner: 'owner', instanceName: 'session' }, secret, { expiresIn: 60 });
  const request = (path: string, method = 'POST', key: string | null = randomUUID(), auth: string | null = token) => fetch(base + '/instances/history-rescan/' + path, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(key ? { 'idempotency-key': key } : {}) } });
  assert.equal((await request('owner/session', 'POST', null, null)).status, 401);
  for (const target of ['other/session', 'owner/other']) {
    assert.equal((await request(target)).status, 403); assert.equal((await request(target + '/' + jobId, 'GET')).status, 403);
  }
  assert.equal((await request('owner/session', 'POST', null)).status, 400); assert.equal((await request('owner/session', 'POST', 'bad')).status, 400);
  assert.equal(calls.length, 0);
  const accepted = await request('owner/session'); assert.equal(accepted.status, 202); assert.equal((await accepted.json()).data.jobId, jobId);
  const status = await request('owner/session/' + jobId, 'GET'); assert.equal(status.status, 200); assert.equal((await status.json()).data.status, 'completed');
  assert.ok(calls.every(call => call[0] === 'owner' && call[1] === 'session'));
  controller.request = async () => { throw new RequestError(409, 'History synchronization is already in progress.', 'HISTORY_SYNC_IN_PROGRESS'); };
  const busy = await request('owner/session');
  assert.equal(busy.status, 409); assert.equal((await busy.json()).code, 'HISTORY_SYNC_IN_PROGRESS');
});

test('natural history and its pending delivery reject a new rescan without creating or replacing a run', async () => {
  const store = new MemoryStore(); let natural = true, backlog = false;
  const service = new HistoryRescanService(store, { exists: async () => true, configured: () => true, connected: () => true,
    naturalHistoryActive: () => natural, historyPending: async () => backlog, emit: async () => {} });
  try {
    const busy = (error: any) => error.statusCode === 409 && error.code === 'HISTORY_SYNC_IN_PROGRESS';
    await assert.rejects(service.request('owner', 'session', randomUUID()), busy);
    assert.equal(store.records.size, 0);
    natural = false; backlog = true;
    await assert.rejects(service.request('owner', 'session', randomUUID()), busy);
    assert.equal(store.records.size, 0);
    backlog = false;
    assert.equal((await service.request('owner', 'session', randomUUID())).reused, false);
  } finally { await service.stop(); }
});

test('natural history starting during a rescan pauses the frozen page without losing identity or consuming retries', async () => {
  const store = new MemoryStore(); let natural = false, ready = false, clock = Date.now();
  store.add('owner/session', 'messages', [{ id: 1, data: { key: { id: 'saved' } } }]);
  const events: RescanEvent[] = [];
  const service = new HistoryRescanService(store, { exists: async () => true, configured: () => true, connected: () => true,
    naturalHistoryActive: () => natural, canProduce: async () => ready, now: () => new Date(clock), emit: async (_instance, event) => { events.push(event); } });
  try {
    const queued = await service.request('owner', 'session', randomUUID()); await service.runOnce();
    assert.equal(queued.waitingReason, 'webhook-backlog');
    ready = true; natural = true; await service.runOnce();
    const paused = await service.status('owner', 'session', queued.jobId);
    assert.equal(paused.waitingReason, 'natural-history'); assert.equal(paused.status, 'queued');
    assert.equal(paused.attempts, 0); assert.equal(events.length, 0);
    const reused = await service.request('owner', 'session', randomUUID());
    assert.equal(reused.jobId, queued.jobId); assert.equal(reused.reused, true);
    await service.runOnce();
    natural = false; clock += 1000; await service.runOnce();
    const done = await service.status('owner', 'session', queued.jobId);
    assert.equal(done.status, 'completed'); assert.equal(done.counts.messages, 1);
    assert.ok(events.filter(event => event.history).every(event => event.history!.source === 'stored-history'));
  } finally { await service.stop(); }
});

test('a completed producer with queued delivery reuses its job until its own run is delivered', async () => {
  const store = new MemoryStore(); let ready = false, pendingRun: string | undefined;
  const service = new HistoryRescanService(store, { exists: async () => true, configured: () => true, connected: () => true,
    canProduce: async () => ready,
    historyPending: async (_owner, _name, runId) => Boolean(pendingRun && (!runId || runId === pendingRun)),
    emit: async (_instance, event) => { pendingRun = (event.data as any)?.runId ?? event.history?.runId ?? pendingRun; } });
  try {
    const first = await service.request('owner', 'session', randomUUID());
    await service.runOnce(); ready = true; await service.runOnce();
    const done = await service.status('owner', 'session', first.jobId);
    assert.equal(done.status, 'completed'); assert.equal(done.waitingReason, 'webhook-backlog');
    const replay = await service.request('owner', 'session', randomUUID());
    assert.equal(replay.reused, true); assert.equal(replay.jobId, first.jobId); assert.equal(store.records.size, 1);
    pendingRun = undefined;
    assert.equal((await service.status('owner', 'session', first.jobId)).waitingReason, null);
    assert.equal((await service.request('owner', 'session', randomUUID())).reused, false);
  } finally { await service.stop(); }
});

test('rescan binds each page to the real online transport and refuses a replacement during the read', async () => {
  const store = new MemoryStore();
  const oldStamp = new Date(Date.now() - 1000).toISOString(), newStamp = new Date().toISOString();
  let stamp = oldStamp, deliveries = 0;
  const snapshot = () => ({ owner: 'owner', instanceName: 'session', connectionStatus: 'ONLINE' as const, connectionState: 'connected' as const, connectionUpdatedAt: stamp });
  store.add('owner/session', 'contacts', [{ id: 1, data: { id: 'saved' } }]);
  const page = store.page.bind(store);
  store.page = async (...args) => { const result = await page(...args); stamp = newStamp; return result; };
  const service = new HistoryRescanService(store, { exists: async () => true, configured: () => true, connected: () => true, snapshot,
    emit: async () => { deliveries++; } });
  try {
    const job = await service.request('owner', 'session', randomUUID()); await service.runOnce();
    const failed = await service.status('owner', 'session', job.jobId);
    assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'HISTORY_CONNECTION_CLOSED'); assert.equal(deliveries, 0);
  } finally { await service.stop(); }
});

test('production replay enqueue preserves online snapshot and source, refusing offline or mismatched transport', async () => {
  const instance = { owner: 'owner', instanceName: 'session', connectionStatus: 'ONLINE' as const, connectionState: 'connected' as const, connectionUpdatedAt: new Date().toISOString() };
  const event: RescanEvent = { id: randomUUID(), timestamp: new Date().toISOString(), event: 'messages.set', data: [{ id: 'saved' }],
    history: { source: 'stored-history', runId: randomUUID(), startedAt: new Date().toISOString(), batchId: 'batch', chunkId: 'chunk' } };
  const calls: any[][] = [];
  const outbox = { enqueue: async (...args: any[]) => { calls.push(args); return event.id; } };
  await enqueueRescanEvent(outbox, instance, event, () => ({ ...instance }));
  assert.deepEqual(calls[0], [event.event, instance, event.data, event.history, { id: event.id, timestamp: event.timestamp }]);
  const closed = (error: any) => error.code === 'HISTORY_CONNECTION_CLOSED';
  await assert.rejects(enqueueRescanEvent(outbox, { ...instance, connectionStatus: 'OFFLINE' }, event, () => instance), closed);
  await assert.rejects(enqueueRescanEvent(outbox, instance, event, () => ({ ...instance, connectionUpdatedAt: '2020-01-01T00:00:00.000Z' })), closed);
  assert.equal(calls.length, 1);
});

test('a naturally busy connection yields the rescan worker to other instances without consuming attempts', async () => {
  const store = new MemoryStore(); let clock = Date.now();
  const first = await store.begin('owner/busy', randomUUID(), true, new Date(clock));
  const second = await store.begin('owner/ready', randomUUID(), true, new Date(clock));
  const delivered: string[] = [];
  const service = new HistoryRescanService(store, { now: () => new Date(clock), exists: async () => true, configured: () => true,
    connected: () => true, naturalHistoryActive: key => key === 'owner/busy', emit: async instance => { delivered.push(instance.instanceName); } });
  try {
    await service.runOnce();
    assert.equal(store.records.get(first.id)!.nextAt, clock + 1000);
    clock += 2000;
    await service.runOnce();
    assert.equal((await service.status('owner', 'ready', second.id)).status, 'completed');
    assert.deepEqual(delivered, ['ready']);
    const paused = await service.status('owner', 'busy', first.id);
    assert.equal(paused.status, 'queued'); assert.equal(paused.attempts, 0);
  } finally { await service.stop(); }
});
