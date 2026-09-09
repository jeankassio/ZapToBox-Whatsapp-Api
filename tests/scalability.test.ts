import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { BoundedCache } from '../src/shared/bounded-cache.js';
import { collectMedia, MediaDownloadBudget, untilAborted, trackMediaDownload, cancelMediaDownloads } from '../src/infra/http/controllers/media-budget.js';
import InstancesRepository from '../src/core/repositories/instances.js';
import { prisma } from '../src/core/connection/prisma.js';
import UserConfig from '../src/infra/config/env.js';

test('1000 independent caches retain a fixed bound without timers and expired entries are not returned', () => {
  let now = 1000;
  const caches = Array.from({ length: 1000 }, () => new BoundedCache(32, 10, () => now));
  for (let owner = 0; owner < caches.length; owner++) {
    const cache = caches[owner]!;
    for (let key = 0; key < 200; key++) cache.set(String(key), `${owner}/${key}`);
    assert.equal(cache.size, 32);
    assert.equal(cache.get('0'), undefined);
    assert.equal(cache.get('199'), `${owner}/199`);
  }
  assert.equal(caches.reduce((total, cache) => total + cache.size, 0), 32_000);
  now += 10_001;
  for (const cache of caches) { assert.equal(cache.get('199'), undefined); cache.flushAll(); assert.equal(cache.size, 0); }
});

test('cache eviction preserves the recently used entry while never changing its expiration', () => {
  let now = 0;
  const cache = new BoundedCache(2, 1, () => now);
  cache.set('a', 1); cache.set('b', 2);
  now = 900; assert.equal(cache.get('a'), 1);
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined);
  now = 1001; assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('c'), 3);
});

test('1000 concurrent media requests start only the four allowed downloads and excess work returns 429', async () => {
  const budget = new MediaDownloadBudget(4);
  let release!: () => void, started = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requests = Array.from({ length: 1000 }, () => budget.run(async () => { started++; await gate; return 'downloaded'; }));
  const finished = Promise.allSettled(requests);
  assert.equal(started, 4);
  release();
  const results = await finished;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 4);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.statusCode, 429);
  assert.equal(await budget.run(async () => 'recovered'), 'recovered');
});

test('download budget is released on failure and oversized streams are destroyed before full consumption', async () => {
  const budget = new MediaDownloadBudget(1);
  await assert.rejects(budget.run(async () => { throw new Error('failure'); }));
  assert.equal(await budget.run(async () => true), true);
  let chunks = 0;
  const stream = Readable.from((async function* () { while (chunks < 1000) { chunks++; yield Buffer.alloc(1024); } })());
  await assert.rejects(collectMedia(stream, 4096, new AbortController().signal), (error: any) => error.statusCode === 413);
  assert.ok(chunks < 1000);
  assert.equal(stream.destroyed, true);
});

test('a stalled media stream respects the deadline and releases its stream', async () => {
  const abort = new AbortController();
  const stream = new Readable({ read() {} });
  const pending = untilAborted(collectMedia(stream, 4096, abort.signal), abort.signal);
  abort.abort();
  await assert.rejects(pending, (error: any) => error.statusCode === 504);
  assert.equal(stream.destroyed, true);
});

test('disconnect cancels only the selected connection downloads and preserves a new generation', () => {
  const first = new AbortController(), other = new AbortController(), next = new AbortController();
  const releaseOld = trackMediaDownload('owner/first', first), releaseOther = trackMediaDownload('owner/other', other);
  cancelMediaDownloads('owner/first');
  const releaseNext = trackMediaDownload('owner/first', next); releaseOld();
  assert.equal(first.signal.aborted, true); assert.equal(other.signal.aborted, false); assert.equal(next.signal.aborted, false);
  cancelMediaDownloads('owner/first'); assert.equal(next.signal.aborted, true);
  releaseNext(); releaseOther();
});

test('1000 persisted status lookups use the exact credential key instead of scanning the session inventory', async t => {
  const before = UserConfig.authStore; UserConfig.authStore = 'database'; t.after(() => { UserConfig.authStore = before; });
  let queries = 0;
  t.mock.method(InstancesRepository.prototype, 'list', async () => { throw new Error('Unexpected inventory scan'); });
  const delegate = prisma.authState as any, original = delegate.findUnique;
  t.after(() => { delegate.findUnique = original; });
  delegate.findUnique = async (query: any) => {
    queries++; assert.equal(query.where.instance_type_key.type, 'creds'); assert.equal(query.where.instance_type_key.key, 'current');
    assert.deepEqual(query.select, { instance: true }); return { instance: query.where.instance_type_key.instance };
  };
  const repository = new InstancesRepository();
  for (let index = 0; index < 1000; index++) {
    const result = await repository.find(`qa-owner-${index}`, 'session');
    assert.equal(result?.owner, `qa-owner-${index}`); assert.equal(result?.connectionStatus, 'OFFLINE');
  }
  assert.equal(queries, 1000);
});
