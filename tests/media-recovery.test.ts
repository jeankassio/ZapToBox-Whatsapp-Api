import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { aesEncryptGCM, getMediaKeys, hkdf, proto, type downloadMediaMessage, type WAMessage, type WASocket } from '@whiskeysockets/baileys';
import MediaController from '../src/infra/http/controllers/media.js';
import type { ControllerDependencies } from '../src/infra/http/controllers/base.js';
import { reuploadHistoricalMedia } from '../src/infra/baileys/media-reupload.js';

const message = (url = 'https://mmg.whatsapp.net/expired'): WAMessage => ({
  key: { id: 'history-image', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
  message: { imageMessage: { url, mediaKey: Buffer.alloc(32, 1), mimetype: 'image/jpeg' } },
});
const repository = (stored: WAMessage): NonNullable<ControllerDependencies['repository']> => ({
  getMessageById: async (id, instance) => id === stored.key.id && instance === 'owner/second' ? stored : undefined,
  getLastMessageByInstance: async () => undefined, getContactById: async () => undefined,
});
const reupload = (socket: WASocket, candidate: WAMessage) => socket.updateMediaMessage(candidate);

test('real provider HTTP 404 renews expired historical media and downloads decrypted bytes', async t => {
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), randomBytes(128)]);
  const key = Buffer.alloc(32, 1);
  const { cipherKey, iv } = await getMediaKeys(key, 'image');
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final(), Buffer.alloc(10)]);
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    if (req.url === '/expired') { res.writeHead(404); res.end(); }
    else { res.writeHead(200); res.end(encrypted); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const stored = message(origin + '/expired');
  let renewals = 0;
  const socket = { logger: { info() {} }, updateMediaMessage: async (candidate: WAMessage) => {
    renewals++; assert.equal(candidate.key.id, stored.key.id);
    candidate.message!.imageMessage!.url = origin + '/renewed'; return candidate;
  } } as unknown as WASocket;
  const controller = new MediaController('owner', 'second', { socket, repository: repository(stored), reupload });
  const result = await controller.getMedia(stored.key.id!);
  assert.equal(result.success, true);
  assert.deepEqual(result.buffer, bytes);
  assert.equal(renewals, 1);
  assert.deepEqual(requests, ['/expired', '/renewed']);
  assert.equal(stored.message!.imageMessage!.url, origin + '/expired', 'normalizing the download must not mutate its source record');
  assert.equal((await new MediaController('owner', 'first', { socket, repository: repository(stored) }).getMedia(stored.key.id!)).statusCode, 404);
});

test('directPath-only history is downloadable without changing stored media metadata', async () => {
  const stored = message(); delete stored.message!.imageMessage!.url; stored.message!.imageMessage!.directPath = '/v/t62.7118-24/media';
  let attempts = 0;
  const download = (async (candidate: WAMessage) => {
    attempts++; assert.match(candidate.message!.imageMessage!.url!, /^https:\/\//);
    assert.equal(new URL(candidate.message!.imageMessage!.url!).pathname, stored.message!.imageMessage!.directPath);
    return Buffer.from('media');
  }) as typeof downloadMediaMessage;
  const result = await new MediaController('owner', 'second', { socket: {} as WASocket, repository: repository(stored), download }).getMedia(stored.key.id!);
  assert.equal(result.success, true); assert.equal(attempts, 1); assert.equal(stored.message!.imageMessage!.url, undefined);
});

test('unavailable media requests a single renewal and returns 410 without private provider errors', async () => {
  const stored = message(); let renewals = 0, downloads = 0;
  const download = (async () => { downloads++; throw { output: { statusCode: 410 }, message: 'private media URL' }; }) as typeof downloadMediaMessage;
  const socket = { logger: {}, updateMediaMessage: async (candidate: WAMessage) => { renewals++; return candidate; } } as unknown as WASocket;
  const result = await new MediaController('owner', 'second', { socket, repository: repository(stored), download, reupload }).getMedia(stored.key.id!);
  assert.equal(result.statusCode, 410); assert.equal(renewals, 1); assert.equal(downloads, 2);
  assert.doesNotMatch(JSON.stringify(result), /private media URL/);
});

test('provider-internal renewal is never repeated by the compatibility fallback', async () => {
  const stored = message(); let renewals = 0;
  const download = (async (candidate: WAMessage, _type: unknown, _options: unknown, context: any) => {
    await context.reuploadRequest(candidate); throw { output: { statusCode: 404 } };
  }) as typeof downloadMediaMessage;
  const socket = { logger: {}, updateMediaMessage: async (candidate: WAMessage) => { renewals++; return candidate; } } as unknown as WASocket;
  const result = await new MediaController('owner', 'second', { socket, repository: repository(stored), download, reupload }).getMedia(stored.key.id!);
  assert.equal(result.statusCode, 410); assert.equal(renewals, 1);
});

test('a disconnect during downloading remains 409 and never sends a renewal over the stale socket', async () => {
  const stored = message(); let renewals = 0;
  const socket = { ws: { isOpen: true }, logger: {}, updateMediaMessage: async (candidate: WAMessage) => { renewals++; return candidate; } };
  const download = (async () => { socket.ws.isOpen = false; throw { output: { statusCode: 404 } }; }) as typeof downloadMediaMessage;
  const result = await new MediaController('owner', 'second', { socket: socket as unknown as WASocket, repository: repository(stored), download }).getMedia(stored.key.id!);
  assert.equal(result.statusCode, 409); assert.equal(renewals, 0);
});

test('temporary upstream failures stay retryable and do not trigger reupload', async () => {
  const stored = message(); let renewals = 0;
  const socket = { logger: {}, updateMediaMessage: async (candidate: WAMessage) => { renewals++; return candidate; } } as unknown as WASocket;
  const download = (async () => { throw { output: { statusCode: 503 } }; }) as typeof downloadMediaMessage;
  const result = await new MediaController('owner', 'second', { socket, repository: repository(stored), download }).getMedia(stored.key.id!);
  assert.equal(result.statusCode, 502); assert.equal(renewals, 0);
});

function renewalFixture() {
  const stored = message(); const ev = new EventEmitter();
  const socket = { ev, authState: { creds: { me: { id: '5511888888888:2@s.whatsapp.net' } } }, getMediaHost: () => 'mmg.whatsapp.net', sendNode: async (_node: any) => {} };
  const response = (result = proto.MediaRetryNotification.ResultType.SUCCESS) => {
    const iv = randomBytes(12);
    const key = hkdf(stored.message!.imageMessage!.mediaKey!, 32, { info: 'WhatsApp Media Retry Notification' });
    const plaintext = proto.MediaRetryNotification.encode({ result, directPath: '/v/renewed-media' }).finish();
    return { key: stored.key, media: { iv, ciphertext: aesEncryptGCM(plaintext, key, iv, Buffer.from(stored.key.id!)) } };
  };
  return { stored, socket, ev, response };
}

test('bounded renewal decrypts the device response, persists metadata and ignores another chat', async () => {
  const f = renewalFixture(); const updates: any[] = [];
  f.ev.on('messages.update', update => updates.push(update));
  f.socket.sendNode = async node => {
    assert.equal(node.tag, 'receipt'); assert.equal(node.attrs.id, f.stored.key.id);
    f.ev.emit('messages.media-update', [{ ...f.response(), key: { ...f.stored.key, remoteJid: 'another@s.whatsapp.net' } }]);
    assert.equal(updates.length, 0);
    f.ev.emit('messages.media-update', [f.response()]);
  };
  const result = await reuploadHistoricalMedia(f.socket as unknown as WASocket, f.stored);
  assert.equal(result.message!.imageMessage!.directPath, '/v/renewed-media');
  assert.equal(result.message!.imageMessage!.url, 'https://mmg.whatsapp.net/v/renewed-media');
  assert.equal(updates.length, 1); assert.equal(updates[0][0].update.message, result.message);
  assert.equal(f.ev.listenerCount('messages.media-update'), 0); assert.equal(f.ev.listenerCount('connection.update'), 0);
});

test('renewal timeout releases listeners and late responses do not change stored metadata', async () => {
  const f = renewalFixture();
  await assert.rejects(reuploadHistoricalMedia(f.socket as unknown as WASocket, f.stored, 5), (error: any) => error.statusCode === 504);
  assert.equal(f.ev.listenerCount('messages.media-update'), 0); assert.equal(f.ev.listenerCount('connection.update'), 0);
  f.ev.emit('messages.media-update', [f.response()]);
  assert.equal(f.stored.message!.imageMessage!.directPath, undefined);
});

test('device-disconnect and unrecoverable media release renewal listeners with distinct statuses', async () => {
  for (const status of [409, 410, 502]) {
    const f = renewalFixture();
    f.socket.sendNode = async () => {
      if (status === 409) f.ev.emit('connection.update', { connection: 'close' });
      else if (status === 410) f.ev.emit('messages.media-update', [f.response(proto.MediaRetryNotification.ResultType.NOT_FOUND)]);
      else throw new Error('private socket error');
    };
    await assert.rejects(reuploadHistoricalMedia(f.socket as unknown as WASocket, f.stored), (error: any) => error.statusCode === status && !error.message.includes('private'));
    assert.equal(f.ev.listenerCount('messages.media-update'), 0); assert.equal(f.ev.listenerCount('connection.update'), 0);
  }
});
