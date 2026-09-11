import { RequestError } from './base.js';

const opusMime = 'audio/ogg; codecs=opus';
const unsupported = new Set(['audio/webm', 'audio/x-matroska', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave', 'audio/flac', 'audio/x-flac']);
const invalid = () => new RequestError(415, 'Prepare this audio as Ogg/Opus before sending. Voice notes require mono Ogg/Opus.');

/** Baileys uploads the original bytes; changing a MIME label does not transcode them. */
export function audioMime(mimetype: string, ptt = false): string {
  const type = mimetype.split(';', 1)[0]!.trim().toLowerCase();
  if (!/^audio\/[a-z0-9.+-]+$/.test(type) || unsupported.has(type)) throw invalid();
  const ogg = type === 'audio/ogg' || type === 'audio/opus';
  if (ptt && !ogg) throw invalid();
  return ogg ? opusMime : mimetype.trim();
}

/** Inspect the identification packet, without a decoder or another media download. */
export function validateAudioBytes(bytes: Buffer, mimetype: string, ptt = false): string {
  if (!bytes.length) throw invalid();
  const prefix = bytes.toString('ascii', 0, 4);
  if ((bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) || prefix === 'RIFF' || prefix === 'fLaC') throw invalid();
  if (mimetype !== opusMime && prefix !== 'OggS') return mimetype;
  if (prefix !== 'OggS' || bytes.length < 47 || bytes[4] !== 0 || bytes[5] !== 2 || bytes[26] !== 1) throw invalid();
  const packetLength = bytes[27]!;
  if (packetLength < 19 || bytes.length <= 28 + packetLength || bytes.toString('ascii', 28, 36) !== 'OpusHead') throw invalid();
  const version = bytes[36]!, channels = bytes[37]!;
  if (version !== 1 || channels < 1 || channels > 2 || (ptt && channels !== 1) || bytes[46] !== 0) throw invalid();
  return opusMime;
}
