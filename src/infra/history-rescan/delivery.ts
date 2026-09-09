import type { InstanceInfo } from '../../shared/types.js';
import type { WebhookOutbox } from '../webhook/outbox.js';
import { RequestError } from '../http/controllers/base.js';
import type { RescanEvent } from './service.js';

/** Bind replay to the live transport which produced this page's snapshot. */
export async function enqueueRescanEvent(outbox: Pick<WebhookOutbox, 'enqueue'>, instance: InstanceInfo, event: RescanEvent,
  current: () => InstanceInfo | undefined): Promise<void> {
  const live = current();
  if (instance.connectionStatus !== 'ONLINE' || live?.connectionStatus !== 'ONLINE'
    || !instance.connectionUpdatedAt || live.connectionUpdatedAt !== instance.connectionUpdatedAt) {
    throw new RequestError(409, 'History connection changed.', 'HISTORY_CONNECTION_CLOSED');
  }
  const id = await outbox.enqueue(event.event, instance, event.data, event.history, { id: event.id, timestamp: event.timestamp });
  if (!id) throw new Error('History webhook is not configured');
}
