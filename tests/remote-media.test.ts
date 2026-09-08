import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { downloadPublicMedia } from '../src/infra/http/controllers/remote-media.js';
import { RequestError } from '../src/infra/http/controllers/base.js';

async function fixture(t: TestContext, handler: RequestListener) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const previous = process.env.TRUSTED_MEDIA_ORIGINS;
  process.env.TRUSTED_MEDIA_ORIGINS = origin;
  t.after(async () => {
    if (previous === undefined) delete process.env.TRUSTED_MEDIA_ORIGINS;
    else process.env.TRUSTED_MEDIA_ORIGINS = previous;
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  });
  return origin;
}

test('malformed redirect URLs reject the download without crashing the HTTP process', async t => {
  const origin = await fixture(t, (req, res) => {
    if (req.url === '/broken') { res.writeHead(302, { location: 'http://[' }); res.end(); }
    else res.end('still-serving');
  });
  await assert.rejects(downloadPublicMedia(origin + '/broken'), (error: unknown) => error instanceof RequestError && error.statusCode === 400);
  assert.equal((await downloadPublicMedia(origin + '/valid')).toString(), 'still-serving');
});

test('redirects revalidate the destination origin and reject private origins outside the allowlist', async t => {
  const origin = await fixture(t, (_req, res) => {
    res.writeHead(302, { location: 'http://127.0.0.1:1/private' }); res.end();
  });
  await assert.rejects(downloadPublicMedia(origin), (error: unknown) => error instanceof RequestError && error.statusCode === 400);
});

test('relative redirects succeed and redirect loops stop after a bounded number of requests', async t => {
  let requests = 0;
  const origin = await fixture(t, (req, res) => {
    requests++;
    if (req.url === '/valid') res.end('media');
    else { res.writeHead(302, { location: req.url === '/start' ? '/valid' : '/loop' }); res.end(); }
  });
  assert.equal((await downloadPublicMedia(origin + '/start')).toString(), 'media');
  requests = 0;
  await assert.rejects(downloadPublicMedia(origin + '/loop'), (error: unknown) => error instanceof RequestError && error.statusCode === 400);
  assert.equal(requests, 4);
});
