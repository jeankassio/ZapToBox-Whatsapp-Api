import test from 'node:test';
import assert from 'node:assert/strict';
import { proto } from '@whiskeysockets/baileys';
import { HistoryProgressTracker } from '../src/infra/baileys/history-progress.js';
import { webhookChunks, WEBHOOK_CHUNK_BYTES } from '../src/infra/webhook/chunks.js';
import { stringify } from '../src/shared/serialization.js';

const recent = proto.HistorySync.HistorySyncType.RECENT;
const full = proto.HistorySync.HistorySyncType.FULL;
const empty = { contacts: 0, chats: 0, messages: 0 };

test('provider 100/isLatest/offline notifications never claim global completion', () => {
  const tracker = new HistoryProgressTracker();
  assert.equal(tracker.snapshot().phase, 'awaiting');
  assert.equal(tracker.snapshot().resumed, false);
  assert.equal(tracker.pendingNotifications(true).phase, 'awaiting');
  assert.equal(tracker.providerStatus({ syncType: recent, status: 'complete', explicit: true }).phase, 'receiving');
  const receiving = tracker.beginBatch({ syncType: recent, progress: 100, isLatest: true }, { ...empty, messages: 3 }, 1);
  assert.equal(receiving.phase, 'receiving');
  assert.equal(receiving.provider.isLatest, true);
  assert.equal(receiving.provider.progress, 100);
  assert.equal(tracker.snapshot('importing').phase, 'importing');
  const finished = tracker.importedBatch();
  assert.equal(finished.phase, 'waiting');
  assert.equal(finished.processedBatches, 1);
  assert.deepEqual(finished.expected, { contacts: 0, chats: 0, messages: 3 });
  assert.equal(finished.expectedChunks, 1);
  assert.ok(finished.sequence > receiving.sequence);
  receiving.expected.messages = 0;
  assert.equal(tracker.snapshot().expected.messages, 3, 'published snapshots cannot mutate future watermarks');
});

test('known downloads and provider timeout remain receiving/paused until an observed import', () => {
  const tracker = new HistoryProgressTracker();
  tracker.download({ syncType: recent, progress: 50, chunkOrder: 1 });
  tracker.download({ syncType: recent, progress: 100, chunkOrder: 2 });
  tracker.beginBatch({ syncType: recent, progress: 50, chunkOrder: 1 }, empty, 0);
  assert.equal(tracker.importedBatch().phase, 'receiving');
  assert.equal(tracker.pendingNotifications(true).phase, 'receiving');
  tracker.beginBatch({ syncType: recent, progress: 100, chunkOrder: 2 }, empty, 0);
  assert.equal(tracker.importedBatch().phase, 'waiting');
  tracker.download({ syncType: recent });
  tracker.beginBatch({ syncType: recent }, empty, 0);
  assert.equal(tracker.importedBatch().phase, 'waiting', 'optional progress and chunkOrder can both be absent');
  assert.equal(tracker.providerStatus({ syncType: recent, status: 'paused', explicit: false }).phase, 'paused');
  tracker.beginBatch({ syncType: recent, progress: 100 }, empty, 0);
  assert.equal(tracker.importedBatch().phase, 'paused');
});

test('buffered history retires only a matched prefix; unmatched downloads cannot finish silently', () => {
  const tracker = new HistoryProgressTracker();
  tracker.download({ syncType: recent, progress: 20, chunkOrder: 1 });
  tracker.download({ syncType: recent, progress: 40, chunkOrder: 2 });
  tracker.beginBatch({ syncType: recent, progress: 40, chunkOrder: 2 }, { ...empty, contacts: 2 }, 1);
  assert.equal(tracker.importedBatch().phase, 'waiting');
  tracker.download({ syncType: full, progress: 50, chunkOrder: 9 });
  tracker.beginBatch({ syncType: recent, progress: 100, chunkOrder: 3 }, empty, 0);
  assert.equal(tracker.importedBatch().phase, 'receiving');
});

test('phase metadata resets across sync types and every socket run has an independent identity', () => {
  const tracker = new HistoryProgressTracker();
  tracker.providerStatus({ syncType: recent, status: 'complete', explicit: true });
  const next = tracker.download({ syncType: full, progress: 5 });
  assert.equal(next.provider.status, null);
  assert.equal(next.provider.progress, 5);
  assert.equal(next.provider.explicit, null);
  assert.equal(tracker.failure().error, 'HISTORY_PROCESSING_FAILED');
  const resumed = new HistoryProgressTracker(true);
  assert.notEqual(resumed.identity.runId, tracker.identity.runId);
  assert.equal(resumed.snapshot().phase, 'waiting');
  assert.equal(resumed.snapshot().resumed, true);
  assert.equal(resumed.snapshot().expectedChunks, 0);
});

test('webhook chunk planning preserves all entries and bounds UTF-8 bytes and item count', () => {
  const entries = Array.from({ length: 251 }, (_, id) => ({ id, text: 'á😀'.repeat(700), bytes: Buffer.from([1, 2, 3]) }));
  const chunks = webhookChunks(entries);
  assert.deepEqual(chunks.flat(), entries);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 100);
    assert.ok(Buffer.byteLength(stringify(chunk)) <= WEBHOOK_CHUNK_BYTES);
  }
  assert.deepEqual(webhookChunks([]), []);
  assert.throws(() => webhookChunks([{ text: 'x'.repeat(WEBHOOK_CHUNK_BYTES) }]), /exceeds supported size/);
});
