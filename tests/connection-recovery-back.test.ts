import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import Instance, { type InstanceDependencies } from '../src/infra/baileys/services.js';
import { createPersistentAuth, type AuthEntry } from '../src/infra/state/auth-state.js';
import { createApp } from '../src/app.js';
import { publicInstanceInfo } from '../src/shared/instance-info.js';
import { instances, instanceConnection, instanceStatus } from '../src/shared/constants.js';

// Uses the adjacent compiled backend, an in-memory database and a simulated
// transport. No WhatsApp account, PostgreSQL server or real logout is involved.
test('API lifecycle and HTTP observations converge on the backend after recovery and real logout', {
  skip: !process.env.QA_BACKEND_PATH,
}, async () => {
  const load = (file: string) => import(pathToFileURL(join(resolve(process.env.QA_BACKEND_PATH!), 'dist', `${file}.js`)).href);
  const [{ SqliteDatabase }, { migrate }, { createWebhookRouter }, { WhatsappClient }, { ConnectionStatusService }, { connectionDto }, { errorHandler }] = await Promise.all([
    load('db'), load('migrate'), load('whatsapp/webhook'), load('whatsapp/client'), load('connection-status'), load('connections'), load('errors'),
  ]);
  const secret = `qa-${randomUUID()}`, previousSecret = process.env.WEBHOOK_SECRET;
  process.env.WEBHOOK_SECRET = secret;
  const name = `qa_${randomUUID().replaceAll('-', '')}`, key = `1/${name}`, jid = '5511999999999@s.whatsapp.net';
  const db = new SqliteDatabase(); await migrate(db);
  await db.execute("INSERT INTO tbl_instances (_id,_user,_identify,_name,_label,_status,_expire,_created) VALUES (1,1,'qa-recovery',?,'QA','0','2099-01-01 00:00:00','2026-01-01 00:00:00')", [name]);
  const api = createApp({ token: secret, ready: async () => {} }).listen(0, '127.0.0.1'); await once(api, 'listening');
  const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const provider = new WhatsappClient({ baseUrl: apiUrl, token: secret });
  const statuses = new ConnectionStatusService(db, provider);
  const app = express(); app.use(express.json()); app.use('/webhook', createWebhookRouter(db, () => {}, undefined, false)); app.use(errorHandler);
  const back = app.listen(0, '127.0.0.1'); await once(back, 'listening');
  const webhookUrl = `http://127.0.0.1:${(back.address() as { port: number }).port}/webhook`;
  const payloads: any[] = [], sockets: any[] = [], rows = new Map<string, AuthEntry>();
  let skipNextOpen = false, failNextSave = false;
  const auth = await createPersistentAuth({
    async read(type, ids) { return Object.fromEntries(ids.flatMap(id => { const row = rows.get(`${type}:${id}`); return row ? [[id, structuredClone(row.value)]] : []; })); },
    async write(entries) { for (const entry of entries) { if (entry.value === null) rows.delete(`${entry.type}:${entry.key}`); else rows.set(`${entry.type}:${entry.key}`, structuredClone(entry)); } },
    async clear() { rows.clear(); },
    async replace(entries) { rows.clear(); await this.write(entries); },
  });
  auth.state.creds.registered = true; await auth.saveCreds();
  const post = async (payload: any) => {
    const response = await fetch(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
  };
  const store: InstanceDependencies['store'] = {
    async saveMessages() {}, async saveManyMessages() { if (failNextSave) { failNextSave = false; throw new Error('Simulated temporary store failure'); } },
    async saveManyContacts() {}, async saveManyChats() {}, async getMessageById() { return undefined; },
    async deleteByInstance() {}, async deleteChats() {}, async deleteMessages() {},
  };
  const instance = new Instance({ loadAuth: async () => auth, store, reconnectDelayMs: 10, reconnectMaxDelayMs: 10, removeSession: async () => {},
    makeSocket(config) {
      const socket = { ev: new EventEmitter(), authState: config.auth, user: { id: jid }, ws: { isOpen: false },
        end() { socket.ws.isOpen = false; }, profilePictureUrl: async () => undefined };
      sockets.push(socket); return socket as any;
    },
    async emit(event, info, data, history) {
      const payload = { id: randomUUID(), timestamp: new Date().toISOString(), event, instance: publicInstanceInfo(info), data, ...(history ? { history } : {}) };
      payloads.push(payload);
      if (event === 'connection.open' && skipNextOpen) { skipNextOpen = false; return; }
      await post(payload);
    },
  });
  const until = async (check: () => Promise<boolean> | boolean) => {
    for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 10)); }
    throw new Error('Expected integrated lifecycle transition did not arrive');
  };
  const dto = async () => connectionDto(db, { ...(await db.query('SELECT * FROM tbl_instances WHERE _id=1'))[0], _role: 'owner' });
  const open = (socket: any) => { socket.ws.isOpen = true; socket.ev.emit('connection.update', { connection: 'open' }); };
  const close = (socket: any, reason: number) => { socket.ws.isOpen = false; socket.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: reason } } } }); };
  try {
    await instance.create({ owner: '1', instanceName: name }); open(sockets[0]);
    await until(async () => (await dto()).status === 'connected');
    close(sockets[0], 428);
    await until(async () => (await dto()).status === 'reconnecting');
    const recovering = await dto();
    assert.equal(recovering.owner, jid); assert.equal(recovering.canRescanHistory, false); assert.equal(recovering.canDelete, false);
    const observation = await provider.readInstanceStatus(1, name);
    assert.equal(observation.data.connectionStatus, 'OFFLINE'); assert.equal(observation.data.connectionState, 'reconnecting');
    assert.equal(auth.state.creds.registered, true);
    const oldClose = payloads.find(payload => payload.event === 'connection.close'); assert.ok(oldClose);
    await post({ event: 'messages.upsert', timestamp: new Date().toISOString(), instance: observation.data, data: [{ key: { id: 'OFFLINE', remoteJid: '5511888888888@s.whatsapp.net' }, message: { conversation: 'Should not import' }, messageTimestamp: 1789000000 }] });
    assert.equal(Number((await db.query('SELECT COUNT(*) AS n FROM tbl_messages'))[0].n), 0);
    // A missed open webhook is repaired by the actual authenticated HTTP endpoint.
    await until(() => sockets.length === 2); skipNextOpen = true; open(sockets[1]);
    await until(() => payloads.some(payload => payload.event === 'connection.open' && payload.instance.connectionUpdatedAt > oldClose.instance.connectionUpdatedAt));
    await statuses.refresh(1, true); assert.equal((await dto()).status, 'connected');
    await post(oldClose); assert.equal((await dto()).status, 'connected');
    // A store failure must restart the transport without revoking the session.
    failNextSave = true;
    sockets[1].ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { id: 'STORE-FAILURE', remoteJid: '5511888888888@s.whatsapp.net' }, message: { conversation: 'Retry transport' } }] });
    await until(async () => (await dto()).status === 'reconnecting');
    await until(() => sockets.length === 3); assert.equal(auth.state.creds.registered, true);
    open(sockets[2]); await until(async () => (await dto()).status === 'connected');
    const priorOpen = payloads.filter(payload => payload.event === 'connection.open').at(-1);
    close(sockets[2], 401);
    await until(async () => (await dto()).status === 'disconnected' && auth.state.creds.registered === false);
    assert.equal((await dto()).owner, null);
    await post(priorOpen); assert.equal((await dto()).status, 'disconnected');
    await statuses.refresh(1, true); assert.equal((await dto()).status, 'disconnected');
    assert.equal(sockets.length, 3);
  } finally {
    await instance.shutdown(); await statuses.stop();
    delete instances[key]; delete instanceConnection[key]; instanceStatus.delete(key);
    api.closeAllConnections(); back.closeAllConnections();
    await Promise.all([new Promise<void>(done => api.close(() => done())), new Promise<void>(done => back.close(() => done()))]);
    await db.close();
    if (previousSecret === undefined) delete process.env.WEBHOOK_SECRET; else process.env.WEBHOOK_SECRET = previousSecret;
  }
});
