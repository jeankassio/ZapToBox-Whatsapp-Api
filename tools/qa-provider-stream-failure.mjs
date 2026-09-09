import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createCipheriv } from 'node:crypto';
import { downloadMediaMessage, getMediaKeys } from '@whiskeysockets/baileys';
import MediaController from '../src/infra/http/controllers/media.ts';

const key = Buffer.alloc(32, 7), bytes = Buffer.from('healthy media after failed stream');
const { cipherKey, iv } = await getMediaKeys(key, 'image');
const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
const encrypted = Buffer.concat([cipher.update(bytes), cipher.final(), Buffer.alloc(10)]);
const server = createServer((req, res) => {
  if (req.url === '/stall') return;
  if (req.url === '/healthy') { res.end(encrypted); return; }
  res.writeHead(200, { 'Content-Length': 100_000 }); res.write(encrypted.subarray(0, 32));
  setTimeout(() => req.socket.destroy(), 20);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const message = path => ({ key: { id: 'stream-check', remoteJid: '1@s.whatsapp.net' }, message: { imageMessage: { url: origin + path, mediaKey: key, mimetype: 'image/jpeg' } } });
try {
  await assert.rejects(downloadMediaMessage(message('/broken'), 'buffer', {}));
  const controller = new MediaController('owner', 'session', { socket: {}, repository: { getMessageById: async () => message('/broken') } });
  const failed = await controller.getMedia('stream-check');
  assert.equal(failed.success, false); assert.equal(failed.statusCode, 502);
  await assert.rejects(downloadMediaMessage(message('/stall'), 'buffer', { options: { signal: AbortSignal.timeout(100) } }));
  assert.deepEqual(await downloadMediaMessage(message('/healthy'), 'buffer', {}), bytes);
  console.log(JSON.stringify({ partialBodyRejected: true, controllerError: failed.statusCode, fetchAbort: true, subsequentDownload: true }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
