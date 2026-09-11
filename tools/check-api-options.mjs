#!/usr/bin/env node
/** Offline checks using the INSTALLED Baileys. Never creates a WhatsApp socket. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { installContactGuard } from './patch-provider-contact-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function checkInstalledProviderGuard() {
  // --check never edits node_modules; build/postinstall installs the adapter.
  await installContactGuard(root, true);
  const source = await readFile(path.join(root, 'node_modules/@whiskeysockets/baileys/lib/Socket/chats.js'), 'utf8');
  const start = source.indexOf('const appPatch = async (patchCreate) => {');
  const end = source.indexOf('const fetchProps = async () => {', start);
  const block = source.slice(start, end);
  const run = async failure => {
    const sequence = [];
    const state = { version: 5, hash: Buffer.alloc(128), indexValueMap: {} };
    const appPatch = vm.runInNewContext(`${block}\nappPatch`, {
      config: { emitOwnEvents: false, zaptoboxContactGuard: async ({ stage }) => {
        sequence.push(stage); if (failure === stage) throw new Error('TEST_GUARD_REJECTION');
      } },
      authState: { creds: { myAppStateKeyId: 'FAKE_TEST_KEY', me: { id: 'fixture' } }, keys: {
        transaction: async fn => fn(), get: async (_type, names) => ({ [names[0]]: state }), set: async () => { sequence.push('persist'); },
      } },
      appStatePatchMutex: { mutex: async fn => fn() }, logger: { debug() {} },
      resyncAppState: async () => { sequence.push('resync'); }, ensureLTHashStateVersion: value => value,
      newLTHashState: () => state, getAppStateSyncKey: async () => ({ keyData: Buffer.alloc(32) }),
      encodeSyncdPatch: async () => { sequence.push('encode'); return { patch: {}, state: { ...state, version: 6 } }; },
      query: async () => { sequence.push('send'); }, S_WHATSAPP_NET: 's.whatsapp.net',
      proto: { SyncdPatch: { encode: () => ({ finish: () => Buffer.alloc(0) }) } },
    });
    const request = { type: 'critical_unblock_low', index: ['contact', 'fixture'] };
    if (failure) await assert.rejects(appPatch(request), /TEST_GUARD_REJECTION/);
    else await appPatch(request);
    return sequence;
  };
  assert.deepEqual(await run(), ['resync', 'before-encode', 'encode', 'before-send', 'send', 'persist']);
  assert.deepEqual(await run('before-encode'), ['resync', 'before-encode']);
  assert.deepEqual(await run('before-send'), ['resync', 'before-encode', 'encode', 'before-send']);
}
async function main() {
  process.chdir(root);
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24+ is required by this API.');
  const { default: UserConfig } = await import(pathToFileURL(path.join(root, 'dist/infra/config/env.js')).href);
  const options = UserConfig.whatsapp;
  console.log('Effective API options (secrets omitted):');
  console.log(JSON.stringify({ node: process.version, executable: process.execPath,
    SESSION: options.browser[0], BROWSER_NAME: options.browser[1], LOG_LEVEL: options.logLevel,
    BAILEYS_LOG_LEVEL: options.baileysLogLevel, LOG_REDACT_IDENTIFIERS: options.redactIdentifiers,
    CONTACT_SYNC_MODE: options.contactMode, CONTACT_SYNC_DIAGNOSTICS: options.contactDiagnostics,
    CONTACT_SYNC_REQUIRE_LID: options.contactRequireLid, CONTACT_SYNC_MIN_UPTIME_MS: options.contactMinUptimeMs,
    CONTACT_SYNC_COOLDOWN_MS: options.contactCooldownMs, WA_QUERY_TIMEOUT_MS: options.queryTimeoutMs }, null, 2));
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@whiskeysockets/baileys');
  const manifest = JSON.parse(await readFile(path.resolve(path.dirname(entry), '../package.json'), 'utf8'));
  assert.equal(manifest.version, '7.0.0-rc14');
  await checkInstalledProviderGuard();
  console.log('PASS: installed contact adapter blocks before encode/send (actual installed function, simulated dependencies).');
  const provider = await import('@whiskeysockets/baileys');
  const { proto, BufferJSON, initAuthCreds, generateRegistrationNode, chatModificationToAppPatch } = provider;
  for (const [name, fn] of Object.entries({ initAuthCreds, generateRegistrationNode, chatModificationToAppPatch })) assert.equal(typeof fn, 'function', `Provider export missing: ${name}`);
  // Fabricated credentials, never your own account's credentials.
  const payload = generateRegistrationNode(initAuthCreds(), { browser: options.browser, version: [2, 3000, 0], syncFullHistory: true, countryCode: 'BR' });
  const props = proto.DeviceProps.decode(payload.devicePairingData.deviceProps);
  assert.equal(props.os, options.browser[0]);
  console.log('PASS: registration DeviceProps contains the configured SESSION label.');
  const keyBytes = Buffer.alloc(32, 19);
  const key = proto.Message.AppStateSyncKeyData.create({ keyData: keyBytes });
  const reloaded = JSON.parse(JSON.stringify(key, BufferJSON.replacer), BufferJSON.reviver);
  const restored = proto.Message.AppStateSyncKeyData.fromObject(reloaded);
  assert.deepEqual(Buffer.from(restored.keyData), keyBytes);
  const authSource = await readFile(path.join(root, 'dist/infra/state/auth-state.js'), 'utf8');
  assert.ok(authSource.includes('AppStateSyncKeyData.fromObject(value)'), 'Rebuild the auth adapter.');
  console.log('PASS: protobuf key JSON round trip restores the original bytes.');
  const pn = '5511000000001@s.whatsapp.net';
  const action = { firstName: 'Teste', fullName: 'Teste Offline', lidJid: '123456789000001@lid', saveOnPrimaryAddressbook: true };
  const patch = chatModificationToAppPatch({ contact: action }, pn);
  assert.deepEqual(patch.index, ['contact', pn]); assert.equal(patch.type, 'critical_unblock_low');
  const decoded = proto.SyncActionValue.decode(proto.SyncActionValue.encode(patch.syncAction).finish());
  assert.equal(decoded.contactAction.firstName, action.firstName);assert.equal(decoded.contactAction.fullName, action.fullName);
  assert.equal(decoded.contactAction.lidJid, action.lidJid); assert.equal(decoded.contactAction.saveOnPrimaryAddressbook, true);
  console.log('PASS: contact fields survive the installed protobuf encoder/decoder.');
  console.log('No socket was created; no database was accessed; no contact was sent. These are offline checks, not WhatsApp acceptance tests.');
}
main().catch(error => {
  // Never dump arbitrary provider/bootstrap objects.
  const text = error instanceof Error ? error.message : 'Unknown verification error';
  console.error('API option check failed:', text.slice(0, 1500));
  process.exitCode = 1;
});
