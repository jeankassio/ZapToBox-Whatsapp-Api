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

type Internal = RescanJob & { active: boolean; token: string | null; until: number; nextAt: number };
class MemoryStore implements RescanStore {
  records = new Map<string, Internal>();
  source = new Map<string, Array<{ id: number; data: any }>>();
  pages: any[] = [];
  failAdvance = false;
  add(instance: string, kind: RescanKind, rows: Array<{ id: number; data: any }>) { this.source.set(`${instance}:${kind}`, structuredClone(rows)); }
  async begin(instance: string, key: string, known: boolean, now: Date) {
    const prior = [...this.records.values()].find(job => job.instance === instance && job.idempotencyKey === key); if (prior) return structuredClone(prior);
    if ([...this.records.values()].some(job => job.instance === instance && job.active)) throw new RequestError(409, 'A history rescan is already in progress for this instance.');
    const max = zeroCounts(), available = zeroCounts();
    for (const kind of RESCAN_KINDS) { const rows = this.source.get(`${instance}:${kind}`) ?? []; max[kind] = rows.at(-1)?.id ?? 0; available[kind] = rows.length; }
    if (!known && !Object.values(available).some(Boolean)) throw new RequestError(404, 'Instance history not found.');
    const job: Internal = { id: randomUUID(), instance, idempotencyKey: key, runId: randomUUID(), status: 'queued',
      state: { phase: 'contacts', cursor: zeroCounts(), max, available, scanned: zeroCounts(), counts: zeroCounts(), chunks: 0, sequence: 0 },
      pending: null, attempts: 0, errorCode: null, createdAt: now, updatedAt: now, completedAt: null, active: true, token: null, until: 0, nextAt: now.getTime() };
    this.records.set(job.id, job); return structuredClone(job);
  }
  async get(instance: string, id: string) { const row = this.records.get(id); return row?.instance === instance ? structuredClone(row) : null; }
  async next(now: Date) { return [...this.records.values()].find(job => job.active && job.nextAt <= now.getTime() && (job.status === 'queued' || job.status === 'running' && job.until <= now.getTime()))?.id ?? null; }
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
  async release(id: string, token: string) { const row = this.owned(id, token); if (row) Object.assign(row, { status: 'queued', token: null }); }
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
  assert.deepEqual(await f.service.request('owner', 'session', key), done);
  await assert.rejects(f.service.status('other', 'session', queued.jobId), (error: any) => error.statusCode === 404);
  await f.service.stop();
});

test('repeating a key shares its durable job, while another key cannot create a second active job', async () => {
  const f = setup({ canProduce: async () => false }), key = randomUUID();
  const [first, replay] = await Promise.all([f.service.request('owner', 'session', key), f.service.request('owner', 'session', key)]);
  assert.equal(first.jobId, replay.jobId); assert.equal(f.store.records.size, 1);
  await assert.rejects(f.service.request('owner', 'session', randomUUID()), (error: any) => error.statusCode === 409);
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
  assert.deepEqual((await store.page('owner/session', 'contacts', 1, 6, 5))[0]!.data, { id: '99@lid', phoneNumber: '5511@s.whatsapp.net', name: 'Contato' });
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
});
