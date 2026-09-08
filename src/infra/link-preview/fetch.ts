import { Resolver } from 'node:dns/promises';
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export class PreviewFetchError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'PreviewFetchError'; }
}

/** Previews never inherit media-origin exceptions: both HTML and images must be public. */
export function previewAddressIsPublic(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function safePreviewUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\\\x00-\x20\x7f]/.test(raw)) throw new PreviewFetchError('PREVIEW_URL_REJECTED');
  let url: URL;
  try { url = new URL(raw); } catch { throw new PreviewFetchError('PREVIEW_URL_REJECTED'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port || !url.hostname || url.href.length > 4096) throw new PreviewFetchError('PREVIEW_URL_REJECTED');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !previewAddressIsPublic(host)) throw new PreviewFetchError('PREVIEW_DESTINATION_REJECTED');
  url.hash = '';
  return url;
}

interface Address { address: string; family: number }
type Resolve = (host: string, signal: AbortSignal) => Promise<Address[]>;
type Request = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export interface PreviewResource { url: string; contentType: string; body: Buffer }
export interface PreviewFetchOptions { signal: AbortSignal; maxBytes: number }

function checkSignal(signal: AbortSignal): void { if (signal.aborted) throw new PreviewFetchError('PREVIEW_ABORTED'); }
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new PreviewFetchError('PREVIEW_ABORTED'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

const resolvePublicHost: Resolve = async (host, signal) => {
  checkSignal(signal);
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  // Dedicated resolver is cancellable; unresolved names cannot retain a job after its deadline.
  const resolver = new Resolver({ timeout: 1000, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const answers = await abortable(Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]), signal);
    checkSignal(signal);
    const addresses: Address[] = [];
    for (const [index, answer] of answers.entries()) {
      if (answer.status === 'fulfilled') addresses.push(...answer.value.map(address => ({ address, family: index === 0 ? 4 : 6 })));
      else if (!['ENODATA', 'ENOTFOUND'].includes(String((answer.reason as NodeJS.ErrnoException)?.code))) throw new PreviewFetchError('PREVIEW_DNS_ERROR');
    }
    return addresses;
  } finally { signal.removeEventListener('abort', cancel); resolver.cancel(); }
};

class ByteLimit extends Transform {
  private bytes = 0;
  constructor(private readonly maximum: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    callback(this.bytes > this.maximum ? new PreviewFetchError('PREVIEW_RESPONSE_TOO_LARGE') : null, this.bytes > this.maximum ? undefined : chunk);
  }
}

async function boundedBody(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const contentLength = response.headers['content-length'];
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes)) {
    response.destroy(); throw new PreviewFetchError('PREVIEW_RESPONSE_TOO_LARGE');
  }
  const encoding = String(response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  if (encoding !== 'identity' && encoding !== '' && !decoder) { response.destroy(); throw new PreviewFetchError('PREVIEW_ENCODING_REJECTED'); }
  const parts: Buffer[] = [];
  const collector = new Transform({ transform(chunk: Buffer, _encoding, done) { parts.push(chunk); done(); } });
  const steps = decoder ? [response, new ByteLimit(maxBytes), decoder, new ByteLimit(maxBytes), collector] : [response, new ByteLimit(maxBytes), collector];
  await pipeline(steps, { signal });
  return Buffer.concat(parts);
}

/** Injection is for isolated transport tests; production always pins checked DNS to the socket. */
export function createPreviewFetcher(dependencies: { resolve?: Resolve; request?: Request } = {}) {
  return async (rawUrl: string, options: PreviewFetchOptions): Promise<PreviewResource> => {
    const { signal, maxBytes } = options;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 5 * 1024 * 1024) throw new PreviewFetchError('PREVIEW_LIMIT_INVALID');
    let url = safePreviewUrl(rawUrl);
    for (let redirects = 0; redirects <= 3; redirects++) {
      checkSignal(signal);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = await abortable((dependencies.resolve ?? resolvePublicHost)(host, signal), signal);
      checkSignal(signal);
      if (!addresses.length || addresses.some(row => !previewAddressIsPublic(row.address) || isIP(row.address) !== row.family)) throw new PreviewFetchError('PREVIEW_DESTINATION_REJECTED');
      const address = addresses[0]!;
      const result = await new Promise<PreviewResource | { redirect: string }>((resolve, reject) => {
        const request = dependencies.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
        const req = request(url, {
          method: 'GET', agent: false, signal, maxHeaderSize: 16 * 1024,
          headers: { accept: 'text/html,application/xhtml+xml,image/jpeg,image/png,image/webp,image/gif;q=0.9', 'accept-encoding': 'identity', 'user-agent': 'ZapToBox-LinkPreview/1.0' },
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        }, response => {
          // Response errors must be handled even if rejection happens before the body pipeline.
          response.on('error', reject);
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) { reject(new PreviewFetchError('PREVIEW_RESPONSE_REJECTED')); return; }
            try { resolve({ redirect: safePreviewUrl(new URL(location, url).href).href }); }
            catch (error) { reject(error); }
            return;
          }
          if (response.statusCode !== 200) { response.destroy(); reject(new PreviewFetchError('PREVIEW_RESPONSE_REJECTED')); return; }
          void boundedBody(response, maxBytes, signal).then(body => resolve({
            url: url.href, contentType: String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase(), body,
          }), reject);
        });
        req.on('error', reject);
        req.end();
      });
      checkSignal(signal);
      if ('body' in result) return result;
      if (redirects === 3) throw new PreviewFetchError('PREVIEW_REDIRECT_LIMIT');
      url = safePreviewUrl(result.redirect);
    }
    throw new PreviewFetchError('PREVIEW_REDIRECT_LIMIT');
  };
}

export const fetchPreviewResource = createPreviewFetcher();
