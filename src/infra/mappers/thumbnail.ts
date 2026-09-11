import sharp from 'sharp';

export const MAX_THUMBNAIL_BYTES = 32 * 1024;
const record = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/** Uses only the small JPEG already embedded in the stored encrypted-media payload. */
export async function embeddedJpegThumbnail(content: unknown): Promise<string | null> {
  let message = record(record(content).message);
  for (let depth = 0; depth < 8; depth++) {
    const wrapper = message.ephemeralMessage ?? message.viewOnceMessage ?? message.viewOnceMessageV2 ?? message.viewOnceMessageV2Extension ?? message.documentWithCaptionMessage ?? message.editedMessage;
    if (!wrapper) break;
    message = record(record(wrapper).message);
  }
  const body = record(message.imageMessage ?? message.videoMessage ?? message.ptvMessage);
  const value = body.jpegThumbnail;
  const raw = typeof value === 'string' ? value : record(value).type === 'Buffer' ? record(value).data : undefined;
  let bytes: Buffer;
  if (typeof raw === 'string') {
    if (!raw || raw.length > Math.ceil(MAX_THUMBNAIL_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) return null;
    bytes = Buffer.from(raw, 'base64');
  } else if (Array.isArray(raw) && raw.length > 0 && raw.length <= MAX_THUMBNAIL_BYTES && raw.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) bytes = Buffer.from(raw);
  else return null;
  if (bytes.length > MAX_THUMBNAIL_BYTES || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) return null;
  try {
    // Bound decoded pixels as well as compressed bytes; malformed JPEGs never
    // become browser sources, and no remote file is opened by this decoder.
    const image = sharp(bytes, { limitInputPixels: 1_048_576, failOn: 'warning' });
    if ((await image.metadata()).format !== 'jpeg') return null;
    await image.stats();
    return bytes.toString('base64');
  } catch { return null; }
}
