import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type RequestListener, type RequestOptions } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { gzipSync, gunzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createPreviewFetcher, previewAddressIsPublic, safePreviewUrl } from '../src/infra/link-preview/fetch.js';

const publicAddress = { address: '93.184.216.34', family: 4 };
const isAbort = (error: any) => error?.name === 'AbortError' || error?.code === 'PREVIEW_ABORTED';
function deadline(t: TestContext, ms = 2000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
  t.after(() => clearTimeout(timer));
  return controller.signal;
}

async function fixture(t: TestContext, handler: RequestListener, resolver?: (host: string, signal: AbortSignal) => Promise<{ address: string; family: number }[]>) {
  const server = createServer(handler).listen(0, '127.0.0.1'); await once(server, 'listening');
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); });
  const calls: { url: URL; options: RequestOptions }[] = [], lookups: string[] = [];
  const fetch = createPreviewFetcher({
    resolve: async (host, signal) => { lookups.push(host); return resolver ? resolver(host, signal) : [publicAddress]; },
    request: (url, options, callback) => {
      calls.push({ url, options });
      // Controlled local server is a test-only transport; all production URL/DNS checks still run.
      return request(local + url.pathname + url.search, options, callback);
    },
  });
  return { fetch, calls, lookups };
}

test('preview destinations reject private, special, encoded IPv4 and IPv6 transition addresses', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.1.1', '192.168.1.1', '192.88.99.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fec0::1', 'fc00::1', '64:ff9b::7f00:1', '64:ff9b:1::1', '2001::1', '2002:7f00:1::1', '2001:db8::1', '3fff::1']) assert.equal(previewAddressIsPublic(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(previewAddressIsPublic(address), true, address);
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://127.1/', 'http://0177.0.0.1/', 'https://[::ffff:127.0.0.1]/']) assert.throws(() => safePreviewUrl(url));
});

test('preview URLs allow only standard HTTP/HTTPS without embedded credentials or control characters', () => {
  for (const url of ['file:///etc/passwd', 'data:image/png;base64,abc', 'ftp://example.com/a', 'https://user:pass@example.com/', 'https://example.com:444/', 'http://example.com:443/', 'https://example.com/a\n', 'https://example.com\\@127.0.0.1/a', 'https://example.com/' + 'a'.repeat(4096)]) assert.throws(() => safePreviewUrl(url));
  assert.equal(safePreviewUrl('https://example.com:443/page?a=1#section').href, 'https://example.com/page?a=1');
  assert.equal(safePreviewUrl('http://example.com:80/').href, 'http://example.com/');
});

test('HTML and image requests pin the checked DNS address and never include application credentials', async t => {
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<title>Example</title>'); });
  const result = await f.fetch('https://public.example/page', { signal: deadline(t), maxBytes: 1024 });
  assert.equal(result.body.toString(), '<title>Example</title>'); assert.equal(result.contentType, 'text/html');
  assert.deepEqual(f.lookups, ['public.example']);
  const options = f.calls[0]!.options;
  assert.equal(options.agent, false); assert.equal(options.method, 'GET');
  const headers = options.headers as Record<string, string>;
  assert.equal(headers['accept-encoding'], 'identity');
  for (const key of ['authorization', 'cookie', 'referer', 'x-webhook-secret']) assert.equal(headers[key], undefined);
  const pinned = await new Promise(resolve => (options.lookup as any)('public.example', { all: true }, (_error: unknown, addresses: unknown) => resolve(addresses)));
  assert.deepEqual(pinned, [publicAddress]);
});

test('a mixed public/private DNS answer is rejected before any connection even for trusted media origins', async t => {
  const previous = process.env.TRUSTED_MEDIA_ORIGINS; process.env.TRUSTED_MEDIA_ORIGINS = 'https://public.example';
  t.after(() => { if (previous === undefined) delete process.env.TRUSTED_MEDIA_ORIGINS; else process.env.TRUSTED_MEDIA_ORIGINS = previous; });
  const f = await fixture(t, (_req, res) => res.end('must not request'), async () => [publicAddress, { address: '127.0.0.1', family: 4 }]);
  await assert.rejects(f.fetch('https://public.example', { signal: deadline(t), maxBytes: 1024 }), { code: 'PREVIEW_DESTINATION_REJECTED' });
  assert.equal(f.calls.length, 0);
});

test('redirects validate every destination, support public relative URLs and stop loops', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/valid') { res.end('done'); return; }
    const location = req.url === '/private' ? 'http://127.0.0.1/secret' : req.url === '/dns-private' ? 'https://internal.example/' : req.url === '/broken' ? 'http://[' : req.url === '/loop' ? '/loop' : '/valid';
    res.writeHead(302, { location }); res.end('ignored');
  }, async host => host === 'internal.example' ? [{ address: '192.168.0.1', family: 4 }] : [publicAddress]);
  const options = { signal: deadline(t), maxBytes: 1024 };
  assert.equal((await f.fetch('https://public.example/start', options)).url, 'https://public.example/valid');
  for (const path of ['/private', '/dns-private', '/broken']) await assert.rejects(f.fetch('https://public.example' + path, options));
  const before = f.calls.length;
  await assert.rejects(f.fetch('https://public.example/loop', options), { code: 'PREVIEW_REDIRECT_LIMIT' });
  assert.equal(f.calls.length - before, 4);
});

test('same-host redirects reject DNS rebinding before opening the next connection', async t => {
  let resolutions = 0;
  const f = await fixture(t, (_req, res) => { res.writeHead(302, { location: '/again' }); res.end(); },
    async () => ++resolutions === 1 ? [publicAddress] : [{ address: '169.254.169.254', family: 4 }]);
  await assert.rejects(f.fetch('https://public.example/start', { signal: deadline(t), maxBytes: 1024 }), { code: 'PREVIEW_DESTINATION_REJECTED' });
  assert.deepEqual(f.lookups, ['public.example', 'public.example']);
  assert.equal(f.calls.length, 1, 'the rebound destination must never receive an HTTP request');
});

test('DNS, waiting for headers, response streaming and redirects share the caller deadline', async t => {
  const unresolved = createPreviewFetcher({ resolve: () => new Promise(() => {}) });
  await assert.rejects(unresolved('https://public.example', { signal: deadline(t, 25), maxBytes: 1024 }), isAbort);
  const f = await fixture(t, (req, res) => {
    if (req.url === '/no-headers') return;
    if (req.url === '/hang') { res.writeHead(200); res.write('part'); }
    else { const timer = setTimeout(() => { res.writeHead(302, { location: '/again' }); res.end(); }, 25); res.on('close', () => clearTimeout(timer)); }
  });
  await assert.rejects(f.fetch('https://public.example/no-headers', { signal: deadline(t, 40), maxBytes: 1024 }), isAbort);
  await assert.rejects(f.fetch('https://public.example/hang', { signal: deadline(t, 40), maxBytes: 1024 }), isAbort);
  const before = f.calls.length;
  await assert.rejects(f.fetch('https://public.example/again', { signal: deadline(t, 45), maxBytes: 1024 }), isAbort);
  assert.ok(f.calls.length - before < 4, 'redirects cannot restart the total timeout');
});

test('both compressed and expanded bodies are bounded; unsupported encodings and truncated bodies reject', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/length') { res.writeHead(200, { 'content-length': '9000' }); res.flushHeaders(); return; }
    if (req.url === '/gzip') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('a'.repeat(9000))); return; }
    if (req.url === '/deflate') { res.writeHead(200, { 'content-encoding': 'deflate' }); res.end(deflateSync('a'.repeat(9000))); return; }
    if (req.url === '/br') { res.writeHead(200, { 'content-encoding': 'br' }); res.end(brotliCompressSync('a'.repeat(9000))); return; }
    if (req.url === '/unsupported') { res.writeHead(200, { 'content-encoding': 'gzip, br' }); res.end('invalid'); return; }
    if (req.url === '/good') { res.writeHead(200, { 'content-encoding': 'gzip' }); res.end(gzipSync('okay')); return; }
    if (req.url === '/good-deflate') { res.writeHead(200, { 'content-encoding': 'deflate' }); res.end(deflateSync('okay')); return; }
    if (req.url === '/truncated') { res.writeHead(200, { 'content-length': '100' }); res.write('part'); res.socket?.destroy(); return; }
    res.write('a'.repeat(512)); res.end('b'.repeat(512));
  });
  for (const path of ['/length', '/gzip', '/deflate', '/br', '/stream', '/unsupported', '/truncated']) await assert.rejects(f.fetch('https://public.example' + path, { signal: deadline(t), maxBytes: 700 }));
  assert.equal((await f.fetch('https://public.example/good', { signal: deadline(t), maxBytes: 700 })).body.toString(), 'okay');
  assert.equal((await f.fetch('https://public.example/good-deflate', { signal: deadline(t), maxBytes: 700 })).body.toString(), 'okay');
});

test('chunked gzip with a large optional header is rejected even when expanded content is tiny', async t => {
  const gzip = gzipSync('okay'), extra = Buffer.alloc(9000, 65), extraLength = Buffer.alloc(2);
  gzip[3] = gzip[3]! | 4; // FEXTRA: the decoder must consume these bytes before the small payload.
  extraLength.writeUInt16LE(extra.length);
  const encoded = Buffer.concat([gzip.subarray(0, 10), extraLength, extra, gzip.subarray(10)]);
  assert.equal(gunzipSync(encoded).toString(), 'okay', 'fixture is valid gzip with four expanded bytes');
  assert.ok(encoded.length > 700);
  const f = await fixture(t, (_req, res) => {
    res.writeHead(200, { 'content-encoding': 'gzip' });
    // Separate writes force chunked transfer, so the compressed byte counter must enforce the cap.
    res.write(encoded.subarray(0, 100)); res.end(encoded.subarray(100));
  });
  await assert.rejects(f.fetch('https://public.example/gzip-header', { signal: deadline(t), maxBytes: 700 }), { code: 'PREVIEW_RESPONSE_TOO_LARGE' });
});
