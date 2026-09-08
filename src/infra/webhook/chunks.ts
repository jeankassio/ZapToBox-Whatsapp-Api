import { stringify } from '../../shared/serialization.js';

export const WEBHOOK_CHUNK_ITEMS = 100;
// Reserve space for the envelope and keep requests comfortably below 1 MB.
export const WEBHOOK_CHUNK_BYTES = 900_000;
export function webhookChunks(data: readonly unknown[]): unknown[][] {
  const chunks: unknown[][] = [];
  let batch: unknown[] = [], bytes = 2;
  for (const item of data) {
    const size = Buffer.byteLength(stringify(item));
    if (size + 2 > WEBHOOK_CHUNK_BYTES) throw new Error('Webhook entry exceeds supported size');
    if (batch.length && (batch.length >= WEBHOOK_CHUNK_ITEMS || bytes + size + 1 > WEBHOOK_CHUNK_BYTES)) { chunks.push(batch); batch = []; bytes = 2; }
    batch.push(item); bytes += size + 1;
  }
  if (batch.length) chunks.push(batch);
  return chunks;
}
