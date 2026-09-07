import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { isMediaUrl } from '../../../shared/guards.js';
import { RequestError } from './base.js';

const deniedV4 = new BlockList();
const deniedV6 = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) deniedV4.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) deniedV6.addSubnet(network, prefix, 'ipv6');
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !deniedV4.check(address, 'ipv4') : family === 6 && !deniedV6.check(address, 'ipv6');
}

/** Download before handing media to Baileys, pinning checked DNS and validating every redirect. */
export async function downloadPublicMedia(rawUrl: string, redirects = 0): Promise<Buffer> {
  if (!isMediaUrl(rawUrl) || redirects > 3) throw new RequestError(400, 'Invalid media URL.');
  const url = new URL(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw new RequestError(400, 'Media URL must resolve to a public address.');
  const address = addresses[0]!;
  const maxBytes = 50 * 1024 * 1024;
  return new Promise<Buffer>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, signal: AbortSignal.timeout(20_000), headers: { 'accept-encoding': 'identity' },
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'object' && options.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
      },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume();
        void downloadPublicMedia(new URL(response.headers.location, url).toString(), redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200 || Number(response.headers['content-length'] ?? 0) > maxBytes) {
        response.destroy(); reject(new RequestError(400, 'Media is unavailable or exceeds 50 MB.')); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(); reject(new RequestError(413, 'Media exceeds 50 MB.')); }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    request.on('error', reject);
    request.end();
  });
}
