import type { Readable } from 'node:stream';
import { RequestError } from './base.js';

/** Reject overload before reading the message or downloading, without an unbounded wait queue. */
export class MediaDownloadBudget {
  private active = 0;
  constructor(private readonly concurrency = 4) {}
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) throw new RequestError(429, 'Media downloads are busy. Retry shortly.');
    this.active++;
    try { return await operation(); } finally { this.active--; }
  }
}

export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new RequestError(504, 'Media download timed out.'));
    if (signal.aborted) { void work.catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Bound decrypted bytes while consuming, rather than checking after allocating the whole file. */
export async function collectMedia(stream: Readable | Buffer, maximum: number, signal: AbortSignal): Promise<Buffer> {
  if (Buffer.isBuffer(stream)) {
    if (stream.length > maximum) throw new RequestError(413, 'Media exceeds the supported size.');
    return stream;
  }
  const aborted = () => stream.destroy();
  signal.addEventListener('abort', aborted, { once: true });
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    if (signal.aborted) throw new RequestError(504, 'Media download timed out.');
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maximum) throw new RequestError(413, 'Media exceeds the supported size.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  } finally { signal.removeEventListener('abort', aborted); stream.destroy(); }
}

export const mediaDownloadBudget = new MediaDownloadBudget();
const downloads = new Map<string, Set<AbortController>>();
export function trackMediaDownload(instance: string, controller: AbortController): () => void {
  const active = downloads.get(instance) ?? new Set<AbortController>();
  active.add(controller); downloads.set(instance, active);
  return () => { active.delete(controller); if (!active.size && downloads.get(instance) === active) downloads.delete(instance); };
}
export function cancelMediaDownloads(instance: string): void {
  const active = downloads.get(instance); downloads.delete(instance);
  for (const controller of active ?? []) controller.abort();
}
