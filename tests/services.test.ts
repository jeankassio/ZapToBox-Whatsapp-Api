import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep, setImmediate as tick } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { aesEncryptGCM, DisconnectReason, hkdf, proto, type WAMessage } from '@whiskeysockets/baileys';
import Instance, { type InstanceDependencies } from '../src/infra/baileys/services.js';
import { createPersistentAuth, type AuthRepository, type AuthEntry } from '../src/infra/state/auth-state.js';
import { instances, instanceConnection, instanceStatus } from '../src/shared/constants.js';
import { deserializeBaileys } from '../src/infra/mappers/messageMapper.js';
import type { HistoryChunkMetadata } from '../src/shared/types.js';
import { publicInstanceInfo } from '../src/shared/instance-info.js';

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
  const flush = async () => {
    await (instance as any).eventTail;
    // Recovery has an independent lifecycle/auth lane, including old accepted
    // writes which no longer block the next socket's event queue.
    while ((instance as any).eventTasks.size) await Promise.all([...(instance as any).eventTasks]);
  };
  const start = async () => { const result = await instance.create({ owner, instanceName: 'one' }); if (auth.state.creds.registered) instance.setStatus('ONLINE'); return result; };
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

test('temporary outages keep reconnecting past five attempts and terminal logout cancels retries', async t => {
  const f = await fixture(t, { overrides: { reconnectDelayMs: 1, reconnectMaxDelayMs: 1 } });
  await f.start();
  for (let attempt = 0; attempt < 7; attempt++) {
    f.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.connectionLost } } } });
    await f.flush();
    await sleep(10);
    assert.equal(f.sockets.length, attempt + 2, `retry ${attempt + 1} must create one replacement`);
  }
  f.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await f.flush();
  assert.equal(instanceStatus.get(f.key), 'ONLINE');
  f.sockets.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await f.flush(); await sleep(10);
  assert.equal(f.sockets.length, 8);
  assert.equal(instanceStatus.get(f.key), 'REMOVED');
  assert.equal(f.auth.state.creds.registered, false);
});

test('persisted history slices are delivered early and transport closure is visible during a slow import', async t => {
  const f = await fixture(t); await f.start();
  f.sockets[0].ev.emit('connection.update', { connection: 'open' }); await f.flush();
  const release = deferred(), entered = deferred();
  const save = f.store.saveManyMessages;
  let slices = 0;
  f.store.saveManyMessages = async (key, messages) => {
    if (++slices === 2) { entered.resolve(); await release.promise; }
    await save(key, messages);
  };
  const messages: WAMessage[] = Array.from({ length: 251 }, (_, id) => ({ key: { id: `slow-${id}`, remoteJid: '2@lid' }, message: { conversation: String(id) } }));
  f.sockets[0].ev.emit('messaging-history.set', { messages, chats: [], contacts: [], syncType: 3, progress: 100 });
  await entered.promise;
  assert.equal(f.stored.size, 100);
  assert.equal(f.webhooks.filter(item => item.event === 'messages.set').length, 1);
  assert.equal(f.webhooks.find(item => item.event === 'messages.set')!.data.length, 100);
  f.sockets[0].ev.emit('messaging-history.set', { messages: [{ key: { id: 'queued-after-import', remoteJid: '2@lid' }, message: { conversation: 'pending' } }], chats: [], contacts: [], syncType: 3, progress: 100 });
  f.sockets[0].ev.emit('connection.update', { connection: 'close' });
  assert.equal(instanceStatus.get(f.key), 'OFFLINE', 'status must not wait for the slow history write');
  assert.equal(f.webhooks.some(item => item.event === 'connection.close'), true, 'connection closure bypasses the slow history write');
  release.resolve(); await f.flush();
  assert.equal(f.stored.size, 200, 'only the first persisted slice and the already-running DB write survive');
  assert.equal([...f.stored.values()].some(message => message.key.id === 'queued-after-import'), false);
  assert.deepEqual(f.webhooks.filter(item => item.event === 'messages.set').map(item => item.data.length), [100]);
  assert.equal(f.webhooks.filter(item => item.event === 'connection.close').length, 1);
});

test('phone logout is immediately terminal and a queued open cannot revive it behind a slow import', async t => {
  const f = await fixture(t); await f.start();
  const release = deferred(), entered = deferred();
  t.after(() => release.resolve());
  const save = f.store.saveManyMessages;
  f.store.saveManyMessages = async (key, messages) => { entered.resolve(); await release.promise; await save(key, messages); };
  const socket = f.sockets[0];
  socket.ev.emit('messaging-history.set', { messages: [{ key: { id: 'before-logout', remoteJid: '2@lid' }, message: { conversation: 'Keep this history' } }], chats: [], contacts: [], syncType: 3, progress: 100 });
  await entered.promise;
  socket.ev.emit('connection.update', { connection: 'open' });
  const online = publicInstanceInfo(instanceConnection[f.key]!);
  assert.equal(online.connectionStatus, 'ONLINE');
  socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  const removed = publicInstanceInfo(instanceConnection[f.key]!);
  assert.equal(removed.connectionStatus, 'REMOVED', 'phone logout must be visible before any pending storage operation finishes');
  assert.equal(instanceStatus.get(f.key), 'REMOVED');
  assert.equal(f.webhooks.filter(item => item.event === 'connection.removed').length, 1, 'the phone logout notification does not wait for the slow import');
  assert.equal(f.instance.getSock(), undefined, 'network operations stop immediately');
  assert.ok(Date.parse(removed.connectionUpdatedAt!) > Date.parse(online.connectionUpdatedAt!));
  socket.ev.emit('connection.update', { connection: 'open' });
  assert.equal(instanceStatus.get(f.key), 'REMOVED', 'late events from the closed socket are ignored');
  release.resolve(); await f.flush();
  assert.equal(f.stored.size, 1, 'accepted history survives phone logout');
  assert.equal(f.webhooks.some(item => item.event === 'connection.open'), false);
  assert.equal(f.webhooks.filter(item => item.event === 'connection.removed').length, 1);
  assert.equal(f.auth.state.creds.registered, false);
  assert.equal(publicInstanceInfo(instanceConnection[f.key]!).connectionUpdatedAt, removed.connectionUpdatedAt, 'the event queue cannot move the lifecycle timestamp to its delayed delivery time');
  assert.equal(instanceStatus.get(f.key), 'REMOVED');
  assert.equal(f.deleted(), 0);
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

test('renewed media metadata is persisted without announcing a message edit', async t => {
  const f = await fixture(t); await f.start();
  const key = { id: 'renewed-metadata', remoteJid: '222@s.whatsapp.net' };
  await f.store.saveMessages(f.key, { key, message: { imageMessage: { caption: 'Legenda original', directPath: '/old' } } });
  f.sockets[0].ev.emit('messages.update', [{ key, update: { mediaMetadataOnly: true, message: { imageMessage: { caption: 'Legenda original', directPath: '/new' } } } }]);
  await f.flush();
  assert.equal(f.stored.get(`${f.key}/${key.id}`)?.message?.imageMessage?.directPath, '/new');
  assert.equal(f.webhooks.filter(event => event.event === 'messages.update').length, 0);
  f.sockets[0].ev.emit('messages.update', [{ key, update: { status: 4 } }]); await f.flush();
  assert.equal(f.webhooks.filter(event => event.event === 'messages.update').length, 1);
});

test('encrypted media renewal failures never announce available media or forward encrypted transport data', async t => {
  const f = await fixture(t); await f.start();
  const stored: WAMessage = { key: { id: 'old-media', remoteJid: '2@lid' }, message: { imageMessage: { mediaKey: Buffer.alloc(32, 1), url: 'https://mmg.whatsapp.net/old' } } };
  f.stored.set(`${f.key}/old-media`, stored);
  const key = hkdf(stored.message!.imageMessage!.mediaKey!, 32, { info: 'WhatsApp Media Retry Notification' });
  for (const success of [false, true]) {
    const iv = Buffer.alloc(12, success ? 1 : 2);
    const plaintext = proto.MediaRetryNotification.encode({ result: success ? proto.MediaRetryNotification.ResultType.SUCCESS : proto.MediaRetryNotification.ResultType.NOT_FOUND, directPath: '/v/renewed' }).finish();
    const ciphertext = aesEncryptGCM(plaintext, key, iv, Buffer.from(stored.key.id!));
    f.sockets[0].ev.emit('messages.media-update', [{ key: stored.key, media: { ciphertext, iv } }]); await f.flush();
    const event = f.webhooks.at(-1)!;
    assert.equal(event.event, 'messages.media-update');
    assert.deepEqual(event.data, [{ key: stored.key, ...(!success ? { error: { code: 'MEDIA_UNAVAILABLE' } } : {}) }]);
    assert.doesNotMatch(JSON.stringify(event.data), /ciphertext|mediaKey/);
  }
});

test('owner disconnect revokes only its device, preserves history and permits pairing another number', async t => {
  const a = await fixture(t), b = await fixture(t);
  await a.start(); await b.start();
  a.sockets[0].ev.emit('connection.update', { connection: 'open' });
  b.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await a.flush(); await b.flush();
  await a.instance.publishSentMessage({ key: { id: 'keep', remoteJid: '2@lid' }, message: { conversation: 'history' } });
  let logouts = 0;
  a.sockets[0].logout = async () => { logouts++; a.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } }); };
  const result = await a.instance.disconnect();
  assert.equal(result.instance.connectionStatus, 'REMOVED'); assert.equal(result.instance.instanceJid, null);
  assert.equal(result.instance.profilePictureUrl, undefined); assert.equal(logouts, 1);
  assert.equal(a.auth.state.creds.registered, false); assert.equal(a.stored.size, 1); assert.equal(a.deleted(), 0);
  assert.equal(b.auth.state.creds.registered, true); assert.equal(b.sockets[0].ended, 0); assert.equal(instanceStatus.get(b.key), 'ONLINE');
  await a.instance.disconnect(); assert.equal(logouts, 1, 'replaying disconnect must not send another remote logout');
  const pairing = a.instance.reconnect();
  await tick();
  a.sockets[1].ev.emit('connection.update', { qr: 'new-number-qr' });
  assert.match((await pairing).qrCode!, /^data:image\/png;base64,/);
  assert.equal(a.stored.size, 1); assert.equal(a.sockets.length, 2);
});

test('failed or offline logout preserves credentials instead of claiming a successful remote disconnect', async t => {
  const f = await fixture(t); await f.start();
  f.instance.setStatus('OFFLINE');
  await assert.rejects(f.instance.disconnect(), (error: any) => error.statusCode === 409);
  assert.equal(f.auth.state.creds.registered, true);
  f.sockets[0].ev.emit('connection.update', { connection: 'open' }); await f.flush();
  f.sockets[0].logout = async () => { throw new Error('private transport detail'); };
  await assert.rejects(f.instance.disconnect(), (error: any) => error.statusCode === 502 && !error.message.includes('private'));
  assert.equal(f.auth.state.creds.registered, true); assert.equal(f.sockets[0].ended, 0);
});

test('event persistence failure emits a redacted notification and recovers without revoking the device', async t => {
  const f = await fixture(t); await f.start();
  f.store.saveManyMessages = async () => { throw new Error('database-secret-message-text'); };
  f.sockets[0].ev.emit('messages.upsert', { messages: [{ key: { id: 'fail', remoteJid: '2@lid' }, message: { conversation: 'private' } }], type: 'notify' });
  await f.flush();
  assert.equal(f.instance.getSock(), undefined);
  assert.deepEqual(f.webhooks.at(-1), { event: 'connection.error', data: { event: 'messages.upsert', error: 'EVENT_PROCESSING_FAILED' } });
  assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
  assert.equal(f.auth.state.creds.registered, true);
  await sleep(15); assert.equal(f.sockets.length, 2);
  f.store.saveManyMessages = async () => {};
  f.sockets[1].ev.emit('connection.update', { connection: 'open' }); await f.flush();
  assert.equal(instanceStatus.get(f.key), 'ONLINE');
  assert.equal(instanceConnection[f.key]!.connectionState, 'connected');
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
  assert.equal(f.webhooks.at(-1)!.data.phase, 'interrupted');
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

test('bad-session and restart-required responses retain credentials and retry instead of inventing a logout', async t => {
  for (const reason of [DisconnectReason.badSession, DisconnectReason.restartRequired]) {
    const f = await fixture(t); await f.start();
    const identity = Buffer.from(f.auth.state.creds.noiseKey.private);
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: reason } } } });
    assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
    await f.flush(); await sleep(15);
    assert.equal(f.sockets.length, 2);
    assert.equal(f.auth.state.creds.registered, true);
    assert.deepEqual(f.auth.state.creds.noiseKey.private, identity);
    assert.equal(f.webhooks.some(event => event.event === 'connection.removed'), false);
  }
});

test('replacement or refusal stops automatic retry while retaining authentication for explicit recovery', async t => {
  for (const reason of [DisconnectReason.connectionReplaced, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch]) {
    const f = await fixture(t); await f.start();
    const identity = Buffer.from(f.auth.state.creds.noiseKey.private);
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: reason } } } });
    await f.flush(); await sleep(15);
    assert.equal(f.sockets.length, 1);
    assert.equal(instanceStatus.get(f.key), 'OFFLINE');
    assert.equal(instanceConnection[f.key]!.connectionState, 'disconnected');
    assert.equal(f.auth.state.creds.registered, true);
    assert.deepEqual(f.auth.state.creds.noiseKey.private, identity);
    assert.equal(f.webhooks.some(event => event.event === 'connection.removed'), false);
    await f.instance.reconnect();
    assert.equal(f.sockets.length, 2);
    assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
  }
});

test('a slow old history write cannot delay recovery or close a replacement when it later fails', async t => {
  const f = await fixture(t); await f.start();
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const save = f.store.saveManyMessages;
  f.store.saveManyMessages = async (key, messages) => {
    if (messages[0]?.key.id === 'old-failure') { entered.resolve(); await release.promise; throw new Error('old storage error'); }
    await save(key, messages);
  };
  const old = f.sockets[0];
  old.ev.emit('messaging-history.set', { messages: [{ key: { id: 'old-failure', remoteJid: '2@lid' }, message: { conversation: 'old' } }], chats: [], contacts: [], syncType: 3 });
  await entered.promise;
  old.ev.emit('connection.update', { connection: 'close' });
  assert.equal(old.config.shouldSyncHistoryMessage({ syncType: 3, directPath: '/stale' }), false);
  await sleep(15);
  assert.equal(f.sockets.length, 2, 'socket replacement must not wait for the blocked history write');
  const fresh = f.sockets[1];
  fresh.ev.emit('connection.update', { connection: 'open' });
  fresh.ev.emit('messages.upsert', { messages: [{ key: { id: 'fresh', remoteJid: '2@lid' }, message: { conversation: 'new' } }], type: 'notify' });
  await (f.instance as any).eventTail;
  assert.equal(f.stored.has(`${f.key}/fresh`), true);
  release.resolve(); await f.flush();
  assert.equal(f.instance.getSock(), fresh);
  assert.equal(fresh.ended, 0);
  assert.equal(instanceStatus.get(f.key), 'ONLINE');
  assert.equal(f.webhooks.filter(event => event.event === 'connection.error').length, 0, 'an obsolete failure cannot announce the new socket offline');
});

test('credentials persist outside the history queue and replacement waits for pending authentication writes', async t => {
  const f = await fixture(t); await f.start();
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const save = f.auth.saveCreds;
  let writes = 0;
  f.auth.saveCreds = async () => { if (++writes === 1) { entered.resolve(); await release.promise; } await save(); };
  f.sockets[0].ev.emit('creds.update', {});
  await entered.promise;
  f.sockets[0].ev.emit('connection.update', { connection: 'close' });
  await sleep(15);
  assert.equal(f.sockets.length, 1, 'Signal credentials cannot be reused before their prior writes settle');
  release.resolve(); await f.flush(); await sleep(15);
  assert.equal(f.sockets.length, 2);
  assert.equal(writes, 2, 'the replacement confirms current credentials were saved');
  assert.equal(f.auth.state.creds.registered, true);
});

test('an old message-update lookup cannot overwrite a newer edit after socket replacement', async t => {
  const f = await fixture(t); await f.start();
  const key = { id: 'edited', remoteJid: '2@lid' };
  await f.store.saveMessages(f.key, { key, message: { conversation: 'original' } });
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const lookup = f.store.getMessageById;
  let count = 0;
  f.store.getMessageById = async (...args) => {
    const snapshot = await lookup(...args);
    if (++count === 1) { entered.resolve(); await release.promise; }
    return snapshot;
  };
  f.sockets[0].ev.emit('messages.update', [{ key, update: { message: { conversation: 'old edit' } } }]);
  await entered.promise;
  f.sockets[0].ev.emit('connection.update', { connection: 'close' });
  await sleep(15);
  f.sockets[1].ev.emit('connection.update', { connection: 'open' });
  f.sockets[1].ev.emit('messages.update', [{ key, update: { message: { conversation: 'new edit' } } }]);
  await (f.instance as any).eventTail;
  assert.equal(f.stored.get(`${f.key}/edited`)!.message!.conversation, 'new edit');
  release.resolve(); await f.flush();
  assert.equal(f.stored.get(`${f.key}/edited`)!.message!.conversation, 'new edit');
  assert.equal(f.webhooks.filter(event => event.event === 'messages.update').length, 1);
});

test('initial auth/setup failures retry without requiring another manual connect', async t => {
  let loads = 0;
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, { overrides: { loadAuth: async () => { if (++loads === 1) throw new Error('storage temporarily unavailable'); return f.auth; } } });
  const result = await f.instance.create({ owner: f.owner, instanceName: 'one' });
  assert.equal(result.instance.connectionState, 'reconnecting');
  assert.equal(f.sockets.length, 0);
  await sleep(15);
  assert.equal(f.sockets.length, 1);
  assert.equal(loads, 2);
  assert.equal(f.auth.state.creds.registered, true);
});

test('a blocked message lookup is drained on shutdown but does not block the next authenticated socket', async t => {
  const f = await fixture(t); await f.start();
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  f.store.getMessageById = async () => { entered.resolve(); await release.promise; return undefined; };
  const lookup = f.sockets[0].config.getMessage({ id: 'old-lookup', remoteJid: '2@lid' });
  await entered.promise;
  f.sockets[0].ev.emit('connection.update', { connection: 'close' });
  await sleep(15);
  assert.equal(f.sockets.length, 2);
  let stopped = false;
  const shutdown = f.instance.shutdown().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  release.resolve(); await lookup; await shutdown;
  assert.equal(stopped, true);
});

test('failed credentials persistence prevents reopening until storage recovers', async t => {
  const f = await fixture(t, { overrides: { reconnectDelayMs: 1, reconnectMaxDelayMs: 1 } }); await f.start();
  const save = f.auth.saveCreds;
  f.auth.saveCreds = async () => { throw new Error('credentials storage unavailable'); };
  f.sockets[0].ev.emit('creds.update', {}); await f.flush();
  await sleep(15);
  assert.equal(f.sockets.length, 1);
  assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
  assert.equal(f.auth.state.creds.registered, true);
  f.auth.saveCreds = save;
  await sleep(15);
  assert.equal(f.sockets.length, 2);
});

test('rapid open-failure loops keep exponential backoff until a connection has been stable', async t => {
  const f = await fixture(t, { overrides: { reconnectDelayMs: 1, reconnectMaxDelayMs: 1, random: () => 1 } }); await f.start();
  for (let index = 0; index < 3; index++) {
    const current = f.sockets.at(-1);
    current.ev.emit('connection.update', { connection: 'open' }); await f.flush();
    current.ev.emit('connection.update', { connection: 'close' }); await f.flush(); await sleep(10);
    assert.equal((f.instance as any).reconnectAttempts, index + 1);
  }
  f.sockets.at(-1).ev.emit('connection.update', { connection: 'open' }); await f.flush();
  (f.instance as any).connectedAt = Date.now() - 61_000;
  f.sockets.at(-1).ev.emit('connection.update', { connection: 'close' }); await f.flush();
  assert.equal((f.instance as any).reconnectAttempts, 1);
});

test('natural history is marked active before it can wait behind another event', async t => {
  const f = await fixture(t);
  f.auth.state.creds.accountSyncCounter = 1;
  await f.start();
  assert.equal(f.instance.getHistoryActivity()?.active, false);
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const save = f.store.saveManyMessages;
  f.store.saveManyMessages = async (key, messages) => {
    if (messages[0]?.key.id === 'blocker') { entered.resolve(); await release.promise; }
    await save(key, messages);
  };
  const socket = f.sockets[0];
  socket.ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'blocker', remoteJid: '2@lid' }, message: { conversation: 'live' } }] });
  await entered.promise;
  socket.config.shouldSyncHistoryMessage({ syncType: 3, progress: 100, directPath: '/history' });
  assert.equal(f.instance.getHistoryActivity()?.active, true, 'a newly observed download immediately prevents another manual rescan');
  socket.ev.emit('messaging-history.set', { messages: [], contacts: [], chats: [], syncType: 3, progress: 100 });
  release.resolve(); await f.flush();
  assert.equal(f.instance.getHistoryActivity()?.active, false);
  assert.equal(f.webhooks.at(-1)!.data.active, false);
});
