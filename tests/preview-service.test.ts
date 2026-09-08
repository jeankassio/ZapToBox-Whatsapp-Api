import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { generateWAMessageContent } from '@whiskeysockets/baileys';
import { extractPreviewLink, LinkPreviewService } from '../src/infra/link-preview/service.js';
import { createPreviewFetcher } from '../src/infra/link-preview/fetch.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const html = '<title>Página &amp; teste</title><meta property="og:description" content=" Uma   descrição "><meta property="og:image" content="../picture.png">';
const raster = (url: string) => ({ url, contentType: 'image/png', body: Buffer.from('fixture-image') });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('link extraction handles HTTP(S), bare domains and punctuation while skipping emails and other schemes', () => {
  assert.deepEqual(extractPreviewLink('Veja (https://example.com/article).'), { url: 'https://example.com/article', matched: 'https://example.com/article' });
  assert.deepEqual(extractPreviewLink('www.example.com/a_(b)'), { url: 'https://www.example.com/a_(b)', matched: 'www.example.com/a_(b)' });
  assert.deepEqual(extractPreviewLink('example.com.br/path#section'), { url: 'https://example.com.br/path', matched: 'example.com.br/path#section' });
  assert.equal(extractPreviewLink('http://example.com/test')?.url, 'http://example.com/test');
  assert.equal(extractPreviewLink('[Página](https://example.com/article)')?.url, 'https://example.com/article');
  assert.equal(extractPreviewLink('Veja:https://example.com/article')?.url, 'https://example.com/article');
  for (const text of ['Sem link', 'pessoa@example.com', 'https://user:password@example.com/private', 'ftp://example.com/file', 'https://example.com:8443/admin']) assert.equal(extractPreviewLink(text), null, text);
  assert.equal(extractPreviewLink('a.'.repeat(32_768)), null);
});

test('preview parses downloaded metadata and supplies only ready JPEG bytes with one shared deadline signal', async () => {
  const calls: { url: string; maxBytes: number; signal: AbortSignal }[] = [];
  let thumbnailSignal: AbortSignal | undefined;
  const service = new LinkPreviewService({
    fetchResource: async (url, options) => {
      calls.push({ url, ...options });
      return calls.length === 1 ? { url: 'https://example.com/final/article', contentType: 'text/html', body: Buffer.from(html) } : raster(url);
    },
    createThumbnail: async (buffer, signal) => { assert.equal(buffer.toString(), 'fixture-image'); thumbnailSignal = signal; return jpeg; },
  });
  const result = await service.preview('owner/one', 'https://example.com/start');
  assert.deepEqual(result, { 'canonical-url': 'https://example.com/final/article', 'matched-text': 'https://example.com/start', title: 'Página & teste', description: 'Uma descrição', jpegThumbnail: jpeg });
  assert.deepEqual(calls.map(call => [call.url, call.maxBytes]), [['https://example.com/start', 512 * 1024], ['https://example.com/picture.png', 5 * 1024 * 1024]]);
  assert.equal(calls[0]?.signal, calls[1]?.signal);
  assert.equal(thumbnailSignal, calls[0]?.signal);
  assert.equal(Object.hasOwn(result!, 'originalThumbnailUrl'), false);
  assert.equal(Object.hasOwn(result!, 'highQualityThumbnail'), false);
});

test('Twitter image metadata, XHTML and small direct raster links can create previews', async () => {
  const service = new LinkPreviewService({
    fetchResource: async url => url.endsWith('/article') ? { url, contentType: 'application/xhtml+xml', body: Buffer.from('<meta name="twitter:title" content="Twitter title"><meta name="twitter:image" content="/photo.png">') } : raster(url),
    createThumbnail: async () => jpeg,
  });
  assert.equal((await service.preview('owner/one', 'https://example.com/article'))?.title, 'Twitter title');
  assert.deepEqual((await service.preview('owner/one', 'https://example.com/direct.png'))?.jpegThumbnail, jpeg);
});

test('cache and in-flight work are isolated by connection, deduplicated by URL and return independent buffers', async () => {
  const gate = deferred<void>();
  let requests = 0;
  const service = new LinkPreviewService({ fetchResource: async url => { requests++; await gate.promise; return raster(url); }, createThumbnail: async () => jpeg });
  const first = service.preview('owner/one', 'https://example.com/image#one');
  const second = service.preview('owner/one', 'https://example.com/image#two');
  const other = service.preview('owner/two', 'https://example.com/image#one');
  await tick();
  assert.equal(requests, 2);
  gate.resolve();
  const [a, b, c] = await Promise.all([first, second, other]);
  assert.equal(a?.['matched-text'], 'https://example.com/image#one');
  assert.equal(b?.['matched-text'], 'https://example.com/image#two');
  a!.jpegThumbnail![0] = 0;
  assert.equal(b?.jpegThumbnail?.[0], 0xff);
  assert.equal(c?.jpegThumbnail?.[0], 0xff);
  assert.equal((await service.preview('owner/one', 'https://example.com/image'))?.jpegThumbnail?.[0], 0xff);
  assert.equal(requests, 2);
});

test('cache expires successes and failures and evicts within each connection and globally', async () => {
  let now = 0;
  const calls: string[] = [];
  const service = new LinkPreviewService({ now: () => now, ttlMs: 100, failureTtlMs: 20, maxEntries: 2, maxEntriesPerConnection: 1,
    fetchResource: async url => { calls.push(url); if (url.endsWith('/failure')) throw new Error('fixture private failure'); return raster(url); }, createThumbnail: async () => jpeg });
  const preview = (connection: string, name: string) => service.preview(connection, 'https://example.com/' + name);
  await preview('owner/one', 'a');
  await preview('owner/one', 'b');
  await preview('owner/one', 'a');
  assert.equal(calls.length, 3, 'one connection cannot consume more than its quota');
  await preview('owner/two', 'b');
  await preview('owner/three', 'c');
  await preview('owner/one', 'a');
  assert.equal(calls.length, 6, 'global cache stays bounded across connections');
  now = 101;
  await preview('owner/one', 'a');
  assert.equal(calls.length, 7);
  assert.equal(await preview('owner/one', 'failure'), null);
  assert.equal(await preview('owner/one', 'failure'), null);
  assert.equal(calls.length, 8);
  now += 21;
  assert.equal(await preview('owner/one', 'failure'), null);
  assert.equal(calls.length, 9);
});

test('preview work across connections never exceeds four active jobs', async () => {
  let active = 0, maximum = 0;
  const service = new LinkPreviewService({ fetchResource: async (url, { signal }) => {
    active++; maximum = Math.max(maximum, active);
    try { await sleep(10, undefined, { signal }); return raster(url); }
    finally { active--; }
  }, createThumbnail: async () => jpeg });
  const values = await Promise.all(Array.from({ length: 12 }, (_, index) => service.preview('owner/' + index, 'https://example.com/image')));
  assert.ok(values.every(value => value?.jpegThumbnail));
  assert.equal(maximum, 4);
});

test('deadline includes queued time and returns text fallback even when a dependency fails to honor abort', async () => {
  const gate = deferred<void>();
  let calls = 0;
  const service = new LinkPreviewService({ timeoutMs: 40, concurrency: 1, fetchResource: async url => { calls++; if (calls === 1) await gate.promise; return raster(url); }, createThumbnail: async () => jpeg });
  const started = Date.now();
  const first = service.preview('owner/one', 'https://example.com/first');
  const queued = service.preview('owner/two', 'https://example.com/queued');
  assert.deepEqual(await Promise.all([first, queued]), [null, null]);
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1, 'a queued request that expires must not start a download');
  gate.resolve();
  await tick();
  assert.ok(await service.preview('owner/three', 'https://example.com/after'));
});

test('missing, invalid, oversized and unsupported resources fall back without exposing parser or decoder failures', async () => {
  const cases = [
    { type: 'text/html', body: '<title>No advertised image</title>' },
    { type: 'text/html', body: '<meta property="og:image" content="http://[">' },
    { type: 'application/octet-stream', body: 'untrusted bytes' },
    { type: 'text/html', body: 'x'.repeat(512 * 1024 + 1) },
  ];
  for (const fixture of cases) {
    let decodes = 0;
    const service = new LinkPreviewService({ fetchResource: async url => ({ url, contentType: fixture.type, body: Buffer.from(fixture.body) }), createThumbnail: async () => { decodes++; return jpeg; } });
    assert.equal(await service.preview('owner/one', 'https://example.com'), null);
    assert.equal(decodes, 0);
  }
  const failedDecoder = new LinkPreviewService({ fetchResource: async url => raster(url), createThumbnail: async () => { throw new Error('private decode detail'); } });
  assert.equal(await failedDecoder.preview('owner/one', 'https://example.com/image'), null);
  const hugeThumbnail = new LinkPreviewService({ fetchResource: async url => raster(url), createThumbnail: async () => Buffer.alloc(64 * 1024 + 1) });
  assert.equal(await hugeThumbnail.preview('owner/one', 'https://example.com/image'), null);
});

test('real bounded HTTP transport, HTML parsing, image worker and message generation preserve a complete preview', async t => {
  const png = await sharp({ create: { width: 640, height: 320, channels: 3, background: '#ed2638' } }).png().toBuffer();
  const server = createServer((req, res) => {
    if (req.url === '/start') { res.writeHead(302, { location: '/article' }); res.end(); }
    else if (req.url === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
      res.end(gzipSync('<title>Prévia integrada</title><meta property="og:image" content="/photo.png">'));
    } else if (req.url === '/photo.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
    else { res.writeHead(404); res.end(); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const calls: string[] = [];
  const fetchResource = createPreviewFetcher({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    request: (url, options, callback) => { calls.push(url.toString()); return request(local + url.pathname, options, callback); },
  });
  const service = new LinkPreviewService({ fetchResource });
  const text = 'Leia https://public.example/start';
  const preview = await service.preview('owner/one', text);
  assert.ok(preview?.jpegThumbnail);
  assert.equal(preview.title, 'Prévia integrada');
  const metadata = await sharp(preview.jpegThumbnail).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 320);
  assert.equal(metadata.height, 160);
  assert.ok(preview.jpegThumbnail.length <= 64 * 1024);
  assert.deepEqual(calls, ['https://public.example/start', 'https://public.example/article', 'https://public.example/photo.png']);
  let implicit = 0;
  const generated = await generateWAMessageContent({ text, linkPreview: preview }, { userJid: '5511999999999@s.whatsapp.net', getUrlInfo: async () => { implicit++; return undefined; } });
  assert.equal(generated.extendedTextMessage?.title, 'Prévia integrada');
  assert.equal(generated.extendedTextMessage?.text, text);
  assert.deepEqual(generated.extendedTextMessage?.jpegThumbnail, preview.jpegThumbnail);
  assert.equal(implicit, 0);
});
