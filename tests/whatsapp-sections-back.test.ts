import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { WAMessage } from '@whiskeysockets/baileys';
import Instance, { type InstanceDependencies } from '../src/infra/baileys/services.js';
import { createPersistentAuth, type AuthEntry } from '../src/infra/state/auth-state.js';
import { publicInstanceInfo } from '../src/shared/instance-info.js';
import { instances, instanceConnection, instanceStatus } from '../src/shared/constants.js';
import express from 'express';
import Token from '../src/infra/state/auth.js';
import InstanceRoutes from '../src/infra/http/routes/instances.js';
import SectionsController from '../src/infra/http/controllers/sections.js';
import type { SpaceRecord } from '../src/infra/mappers/spaces.js';
import { ContactMapper, mergeContactNames } from '../src/infra/mappers/contactMapper.js';

// Run with QA_BACKEND_PATH set to the adjacent backend. Both the backend HTTP
// server and webhooks are real; the WhatsApp transport and auth store are isolated.
test('API history and live webhooks keep empty chats and status out of conversations regardless of import order', {
  skip: !process.env.QA_BACKEND_PATH,
}, async t => {
  let cleanup: () => Promise<void> = async () => {};
  t.after(() => cleanup()); // Drain the API before the fixture closes its webhook server.
  const load = (file: string) => import(pathToFileURL(join(resolve(process.env.QA_BACKEND_PATH!), file)).href);
  const { syncFixture } = await load('test/sync-fixture.ts');
  const f = await syncFixture(t), owner = String(f.connection.id), name = f.connection.identify, key = `${owner}/${name}`;
  const entries = new Map<string, AuthEntry>(), messages = new Map<string, WAMessage>(), delivered: string[] = [];
  const auth = await createPersistentAuth({
    async read(type, ids) { return Object.fromEntries(ids.flatMap(id => { const entry = entries.get(`${type}:${id}`); return entry ? [[id, structuredClone(entry.value)]] : []; })); },
    async write(rows) { for (const row of rows) { if (row.value === null) entries.delete(`${row.type}:${row.key}`); else entries.set(`${row.type}:${row.key}`, structuredClone(row)); } },
    async replace(rows) { entries.clear(); await this.write(rows); },
    async clear() { entries.clear(); },
  });
  auth.state.creds.registered = true;
  const ev = new EventEmitter();
  const contacts = new Map<string, any>();
  const socket: any = { ev, ws: { isOpen: true }, authState: auth.state, user: { id: '5511990000000@s.whatsapp.net' },
    end() { socket.ws.isOpen = false; }, async profilePictureUrl() { return undefined; }, async groupFetchAllParticipating() { return {}; }, async communityFetchAllParticipating() { return {}; } };
  const store: InstanceDependencies['store'] = {
    async saveMessages(_key, message) { messages.set(message.key.id!, message); },
    async saveManyMessages(_key, rows) { for (const message of rows) messages.set(message.key.id!, message); },
    async saveManyContacts(_key, rows) {
      return rows.map(contact => {
        const prior = contacts.get(contact.id), row = { jid: contact.id, ...mergeContactNames(prior ? [prior] : [], contact) };
        contacts.set(contact.id, row); return ContactMapper.event(row, contact);
      });
    }, async saveManyChats() {}, async deleteByInstance() {}, async deleteChats() {}, async deleteMessages() {},
    async getMessageById(id) { return messages.get(id); },
  };
  const instance = new Instance({ loadAuth: async () => auth, makeSocket: () => socket, store,
    emit: async (event, info, data, history) => {
      const response = await f.webhook(event, data, { instance: publicInstanceInfo(info), ...(history ? { history } : {}) });
      assert.equal(response.status, 200, `${event}: ${JSON.stringify(response.body)}`); delivered.push(event);
    },
  });
  cleanup = async () => { await instance.shutdown(); delete instances[key]; delete instanceConnection[key]; instanceStatus.delete(key); };
  const flush = async () => {
    await (instance as any).eventTail;
    while ((instance as any).eventTasks.size) await Promise.all([...(instance as any).eventTasks]);
  };
  const emit = async (event: string, data: unknown) => { ev.emit(event, data); await flush(); };
  const route = `/api/connections/${name}`;
  const list = async (suffix = '') => {
    const result = await f.request(`${route}/chats?limit=100${suffix}`, { session: f.owner });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.data;
  };
  await instance.create({ owner, instanceName: name }); await emit('connection.update', { connection: 'open' });
  const a = '5511981111111@s.whatsapp.net', b = '5511982222222@s.whatsapp.net', empty = '5511983333333@s.whatsapp.net';
  const baseline = Math.floor(Date.now() / 1000) - 3600;
  const message = (id: string, jid: string, offset: number, text: string): WAMessage => ({
    key: { id, remoteJid: jid, fromMe: false, ...(jid === 'status@broadcast' ? { participant: a } : {}) },
    message: { conversation: text }, messageTimestamp: baseline + offset, pushName: jid === a ? 'Alice' : 'Bruno',
  });
  await emit('chats.upsert', [{ id: empty, name: 'Contato vazio' }, { id: 'status@broadcast', name: 'status' }]);
  assert.deepEqual((await list()).items, [], 'metadata alone must not appear as a conversation');
  await emit('contacts.upsert', [{ id: a, name: 'Alice da agenda', notify: 'Nome público antigo' }]);
  await emit('messages.upsert', { type: 'notify', messages: [message('a-latest', a, 200, 'Mais recente A'), message('b-first', b, 100, 'Primeira B')] });
  assert.deepEqual((await list()).items.map((chat: any) => chat.jid), [a, b]);
  await emit('messaging-history.set', {
    messages: [message('a-old', a, 1, 'Antiga importada depois'), message('status-active', 'status@broadcast', 250, 'Meu status')],
    contacts: [], chats: [{ id: b, name: 'Bruno' }, { id: empty, name: 'Sem mensagens' }, { id: 'status@broadcast', name: 'status' }],
    syncType: 3, progress: 100, isLatest: true,
  });
  const afterHistory = await list();
  assert.deepEqual(afterHistory.items.map((chat: any) => chat.jid), [a, b]);
  assert.equal(afterHistory.items[0].lastMessage.text, 'Mais recente A');
  assert.equal(afterHistory.items[0].name, 'Alice da agenda', 'the API contact source survives message/history webhooks');
  await emit('contacts.update', [{ id: a, notify: 'Novo nome público' }]);
  assert.equal((await list()).items.find((chat: any) => chat.jid === a).name, 'Alice da agenda');
  assert.equal(afterHistory.items.every((chat: any) => Boolean(chat.lastMessage)), true);
  assert.equal((await f.db.query('SELECT _messageId FROM tbl_status WHERE _instanceId=?', [f.connection.id])).length, 1);
  assert.equal((await f.db.query("SELECT _messageId FROM tbl_messages WHERE _instanceId=? AND _messageId='status-active'", [f.connection.id])).length, 0);
  await emit('messages.upsert', { type: 'notify', messages: [message('b-live', b, 300, 'Última B')] });
  assert.deepEqual((await list()).items.map((chat: any) => chat.jid), [b, a]);
  const direct = await f.request(`${route}/chats`, { session: f.owner });
  assert.deepEqual(direct.body.data.map((chat: any) => chat.jid), [b, a], 'unpaginated clients use the same visibility rule');
  assert.equal((await f.request(`${route}/chats?limit=100`, { session: f.other })).status, 404);
  assert.deepEqual((await f.request(`${route}/statuses`, { session: f.owner })).body.data.items.map((item: any) => item.id), ['status-active']);
  await emit('messages.update', [{ key: { id: 'status-active', remoteJid: 'status@broadcast' }, update: { message: null } }]);
  assert.deepEqual((await f.request(`${route}/statuses`, { session: f.owner })).body.data.items, [], 'revoked status is removed from its viewer');
  assert.deepEqual((await list()).items.map((chat: any) => chat.jid), [b, a]);
  assert.ok(delivered.includes('messages.set')); assert.ok(delivered.includes('chats.set'));
});

test('real sections HTTP contract exposes observed channels and community membership without mixing status into conversations', {
  skip: !process.env.QA_BACKEND_PATH,
}, async t => {
  const load = (file: string) => import(pathToFileURL(join(resolve(process.env.QA_BACKEND_PATH!), file)).href);
  const [{ syncFixture }, { WhatsappClient }] = await Promise.all([load('test/sync-fixture.ts'), load('src/whatsapp/client.ts')]);
  const f = await syncFixture(t);
  const parent = '120363111111111111@g.us', group = '120363222222222222@g.us', announce = '120363333333333333@g.us';
  const channel = '120363444444444444@newsletter', person = '5511981111111@s.whatsapp.net';
  const spaces = new Map<string, SpaceRecord>([[channel, { id: channel }]]);
  let catalogReads = 0;
  let socket: any = { ws: { isOpen: true },
    async groupFetchAllParticipating() { catalogReads++; return {
      [group]: { id: group, subject: 'Participantes', linkedParent: parent, isCommunityAnnounce: false },
      [announce]: { id: announce, subject: 'Avisos', linkedParent: parent, isCommunityAnnounce: true },
    }; },
    async communityFetchAllParticipating() { return { [parent]: { id: parent, subject: 'Comunidade de teste', isCommunity: true } }; },
    async newsletterMetadata(kind: string, jid: string) { assert.equal(kind, 'jid'); assert.equal(jid, channel); return { id: jid, name: 'Canal recebido', description: 'Publicações do canal' }; },
  };
  const secret = 'isolated-sections-contract', api = express();
  api.use(new Token(secret).verify); api.use(express.json());
  api.use('/instances', new InstanceRoutes(undefined, (owner, name) => new SectionsController(owner, name, {
    socket, readSpaces: async () => [...spaces.values()], saveSpaces: async (_key, rows) => { for (const row of rows) spaces.set(row.id, row); },
  })).get());
  const server = api.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const client = new WhatsappClient({ baseUrl, token: secret });
  t.mock.method(f.application.client, 'readSections', client.readSections.bind(client));
  const route = `/api/connections/${f.connection.identify}`;
  const catalog = await f.request(`${route}/sections`, { session: f.owner });
  assert.equal(catalog.status, 200, JSON.stringify(catalog.body));
  assert.ok(catalog.body.data.limitations.includes('NEWSLETTER_OBSERVED_ONLY'));
  assert.equal(catalog.body.data.items.find((item: any) => item.id === 'channels').count, 1);
  assert.equal(catalog.body.data.items.find((item: any) => item.id === 'communities').count, 1);
  const list = async (section: string) => {
    const response = await f.request(`${route}/chats?limit=100&section=${section}`, { session: f.owner });
    assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body.data.items;
  };
  assert.deepEqual(await list('conversations'), [], 'catalog metadata cannot manufacture conversations');
  const channels = await list('channels');
  assert.equal(channels.length, 1); assert.equal(channels[0].jid, channel); assert.equal(channels[0].name, 'Canal recebido');
  assert.equal(channels[0].readOnly, true); assert.equal(channels[0].lastMessage, null);
  const communities = await list('communities');
  assert.ok(communities.some((item: any) => item.jid === parent && item.readOnly === true));
  assert.ok(communities.some((item: any) => item.jid === group && item.community?.parentJid === parent));

  const now = Math.floor(Date.now() / 1000) - 60;
  const message = (id: string, jid: string, timestamp: number, text: string) => ({
    key: { id, remoteJid: jid, fromMe: false, participant: person },
    message: { conversation: text }, messageTimestamp: timestamp, pushName: 'Participante',
  });
  const imported = await f.webhook('messages.upsert', [
    message('group-text', group, now - 20, 'Mensagem do grupo'), message('channel-text', channel, now - 10, 'Publicação'),
    message('status-current', 'status@broadcast', now, 'Status atual'),
    message('status-expired', 'status@broadcast', now - 86400, 'Status expirado'),
  ]);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.deepEqual((await list('conversations')).map((item: any) => item.jid), [group]);
  assert.equal((await list('channels'))[0].lastMessage.text, 'Publicação');
  const statuses = await f.request(`${route}/statuses`, { session: f.owner });
  assert.equal(statuses.status, 200, JSON.stringify(statuses.body));
  assert.deepEqual(statuses.body.data.items.map((item: any) => item.id), ['status-current']);
  assert.equal(statuses.body.data.items[0].author.address, person);
  await f.request(`${route}/sections`, { session: f.owner });
  assert.equal(catalogReads, 1, 'reopening sections reuses the tenant catalog cache');
  // A new provider socket returns a complete snapshot where the group is no
  // longer linked. The null removal must survive both HTTP and stored metadata.
  socket = { ...socket, async groupFetchAllParticipating() { catalogReads++; return {
    [group]: { id: group, subject: 'Agora independente', isCommunity: false, isCommunityAnnounce: false, announce: false },
    [announce]: { id: announce, subject: 'Avisos', linkedParent: parent, isCommunityAnnounce: true },
  }; } };
  await f.db.execute("UPDATE tbl_whatsappSectionState SET _checkedAt='2000-01-01T00:00:00Z' WHERE _instanceId=?", [f.connection.id]);
  assert.equal((await f.request(`${route}/sections`, { session: f.owner })).status, 200);
  assert.equal((await list('communities')).some((item: any) => item.jid === group), false, 'unlinked group leaves the community tree');
  const independent = (await list('conversations')).find((item: any) => item.jid === group);
  assert.equal(independent.name, 'Agora independente'); assert.equal(independent.community, undefined); assert.equal(independent.readOnly, false);
  assert.equal((await f.request(`${route}/sections`, { session: f.other })).status, 404);
  assert.equal((await f.request(`${route}/statuses`, { session: f.other })).status, 404);
  assert.equal((await f.request(`${route}/chats?limit=100&section=channels`, { session: f.other })).status, 404);
  assert.equal(catalogReads, 2);
  assert.equal((await fetch(`${baseUrl}/instances/sections/${f.connection.id}/${f.connection.identify}`)).status, 401);
});
