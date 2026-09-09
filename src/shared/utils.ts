import { promises as fs } from "node:fs";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import type { HistoryChunkMetadata, InstanceData, ProxyAgent } from "./types.js";
import UserConfig from "../infra/config/env.js";
import { WebhookOutbox } from "../infra/webhook/outbox.js";
import { webhookChunks } from "../infra/webhook/chunks.js";
import { instanceConnection } from './constants.js';
import { instanceKey } from './identity.js';
import { cancelMediaDownloads } from '../infra/http/controllers/media-budget.js';

export const webhookOutbox = new WebhookOutbox({
  directory:UserConfig.webhook_queue_dir,url:UserConfig.webhookUrl,secret:UserConfig.webhookSecret,
  timeoutMs:UserConfig.webhookTimeoutMs,maxAttempts:UserConfig.webhookMaxAttempts,
  concurrency:UserConfig.webhookConcurrency,retryMs:UserConfig.webhook_interval,durable:UserConfig.useWebhookQueue,
  canDeliver: event => event.event.startsWith('connection.') || event.event.startsWith('qrcode.') || event.event.startsWith('pairingcode.')
    || (instanceConnection[instanceKey(event.instance.owner, event.instance.instanceName)]?.connectionStatus === 'ONLINE'),
});

export async function removeInstancePath(instancePath:string): Promise<void> {
  const base = path.resolve(UserConfig.sessionFolderName);
  const target = path.resolve(instancePath);
  const relative = path.relative(base,target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).length !== 2) throw new Error('Invalid instance path');
  // Reject symlink/junction parents before any recursive removal.
  const realBase = await fs.realpath(base).catch(()=>base);
  const realParent = await fs.realpath(path.dirname(target)).catch(()=>path.dirname(target));
  const parentRelative = path.relative(realBase,realParent);
  if (!parentRelative || parentRelative.startsWith('..') || path.isAbsolute(parentRelative)) throw new Error('Invalid session parent');
  const stat = await fs.lstat(target).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if (stat?.isSymbolicLink()) throw new Error('Session symlinks are not supported');
  await fs.rm(target,{recursive:true,force:true});
}

export async function genProxy(proxy?:string): Promise<ProxyAgent> {
  if (!proxy) return {};
  const protocol = new URL(proxy).protocol;
  if (protocol === 'http:' || protocol === 'https:') {
    const agent = new HttpsProxyAgent(proxy);
    return {wsAgent:agent,fetchAgent:agent};
  }
  if (['socks:','socks4:','socks5:'].includes(protocol)) {
    const agent = new SocksProxyAgent(proxy);
    return {wsAgent:agent,fetchAgent:agent};
  }
  throw new Error('Unsupported PROXY_URL protocol');
}

export async function trySendWebhook(event:string,instance:InstanceData,data:unknown,history?:HistoryChunkMetadata): Promise<void> {
  if (!event.startsWith('connection.') && !event.startsWith('qrcode.') && !event.startsWith('pairingcode.') && instance.connectionStatus !== 'ONLINE') return;
  const closed = ['connection.close', 'connection.removed'].includes(event), closedAt = new Date();
  if (closed) cancelMediaDownloads(instanceKey(instance.owner, instance.instanceName));
  const discarded = closed ? Promise.all([
    webhookOutbox.discardInstance(instance.owner, instance.instanceName),
    import('../infra/history-rescan/index.js').then(({ historyRescan }) => historyRescan.cancel(instance.owner, instance.instanceName, closedAt)),
  ]) : undefined;
  void discarded?.catch(() => console.error('Could not clear disconnected instance work.'));
  const info = {
    owner:instance.owner,instanceName:instance.instanceName,connectionStatus:instance.connectionStatus,
    ...(instance.connectionUpdatedAt ? {connectionUpdatedAt:instance.connectionUpdatedAt} : {}),
    profilePictureUrl:instance.profilePictureUrl,
    instanceJid:jidNormalizedUser(instance.socket?.user?.id ?? instance.instanceJid ?? '') || null,
  };
  // The producer already assigns stable IDs to planned history chunks. It must
  // announce exactly the same count that gets placed into the durable outbox.
  if(Array.isArray(data) && data.length) {
    const chunks=webhookChunks(data);
    if(history && chunks.length!==1)throw new Error('History chunk plan mismatch');
    for(const batch of chunks)await webhookOutbox.enqueue(event,info,batch,history);
  } else await webhookOutbox.enqueue(event,info,data,history);
  await discarded;
}
