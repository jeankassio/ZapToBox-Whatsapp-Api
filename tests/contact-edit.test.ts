import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { chatModificationToAppPatch, type WASocket } from '@whiskeysockets/baileys';
import ProfileController, { type ProfileDependencies } from '../src/infra/http/controllers/profile.js';
import ProfileRoutes from '../src/infra/http/routes/profile.js';
import Token from '../src/infra/state/auth.js';
import type { Contact } from '../src/shared/types.js';

const jid = '5511999999999@s.whatsapp.net', lid = '123456789012345@lid';
const secret = 'contact-edit-test-secret-not-production-123456';
const repository: NonNullable<ProfileDependencies['repository']> = {
  getContactById: async () => undefined, getMessageById: async () => undefined, getLastMessageByInstance: async () => undefined,
};
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: TestContext) {
  const changes: { id: string; contact: any }[] = [], saved: Contact[] = [];
  const socket = { addOrEditContact: async (id: string, contact: any) => { changes.push({ id, contact }); } } as unknown as WASocket;
  const deps: ProfileDependencies = { socket, repository, onContact: async contact => { saved.push(contact); return contact; } };
  const app = express(); app.use(express.json()); app.use(new Token(secret).verify);
  app.use('/profile', new ProfileRoutes((owner, name) => new ProfileController(owner, name, deps)).get());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(body: unknown, token: string | null = secret, path = '/owner/one') {
    const response = await fetch(`${origin}/profile/contactName${path}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { deps, changes, saved, request };
}

test('contact edit route scopes authorization, rejects invalid input and never mutates another chat type', async t => {
  const f = await fixture(t), payload = { remoteJid: jid, name: 'Dentista' };
  assert.equal((await f.request(payload, null)).status, 401);
  const token = jwt.sign({ owner: 'owner', instanceName: 'one' }, secret, { algorithm: 'HS256', expiresIn: 60 });
  for (const path of ['/other/one', '/owner/other']) assert.equal((await f.request(payload, token, path)).status, 403);
  for (const remoteJid of ['status@broadcast', '120363123456789@g.us', '120363123456789@newsletter', {}, 'invalid']) assert.equal((await f.request({ ...payload, remoteJid })).status, 400);
  for (const name of ['', '  ', 'a'.repeat(201), 'bad\nname', 'bad\u0000name', null, {}]) assert.equal((await f.request({ ...payload, name })).status, 400);
  assert.equal(f.changes.length, 0); assert.equal(f.saved.length, 0);
  const result = await f.request({ remoteJid: '+5511999999999', name: '  Dentista  ' }, token);
  assert.equal(result.status, 200); assert.equal(result.body.data.contact.name, 'Dentista');
  assert.equal(result.body.data.syncedToWhatsApp, true); assert.equal(result.body.data.syncPending, undefined);
});

test('contact edit preserves aliases and uses the actual Baileys app-state contact patch contract', async t => {
  const f = await fixture(t);
  const normalizedLid = `${lid.split('@')[0]}@lid`;
  f.deps.repository = { ...repository, getContactById: async () => ({ id: lid, phoneNumber: jid, name: 'Antigo', notify: 'Perfil' }) };
  const result = await f.request({ remoteJid: `${normalizedLid.split('@')[0]}:2@lid`, name: 'Novo nome' });
  assert.equal(result.status, 200); assert.equal(f.changes[0].id, normalizedLid);
  assert.deepEqual(f.changes[0].contact, { fullName: 'Novo nome', saveOnPrimaryAddressbook: true });
  const patch = chatModificationToAppPatch({ contact: f.changes[0].contact }, normalizedLid);
  assert.equal(patch.type, 'critical_unblock_low'); assert.deepEqual(patch.index, ['contact', normalizedLid]);
  assert.equal(patch.syncAction.contactAction?.fullName, 'Novo nome');
  assert.equal(result.body.data.contact.savedName, 'Novo nome'); assert.equal(result.body.data.contact.phoneNumber, jid);
  assert.equal(result.body.data.contact.nameSource, 'saved'); assert.ok(Date.parse(result.body.data.contact.savedNameUpdatedAt));
});

test('contact edit waits for provider acknowledgment before observing or persisting a name', async () => {
  const ack = deferred(), saved: Contact[] = [];
  const socket = { addOrEditContact: () => ack.promise } as unknown as WASocket;
  const result = new ProfileController('owner', 'one', { socket, repository, onContact: async contact => { saved.push(contact); } }).contactName(jid, 'Novo');
  await Promise.resolve(); assert.equal(saved.length, 0);
  const acceptedAfter = Date.now(); ack.resolve();
  assert.equal((await result).success, true); assert.equal(saved.length, 1); assert.ok(Date.parse(saved[0].savedNameUpdatedAt!) >= acceptedAfter);
});

test('unsupported, offline and failed provider edits never persist or report saved names', async () => {
  let writes = 0;
  for (const [status, socket] of [[501, {}], [409, { ws: { isOpen: false } }], [502, { addOrEditContact: async () => { throw new Error('Provider rejected'); } }]] as const) {
    const result = await new ProfileController('owner', 'one', { socket: socket as unknown as WASocket, repository, onContact: async () => { writes++; } }).contactName(jid, 'Novo');
    assert.equal(result.success, false); assert.equal(result.statusCode, status); assert.equal(result.data, undefined);
  }
  assert.equal(writes, 0);
});

test('an acknowledged edit returns its snapshot when local publication fails or the socket closes', async () => {
  for (const closeSocket of [false, true]) {
    let writes = 0;
    const socket = { ws: { isOpen: true }, addOrEditContact: async () => { if (closeSocket) socket.ws.isOpen = false; } } as unknown as WASocket;
    const result = await new ProfileController('owner', 'one', { socket, repository, onContact: async () => { writes++; throw new Error('Local database unavailable'); } }).contactName(jid, 'Novo');
    assert.equal(result.success, true); assert.equal(result.data.syncedToWhatsApp, true); assert.equal(result.data.syncPending, true);
    assert.equal(result.data.contact.savedName, 'Novo'); assert.equal(writes, closeSocket ? 0 : 1);
  }
});
