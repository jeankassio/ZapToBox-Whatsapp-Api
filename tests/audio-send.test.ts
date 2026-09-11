import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import { generateWAMessageContent, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import MessagesController from '../src/infra/http/controllers/messages.js';
import { RequestError } from '../src/infra/http/controllers/base.js';
import MessageRoutes from '../src/infra/http/routes/messages.js';
import Token from '../src/infra/state/auth.js';
import { instances, instanceStatus } from '../src/shared/constants.js';

// Real 60 ms mono Ogg/Opus silence generated locally with FFmpeg, never sent to WhatsApp.
const opus = Buffer.from('T2dnUwACAAAAAAAAAADVV+vnAAAAAM0exNEBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAANVX6+cBAAAAK4z2AwE9T3B1c1RhZ3MMAAAATGF2ZjYyLjMuMTAwAQAAAB0AAABlbmNvZGVyPUxhdmM2Mi4xMS4xMDAgbGlib3B1c09nZ1MABHgMAAAAAAAA1Vfr5wIAAAA4EqMUBAMDAwP4//74//74//74//4=', 'base64');
const jid = '551188887777@s.whatsapp.net';
const secret = 'test-only-audio-secret-not-production-123456';
const source = 'https://media.example.test/recording.ogg';
const input = (mimetype = 'audio/ogg; codecs=opus', ptt = true) => ({ remoteJid: jid, message: { audio: { url: source }, mimetype, ptt } });
const sent = (): WAMessage => ({ key: { id: 'locally-generated-message-id', remoteJid: jid, fromMe: true }, messageTimestamp: 1_800_000_000, message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } });

async function fixture(t: TestContext, options: { bytes?: Buffer; send?: WASocket['sendMessage']; onSent?: (message: WAMessage) => Promise<void> } = {}) {
  let downloads = 0;
  const calls: any[] = [], persisted: WAMessage[] = [];
  const socket = { sendMessage: async (...args: any[]) => { calls.push(args); return options.send ? options.send(...args as Parameters<WASocket['sendMessage']>) : sent(); } } as unknown as WASocket;
  const app = express();
  app.use(express.json()); app.use(new Token(secret).verify);
  app.use('/messages', new MessageRoutes((owner, name, target, delay) => new MessagesController(owner, name, target, delay, {
    socket, fetchMedia: async () => { downloads++; return options.bytes ?? opus; },
    onSent: options.onSent ?? (async message => { persisted.push(message); }),
  })).get());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(body = input(), path = '/messages/sendAudio/owner/session', token = secret) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { request, calls, persisted, downloads: () => downloads };
}

test('voice note sends real Ogg bytes, canonical Opus MIME and PTT through the authenticated audio route', async t => {
  const f = await fixture(t);
  const result = await f.request(input('audio/ogg'));
  assert.equal(result.status, 200);
  assert.equal(result.body.messageId, 'locally-generated-message-id');
  assert.deepEqual(f.calls[0], [jid, { audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true }, {}]);
  assert.equal(f.persisted.length, 1);
  assert.equal(f.downloads(), 1);
});

test('incompatible MIME is rejected before download, and actual browser bytes cannot masquerade as Ogg', async t => {
  const f = await fixture(t);
  for (const [mime, ptt] of [['audio/webm;codecs=opus', false], ['audio/wav', false], ['audio/flac', false], ['audio/mpeg', true], ['video/mp4', false]] as const) {
    assert.equal((await f.request(input(mime, ptt))).status, 415);
  }
  assert.equal(f.downloads(), 0);
  assert.equal(f.calls.length, 0);
  for (const bytes of [Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]), Buffer.from('RIFFtest'), Buffer.from('fLaCtest'), Buffer.alloc(0), opus.subarray(0, 47)]) {
    const invalid = await fixture(t, { bytes });
    assert.equal((await invalid.request()).status, 415);
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.persisted.length, 0);
  }
  const stereo = Buffer.from(opus); stereo[37] = 2;
  const wrongChannels = await fixture(t, { bytes: stereo });
  assert.equal((await wrongChannels.request()).status, 415);
});

test('ordinary audio keeps PTT false and the existing byte/MIME contract', async t => {
  const bytes = Buffer.from('ID3-existing-upload');
  const f = await fixture(t, { bytes });
  const result = await f.request(input('audio/mpeg', false));
  assert.equal(result.status, 200);
  assert.deepEqual(f.calls[0][1], { audio: bytes, mimetype: 'audio/mpeg', ptt: false });
});

test('audio authorization and invalid PTT values never reach media download or provider', async t => {
  const f = await fixture(t);
  const token = jwt.sign({ owner: 'owner', instanceName: 'session' }, secret, { algorithm: 'HS256', expiresIn: 60 });
  assert.equal((await f.request(input(), '/messages/sendAudio/other/session', token)).status, 403);
  assert.equal((await f.request(input(), '/messages/sendAudio/owner/other', token)).status, 403);
  const malformed = input(); (malformed.message as any).ptt = 'true';
  assert.equal((await f.request(malformed)).status, 400);
  assert.equal(f.downloads(), 0); assert.equal(f.calls.length, 0);
});

test('provider audio errors and absent identifiers return failure without a success bubble or local persistence', async t => {
  for (const send of [async () => { throw new Error('private-provider-upload-token'); }, async () => undefined]) {
    const f = await fixture(t, { send });
    const result = await f.request();
    assert.equal(result.status, 502); assert.equal(result.body.success, false);
    assert.equal(result.body.messageId, undefined); assert.equal(f.persisted.length, 0);
    assert.doesNotMatch(JSON.stringify(result.body), /private-provider-upload-token/);
  }
});

test('relayed audio preserves its identifier if subsequent local storage fails', async t => {
  const f = await fixture(t, { onSent: async () => { throw new Error('storage-unavailable'); } });
  const result = await f.request();
  assert.equal(result.status, 200); assert.equal(result.body.syncPending, true);
  assert.equal(result.body.messageId, 'locally-generated-message-id'); assert.equal(f.calls.length, 1);
});

test('audio download started on a detached socket is never sent through its replacement', async () => {
  const key = 'audio-owner/audio-session';
  let resolveDownload!: (bytes: Buffer) => void, calls = 0;
  const first = { sendMessage: async () => { calls++; return sent(); } } as unknown as WASocket;
  const second = { ...first } as WASocket;
  let active = first;
  instances[key] = { getSock: () => active } as typeof instances[string]; instanceStatus.set(key, 'ONLINE');
  try {
    const controller = new MessagesController('audio-owner', 'audio-session', jid, 0, { fetchMedia: () => new Promise(resolve => { resolveDownload = resolve; }) });
    const pending = controller.sendMessageAudio(input().message);
    active = second; resolveDownload(opus);
    await assert.rejects(pending, error => error instanceof RequestError && error.statusCode === 409);
    assert.equal(calls, 0);
  } finally { delete instances[key]; instanceStatus.delete(key); }
});

test('installed Baileys prepares the converted recording as a native voice note without transcoding', async () => {
  let uploads = 0;
  const message = await generateWAMessageContent({ audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true, waveform: new Uint8Array([0]) }, {
    userJid: jid,
    upload: async () => { uploads++; return { mediaUrl: 'https://media.example.test/encrypted', directPath: '/fixture-only' }; },
  });
  assert.equal(uploads, 1);
  assert.equal(message.audioMessage?.ptt, true);
  assert.equal(message.audioMessage?.mimetype, 'audio/ogg; codecs=opus');
  assert.equal(Number(message.audioMessage?.fileLength), opus.length);
  assert.ok(Number.isFinite(message.audioMessage?.seconds), 'the real codec/container allows provider duration extraction');
  assert.ok(message.audioMessage?.mediaKey?.length);
});
