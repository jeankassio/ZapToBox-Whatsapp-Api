import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep, setImmediate as tick } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { DisconnectReason, proto, type WAMessage } from '@whiskeysockets/baileys';
import Instance, { type InstanceDependencies } from '../src/infra/baileys/services.js';
import { createPersistentAuth, type AuthRepository, type AuthEntry } from '../src/infra/state/auth-state.js';
import { instances, instanceConnection, instanceStatus } from '../src/shared/constants.js';
import { deserializeBaileys } from '../src/infra/mappers/messageMapper.js';
import type { HistoryChunkMetadata } from '../src/shared/types.js';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function memoryAuth(): AuthRepository {
  const rows = new Map<string, AuthEntry>();
  return {
    async read(type, ids) { return Object.fromEntries(ids.flatMap(id => { const row = rows.get(`${type}:${id}`); return row ? [[id, row.value]] : []; })); },
    async write(entries) { for (const entry of entries) { if (entry.value === null) rows.delete(`${entry.type}:${entry.key}`); else rows.set(`${entry.type}:${entry.key}`, structuredClone(entry)); } },
    async clear() { rows.clear(); },
    async replace(entries) { rows.clear(); await this.write(entries); },
  };
}
async function fixture(t: any, options: { registered?: boolean; overrides?: Partial<InstanceDependencies>; initialQR?: boolean } = {}) {
  const owner = `qa_${randomUUID()}`;
  const key = `${owner}/one`;
  const auth = await createPersistentAuth(memoryAuth());
  auth.state.creds.registered = options.registered ?? true;
  const sockets: any[] = [];
  const webhooks: { event: string; data: any; history?: HistoryChunkMetadata }[] = [];
  const stored = new Map<string, WAMessage>();
  const lookups: unknown[][] = [];
  let deletes = 0, pairingRequests = 0;
  const store: InstanceDependencies['store'] = {
    async saveMessages(instance, message) { stored.set(`${instance}/${message.key.id}`, message); },
    async saveManyMessages(instance, messages) { for (const message of messages) await store.saveMessages(instance, message); },
    async saveManyContacts() {}, async saveManyChats() {}, async deleteChats() {}, async deleteMessages() {},
    async getMessageById(id, instance, remoteJid) { lookups.push([id, instance, remoteJid]); return stored.get(`${instance}/${id}`); },
    async deleteByInstance() { deletes++; stored.clear(); return { count: 1 }; },
  };
  const instance = new Instance({
    loadAuth: async () => auth, store, reconnectDelayMs: 5, qrTimeoutMs: 100, qrLimit: 3,
    removeSession: async () => {},
    emit: async (event, info, data, history) => { assert.equal(info.owner, owner); webhooks.push({ event, data, ...(history ? { history } : {}) }); },
    makeSocket: config => {
      const ev = new EventEmitter();
      const socket = { ev, config, authState: config.auth, user: { id: '111@s.whatsapp.net' }, ended: 0,
        end() { socket.ended++; ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } }); },
        async profilePictureUrl() { return undefined; },
        async requestPairingCode() { pairingRequests++; return '12345678'; },
      };
      sockets.push(socket);
      if (options.initialQR) setImmediate(() => ev.emit('connection.update', { qr: 'fake-qr-data' }));
      return socket as any;
    },
    ...options.overrides,
  });
  t.after(async () => { await instance.shutdown(); delete instances[key]; delete instanceConnection[key]; instanceStatus.delete(key); });
  const flush = async () => { await (instance as any).eventTail; };
  const start = () => instance.create({ owner, instanceName: 'one' });
  return { instance, auth, sockets, webhooks, stored, lookups, store, key, owner, flush, start, deleted: () => deletes, pairingRequests: () => pairingRequests };
}

test('QR connect polling preserves socket and QR without duplicate events', async t => {
  const f = await fixture(t, { registered: false, initialQR: true });
  const result = await f.start();
  assert.match(result.qrCode!, /^data:image\/png;base64,/);
  const again = await f.instance.reconnect();
  assert.equal(again.qrCode, result.qrCode);
  assert.equal(f.sockets.length, 1);
  assert.equal(f.sockets[0].ended, 0);
  assert.equal(f.webhooks.filter(item => item.event === 'qrcode.updated').length, 1);
});

test('pairing code is requested once; QR limit stops networking without deleting history', async t => {
  const f = await fixture(t, { registered: false, initialQR: true });
  const result = await f.instance.create({ owner: f.owner, instanceName: 'one', phoneNumber: '5511999999999' });
  assert.equal(result.pairingCode, '12345678');
  for (let index = 0; index < 2; index++) {
    f.sockets[0].ev.emit('connection.update', { qr: 'next-qr' }); await f.flush();
  }
  assert.equal(f.pairingRequests(), 1);
  assert.equal(f.sockets[0].ended, 0);
  f.sockets[0].ev.emit('connection.update', { qr: 'limit-qr' }); await f.flush();
  assert.equal(f.sockets[0].ended, 1);
  assert.equal(f.deleted(), 0);
  assert.equal(f.webhooks.at(-1)?.event, 'pairingcode.limit');
});

test('duplicate close notifications create one replacement; shutdown cancels pending reconnect', async t => {
  const f = await fixture(t);
  await f.start();
  const closed = { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionClosed } } } };
  f.sockets[0].ev.emit('connection.update', closed);
  f.sockets[0].ev.emit('connection.update', closed);
  await f.flush();
  await sleep(20);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[0].ended, 1);
  assert.equal(f.webhooks.filter(item => item.event === 'connection.close').length, 1);
  f.sockets[1].ev.emit('connection.update', closed);
  await f.flush();
  await f.instance.shutdown();
  await sleep(20);
  assert.equal(f.sockets.length, 2);
});

test('shutdown waits for pending auth initialization and never opens its socket afterward', async t => {
  const ready = deferred<any>();
  const f = await fixture(t, { overrides: { loadAuth: () => ready.promise } });
  const starting = f.start();
  const stopping = f.instance.shutdown();
  let complete = false;
  void stopping.then(() => { complete = true; });
  await tick(); assert.equal(complete, false);
  ready.resolve(f.auth);
  await stopping; await starting;
  assert.equal(f.sockets.length, 0);
  assert.equal(complete, true);
});

test('shutdown drains accepted message writes and their durable webhook notifications', async t => {
  const f = await fixture(t);
  const release = deferred(); const entered = deferred();
  const original = f.store.saveManyMessages;
  let count = 0;
  f.store.saveManyMessages = async (key, messages) => { if (++count === 1) { entered.resolve(); await release.promise; } await original(key, messages); };
  await f.start();
  for (const id of ['one', 'two']) f.sockets[0].ev.emit('messages.upsert', { messages: [{ key: { id, remoteJid: '2@lid' }, message: { conversation: id } }], type: 'notify' });
  await entered.promise;
  let stopped = false;
  const stopping = f.instance.shutdown().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  release.resolve(); await stopping;
  assert.equal(f.stored.size, 2);
  assert.equal(f.webhooks.filter(item => item.event === 'messages.upsert').length, 2);
});

test('shutdown drains Signal reads and rejects late socket key writes without touching the repository', async t => {
  const f = await fixture(t); await f.start();
  const release = deferred<Record<string, Uint8Array>>(); const entered = deferred();
  let reads = 0, writes = 0;
  f.auth.state.keys.get = async () => { reads++; entered.resolve(); return release.promise as any; };
  f.auth.state.keys.set = async () => { writes++; };
  const keys = f.sockets[0].config.auth.keys;
  const reading = keys.get('session', ['uncached']);
  await entered.promise;
  let complete = false;
  const stopping = f.instance.shutdown().then(() => { complete = true; });
  await tick(); assert.equal(complete, false);
  release.resolve({}); await reading; await stopping;
  assert.equal(reads, 1);
  await assert.rejects(keys.set({ session: { late: Buffer.from([1]) } }), /stopped/);
  assert.equal(writes, 0);
  assert.equal(await f.sockets[0].config.getMessage({ id: 'late', remoteJid: '1@lid' }), undefined);
  assert.equal(f.lookups.length, 0);
});

test('getMessage is scoped, returns missing as undefined, and sent edit/revoke/media events retain content', async t => {
  const f = await fixture(t); await f.start();
  assert.equal(await f.instance.getMessage({ id: 'absent', remoteJid: '2@lid' }), undefined);
  assert.deepEqual(f.lookups[0], ['absent', f.key, '2@lid']);
  const image: WAMessage = { key: { id: 'image', remoteJid: '2@lid', remoteJidAlt: '1@s.whatsapp.net', fromMe: true }, message: { imageMessage: { mediaKey: Buffer.from([1, 2, 3]) } } };
  await f.instance.publishSentMessage(image);
  const restored = await f.instance.getMessage(image.key);
  assert.deepEqual(restored?.imageMessage?.mediaKey, Buffer.from([1, 2, 3]));
  assert.deepEqual(deserializeBaileys(f.webhooks[0]!.data)[0].message.imageMessage.mediaKey, Buffer.from([1, 2, 3]));
  for (const type of [proto.Message.ProtocolMessage.Type.REVOKE, proto.Message.ProtocolMessage.Type.MESSAGE_EDIT]) {
    const message: WAMessage = { key: { id: `protocol-${type}`, remoteJid: '2@lid', fromMe: true }, message: { protocolMessage: { type, key: image.key, editedMessage: { conversation: 'changed' } } } };
    await f.instance.publishSentMessage(message);
    assert.equal(f.webhooks.at(-1)!.data[0].message.protocolMessage.type, type);
    f.sockets[0].ev.emit('messages.upsert', { messages: [message], type: 'notify' });
    await f.flush();
    assert.equal(f.webhooks.at(-1)!.event, 'messages.upsert');
    assert.equal(f.webhooks.at(-1)!.data[0].message.protocolMessage.type, type);
  }
});

test('received and sent stickers, GIF playback and named locations survive persistence and webhook serialization', async t => {
  const f = await fixture(t); await f.start();
  const contents: NonNullable<WAMessage['message']>[] = [
    { stickerMessage: { mimetype: 'image/webp', isAnimated: true, mediaKey: Buffer.from([7, 8, 9]), directPath: '/sticker', width: 512, height: 512 } },
    { videoMessage: { mimetype: 'video/mp4', gifPlayback: true, caption: 'GIF', mediaKey: Buffer.from([4, 5, 6]), directPath: '/animation' } },
    { locationMessage: { degreesLatitude: -23.55052, degreesLongitude: -46.63331, name: 'Praça da Sé', address: 'São Paulo, Brasil' } },
    { liveLocationMessage: { degreesLatitude: 0, degreesLongitude: 0, caption: 'Localização em tempo real' } },
  ];
  for (const [index, content] of contents.entries()) {
    const incoming: WAMessage = { key: { id: `received-${index}`, remoteJid: '2@lid', fromMe: false }, message: content };
    f.sockets[0].ev.emit('messages.upsert', { messages: [incoming], type: 'notify' });
    await f.flush();
    assert.deepEqual(f.stored.get(`${f.key}/${incoming.key.id}`)?.message, content);
    const receivedEvent = f.webhooks.at(-1)!;
    assert.equal(receivedEvent.event, 'messages.upsert');
    assert.deepEqual(deserializeBaileys(receivedEvent.data)[0].message, content);
    assert.equal(receivedEvent.data[0].messageType, Object.keys(content)[0]);
    const outgoing = { ...incoming, key: { ...incoming.key, id: `sent-${index}`, fromMe: true } };
    await f.instance.publishSentMessage(outgoing);
    assert.deepEqual(deserializeBaileys(f.webhooks.at(-1)!.data)[0].message, content);
    assert.deepEqual({ ...await f.instance.getMessage(outgoing.key) }, content);
  }
});

test('logout resets credentials while history survives; explicit DELETE removes history', async t => {
  const f = await fixture(t); await f.start();
  await f.instance.publishSentMessage({ key: { id: 'keep', remoteJid: '2@lid' }, message: { conversation: 'history' } });
  f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await f.flush();
  assert.equal(f.auth.state.creds.registered, false);
  assert.equal(f.deleted(), 0);
  assert.equal(f.stored.size, 1);
  await sleep(15); assert.equal(f.sockets.length, 1);
  await f.instance.clearInstance();
  assert.equal(f.deleted(), 1);
  assert.equal(f.stored.size, 0);
  assert.equal(f.webhooks.at(-1)?.event, 'connection.removed');
});

test('event persistence failure disconnects and emits a redacted error notification', async t => {
  const f = await fixture(t); await f.start();
  f.store.saveManyMessages = async () => { throw new Error('database-secret-message-text'); };
  f.sockets[0].ev.emit('messages.upsert', { messages: [{ key: { id: 'fail', remoteJid: '2@lid' }, message: { conversation: 'private' } }], type: 'notify' });
  await f.flush();
  assert.equal(f.instance.getSock(), undefined);
  assert.deepEqual(f.webhooks.at(-1), { event: 'connection.error', data: { event: 'messages.upsert', error: 'EVENT_PROCESSING_FAILED' } });
  await sleep(15); assert.equal(f.sockets.length, 1);
});

test('group and device caches are isolated per instance', async t => {
  const a = await fixture(t), b = await fixture(t); await a.start(); await b.start();
  a.sockets[0].ev.emit('groups.upsert', [{ id: 'group@g.us', subject: 'Private A', participants: [] }]);
  await a.flush();
  assert.equal((await a.sockets[0].config.cachedGroupMetadata('group@g.us')).subject, 'Private A');
  assert.equal(await b.sockets[0].config.cachedGroupMetadata('group@g.us'), undefined);
  a.sockets[0].config.userDevicesCache.set('user', ['private-device']);
  assert.equal(b.sockets[0].config.userDevicesCache.get('user'), undefined);
});

test('history announces exact visible chunks before writes and waits for persistence plus enqueue', async t => {
  const f = await fixture(t); await f.start();
  const entered = deferred(), release = deferred();
  f.store.saveManyContacts = async () => { entered.resolve(); await release.promise; };
  const messages: WAMessage[] = Array.from({ length: 201 }, (_, id) => ({ key: { id: `history-${id}`, remoteJid: '2@lid' }, message: { conversation: String(id) } }));
  messages.push({ key: { id: 'internal', remoteJid: '2@lid' }, message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION } } });
  const contacts = Array.from({ length: 101 }, (_, id) => ({ id: `${id}@lid` }));
  f.sockets[0].ev.emit('messaging-history.set', { messages, contacts, chats: [{ id: '2@lid' }], syncType: 3, progress: 100, isLatest: true });
  await entered.promise;
  assert.deepEqual(f.webhooks.map(item => item.event), ['messaging-history.progress', 'messaging-history.progress']);
  assert.equal(f.webhooks[0]!.data.phase, 'receiving');
  assert.equal(f.webhooks[0]!.data.expectedChunks, 6);
  assert.deepEqual(f.webhooks[0]!.data.expected, { contacts: 101, chats: 1, messages: 201 });
  assert.equal(f.webhooks[1]!.data.phase, 'importing');
  release.resolve(); await f.flush();
  const chunks = f.webhooks.filter(item => item.history);
  assert.equal(chunks.length, 6);
  assert.equal(new Set(chunks.map(item => item.history!.batchId)).size, 1);
  assert.equal(new Set(chunks.map(item => item.history!.chunkId)).size, 6);
  assert.ok(chunks.every(item => Array.isArray(item.data) && item.data.length <= 100 && item.history!.runId === f.webhooks[0]!.data.runId));
  assert.equal(f.stored.size, 202, 'internal history remains available to getMessage');
  const progress = f.webhooks.at(-1)!.data;
  assert.equal(progress.phase, 'waiting');
  assert.equal(progress.processedBatches, 1);
  assert.equal(progress.expectedChunks, chunks.length);
  f.sockets[0].ev.emit('messaging-history.set', { messages: [], contacts: [], chats: [], syncType: 3, progress: 100 });
  await f.flush();
  assert.equal(f.webhooks.at(-1)!.data.expectedChunks, 6);
  assert.equal(f.webhooks.at(-1)!.data.processedBatches, 2, 'empty observed batches also finish');
});

test('history hooks ignore probes and only finish known downloads after matching imports', async t => {
  const f = await fixture(t); await f.start();
  const socket = f.sockets[0], recent = proto.HistorySync.HistorySyncType.RECENT;
  assert.equal(socket.config.shouldSyncHistoryMessage({ syncType: recent }), true);
  await f.flush(); assert.equal(f.webhooks.length, 0);
  socket.config.shouldSyncHistoryMessage({ syncType: recent, directPath: '/fake-history', progress: 100, chunkOrder: 1 });
  socket.ev.emit('messaging-history.status', { syncType: recent, status: 'complete', explicit: true });
  socket.ev.emit('connection.update', { receivedPendingNotifications: true });
  await f.flush();
  assert.ok(f.webhooks.every(item => item.data.phase === 'receiving'));
  socket.ev.emit('messaging-history.set', { messages: [], contacts: [], chats: [], syncType: recent, progress: 100, chunkOrder: 1, isLatest: true });
  await f.flush();
  assert.equal(f.webhooks.at(-1)!.data.phase, 'waiting');
  socket.ev.emit('messaging-history.status', { syncType: recent, status: 'paused', explicit: false });
  await f.flush(); assert.equal(f.webhooks.at(-1)!.data.phase, 'paused');
});

test('history import and oversized-payload failures publish errors without a successful terminal batch', async t => {
  for (const oversized of [false, true]) {
    const f = await fixture(t); await f.start();
    if (!oversized) f.store.saveManyMessages = async () => { throw new Error('private database details'); };
    f.sockets[0].ev.emit('messaging-history.set', { messages: [{ key: { id: 'failed', remoteJid: '2@lid' }, message: { conversation: oversized ? 'x'.repeat(900_001) : 'private text' } }], contacts: [], chats: [], syncType: 3, progress: 100 });
    await f.flush();
    const progress = f.webhooks.filter(item => item.event === 'messaging-history.progress');
    assert.equal(progress.at(-1)!.data.phase, 'error');
    assert.equal(progress.at(-1)!.data.error, 'HISTORY_PROCESSING_FAILED');
    assert.equal(progress.at(-1)!.data.processedBatches, 0);
    assert.ok(progress.every(item => item.data.phase !== 'waiting'));
    assert.equal(f.webhooks.filter(item => item.history).length, 0);
    assert.equal(f.instance.getSock(), undefined);
  }
});

test('outbox enqueue failure keeps the announced missing chunk visible', async t => {
  const captured: any[] = [];
  const f = await fixture(t, { overrides: { emit: async (event, _info, data, history) => {
    if (history) throw new Error('outbox unavailable');
    captured.push({ event, data });
  } } });
  await f.start();
  f.sockets[0].ev.emit('messaging-history.set', { messages: [], contacts: [{ id: '2@lid' }], chats: [], syncType: 3 });
  await f.flush();
  const progress = captured.filter(item => item.event === 'messaging-history.progress');
  assert.equal(progress.at(-1).data.expectedChunks, 1);
  assert.equal(progress.at(-1).data.processedBatches, 0);
  assert.equal(progress.at(-1).data.phase, 'error');
});

test('socket replacement interrupts the old run and rejects late history callbacks', async t => {
  const f = await fixture(t); await f.start();
  const old = f.sockets[0];
  old.ev.emit('connection.update', { connection: 'open' }); await f.flush();
  const oldRun = f.webhooks.at(-1)!.data.runId;
  old.ev.emit('connection.update', { connection: 'close' }); await f.flush();
  assert.equal(f.webhooks.at(-2)!.data.phase, 'interrupted');
  await sleep(20);
  const count = f.webhooks.length;
  old.config.shouldSyncHistoryMessage({ syncType: 3, directPath: '/late' });
  old.ev.emit('messaging-history.status', { syncType: 3, status: 'paused', explicit: false });
  await f.flush(); assert.equal(f.webhooks.length, count);
  f.sockets[1].ev.emit('connection.update', { connection: 'open' }); await f.flush();
  assert.notEqual(f.webhooks.at(-1)!.data.runId, oldRun);
  assert.equal(f.webhooks.at(-1)!.data.expectedChunks, 0);
});

test('resumed credentials identify a quiet reconnect without inventing an imported batch', async t => {
  const f = await fixture(t);
  f.auth.state.creds.accountSyncCounter = 1;
  await f.start();
  f.sockets[0].ev.emit('connection.update', { connection: 'open' }); await f.flush();
  const snapshot = f.webhooks.at(-1)!.data;
  assert.equal(snapshot.resumed, true);
  assert.equal(snapshot.phase, 'waiting');
  assert.equal(snapshot.processedBatches, 0);
  assert.equal(snapshot.expectedChunks, 0);
  assert.deepEqual(snapshot.expected, { contacts: 0, chats: 0, messages: 0 });
});
