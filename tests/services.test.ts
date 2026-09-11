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
import Sessions from '../src/infra/state/sessions.js';
import { groupSpaceRevision } from '../src/infra/baileys/sections-state.js';
import { ContactMapper, mergeContactNames } from '../src/infra/mappers/contactMapper.js';

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
async function fixture(t: any, options: { registered?: boolean; qrLinked?: boolean; overrides?: Partial<InstanceDependencies>; initialQR?: boolean } = {}) {
  const owner = `qa_${randomUUID()}`;
  const key = `${owner}/one`;
  const authRepository = memoryAuth();
  const auth = await createPersistentAuth(authRepository);
  auth.state.creds.registered = options.registered ?? true;
  if (options.qrLinked) Object.assign(auth.state.creds, {
    registered: false, me: { id: '111:7@s.whatsapp.net', name: 'QR fixture' }, account: { details: Buffer.from([1]) },
  });
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
  return { instance, auth, authRepository, sockets, webhooks, stored, lookups, store, key, owner, flush, start, deleted: () => deletes, pairingRequests: () => pairingRequests };
}

test('presence caches and publishes at receipt time while history storage is blocked, then clears on shutdown', async t => {
  const f = await fixture(t); await f.start(); const entered = deferred(), release = deferred();
  f.store.saveManyMessages = async () => { entered.resolve(); await release.promise; };
  f.sockets[0].ev.emit('messaging-history.set', { messages: [{ key: { id: 'history', remoteJid: '5511999999999@s.whatsapp.net' }, message: { conversation: 'old' } }], chats: [], contacts: [], isLatest: false });
  await entered.promise;
  const id = '5511999999999@s.whatsapp.net', lastSeen = Math.floor(Date.now() / 1000) - 50;
  f.sockets[0].ev.emit('presence.update', { id: id.replace('@', ':7@'), presences: { [id]: { lastKnownPresence: 'unavailable', lastSeen } } });
  const snapshot = f.instance.getPresence(id);
  assert.equal(snapshot.presences[id]?.lastSeen, lastSeen); assert.ok(snapshot.observedAt);
  await tick();
  assert.deepEqual(f.webhooks.find(item => item.event === 'presence.update')!.data, snapshot, 'presence must not wait behind a history batch');
  release.resolve(); await f.flush(); await f.instance.shutdown();
  assert.equal(f.instance.getPresence(id).observedAt, null);
  f.sockets[0].ev.emit('presence.update', { id, presences: { [id]: { lastKnownPresence: 'available' } } });
  assert.equal(f.instance.getPresence(id).observedAt, null);
});

test('presence subscribe correlates stored Signal PN/LID aliases, deduplicates calls and never changes own presence', async t => {
  const f = await fixture(t); await f.start();
  const id = '5511999999999@s.whatsapp.net', lid = '123456789012345@lid'; let calls = 0;
  await f.auth.state.keys.set({ 'lid-mapping': { '5511999999999': '123456789012345', '123456789012345_reverse': '5511999999999' } });
  f.sockets[0].presenceSubscribe = async (jid: string) => { assert.equal(jid, id); calls++; f.sockets[0].ev.emit('presence.update', { id: lid, presences: { [lid]: { lastKnownPresence: 'composing' } } }); };
  f.sockets[0].sendPresenceUpdate = async () => { throw new Error('Own presence must not change'); };
  const [first, second] = await Promise.all([f.instance.subscribePresence(id, f.sockets[0]), f.instance.subscribePresence(id, f.sockets[0])]);
  assert.equal(calls, 1); assert.deepEqual(first, second); assert.equal(first.id, id); assert.deepEqual(first.presences, { [id]: { lastKnownPresence: 'composing' } });
  await f.instance.subscribePresence(id, f.sockets[0]); assert.equal(calls, 1);
  await f.flush(); assert.deepEqual(f.webhooks.find(item => item.event === 'presence.update')!.data, first);
  await f.instance.shutdown(); await assert.rejects(f.instance.subscribePresence(id, f.sockets[0]), (error: any) => error.statusCode === 409);
});

test('acknowledged contact edits persist and publish canonical names independently of provider echoes', async t => {
  const f = await fixture(t); await f.start();
  const id = '5511999999999@s.whatsapp.net';
  let row: any;
  f.store.saveManyContacts = async (_key, contacts) => contacts.map(contact => {
    row = { jid: id, ...mergeContactNames(row ? [row] : [], contact) };
    return ContactMapper.event(row, contact);
  });
  f.sockets[0].ev.emit('contacts.upsert', [{ id, name: 'Novo', notify: 'Perfil' }]);
  await f.flush();
  const echoedAt = f.webhooks.find(item => item.event === 'contacts.upsert')!.data[0].savedNameUpdatedAt;
  const contact = await f.instance.publishContact({ id, name: 'Novo', savedName: 'Novo', savedNameUpdatedAt: echoedAt }, f.sockets[0]);
  assert.equal(contact.name, 'Novo'); assert.equal(contact.notify, 'Perfil');
  assert.ok(contact.savedNameUpdatedAt! > echoedAt, 'explicit ACK observation advances past an earlier provider echo');
  assert.deepEqual(f.webhooks.filter(item => item.event === 'contacts.upsert').at(-1)!.data, [contact]);
  f.sockets[0].ev.emit('contacts.update', [{ id, notify: 'Perfil novo' }]); await f.flush();
  assert.equal(row.name, 'Novo'); assert.equal(row.nameMetadata.savedNameUpdatedAt, contact.savedNameUpdatedAt);
});

test('contact publication rejects old sockets and shutdown drains an accepted contact write', async t => {
  const f = await fixture(t); await f.start();
  const write = deferred(), started = deferred(); let calls = 0;
  f.store.saveManyContacts = async (_key, contacts) => { calls++; started.resolve(); await write.promise; return contacts; };
  await assert.rejects(f.instance.publishContact({ id: '5511999999999@s.whatsapp.net', name: 'Novo' }, {} as any));
  assert.equal(calls, 0);
  const publish = f.instance.publishContact({ id: '5511999999999@s.whatsapp.net', name: 'Novo' }, f.sockets[0]);
  const rejected = assert.rejects(publish, /connection changed/); await started.promise;
  let stopped = false; const shutdown = f.instance.shutdown().then(() => { stopped = true; });
  await tick(); assert.equal(stopped, false);
  write.resolve(); await rejected; await shutdown;
  assert.equal(f.webhooks.some(item => item.event === 'contacts.upsert'), false, 'old socket publication cannot leak into a new lifecycle');
});

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

test('history names and live profile updates publish the merged saved name with its original observation time', async t => {
  const f = await fixture(t); await f.start();
  const contacts = new Map<string, any>();
  f.store.saveManyContacts = async (_instance, rows) => rows.map(row => {
    const saved = { jid: row.id, ...mergeContactNames(contacts.has(row.id!) ? [contacts.get(row.id!)] : [], row) };
    contacts.set(row.id!, saved); return ContactMapper.event(saved, row);
  });
  const id = '5511999999999@s.whatsapp.net';
  f.sockets[0].ev.emit('messaging-history.set', { contacts: [{ id, name: 'Dentista' }], chats: [], messages: [], isLatest: true });
  await f.flush();
  const historical = f.webhooks.find(event => event.event === 'contacts.set')!.data[0];
  assert.equal(historical.savedName, 'Dentista'); assert.ok(Date.parse(historical.savedNameUpdatedAt));
  f.sockets[0].ev.emit('contacts.update', [{ id, notify: 'Maria', verifiedName: 'Clínica' }]);
  await f.flush();
  const live = f.webhooks.find(event => event.event === 'contacts.update')!.data[0];
  assert.equal(live.name, 'Dentista'); assert.equal(live.notify, 'Maria'); assert.equal(live.savedNameUpdatedAt, historical.savedNameUpdatedAt);
  f.sockets[0].ev.emit('contacts.update', [{ id, name: '' }]);
  await f.flush();
  const removed = f.webhooks.filter(event => event.event === 'contacts.update').at(-1)!.data[0];
  assert.equal(removed.savedName, null); assert.equal(removed.name, null); assert.ok(removed.savedNameUpdatedAt > historical.savedNameUpdatedAt);
});

test('community events persist parent and announcement metadata while status and channel messages keep their exact JIDs', async t => {
  const f = await fixture(t); await f.start();
  const chats: any[] = [];
  f.store.saveManyChats = async (_instance, records) => { chats.push(...records); };
  f.sockets[0].ev.emit('groups.upsert', [{ id: '120363123450000@g.us', subject: 'Community', isCommunity: true, participants: [] }]);
  f.sockets[0].ev.emit('groups.update', [{ id: '120363123450001@g.us', subject: 'Announcements', linkedParent: '120363123450000@g.us', isCommunityAnnounce: true }]);
  for (const [id, remoteJid] of [['status-message', 'status@broadcast'], ['channel-message', '120363123456789@newsletter']]) {
    f.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id, remoteJid, participant: '5511999999999@s.whatsapp.net' }, message: { conversation: 'Real provider content' }, messageTimestamp: Math.floor(Date.now() / 1000) }] });
  }
  await f.flush();
  assert.equal(chats[0].isCommunity, true); assert.equal(chats[1].linkedParent, chats[0].id); assert.equal(chats[1].isCommunityAnnounce, true);
  assert.equal(f.stored.get(`${f.key}/status-message`)?.key.remoteJid, 'status@broadcast');
  assert.equal(f.stored.get(`${f.key}/channel-message`)?.key.remoteJid, '120363123456789@newsletter');
  assert.equal(f.webhooks.find(row => row.event === 'groups.update')?.data[0].isCommunityAnnounce, true);
});

test('full group events clear membership but a partial rename preserves omitted metadata', async t => {
  const f = await fixture(t); await f.start(); const chats: any[] = [];
  f.store.saveManyChats = async (_instance, records) => { chats.push(...records); };
  const id = '120363123450001@g.us';
  f.sockets[0].ev.emit('groups.update', [{ id, subject: 'Renamed' }]);
  assert.equal(groupSpaceRevision(f.sockets[0], f.key), 1);
  await f.flush();
  assert.equal(Object.hasOwn(chats[0], 'linkedParent'), false);
  assert.equal(Object.hasOwn(f.webhooks.find(row => row.event === 'groups.update')!.data[0], 'linkedParent'), false);
  f.sockets[0].ev.emit('groups.update', [{ id, subject: 'Unlinked', participants: [], isCommunity: false, isCommunityAnnounce: false, announce: false, linkedParent: undefined }]);
  await f.flush();
  assert.equal(chats[1].linkedParent, null); assert.equal(chats[1].isCommunity, false);
  assert.equal(f.webhooks.filter(row => row.event === 'groups.update').at(-1)!.data[0].linkedParent, null);
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

test('message webhooks distinguish live, offline, recovery and synchronized history without fetching media', async t => {
  const f = await fixture(t); await f.start();
  const image = (id: string): WAMessage => ({ key: { id, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false }, message: { imageMessage: { mediaKey: Buffer.from([1, 2, 3]), directPath: '/encrypted-image' } } });
  f.sockets[0].ev.emit('messaging-history.set', { messages: [image('history')], contacts: [], chats: [], isLatest: false });
  for (const [id, type, requestId] of [['live', 'notify', undefined], ['offline', 'append', undefined], ['recovery', 'notify', 'phone-request']] as const) {
    f.sockets[0].ev.emit('messages.upsert', { type, requestId, messages: [image(id)] });
  }
  await f.flush();
  const received = f.webhooks.filter(item => item.event === 'messages.set' || item.event === 'messages.upsert').flatMap(item => item.data);
  assert.deepEqual(received.map(item => [item.key.id, item.messageSource]), [['history', 'history'], ['live', 'live'], ['offline', 'offline'], ['recovery', 'recovery']]);
  assert.equal(f.lookups.length, 0);
  for (const item of received) assert.equal(item.message.imageMessage.directPath, '/encrypted-image');
  await f.instance.publishSentMessage({ ...image('sent'), key: { ...image('sent').key, fromMe: true } });
  assert.equal(f.webhooks.at(-1)!.data[0].messageSource, 'sent');
});

test('an event queued before connection opening cannot acquire live provenance while waiting for storage', async t => {
  const f = await fixture(t); await f.start();
  f.instance.setStatus('OFFLINE');
  f.sockets[0].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'before-open', remoteJid: '5511999999999@s.whatsapp.net' }, message: { conversation: 'pending' } }] });
  f.sockets[0].ev.emit('connection.update', { connection: 'open' });
  await f.flush();
  assert.equal(f.webhooks.find(item => item.event === 'messages.upsert')!.data[0].messageSource, 'unknown');
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

test('replacement or refusal recovers automatically after cooldown while retaining authentication', async t => {
  for (const reason of [DisconnectReason.connectionReplaced, DisconnectReason.forbidden, DisconnectReason.multideviceMismatch]) {
    const f = await fixture(t, { overrides: { conflictRetryDelayMs: 60, refusalRetryDelayMs: 60 } }); await f.start();
    const identity = Buffer.from(f.auth.state.creds.noiseKey.private);
    f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: reason } } } });
    await f.flush(); await sleep(15);
    assert.equal(f.sockets.length, 1);
    assert.equal(instanceStatus.get(f.key), 'OFFLINE');
    assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
    assert.equal(f.auth.state.creds.registered, true);
    assert.deepEqual(f.auth.state.creds.noiseKey.private, identity);
    assert.equal(f.webhooks.some(event => event.event === 'connection.removed'), false);
    await f.instance.reconnect();
    assert.equal(f.sockets.length, 1, 'panel polling must respect the cooldown');
    await sleep(80);
    assert.equal(f.sockets.length, 2);
    assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
    f.sockets[1].ev.emit('connection.update', { connection: 'open' }); await f.flush();
    assert.equal(instanceStatus.get(f.key), 'ONLINE');
    assert.deepEqual(f.auth.state.creds.noiseKey.private, identity);
  }
});

test('session supervision replaces a silently closed socket without panel activity or a new QR', async t => {
  const f = await fixture(t); await f.start();
  const supervisor = new Sessions({ discoverFiles: async () => [], useDatabase: () => false, healthIntervalMs: 5 });
  t.after(() => supervisor.shutdown());
  await supervisor.start();
  const old = f.sockets[0]; old.ws = { isOpen: true };
  old.ev.emit('connection.update', { connection: 'open' }); await f.flush();
  await sleep(20); assert.equal(f.sockets.length, 1, 'quiet healthy connections stay open');
  old.ws.isOpen = false; // No connection.update arrives.
  for (let attempt = 0; attempt < 100 && f.sockets.length < 2; attempt++) await sleep(5);
  assert.equal(f.sockets.length, 2);
  assert.equal(old.ended, 1);
  assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
  assert.equal(f.auth.state.creds.registered, true);
  assert.equal(f.deleted(), 0);
  f.sockets[1].ev.emit('connection.update', { connection: 'open' }); await f.flush();
  assert.equal(instanceStatus.get(f.key), 'ONLINE');
  assert.equal(f.webhooks.some(item => /qrcode|connection.removed/.test(item.event)), false);
  await supervisor.shutdown(); await sleep(20);
  assert.equal(f.sockets.length, 2, 'shutdown cancels supervision and retries');
});

test('registered login stuck before connection.open is replaced after the handshake deadline', async t => {
  const f = await fixture(t); await f.instance.create({ owner: f.owner, instanceName: 'one' });
  f.sockets[0].ws = { isOpen: true };
  f.instance.checkHealth();
  assert.equal(f.sockets[0].ended, 0, 'a new handshake receives time to authenticate');
  f.instance.checkHealth(Date.now() + 120_001);
  await sleep(20);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.auth.state.creds.registered, true);
  assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
});

test('QR-linked sessions are supervised and reconnect without changing the provider registered flag', async t => {
  const f = await fixture(t, { qrLinked: true });
  const identity = Buffer.from(f.auth.state.creds.noiseKey.private);
  const result = await f.instance.create({ owner: f.owner, instanceName: 'one' });
  assert.equal(result.instance.connectionState, 'reconnecting');
  assert.equal(result.qrCode, undefined);
  assert.equal(f.auth.state.creds.registered, false);
  assert.ok((await createPersistentAuth(f.authRepository)).state.creds.account, 'QR credentials are persisted before opening the socket');
  f.sockets[0].ev.emit('connection.update', { connection: 'connecting' }); await f.flush();
  assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
  f.instance.checkHealth(Date.now() + 120_001);
  for (let attempt = 0; attempt < 100 && f.sockets.length < 2; attempt++) await sleep(5);
  assert.equal(f.sockets.length, 2, 'a stalled QR login retries automatically');
  const connected = f.sockets[1]; connected.ws = { isOpen: true };
  connected.ev.emit('connection.update', { connection: 'open' }); await f.flush();
  connected.ws.isOpen = false;
  f.instance.checkHealth();
  for (let attempt = 0; attempt < 100 && f.sockets.length < 3; attempt++) await sleep(5);
  assert.equal(f.sockets.length, 3, 'a silently closed QR socket retries automatically');
  assert.deepEqual(f.auth.state.creds.noiseKey.private, identity);
  assert.equal(f.auth.state.creds.registered, false);
  assert.equal(f.webhooks.some(item => /qrcode|connection.removed/.test(item.event)), false);
  f.sockets[2].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await f.flush(); f.instance.checkHealth(Date.now() + 300_000); await sleep(20);
  assert.equal(f.sockets.length, 3, 'phone revocation still cancels QR session recovery');
  assert.equal(f.auth.state.creds.me, undefined); assert.equal(f.auth.state.creds.account, undefined);
  assert.equal(f.deleted(), 0);
});

test('QR-linked disconnect requires a successful remote logout before clearing the signed identity', async t => {
  const f = await fixture(t, { qrLinked: true });
  await f.instance.create({ owner: f.owner, instanceName: 'one' });
  await assert.rejects(f.instance.disconnect(), (error: any) => error.statusCode === 409);
  assert.ok(f.auth.state.creds.account);
  const socket = f.sockets[0];
  socket.ev.emit('connection.update', { connection: 'open' }); await f.flush();
  socket.logout = async () => { throw new Error('Temporary failure'); };
  await assert.rejects(f.instance.disconnect(), (error: any) => error.statusCode === 502);
  assert.ok(f.auth.state.creds.account); assert.equal(socket.ended, 0);
  let logouts = 0;
  socket.logout = async () => { logouts++; };
  const result = await f.instance.disconnect();
  assert.equal(logouts, 1); assert.equal(result.instance.connectionStatus, 'REMOVED');
  assert.equal(f.auth.state.creds.me, undefined); assert.equal(f.auth.state.creds.account, undefined);
  assert.equal(f.deleted(), 0);
});

test('supervision never revives a revoked session or expires a valid QR awaiting pairing', async t => {
  const unpaired = await fixture(t, { registered: false, initialQR: true });
  const qr = await unpaired.start();
  unpaired.instance.checkHealth(Date.now() + 300_000);
  assert.equal(unpaired.sockets.length, 1); assert.equal(unpaired.sockets[0].ended, 0);
  assert.equal((await unpaired.instance.reconnect()).qrCode, qr.qrCode);
  const f = await fixture(t); await f.start();
  f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  await f.flush(); f.instance.checkHealth(Date.now() + 300_000); await sleep(20);
  assert.equal(f.sockets.length, 1); assert.equal(f.auth.state.creds.registered, false);
  assert.equal(instanceStatus.get(f.key), 'REMOVED');
});

test('Signal storage failure closes transport and reconnects only after pending keys are saved', async t => {
  const f = await fixture(t, { overrides: { reconnectDelayMs: 1, reconnectMaxDelayMs: 1 } }); await f.start();
  const write = f.authRepository.write.bind(f.authRepository);
  let offline = true;
  f.authRepository.write = async entries => { if (offline) throw new Error('Storage unavailable'); await write(entries); };
  t.after(() => { offline = false; });
  const value = Buffer.from([8, 9, 10]);
  await assert.rejects(f.sockets[0].config.auth.keys.set({ session: { peer: value } }));
  assert.equal(f.sockets[0].ended, 1);
  assert.equal(instanceConnection[f.key]!.connectionState, 'reconnecting');
  await sleep(20); assert.equal(f.sockets.length, 1, 'never reuse a stale Signal snapshot');
  offline = false;
  for (let attempt = 0; attempt < 100 && f.sockets.length < 2; attempt++) await sleep(5);
  assert.equal(f.sockets.length, 2);
  assert.deepEqual((await f.sockets[1].config.auth.keys.get('session', ['peer'])).peer, value);
  assert.equal(f.auth.state.creds.registered, true);
  assert.equal(f.webhooks.some(item => item.event === 'connection.removed'), false);
});

test('phone revocation during a failed Signal write resets auth without replaying old keys', async t => {
  const f = await fixture(t); await f.start();
  const entered = deferred(), release = deferred();
  const write = f.authRepository.write.bind(f.authRepository);
  let attempts = 0;
  f.authRepository.write = async entries => {
    if (++attempts === 1) { entered.resolve(); await release.promise; throw new Error('Storage unavailable'); }
    await write(entries);
  };
  const saving = f.sockets[0].config.auth.keys.set({ session: { old: Buffer.from([1]) } });
  const rejected = assert.rejects(saving);
  await entered.promise;
  f.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } } });
  release.resolve(); await rejected; await f.flush(); await f.auth.drain();
  assert.equal(f.auth.state.creds.registered, false);
  assert.equal((await f.auth.state.keys.get('session', ['old'])).old, undefined);
  assert.equal(instanceStatus.get(f.key), 'REMOVED');
  await sleep(20); assert.equal(f.sockets.length, 1);
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
