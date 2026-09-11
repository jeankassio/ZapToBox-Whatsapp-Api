import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import sharp from 'sharp';
import MediaController, { type MediaDependencies } from '../src/infra/http/controllers/media.js';
import MediaRoutes from '../src/infra/http/routes/media.js';
import Token from '../src/infra/state/auth.js';
import Repository, { prisma } from '../src/core/connection/prisma.js';
import { embeddedJpegThumbnail } from '../src/infra/mappers/thumbnail.js';

const remoteJid = '5511999999999@s.whatsapp.net', secret = 'thumbnail-qa-not-production-123456789';
const jpeg = () => sharp({ create: { width: 2, height: 2, channels: 3, background: '#778899' } }).jpeg().toBuffer();
const payload = (value: unknown, type = 'imageMessage') => ({ message: { [type]: { jpegThumbnail: value, url: 'https://never-fetch.invalid/original', mediaKey: 'private' } } });
async function fixture(t: TestContext, thumbnailPayloads: NonNullable<MediaDependencies['thumbnailPayloads']>) {
  const app = express(); app.use(express.json()); app.use(new Token(secret).verify);
  app.use('/media', new MediaRoutes((owner, name) => new MediaController(owner, name, {
    thumbnailPayloads,
    download: async () => { throw new Error('Thumbnail lookup must not download'); },
    reupload: async () => { throw new Error('Thumbnail lookup must not call WhatsApp'); },
  })).get());
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (body: unknown, token: string | null = secret, suffix = '/owner/one') => {
    const response = await fetch(`${origin}/media/thumbnails${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
}

test('batch thumbnails work without a socket, use one scoped lookup and expose only requested JPEGs', async t => {
  const bytes = await jpeg(), base64 = bytes.toString('base64'); const calls: unknown[][] = [];
  const request = await fixture(t, async (...args) => {
    calls.push(args);
    return [{ messageId: 'image', content: payload({ type: 'Buffer', data: base64 }) }, { messageId: 'video', content: payload(base64, 'videoMessage') }];
  });
  const result = await request({ messageIds: ['image', 'video', 'missing', 'image'], remoteJid });
  assert.equal(result.status, 200); assert.deepEqual(calls, [['owner/one', ['image', 'video', 'missing'], remoteJid]]);
  assert.deepEqual(result.body, { success: true, data: { items: [{ messageId: 'image', thumbnail: base64 }, { messageId: 'video', thumbnail: base64 }, { messageId: 'missing', thumbnail: null }] } });
  assert.doesNotMatch(JSON.stringify(result.body), /mediaKey|private|https:|url|content/);
});

test('thumbnail query enforces auth, tenant scope and bounded IDs before querying', async t => {
  let calls = 0; const request = await fixture(t, async () => { calls++; return []; });
  const body = { messageIds: ['image'], remoteJid };
  assert.equal((await request(body, null)).status, 401);
  const token = jwt.sign({ owner: 'owner', instanceName: 'one' }, secret, { algorithm: 'HS256', expiresIn: 60 });
  for (const suffix of ['/foreign/one', '/owner/other']) assert.equal((await request(body, token, suffix)).status, 403);
  for (const invalid of [[], {}, { messageIds: [] }, { messageIds: Array.from({ length: 41 }, (_, i) => String(i)) }, { messageIds: ['bad\n'] }, { messageIds: [null] }, { ...body, remoteJid: 'not-a-jid' }]) assert.equal((await request(invalid)).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request({ messageIds: Array.from({ length: 40 }, (_, i) => `id-${i}`) }, token)).body.data.items.length, 40);
  assert.equal(calls, 1);
});

test('stored thumbnail lookup makes one instance/conversation query selecting no other columns', async t => {
  const original = prisma.message.findMany; const queries: unknown[] = [];
  prisma.message.findMany = (async (query: unknown) => { queries.push(query); return []; }) as typeof original;
  t.after(() => { prisma.message.findMany = original; });
  await Repository.getMessageThumbnailPayloads('owner/one', ['image', 'video'], remoteJid);
  assert.deepEqual(queries, [{ where: { instance: 'owner/one', messageId: { in: ['image', 'video'] }, remoteJid }, select: { messageId: true, content: true } }]);
});

test('thumbnail decoder handles wrappers and legacy bytes but rejects non-JPEG, oversized and corrupt data', async () => {
  const bytes = await jpeg(), base64 = bytes.toString('base64');
  const wrapped = { message: { ephemeralMessage: { message: payload({ type: 'Buffer', data: base64 }, 'videoMessage').message } } };
  assert.equal(await embeddedJpegThumbnail(wrapped), base64);
  assert.equal(await embeddedJpegThumbnail(payload({ type: 'Buffer', data: [...bytes] })), base64);
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#778899' } }).png().toBuffer();
  const hugePixels = await sharp({ create: { width: 1400, height: 800, channels: 3, background: '#778899' } }).jpeg().toBuffer();
  for (const value of [undefined, 'not base64!', png.toString('base64'), Buffer.alloc(32769).toString('base64'), '/9j/2Q==', hugePixels.toString('base64'), bytes.subarray(0, bytes.length - 2).toString('base64')]) assert.equal(await embeddedJpegThumbnail(payload(value)), null);
  assert.equal(await embeddedJpegThumbnail({ message: null }), null);
  assert.equal(await embeddedJpegThumbnail({ message: { conversation: 'text' } }), null);
});
