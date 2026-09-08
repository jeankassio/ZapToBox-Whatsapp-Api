import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { createPreviewThumbnail, PreviewThumbnailError } from '../src/infra/link-preview/thumbnail.js';

const controller = () => new AbortController();
const solid = (width = 720, height = 360, background = '#ed2638') => sharp({ create: { width, height, channels: 4, background } });
async function jpegMetadata(output: Buffer) {
  assert.ok(Buffer.isBuffer(output)); assert.ok(output.length <= 64 * 1024);
  assert.deepEqual([...output.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...output.subarray(-2)], [0xff, 0xd9]);
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.ok(metadata.width! <= 320 && metadata.height! <= 320);
  assert.equal(metadata.hasAlpha, false);
  assert.equal((await sharp(output).raw().toBuffer()).length, metadata.width! * metadata.height! * 3);
  return metadata;
}
const failure = (code: string) => (error: unknown) => error instanceof PreviewThumbnailError && error.code === code;

test('a bounded worker queue supports cancellation without blocking subsequent thumbnails', async () => {
  const input = await solid(48, 32).png().toBuffer();
  const signals = Array.from({ length: 7 }, controller);
  const jobs = signals.map(signal => createPreviewThumbnail(input, signal.signal).then(value => value, error => error as PreviewThumbnailError));
  signals[0]!.abort(); signals[2]!.abort();
  const results = await Promise.all(jobs);
  assert.ok(results[0] instanceof PreviewThumbnailError); assert.equal((results[0] as PreviewThumbnailError).code, 'PREVIEW_THUMBNAIL_ABORTED');
  assert.ok(results[2] instanceof PreviewThumbnailError); assert.equal((results[2] as PreviewThumbnailError).code, 'PREVIEW_THUMBNAIL_ABORTED');
  assert.ok(results[6] instanceof PreviewThumbnailError); assert.equal((results[6] as PreviewThumbnailError).code, 'PREVIEW_THUMBNAIL_BUSY');
  for (const index of [1, 3, 4, 5]) await jpegMetadata(results[index] as Buffer);
  await jpegMetadata(await createPreviewThumbnail(input, controller().signal));
});

test('real JPEG, PNG, interlaced PNG, lossy/lossless WebP and GIF become bounded JPEG thumbnails', async () => {
  const fixtures = [
    await solid().jpeg().toBuffer(), await solid().png().toBuffer(), await solid().png({ progressive: true }).toBuffer(),
    await solid().webp().toBuffer(), await solid().webp({ lossless: true }).toBuffer(), await solid().gif().toBuffer(),
  ];
  for (const input of fixtures) {
    const output = await createPreviewThumbnail(input, controller().signal), metadata = await jpegMetadata(output);
    assert.equal(metadata.width, 320); assert.equal(metadata.height, 160);
    const pixel = await sharp(output).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[0]! > 210 && pixel[1]! < 70, 'The thumbnail contains decoded image pixels');
  }
});

test('thumbnails honor orientation, preserve small dimensions and flatten transparency on white', async () => {
  const rotated = await solid(720, 360).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const portrait = await jpegMetadata(await createPreviewThumbnail(rotated, controller().signal));
  assert.equal(portrait.width, 160); assert.equal(portrait.height, 320); assert.equal(portrait.orientation, undefined);
  const transparent = await solid(24, 12, '#00000000').png().toBuffer();
  const output = await createPreviewThumbnail(transparent, controller().signal), small = await jpegMetadata(output);
  assert.equal(small.width, 24); assert.equal(small.height, 12);
  const pixel = await sharp(output).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
  assert.ok([...pixel].every(channel => channel >= 250));
});

test('animated GIF and WebP use only the first frame', async () => {
  const width = 32, frameHeight = 24, raw = Buffer.alloc(width * frameHeight * 2 * 3);
  for (let index = 0; index < raw.length; index += 3) raw[index + (index < raw.length / 2 ? 0 : 2)] = 255;
  for (const format of ['gif', 'webp'] as const) {
    const input = await sharp(raw, { raw: { width, height: frameHeight * 2, pageHeight: frameHeight, channels: 3 } }).toFormat(format, { loop: 0, delay: [20, 20] }).toBuffer();
    assert.equal((await sharp(input).metadata()).pages, 2);
    const output = await createPreviewThumbnail(input, controller().signal), metadata = await jpegMetadata(output);
    assert.equal(metadata.width, width); assert.equal(metadata.height, frameHeight);
    const pixel = await sharp(output).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[0]! > 230 && pixel[2]! < 30, 'First frame is red; the second frame must not be stacked or selected');
  }
});

test('unsupported formats, HTML, SVG and broken raster data are rejected without exposing decoder details', async () => {
  const png = await solid(16, 16).png().toBuffer();
  for (const input of [Buffer.alloc(0), Buffer.from('<html><img src="secret"></html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), Buffer.from('https://example.test/private'), Buffer.from([0xff, 0xd8, 0, 0]), png.subarray(0, 40)]) {
    await assert.rejects(createPreviewThumbnail(input, controller().signal), (error: unknown) => error instanceof PreviewThumbnailError && error.code === 'PREVIEW_THUMBNAIL_INVALID' && !error.message.includes('secret'));
  }
});

test('size and pixel bounds reject forged PNG, JPEG, GIF and WebP headers before decoding', async () => {
  await assert.rejects(createPreviewThumbnail(Buffer.alloc(5 * 1024 * 1024 + 1), controller().signal), failure('PREVIEW_THUMBNAIL_LIMIT'));
  for (const [width, height] of [[9000, 1], [4096, 4096], [0, 10]]) {
    const png = await solid(16, 16).png().toBuffer(); png.writeUInt32BE(width!, 16); png.writeUInt32BE(height!, 20);
    await assert.rejects(createPreviewThumbnail(png, controller().signal), failure('PREVIEW_THUMBNAIL_LIMIT'));
  }
  const jpg = await solid(16, 16).jpeg().toBuffer(), frame = jpg.indexOf(Buffer.from([0xff, 0xc0])); assert.ok(frame > 0);
  jpg.writeUInt16BE(9000, frame + 7);
  await assert.rejects(createPreviewThumbnail(jpg, controller().signal), failure('PREVIEW_THUMBNAIL_LIMIT'));
  const gif = await solid(16, 16).gif().toBuffer(); gif.writeUInt16LE(9000, 6);
  await assert.rejects(createPreviewThumbnail(gif, controller().signal), failure('PREVIEW_THUMBNAIL_LIMIT'));
  const webp = Buffer.alloc(30); webp.write('RIFF', 0); webp.writeUInt32LE(22, 4); webp.write('WEBPVP8X', 8); webp.writeUInt32LE(10, 16); webp.writeUIntLE(8999, 24, 3);
  await assert.rejects(createPreviewThumbnail(webp, controller().signal), failure('PREVIEW_THUMBNAIL_LIMIT'));
});

test('an already aborted request and an abort during worker startup reject promptly', async () => {
  const input = await solid(1200, 1200).png().toBuffer(), before = controller(); before.abort();
  await assert.rejects(createPreviewThumbnail(input, before.signal), failure('PREVIEW_THUMBNAIL_ABORTED'));
  const running = controller(), pending = createPreviewThumbnail(input, running.signal);
  const rejected = assert.rejects(pending, failure('PREVIEW_THUMBNAIL_ABORTED'));
  setImmediate(() => running.abort());
  await rejected;
});
