import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';
import { createPersistentAuth, filesystemAuthRepository, safeSessionDirectory, type AuthEntry, type AuthRepository } from '../src/infra/state/auth-state.js';
import { serializeBaileys, deserializeBaileys, MessageMapper } from '../src/infra/mappers/messageMapper.js';
import { ContactMapper } from '../src/infra/mappers/contactMapper.js';
import { instanceKey } from '../src/shared/identity.js';
import { ambiguousLegacyKeys, discoverFileSessions } from '../src/infra/state/sessions.js';

export function memoryAuthRepository(): AuthRepository & { entries: Map<string, AuthEntry> } {
  const entries = new Map<string, AuthEntry>();
  return {
    entries,
    async read(type, ids) { return Object.fromEntries(ids.flatMap(id => { const row = entries.get(JSON.stringify([type, id])); return row ? [[id, row.value]] : []; })); },
    async write(rows) { for (const row of rows) { const key = JSON.stringify([row.type, row.key]); if (row.value === null) entries.delete(key); else entries.set(key, structuredClone(row)); } },
    async clear() { entries.clear(); },
    async replace(rows) { entries.clear(); await this.write(rows); },
  };
}

async function fixture(t: any): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'qa-zaptobox-auth-'));
  t.after(async () => {
    const relative = path.relative(tmpdir(), directory);
    assert.ok(relative.startsWith('qa-zaptobox-auth-') && !relative.includes(path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('Signal categories survive restart and null deletes; serialization is idempotent', async () => {
  const repo = memoryAuthRepository();
  const auth = await createPersistentAuth(repo);
  const bytes = Buffer.from([0, 255, 7, 8]);
  const json = serializeBaileys({ bytes, exact: 9007199254740993n });
  assert.deepEqual(serializeBaileys(json), json);
  assert.deepEqual(deserializeBaileys(json).bytes, bytes);
  await auth.state.keys.set({
    session: { one: bytes }, 'identity-key': { two: bytes }, 'lid-mapping': { '111': '222', '222_reverse': '111' },
    'device-list': { '111': ['1', '2'] }, tctoken: { '111': { token: bytes, timestamp: '10' } },
    'app-state-sync-key': { app: { keyData: bytes, timestamp: 5 } },
  });
  auth.state.creds.registered = true;
  await auth.saveCreds();
  const loaded = await createPersistentAuth(repo);
  assert.equal(loaded.state.creds.registered, true);
  assert.deepEqual((await loaded.state.keys.get('session', ['one'])).one, bytes);
  assert.deepEqual((await loaded.state.keys.get('identity-key', ['two'])).two, bytes);
  assert.deepEqual((await loaded.state.keys.get('tctoken', ['111']))['111']?.token, bytes);
  assert.deepEqual((await loaded.state.keys.get('app-state-sync-key', ['app'])).app?.keyData, bytes);
  assert.equal((await loaded.state.keys.get('lid-mapping', ['222_reverse']))['222_reverse'], '111');
  await loaded.state.keys.set({ session: { one: null } });
  assert.equal((await loaded.state.keys.get('session', ['one'])).one, undefined);
  await loaded.reset();
  const reset = await createPersistentAuth(repo);
  assert.equal(reset.state.creds.registered, false);
  assert.equal((await reset.state.keys.get('identity-key', ['two'])).two, undefined);
});

test('legacy credentials import preserves source and escaped key lookup; reset prevents reimport', async t => {
  const root = await fixture(t);
  const directory = await safeSessionDirectory(root, 'owner', 'Atendimento@1_nome', true);
  const creds = initAuthCreds(); creds.registered = true;
  const credsText = JSON.stringify(creds, BufferJSON.replacer);
  const binary = Buffer.from([1, 2, 3, 4]);
  await writeFile(path.join(directory, 'creds.json'), credsText);
  await writeFile(path.join(directory, 'session-123-7.0.json'), JSON.stringify(binary, BufferJSON.replacer));
  const repo = memoryAuthRepository();
  const auth = await createPersistentAuth(repo, directory);
  assert.equal(auth.state.creds.registered, true);
  assert.deepEqual((await auth.state.keys.get('session', ['123:7.0']))['123:7.0'], binary);
  assert.equal(await readFile(path.join(directory, 'creds.json'), 'utf8'), credsText);
  await auth.state.keys.set({ session: { '123:7.0': null } });
  assert.equal((await auth.state.keys.get('session', ['123:7.0']))['123:7.0'], undefined);
  await auth.reset();
  const next = await createPersistentAuth(repo, directory);
  assert.equal(next.state.creds.registered, false);
  assert.equal(await readFile(path.join(directory, 'creds.json'), 'utf8'), credsText);
});

test('filesystem atomic snapshot roundtrip and corruption fails without replacing data', async t => {
  const root = await fixture(t);
  const directory = await safeSessionDirectory(root, 'owner', 'name', true);
  const auth = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  const bytes = Buffer.from([5, 4, 3]);
  await Promise.all([auth.state.keys.set({ session: { a: bytes } }), auth.saveCreds(), auth.state.keys.set({ 'device-list': { a: ['1'] } })]);
  const next = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  assert.deepEqual((await next.state.keys.get('session', ['a'])).a, bytes);
  assert.deepEqual((await next.state.keys.get('device-list', ['a'])).a, ['1']);
  await writeFile(path.join(directory, 'auth-state.json'), '{corrupt');
  await assert.rejects(filesystemAuthRepository(directory));
  assert.equal(await readFile(path.join(directory, 'auth-state.json'), 'utf8'), '{corrupt');
});

test('session identities prevent traversal, retain legacy names, reject junction escape and detect collisions', async t => {
  const root = await fixture(t);
  assert.equal(instanceKey('a_b', 'c'), 'a_b/c');
  assert.notEqual(instanceKey('a_b', 'c'), instanceKey('a', 'b_c'));
  assert.equal(instanceKey('José@1', 'Atendimento 2'), 'José@1/Atendimento 2');
  for (const value of ['..', '../escape', 'a/b', 'a\\b', 'name:ads', 'nul', 'con.txt', 'tail.', 'tail ']) assert.throws(() => instanceKey(value, 'one'));
  assert.deepEqual([...ambiguousLegacyKeys([{ owner: 'a_b', instanceName: 'c' }, { owner: 'a', instanceName: 'b_c' }])], ['a_b_c']);
  await safeSessionDirectory(root, 'owner', 'good', true);
  const outside = path.join(root, 'elsewhere'); await mkdir(outside);
  await symlink(outside, path.join(root, 'owner', 'linked'), 'junction');
  await assert.rejects(safeSessionDirectory(root, 'owner', 'linked'));
  assert.deepEqual(await discoverFileSessions(root), [{ owner: 'owner', instanceName: 'good' }]);
});

test('message and contact mappers preserve LID alternative keys and legacy media keys', () => {
  const bytes = Buffer.from([100, 2, 3]);
  const row: any = { remoteJid: '2@lid', fromMe: true, messageId: 'm1', messageTimestamp: 5n, status: '0', pushName: 'Pessoa',
    content: { key: { id: 'm1', remoteJid: '2@lid', remoteJidAlt: '1@s.whatsapp.net', participant: '3@lid', participantAlt: '4@s.whatsapp.net' }, message: { imageMessage: { mediaKey: bytes.toString('base64') } } } };
  const result = MessageMapper.toWAMessage(row);
  assert.equal(result.key.participantAlt, '4@s.whatsapp.net');
  assert.equal(result.status, 0);
  assert.deepEqual(result.message?.imageMessage?.mediaKey, bytes);
  assert.deepEqual(ContactMapper.toContact({ lid: '2@lid', jid: null }), { id: '2@lid' });
  assert.deepEqual(ContactMapper.toContact({ lid: '2@lid', jid: '1@s.whatsapp.net' }), { id: '2@lid', phoneNumber: '1@s.whatsapp.net' });
});
