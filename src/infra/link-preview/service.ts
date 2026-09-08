import type { WAUrlInfo } from '@whiskeysockets/baileys';
import { getPreviewFromContent } from 'link-preview-js';
import { fetchPreviewResource, safePreviewUrl } from './fetch.js';
import { createPreviewThumbnail } from './thumbnail.js';

const HTML_BYTES = 512 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const THUMBNAIL_BYTES = 64 * 1024;
const MAX_PENDING = 32;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
type PreparedPreview = Omit<WAUrlInfo, 'matched-text'>;
type CacheEntry = { connection: string; expiresAt: number; value: PreparedPreview | null };
type Waiter = { signal: AbortSignal; start: () => void; aborted: () => void };

interface PreviewOptions {
  fetchResource?: typeof fetchPreviewResource;
  createThumbnail?: typeof createPreviewThumbnail;
  now?: () => number;
  timeoutMs?: number;
  concurrency?: number;
  ttlMs?: number;
  failureTtlMs?: number;
  maxEntries?: number;
  maxEntriesPerConnection?: number;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

/** Find one link without interpreting email addresses, other protocols or prose as credentials. */
export function extractPreviewLink(text: string): { url: string; matched: string } | null {
  if (typeof text !== 'string' || text.length > 65_536) return null;
  // Tokenize first and cap each candidate before examining domain labels. A regex
  // with repeated optional domain groups can backtrack heavily on long chat text.
  for (const match of text.matchAll(/[^\s<>"'“”‘’]+/gu)) {
    if (match[0].length > 4096) continue;
    let candidate = match[0];
    const explicitIndex = candidate.search(/https?:\/\//i);
    if (explicitIndex > 0 && /[:=([{]/u.test(candidate[explicitIndex - 1]!)) candidate = candidate.slice(explicitIndex);
    let matched = candidate.replace(/^[([{]+/u, '').replace(/[.,!?;:]+$/u, '');
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']] as const) {
      while (matched.endsWith(closing) && matched.split(closing).length > matched.split(opening).length) matched = matched.slice(0, -1);
    }
    matched = matched.replace(/[.,!?;:]+$/u, '');
    try {
      const explicit = /^https?:\/\//i.test(matched);
      if (!explicit && !/^[a-z0-9]/i.test(matched)) continue;
      const url = safePreviewUrl(explicit ? matched : 'https://' + matched);
      if (!explicit) {
        const labels = url.hostname.split('.');
        if (labels.length < 2 || !/^[a-z]{2,63}$/i.test(labels.at(-1)!)
          || !labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) continue;
      }
      return { url: url.toString(), matched };
    } catch { /* Try the next explicit link, never fetch an invalid URL. */ }
  }
  return null;
}

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** A preview failure affects only decoration; every result is safe to pass explicitly to sendMessage. */
export class LinkPreviewService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<PreparedPreview | null>>();
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private readonly fetchResource: typeof fetchPreviewResource;
  private readonly createThumbnail: typeof createPreviewThumbnail;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxEntriesPerConnection: number;

  constructor(options: PreviewOptions = {}) {
    this.fetchResource = options.fetchResource ?? fetchPreviewResource;
    this.createThumbnail = options.createThumbnail ?? createPreviewThumbnail;
    this.now = options.now ?? Date.now;
    this.timeoutMs = bounded(options.timeoutMs, 6000, 1, 6000);
    this.concurrency = bounded(options.concurrency, 4, 1, 4);
    this.ttlMs = bounded(options.ttlMs, 15 * 60_000, 0, 15 * 60_000);
    this.failureTtlMs = bounded(options.failureTtlMs, 30_000, 0, 30_000);
    this.maxEntries = bounded(options.maxEntries, 256, 1, 256);
    this.maxEntriesPerConnection = bounded(options.maxEntriesPerConnection, 32, 1, 32);
  }

  async preview(connection: string, text: string): Promise<WAUrlInfo | null> {
    const link = extractPreviewLink(text);
    if (!link) return null;
    const key = JSON.stringify([connection, link.url]);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      if (cached.expiresAt > this.now()) {
        this.cache.set(key, cached);
        return this.result(cached.value, link.matched);
      }
    }
    const existing = this.pending.get(key);
    if (existing) return this.result(await existing, link.matched);
    // Avoid unbounded work/futures when many unique links arrive together.
    if (this.pending.size >= MAX_PENDING) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Preview deadline exceeded')), this.timeoutMs);
    const work = this.run(link.url, controller.signal);
    const task = withinDeadline(work, controller.signal).catch(() => null);
    this.pending.set(key, task);
    try {
      const value = await task;
      this.remember(key, connection, value);
      return this.result(value, link.matched);
    } finally {
      clearTimeout(timer);
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }

  private result(value: PreparedPreview | null, matched: string): WAUrlInfo | null {
    return value ? { ...value, 'matched-text': matched, ...(value.jpegThumbnail ? { jpegThumbnail: Buffer.from(value.jpegThumbnail) } : {}) } : null;
  }

  private remember(key: string, connection: string, value: PreparedPreview | null): void {
    this.cache.delete(key);
    let owned = 0;
    for (const entry of this.cache.values()) if (entry.connection === connection) owned++;
    for (const [oldKey, entry] of this.cache) {
      if (owned < this.maxEntriesPerConnection) break;
      if (entry.connection === connection) { this.cache.delete(oldKey); owned--; }
    }
    while (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { connection, value, expiresAt: this.now() + (value ? this.ttlMs : this.failureTtlMs) });
  }

  private acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const start = () => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          const next = this.waiters.shift();
          if (next) { next.signal.removeEventListener('abort', next.aborted); next.start(); }
        });
      };
      if (this.active < this.concurrency) { start(); return; }
      const waiter: Waiter = { signal, start, aborted: () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal.reason);
      } };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.aborted, { once: true });
    });
  }

  private async run(url: string, signal: AbortSignal): Promise<PreparedPreview | null> {
    const release = await this.acquire(signal);
    try {
      signal.throwIfAborted();
      const page = await this.fetchResource(url, { signal, maxBytes: HTML_BYTES });
      signal.throwIfAborted();
      const finalUrl = safePreviewUrl(page.url);
      if (page.body.length > HTML_BYTES) return null;
      if (IMAGE_TYPES.has(page.contentType)) {
        const jpegThumbnail = await this.thumbnail(page.body, signal);
        return { 'canonical-url': finalUrl.toString(), title: finalUrl.hostname, jpegThumbnail };
      }
      if (!['text/html', 'application/xhtml+xml'].includes(page.contentType)) return null;
      const parsed = await getPreviewFromContent({ url: finalUrl.toString(), headers: { 'content-type': 'text/html' }, data: page.body.toString('utf8') }, {
        imagesPropertyType: 'og',
        onResponse: (info, doc) => {
          const metadata = { ...info,
            title: info.title || doc('meta[name="twitter:title"],meta[property="twitter:title"]').first().attr('content') || '',
            description: info.description || doc('meta[name="twitter:description"],meta[property="twitter:description"]').first().attr('content'),
          };
          if (info.images.length) return metadata;
          const image = doc('meta[name="twitter:image"],meta[property="twitter:image"],meta[name="twitter:image:src"],link[rel="image_src"]').first();
          const source = image.attr('content') ?? image.attr('href');
          return source ? { ...metadata, images: [new URL(source, finalUrl).toString()] } : metadata;
        },
      });
      signal.throwIfAborted();
      if (!('images' in parsed) || !Array.isArray(parsed.images)) return null;
      // Consider at most two advertised images, never arbitrary assets or browser scripts.
      for (const image of parsed.images.slice(0, 2)) {
        try {
          const imageUrl = safePreviewUrl(new URL(image, finalUrl).toString());
          const resource = await this.fetchResource(imageUrl.toString(), { signal, maxBytes: IMAGE_BYTES });
          signal.throwIfAborted();
          if (!IMAGE_TYPES.has(resource.contentType) || resource.body.length > IMAGE_BYTES) continue;
          const jpegThumbnail = await this.thumbnail(resource.body, signal);
          const description = cleanText('description' in parsed ? parsed.description : undefined, 1024);
          return { 'canonical-url': finalUrl.toString(), title: cleanText('title' in parsed ? parsed.title : undefined, 256) || finalUrl.hostname,
            ...(description ? { description } : {}), jpegThumbnail };
        } catch { if (signal.aborted) signal.throwIfAborted(); }
      }
      return null;
    } finally { release(); }
  }

  private async thumbnail(buffer: Buffer, signal: AbortSignal): Promise<Buffer> {
    const thumbnail = await this.createThumbnail(buffer, signal);
    signal.throwIfAborted();
    if (!thumbnail.length || thumbnail.length > THUMBNAIL_BYTES) throw new Error('Invalid thumbnail size');
    return Buffer.from(thumbnail);
  }
}

export const linkPreviewService = new LinkPreviewService();
