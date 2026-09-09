import { prisma } from '../../core/connection/prisma.js';
import { webhookOutbox } from '../../shared/utils.js';
import UserConfig from '../config/env.js';
import InstancesController from '../http/controllers/instances.js';
import { HistoryRescanService } from './service.js';
import { PrismaRescanStore } from './prisma-store.js';
import { instanceConnection, instances } from '../../shared/constants.js';
import { instanceKey } from '../../shared/identity.js';
import { publicInstanceInfo } from '../../shared/instance-info.js';
import { enqueueRescanEvent } from './delivery.js';

const snapshot = (key: string) => instanceConnection[key] ? publicInstanceInfo(instanceConnection[key]!) : undefined;

export const historyRescan = new HistoryRescanService(new PrismaRescanStore(prisma), {
  configured: () => Boolean(UserConfig.webhookUrl),
  connected: key => snapshot(key)?.connectionStatus === 'ONLINE',
  snapshot,
  naturalHistoryActive: key => instances[key]?.getHistoryActivity()?.active ?? false,
  historyPending: (owner, name, runId) => webhookOutbox.hasPendingHistory(owner, name, runId),
  exists: async (owner, name) => Boolean(await new InstancesController().find(owner, name)),
  // Do not grow the filesystem queue indefinitely when the receiver is offline.
  canProduce: async () => (await webhookOutbox.stats()).pending < 50,
  emit: async (instance, event) => {
    await enqueueRescanEvent(webhookOutbox, instance, event, () => snapshot(instanceKey(instance.owner, instance.instanceName)));
  },
});
