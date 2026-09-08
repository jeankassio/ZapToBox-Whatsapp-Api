import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_PIXELS = 8_000_000;
const MAX_DIMENSION = 8192;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_WORKERS = 2;
const MAX_QUEUED = 4;
const DEADLINE_MS = 5000;
const sharpPath = createRequire(import.meta.url).resolve('sharp');

type Failure = 'PREVIEW_THUMBNAIL_INVALID' | 'PREVIEW_THUMBNAIL_LIMIT' | 'PREVIEW_THUMBNAIL_ABORTED' | 'PREVIEW_THUMBNAIL_TIMEOUT' | 'PREVIEW_THUMBNAIL_BUSY';
export class PreviewThumbnailError extends Error {
  constructor(readonly code: Failure) {
    super('Não foi possível gerar a miniatura dentro dos limites permitidos.');
    this.name = 'PreviewThumbnailError';
  }
}
function dimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) throw new PreviewThumbnailError('PREVIEW_THUMBNAIL_LIMIT');
}

/** Inspect small raster headers before any decoder sees the input. The worker validates metadata again. */
function inspectInput(buffer: Buffer): 'jpeg' | 'png' | 'webp' | 'gif' {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID');
  if (buffer.length > MAX_INPUT_BYTES) throw new PreviewThumbnailError('PREVIEW_THUMBNAIL_LIMIT');
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.readUInt32BE(8) === 13 && buffer.toString('ascii', 12, 16) === 'IHDR') {
    dimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    return 'png';
  }
  if (buffer.length >= 13 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    dimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
    return 'gif';
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP' && buffer.readUInt32LE(4) + 8 === buffer.length) {
    const type = buffer.toString('ascii', 12, 16);
    if (type === 'VP8X') dimensions(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
    else if (type === 'VP8L' && buffer[20] === 0x2f) dimensions((buffer[21]! | ((buffer[22]! & 0x3f) << 8)) + 1, ((buffer[22]! >> 6) | (buffer[23]! << 2) | ((buffer[24]! & 0x0f) << 10)) + 1);
    else if (type === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) dimensions(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    else throw new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID');
    return 'webp';
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 3 < buffer.length) {
      if (buffer[cursor++] !== 0xff) break;
      while (buffer[cursor] === 0xff) cursor++;
      const marker = buffer[cursor++];
      if (marker === undefined || marker === 0xda || marker === 0xd9 || cursor + 2 > buffer.length) break;
      const size = buffer.readUInt16BE(cursor);
      if (size < 2 || cursor + size > buffer.length) break;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (size < 8 || buffer[cursor + 2] !== 8) break;
        dimensions(buffer.readUInt16BE(cursor + 5), buffer.readUInt16BE(cursor + 3));
        return 'jpeg';
      }
      cursor += size;
    }
  }
  throw new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID');
}

// Plain CommonJS eval makes the same worker run under tsx and compiled ESM, without a copied asset or loader.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const sharp = require(workerData.sharpPath);
  sharp.cache(false);
  sharp.concurrency(1);
  const input = Buffer.from(workerData.bytes);
  const options = { limitInputPixels: 8000000, unlimited: false, failOn: 'warning', sequentialRead: true, pages: 1, page: 0, animated: false };
  const image = sharp(input, options).timeout({ seconds: 3 });
  const metadata = await image.metadata();
  const height = metadata.pageHeight || metadata.height;
  if (metadata.format !== workerData.format || !Number.isInteger(metadata.width) || !Number.isInteger(height) || metadata.width < 1 || height < 1 || metadata.width > 8192 || height > 8192 || metadata.width * height > 8000000) throw new Error('Invalid dimensions');
  const pipeline = image.rotate().resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).toColourspace('srgb');
  let output = await pipeline.clone().jpeg({ quality: 75, chromaSubsampling: '4:2:0' }).toBuffer();
  if (output.length > 65536) output = await pipeline.clone().jpeg({ quality: 45, chromaSubsampling: '4:2:0' }).toBuffer();
  if (output.length > 65536 || output.length < 4 || output[0] !== 255 || output[1] !== 216) throw new Error('Invalid output');
  const bytes = Uint8Array.from(output);
  parentPort.postMessage({ ok: true, bytes }, [bytes.buffer]);
})().catch(() => parentPort.postMessage({ ok: false })).finally(() => parentPort.close());
`;

interface Job {
  input: Buffer;
  format: ReturnType<typeof inspectInput>;
  signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  abort: () => void;
  resolve: (value: Buffer) => void;
  reject: (error: Error) => void;
  settled: boolean;
  worker?: Worker;
}
const queue: Job[] = [];
let activeWorkers = 0;

function finish(job: Job, error?: PreviewThumbnailError, output?: Buffer) {
  if (job.settled) return;
  job.settled = true;
  clearTimeout(job.timer);
  job.signal.removeEventListener('abort', job.abort);
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
  // Native work also has a libvips deadline. Keep its slot until exit, but reject cancellation immediately.
  const terminated = job.worker?.terminate();
  if (error) {
    void terminated?.catch(() => {});
    job.reject(error);
  } else {
    // A completed call also releases its worker before the caller starts more image work.
    void (terminated ?? Promise.resolve()).then(() => job.signal.aborted ? job.reject(new PreviewThumbnailError('PREVIEW_THUMBNAIL_ABORTED')) : job.resolve(output!), () => job.reject(new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID')));
  }
  drain();
}

function drain() {
  while (activeWorkers < MAX_WORKERS && queue.length) {
    const job = queue.shift()!;
    if (job.settled) continue;
    activeWorkers++;
    try {
      const bytes = Uint8Array.from(job.input);
      const worker = new Worker(workerSource, {
        eval: true, execArgv: [], workerData: { sharpPath, bytes, format: job.format }, transferList: [bytes.buffer],
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      });
      job.worker = worker;
      worker.once('message', (message: unknown) => {
        const result = message as { ok?: boolean; bytes?: unknown } | null;
        if (!result?.ok || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength > MAX_OUTPUT_BYTES || result.bytes.byteLength < 4 || result.bytes[0] !== 0xff || result.bytes[1] !== 0xd8) return finish(job, new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID'));
        finish(job, undefined, Buffer.from(result.bytes));
      });
      worker.once('error', () => finish(job, new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID')));
      worker.once('exit', () => {
        activeWorkers--;
        delete job.worker;
        if (!job.settled) finish(job, new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID'));
        drain();
      });
    } catch {
      activeWorkers--;
      finish(job, new PreviewThumbnailError('PREVIEW_THUMBNAIL_INVALID'));
    }
  }
}

/** Decode untrusted raster data away from the main event loop. Queue time is part of the five-second budget. */
export function createPreviewThumbnail(buffer: Buffer, signal: AbortSignal): Promise<Buffer> {
  if (signal.aborted) return Promise.reject(new PreviewThumbnailError('PREVIEW_THUMBNAIL_ABORTED'));
  let format: ReturnType<typeof inspectInput>;
  try { format = inspectInput(buffer); } catch (error) { return Promise.reject(error); }
  if (activeWorkers >= MAX_WORKERS && queue.length >= MAX_QUEUED) return Promise.reject(new PreviewThumbnailError('PREVIEW_THUMBNAIL_BUSY'));
  return new Promise<Buffer>((resolve, reject) => {
    const job: Job = {
      input: buffer, format, signal, resolve, reject, settled: false,
      timer: setTimeout(() => finish(job, new PreviewThumbnailError('PREVIEW_THUMBNAIL_TIMEOUT')), DEADLINE_MS),
      abort: () => finish(job, new PreviewThumbnailError('PREVIEW_THUMBNAIL_ABORTED')),
    };
    signal.addEventListener('abort', job.abort, { once: true });
    queue.push(job);
    if (signal.aborted) job.abort(); else drain();
  });
}
