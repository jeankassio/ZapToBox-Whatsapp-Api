import { prisma } from '../../core/connection/prisma.js';
import { webhookOutbox } from '../../shared/utils.js';
import UserConfig from '../config/env.js';
import InstancesController from '../http/controllers/instances.js';
import { HistoryRescanService } from './service.js';
import { PrismaRescanStore } from './prisma-store.js';
import { instanceConnection } from '../../shared/constants.js';
import { instanceKey } from '../../shared/identity.js';

export const historyRescan = new HistoryRescanService(new PrismaRescanStore(prisma), {
  configured: () => Boolean(UserConfig.webhookUrl),
  connected: key => instanceConnection[key]?.connectionStatus === 'ONLINE',
  exists: async (owner, name) => Boolean(await new InstancesController().find(owner, name)),
  // Do not grow the filesystem queue indefinitely when the receiver is offline.
  canProduce: async () => (await webhookOutbox.stats()).pending < 50,
  emit: async (instance, event) => {
    if (instanceConnection[instanceKey(instance.owner, instance.instanceName)]?.connectionStatus !== 'ONLINE') throw new Error('History connection is offline');
    const id = await webhookOutbox.enqueue(event.event, instance, event.data, event.history, { id: event.id, timestamp: event.timestamp });
    if (!id) throw new Error('History webhook is not configured');
  },
});
