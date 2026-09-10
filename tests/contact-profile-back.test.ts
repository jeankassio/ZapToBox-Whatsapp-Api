import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import type { WASocket } from '@whiskeysockets/baileys';
import ProfileController from '../src/infra/http/controllers/profile.js';
import ProfileRoutes from '../src/infra/http/routes/profile.js';
import Token from '../src/infra/state/auth.js';
import { ContactMapper, mergeContactNames } from '../src/infra/mappers/contactMapper.js';
import type { Contact } from '../src/shared/types.js';

// Both HTTP applications and the contact webhook are real. The WhatsApp socket
// and API contact store are isolated; no phone contact is changed by this test.
test('contact edit traverses Back and API, waits for WhatsApp and accepts its own webhook before the response', {
  skip: !process.env.QA_BACKEND_PATH,
}, async t => {
  const load = (file: string) => import(pathToFileURL(join(resolve(process.env.QA_BACKEND_PATH!), file)).href);
  const [{ syncFixture, historyMessage }, { WhatsappClient }] = await Promise.all([load('test/sync-fixture.ts'), load('src/whatsapp/client.ts')]);
  const f = await syncFixture(t), jid = '5511985551001@s.whatsapp.net';
  const original = { id: jid, name: 'Nome salvo anteriormente', savedNameUpdatedAt: '2026-01-01T00:00:00.000Z', notify: 'Nome público' };
  await f.webhook('contacts.upsert', original);
  await f.webhook('messages.upsert', { ...historyMessage('contact-profile-integration'), key: { id: 'contact-profile-integration', remoteJid: jid, fromMe: false }, pushName: 'Nome público' });
  const [contact] = await f.db.query('SELECT _id FROM tbl_contacts WHERE _instanceId=? AND _jid=?', [f.connection.id, jid]);
  const route = `/api/connections/${f.connection.identify}/contacts/${contact._id}`;
  let saved = { jid, ...mergeContactNames([], original) }, calls = 0, observedWebhook = false;
  const name = 'Verônica Viana — Cliente';
  const socket = { ws: { isOpen: true }, async addOrEditContact(address: string, action: any) {
    calls++; assert.equal(address, jid); assert.equal(action.fullName, name);
    const [before] = await f.db.query('SELECT _name FROM tbl_contacts WHERE _id=?', [contact._id]);
    assert.equal(before._name, 'Nome salvo anteriormente', 'local name cannot change before provider confirmation');
  } } as unknown as WASocket;
  const onContact = async (value: Contact) => {
    saved = { jid, ...mergeContactNames([saved], value) };
    const canonical = ContactMapper.event(saved, value);
    const response = await f.webhook('contacts.update', canonical);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    observedWebhook = true;
    return canonical;
  };
  const secret = 'isolated-contact-profile-api', api = express();
  api.use(express.json()); api.use(new Token(secret).verify);
  api.use('/profile', new ProfileRoutes((owner, identify) => {
    assert.equal(owner, String(f.connection.id)); assert.equal(identify, f.connection.identify);
    return new ProfileController(owner, identify, { socket, onContact, repository: {
      async getContactById() { return ContactMapper.toContact(saved); }, async getMessageById() { return undefined; }, async getLastMessageByInstance() { return undefined; },
    } });
  }).get());
  const server = api.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }));
  const provider = new WhatsappClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: secret });
  t.mock.method(f.application.client, 'editContactName', provider.editContactName.bind(provider));
  const initial = await f.request(route, { session: f.owner });
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.data.name, original.name); assert.equal(initial.body.data.phone, '5511985551001');
  assert.equal(initial.body.data.editTarget, 'whatsapp');
  assert.equal((await f.request(route, { session: f.other })).status, 404);
  const denied = await f.request(route, { method: 'PATCH', session: f.other, body: { version: initial.body.data.version, name } });
  assert.equal(denied.status, 404); assert.equal(calls, 0);
  const result = await f.request(route, { method: 'PATCH', session: f.owner, body: { version: initial.body.data.version, name } });
  assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(calls, 1); assert.equal(observedWebhook, true);
  assert.equal(result.body.data.name, name); assert.equal(result.body.data.savedName, name); assert.equal(result.body.data.nameSource, 'saved');
  const [row] = await f.db.query('SELECT _name,_savedName,_jid FROM tbl_contacts WHERE _id=?', [contact._id]);
  assert.deepEqual({ ...row }, { _name: name, _savedName: name, _jid: jid });
  const chats = await f.request(`/api/connections/${f.connection.identify}/chats`, { session: f.owner });
  assert.equal(chats.body.data[0].name, name);
  await f.webhook('messages.upsert', { ...historyMessage('contact-profile-followup'), key: { id: 'contact-profile-followup', remoteJid: jid, fromMe: false }, pushName: 'Outro nome público' });
  const confirmed = (await f.request(route, { session: f.owner })).body.data;
  assert.equal(confirmed.name, name);
  delete (socket as any).addOrEditContact;
  const unsupported = await f.request(route, { method: 'PATCH', session: f.owner, body: { version: confirmed.version, name: 'Não deve salvar apenas localmente' } });
  assert.equal(unsupported.status, 501, JSON.stringify(unsupported.body)); assert.equal(unsupported.body.error.code, 'CONTACT_EDIT_UNSUPPORTED');
  const unchanged = (await f.request(route, { session: f.owner })).body.data;
  assert.equal(unchanged.name, name); assert.equal(unchanged.version, confirmed.version); assert.equal(unchanged.canEdit, true); assert.equal(calls, 1);
});
