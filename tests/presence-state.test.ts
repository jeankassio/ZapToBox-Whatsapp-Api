import test from 'node:test';
import assert from 'node:assert/strict';
import { PresenceState, presenceJid } from '../src/infra/baileys/presence-state.js';

const pn = '5511999999999@s.whatsapp.net', lid = '123456789012345@lid';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test('presence snapshots normalize device JIDs, keep only provider lastSeen and expire at 90 seconds', () => {
  let now = 1_800_000_000_000; const state = new PresenceState(() => now);
  const snapshot = state.observe({ id: pn.replace('@', ':7@'), presences: { [pn.replace('@', ':3@')]: { lastKnownPresence: 'unavailable', lastSeen: now / 1000 - 60 } } })[0]!;
  assert.equal(snapshot.id, pn); assert.deepEqual(snapshot.presences[pn], { lastKnownPresence: 'unavailable', lastSeen: now / 1000 - 60 });
  assert.equal(Date.parse(snapshot.expiresAt!) - Date.parse(snapshot.observedAt!), 90_000);
  now += 89_999; assert.equal(state.snapshot(pn).presences[pn]?.lastKnownPresence, 'unavailable');
  now++; assert.deepEqual(state.snapshot(pn), { id: pn, presences: {}, observedAt: null, expiresAt: null });
  for (const lastSeen of [undefined, 0, -1, Infinity, 1.5, String(now / 1000), now / 1000 + 1]) {
    state.observe({ id: pn, presences: { [pn]: { lastKnownPresence: 'available', lastSeen } } });
    assert.deepEqual(state.snapshot(pn).presences[pn], { lastKnownPresence: 'available' });
  }
});

test('known aliases correlate snapshots and webhooks but unrelated authors do not become the selected person', () => {
  const state = new PresenceState(); state.link(pn, [pn, lid]);
  const deliveries = state.observe({ id: lid, presences: { [lid]: { lastKnownPresence: 'recording' }, '5511888888888@s.whatsapp.net': { lastKnownPresence: 'available' } } });
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0]!.id, pn);
  assert.deepEqual(deliveries[0]!.presences, { [pn]: { lastKnownPresence: 'recording' } });
  assert.deepEqual(state.snapshot(pn), deliveries[0]);
  state.clear(); assert.equal(state.snapshot(pn).observedAt, null);
  const raw = state.observe({ id: lid, presences: { [lid]: { lastKnownPresence: 'composing' } } });
  assert.equal(raw[0]!.id, lid, 'old socket aliases do not survive clear');
});

test('snapshots and registrations are bounded and invalid event fields never become presence', () => {
  const state = new PresenceState();
  for (let index = 0; index < 300; index++) {
    const id = `${5511000000000 + index}@s.whatsapp.net`; state.link(id, [id]);
    state.observe({ id, presences: { [id]: { lastKnownPresence: 'paused' } } });
  }
  assert.equal((state as any).snapshots.size, 128); assert.equal((state as any).targets.size, 128);
  assert.equal(state.snapshot('5511000000000@s.whatsapp.net').observedAt, null);
  assert.deepEqual(state.observe({ id: '120363123456@g.us', presences: { [pn]: { lastKnownPresence: 'available' } } }), []);
  assert.deepEqual(state.observe({ id: pn, presences: { [pn]: { lastKnownPresence: 'invented' } } }), []);
  assert.equal(presenceJid('status@broadcast'), undefined); assert.equal(presenceJid(lid.replace('@', ':7@')), lid);
});

test('subscribe deduplicates pending work, throttles for 30 seconds and retries failures', async () => {
  let now = 1_800_000_000_000, calls = 0; const state = new PresenceState(() => now), gate = deferred();
  const action = async () => { calls++; await gate.promise; };
  const first = state.subscribe(pn, action), second = state.subscribe(pn, action);
  await Promise.resolve(); assert.equal(calls, 1); gate.resolve();
  assert.equal((await first).observedAt, null); await second;
  now += 29_999; await state.subscribe(pn, action); assert.equal(calls, 1);
  now++; await state.subscribe(pn, action); assert.equal(calls, 2);
  const failure = new PresenceState();
  await assert.rejects(failure.subscribe(pn, async () => { throw new Error('transient'); }));
  await failure.subscribe(pn, async () => { calls++; }); assert.equal(calls, 3);
});

test('timeout keeps a hung operation deduplicated and prevents late side effects', async () => {
  const state = new PresenceState(Date.now, 5), gate = deferred(); let calls = 0, sent = 0;
  const action = async (active: () => boolean) => { calls++; await gate.promise; if (active()) sent++; };
  await assert.rejects(state.subscribe(pn, action), (error: any) => error.statusCode === 504);
  await assert.rejects(state.subscribe(pn, action), (error: any) => error.statusCode === 504);
  assert.equal(calls, 1); gate.resolve(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent, 0); await state.subscribe(pn, async () => { sent++; }); assert.equal(sent, 1);
});

test('pending subscriptions remain bounded and clear invalidates an old completion', async () => {
  const state = new PresenceState(), gate = deferred();
  const pending = Array.from({ length: 128 }, (_, index) => state.subscribe(`${5511000000000 + index}@s.whatsapp.net`, () => gate.promise));
  const all = Promise.allSettled(pending);
  await assert.rejects(state.subscribe(pn, () => gate.promise), (error: any) => error.statusCode === 429);
  assert.equal((state as any).requests.size, 128);
  state.clear(); gate.resolve();
  const settled = await all; assert.ok(settled.every(item => item.status === 'rejected' && item.reason.statusCode === 409));
  assert.equal((state as any).requests.size, 0);
});
