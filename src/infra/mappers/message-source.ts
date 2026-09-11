import type { BaileysEventMap } from '@whiskeysockets/baileys';
import type { MessageWebhook } from '../../shared/types.js';

/** Provider receipt semantics, captured before the API's persistence queue. */
export function upsertMessageSource(upsert: Pick<BaileysEventMap['messages.upsert'], 'type' | 'requestId'>, receivedWhileConnected: boolean): NonNullable<MessageWebhook['messageSource']> {
  if (upsert.requestId) return 'recovery';
  if (upsert.type === 'append') return 'offline';
  return upsert.type === 'notify' && receivedWhileConnected ? 'live' : 'unknown';
}
