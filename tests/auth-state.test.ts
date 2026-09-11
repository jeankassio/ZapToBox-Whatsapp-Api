import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initAuthCreds, BufferJSON, configureSuccessfulPairing, encodeSignedDeviceIdentity, Curve, hmacSign, proto, WA_ADV_ACCOUNT_SIG_PREFIX } from '@whiskeysockets/baileys';
import { createPersistentAuth, filesystemAuthRepository, safeSessionDirectory, type AuthEntry, type AuthRepository } from '../src/infra/state/auth-state.js';
import { serializeBaileys, deserializeBaileys, MessageMapper } from '../src/infra/mappers/messageMapper.js';
import { ContactMapper } from '../src/infra/mappers/contactMapper.js';
import { instanceKey } from '../src/shared/identity.js';
import { ambiguousLegacyKeys, discoverFileSessions } from '../src/infra/state/sessions.js';
import { hasLinkedCredentials } from '../src/shared/auth-credentials.js';

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

/** An authentic provider pair-success calculation using only generated local keys. */
function successfulQrCredentials() {
  const creds = initAuthCreds(), accountKey = Curve.generateKeyPair();
  const details = proto.ADVDeviceIdentity.encode({ rawId: 123, timestamp: 1_700_000_000, keyIndex: 1 }).finish();
  const accountSignature = Curve.sign(accountKey.private, Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, details, creds.signedIdentityKey.public]));
  const account = proto.ADVSignedDeviceIdentity.encode({ details, accountSignatureKey: accountKey.public, accountSignature }).finish();
  const identity = proto.ADVSignedDeviceIdentityHMAC.encode({ details: account, hmac: hmacSign(account, Buffer.from(creds.advSecretKey, 'base64')) }).finish();
  const update = configureSuccessfulPairing({ tag: 'iq', attrs: { id: 'local-pair-success' }, content: [{ tag: 'pair-success', attrs: {}, content: [
    { tag: 'device-identity', attrs: {}, content: identity },
    { tag: 'device', attrs: { jid: '5511999999999:7@s.whatsapp.net', lid: '123456789012345@lid' } },
    { tag: 'platform', attrs: { name: 'android' } },
  ] }] }, creds).creds;
  assert.equal(Object.hasOwn(update, 'registered'), false, 'QR pairing does not update the registered flag in Baileys rc14');
  return Object.assign(creds, update);
}

test('real QR pairing credentials remain linked after memory persistence with registered false', async () => {
  const repo = memoryAuthRepository(), auth = await createPersistentAuth(repo);
  const paired = successfulQrCredentials();
  Object.assign(auth.state.creds, paired); await auth.saveCreds();
  const restarted = await createPersistentAuth(repo);
  assert.equal(restarted.state.creds.registered, false);
  assert.equal(restarted.state.creds.me?.id, paired.me?.id);
  assert.deepEqual(encodeSignedDeviceIdentity(restarted.state.creds.account!, true), encodeSignedDeviceIdentity(paired.account!, true));
  assert.equal(hasLinkedCredentials(restarted.state.creds), true);
  await restarted.reset();
  const removed = await createPersistentAuth(repo);
  assert.equal(hasLinkedCredentials(removed.state.creds), false);
  assert.equal(removed.state.creds.me, undefined); assert.equal(removed.state.creds.account, undefined);
});

test('filesystem restart restores QR linkage and reset cannot reimport its previous legacy credentials', async t => {
  const root = await fixture(t), directory = await safeSessionDirectory(root, 'owner', 'qr', true);
  const paired = successfulQrCredentials();
  await writeFile(path.join(directory, 'creds.json'), JSON.stringify(paired, BufferJSON.replacer));
  const auth = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  const signalKey = Buffer.from([1, 2, 3, 4]);
  await auth.state.keys.set({ session: { peer: signalKey } }); await auth.saveCreds(); await auth.drain();
  const restarted = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  assert.equal(restarted.state.creds.registered, false); assert.equal(hasLinkedCredentials(restarted.state.creds), true);
  assert.deepEqual(encodeSignedDeviceIdentity(restarted.state.creds.account!, true), encodeSignedDeviceIdentity(paired.account!, true));
  assert.deepEqual((await restarted.state.keys.get('session', ['peer'])).peer, signalKey);
  await restarted.reset(); await restarted.drain();
  const removed = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  assert.equal(hasLinkedCredentials(removed.state.creds), false);
  assert.equal(removed.state.creds.me, undefined); assert.equal((await removed.state.keys.get('session', ['peer'])).peer, undefined);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'creds.json'), 'utf8')).me.id, paired.me?.id, 'reset retains but never reimports the original QR file');
});

test('a phone-code request persisted before confirmation is not mistaken for a linked session', async t => {
  const root = await fixture(t), directory = await safeSessionDirectory(root, 'owner', 'pending-code', true);
  const auth = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  // requestPairingCode sets these fields and emits creds.update before the phone accepts.
  auth.state.creds.me = { id: '5511999999999@s.whatsapp.net', name: '~' };
  auth.state.creds.pairingCode = '12345678';
  await auth.saveCreds();
  const restarted = await createPersistentAuth(await filesystemAuthRepository(directory), directory);
  assert.ok(restarted.state.creds.me?.id); assert.equal(restarted.state.creds.account, undefined);
  assert.equal(restarted.state.creds.registered, false); assert.equal(hasLinkedCredentials(restarted.state.creds), false);
});

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

test('failed Signal writes stay pending and must become durable before credentials are reused', async () => {
  const repo = memoryAuthRepository(), auth = await createPersistentAuth(repo);
  const write = repo.write.bind(repo);
  let unavailable = true;
  repo.write = async entries => { if (unavailable) throw new Error('Temporary storage outage'); await write(entries); };
  const key = Buffer.from([7, 6, 5]);
  await assert.rejects(auth.state.keys.set({ session: { peer: key }, 'device-list': { peer: ['1'] } }));
  await assert.rejects(auth.drain(), 'drain must not report success with lost Signal keys');
  unavailable = false;
  await auth.drain();
  const loaded = await createPersistentAuth(repo);
  assert.deepEqual((await loaded.state.keys.get('session', ['peer'])).peer, key);
  assert.deepEqual((await loaded.state.keys.get('device-list', ['peer'])).peer, ['1']);
});

test('a later credentials save cannot discard a failed Signal write and pending deletes stay deleted', async () => {
  const repo = memoryAuthRepository(), auth = await createPersistentAuth(repo);
  await auth.state.keys.set({ session: { deleted: Buffer.from([1]) } });
  const write = repo.write.bind(repo);
  repo.write = async () => { throw new Error('Temporary storage outage'); };
  await assert.rejects(auth.state.keys.set({ session: { peer: Buffer.from([2]), deleted: null } }));
  repo.write = write;
  auth.state.creds.registered = true; await auth.saveCreds();
  const loaded = await createPersistentAuth(repo);
  assert.equal(loaded.state.creds.registered, true);
  assert.deepEqual((await loaded.state.keys.get('session', ['peer'])).peer, Buffer.from([2]));
  assert.equal((await loaded.state.keys.get('session', ['deleted'])).deleted, undefined);
});

test('revocation discards unsaved Signal keys instead of replaying them into fresh credentials', async () => {
  const repo = memoryAuthRepository(), auth = await createPersistentAuth(repo);
  const write = repo.write.bind(repo);
  repo.write = async () => { throw new Error('Temporary storage outage'); };
  await assert.rejects(auth.state.keys.set({ session: { peer: Buffer.from([3]) } }));
  repo.write = write;
  await auth.reset(); await auth.drain();
  assert.equal(auth.state.creds.registered, false);
  assert.equal((await auth.state.keys.get('session', ['peer'])).peer, undefined);
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
