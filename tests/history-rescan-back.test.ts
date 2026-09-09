import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import Token from '../src/infra/state/auth.js';
import InstanceRoutes from '../src/infra/http/routes/instances.js';
import { HistoryRescanService, zeroCounts, type RescanStore, type RescanJob } from '../src/infra/history-rescan/service.js';
import { enqueueRescanEvent } from '../src/infra/history-rescan/delivery.js';
import type { InstanceInfo } from '../src/shared/types.js';

// Opt-in cross-project contract check. The transport, source store and SQLite
// database are isolated; no WhatsApp account or production service is contacted.
test('manual rescan follows natural sync, reuses its job and delivers online history to the real backend', {
  skip: !process.env.QA_BACKEND_PATH,
}, async t => {
  const load = (file: string) => import(pathToFileURL(join(resolve(process.env.QA_BACKEND_PATH!), file)).href);
  const [{ syncFixture, historyMessage }, { WhatsappClient }, { getSyncStatus }] = await Promise.all([
    load('test/sync-fixture.ts'), load('src/whatsapp/client.ts'), load('src/whatsapp/sync.ts'),
  ]);
  const f = await syncFixture(t);
  const startedAt = new Date(Date.now() - 60_000).toISOString(), runId = randomUUID();
  const generation = new Date(Date.now() - 120_000).toISOString();
  const snapshot: InstanceInfo = { owner: String(f.connection.id), instanceName: f.connection.identify,
    connectionStatus: 'ONLINE', connectionState: 'connected', connectionUpdatedAt: generation };
  await f.webhook('connection.open', {}, { instance: snapshot });
  await f.chunk('natural-chunk', [historyMessage('natural-text'), historyMessage('recover-photo', true)], { runId, startedAt });
  await f.progress({ runId, startedAt, phase: 'receiving', expectedChunks: 2,
    expected: { contacts: 0, chats: 0, messages: 3 }, processedBatches: 1 });
  // Previously cancelled media remains in the conversation but lacks a queue
  // entry. A genuine replay should restore it without duplicating the message.
  await f.db.execute('DELETE FROM tbl_queueMediaMessage WHERE _instanceId=? AND _messageId=?', [f.connection.id, 'recover-photo']);
  const before = await getSyncStatus(f.db, f.connection.id);
  assert.equal(before.history.processed.messages, 2);

  let natural = true, produce = false;
  let job: RescanJob | null = null, lease: string | null = null, active = false;
  const clone = <T>(value: T): T => structuredClone(value);
  const rows = [historyMessage('natural-text'), historyMessage('recover-photo', true), historyMessage('restored-text')];
  const store: RescanStore = {
    async findByKey(instance, key) { return job?.instance === instance && job.idempotencyKey === key ? clone(job) : null; },
    async findActive(instance) { return active && job?.instance === instance ? clone(job) : null; },
    async begin(instance, key, _known, now) {
      if (active && job) return { ...clone(job), reused: true };
      job = { id: randomUUID(), instance, idempotencyKey: key, runId: randomUUID(), status: 'queued',
        state: { phase: 'contacts', cursor: zeroCounts(), max: { ...zeroCounts(), messages: rows.length },
          available: { ...zeroCounts(), messages: rows.length }, scanned: zeroCounts(), counts: zeroCounts(), chunks: 0, sequence: 0 },
        pending: null, attempts: 0, errorCode: null, createdAt: now, updatedAt: now, completedAt: null };
      active = true; return clone(job);
    },
    async get(instance, id) { return job?.instance === instance && job.id === id ? clone(job) : null; },
    async next() { return active && !lease && job ? job.id : null; },
    async claim(id, token) { if (!job || job.id !== id || !active || lease) return null; lease = token; job.status = 'running'; return clone(job); },
    async renew(_id, token) { return token === lease; },
    async stage(_id, token, pending) { if (!job || token !== lease) return false; job.pending = clone(pending); return true; },
    async advance(_id, token, pending, now) {
      if (!job || token !== lease) return false;
      job.state = clone(pending.after); job.pending = null; job.updatedAt = now;
      if (pending.complete) { job.status = 'completed'; job.completedAt = now; active = false; lease = null; }
      return true;
    },
    async release(_id, token) { if (job && lease === token) { job.status = 'queued'; lease = null; } },
    async fail(_id, token, code, _retryAt, terminal) {
      if (job && lease === token) { job.errorCode = code; job.attempts++; job.status = terminal ? 'failed' : 'queued'; active = !terminal; lease = null; }
    },
    async page(_instance, kind, after, maximum, take) {
      return kind === 'messages' ? rows.map((data: unknown, i: number) => ({ id: i + 1, data })).filter((row: { id: number }) => row.id > after && row.id <= maximum).slice(0, take) : [];
    },
  };
  const delivered: string[] = [];
  const service = new HistoryRescanService(store, { configured: () => true, exists: async () => true,
    connected: () => true, snapshot: () => snapshot, naturalHistoryActive: () => natural,
    historyPending: async () => false, canProduce: async () => produce, pageSize: 1,
    emit: async (instance, event) => enqueueRescanEvent({ enqueue: async (name, info, data, history, options) => {
      const result = await f.webhook(name, data, { id: options!.id, timestamp: options!.timestamp, instance: info, ...(history ? { history } : {}) });
      assert.equal(result.status, 200, JSON.stringify(result.body)); delivered.push(name); return options!.id!;
    } }, instance, event, () => snapshot),
  });
  t.after(() => service.stop());
  const secret = 'isolated-rescan-contract';
  const app = express(); app.use(new Token(secret).verify); app.use(express.json());
  app.use('/instances', new InstanceRoutes(service).get());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const client = new WhatsappClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: secret });
  t.mock.method(f.application.client, 'rescanHistory', client.rescanHistory.bind(client));
  t.mock.method(f.application.client, 'historyRescanStatus', client.historyRescanStatus.bind(client));
  const path = `/api/connections/${f.connection.identify}/history-rescan`;

  const following = await f.request(path, { session: f.owner, body: {}, key: randomUUID() });
  assert.equal(following.status, 200, JSON.stringify(following.body));
  assert.equal(job, null, 'clicking during natural sync must not create a competing run');
  assert.equal((await getSyncStatus(f.db, f.connection.id)).history.processed.messages, 2);
  assert.equal((await f.db.query('SELECT _id FROM tbl_queueMediaMessage WHERE _instanceId=?', [f.connection.id])).length, 0);

  natural = false;
  // Complete the pending natural batch so local receiving is also settled.
  await f.chunk('natural-last', [historyMessage('natural-last')], { runId, startedAt });
  await f.progress({ runId, startedAt, sequence: 2, phase: 'waiting', expectedChunks: 2,
    expected: { contacts: 0, chats: 0, messages: 3 }, processedBatches: 2 });
  const queued = await f.request(path, { session: f.owner, body: {}, key: randomUUID() });
  assert.equal(queued.status, 200, JSON.stringify(queued.body)); assert.ok(queued.body.data.jobId);
  const repeated = await f.request(path, { session: f.owner, body: {}, key: randomUUID() });
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.equal(repeated.body.data.jobId, queued.body.data.jobId);
  assert.equal((await getSyncStatus(f.db, f.connection.id)).history.processed.messages, 3, 'merely queuing does not erase received history');

  produce = true; await service.runOnce();
  const done = await service.status(String(f.connection.id), f.connection.identify, queued.body.data.jobId);
  assert.equal(done.status, 'completed'); assert.equal(done.completionMeaning, 'enqueued');
  assert.equal(done.counts.messages, 3); assert.equal(done.scanned.messages, 3);
  assert.ok(delivered.includes('messages.set'));
  const sync = await getSyncStatus(f.db, f.connection.id);
  assert.equal(sync.runId, queued.body.data.runId);
  assert.equal(sync.history.processed.messages, 3, 'online replay is actually accepted by the backend');
  assert.equal((await f.db.query('SELECT _id FROM tbl_messages WHERE _instanceId=? AND _messageId=?', [f.connection.id, 'restored-text'])).length, 1);
  assert.equal((await f.db.query('SELECT _id FROM tbl_queueMediaMessage WHERE _instanceId=? AND _messageId=?', [f.connection.id, 'recover-photo'])).length, 1);
  const [historyRow] = await f.db.query('SELECT _manualJob FROM tbl_historySync WHERE _instanceId=?', [f.connection.id]);
  await f.db.execute('UPDATE tbl_historySync SET _manualJob=? WHERE _instanceId=?',
    [JSON.stringify({ ...JSON.parse(historyRow._manualJob), checkedAt: startedAt }), f.connection.id]);
  const reopened = await f.request(path + '/current', { session: f.owner });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.data.job.jobId, queued.body.data.jobId);
  assert.equal(reopened.body.data.job.status, 'completed');
  assert.equal(reopened.body.data.job.imported.complete, true);
  assert.equal(reopened.body.data.job.imported.processed.messages, 3);
  assert.equal((await f.request(path + '/current', { session: f.other })).status, 404);
});
