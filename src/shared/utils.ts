import { promises as fs } from "node:fs";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import type { InstanceData, ProxyAgent } from "./types.js";
import UserConfig from "../infra/config/env.js";
import { WebhookOutbox } from "../infra/webhook/outbox.js";
import { stringify } from "./serialization.js";

export const webhookOutbox = new WebhookOutbox({
  directory:UserConfig.webhook_queue_dir,url:UserConfig.webhookUrl,secret:UserConfig.webhookSecret,
  timeoutMs:UserConfig.webhookTimeoutMs,maxAttempts:UserConfig.webhookMaxAttempts,
  concurrency:UserConfig.webhookConcurrency,retryMs:UserConfig.webhook_interval,durable:UserConfig.useWebhookQueue,
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

export async function trySendWebhook(event:string,instance:InstanceData,data:unknown): Promise<void> {
  const info = {
    owner:instance.owner,instanceName:instance.instanceName,connectionStatus:instance.connectionStatus,
    profilePictureUrl:instance.profilePictureUrl,
    instanceJid:jidNormalizedUser(instance.socket?.user?.id ?? instance.instanceJid ?? '') || null,
  };
  // History can contain thousands of entries; the Back accepts at most 1000 per request.
  if(Array.isArray(data) && data.length) {
    let batch:unknown[]=[];let bytes=0;
    for(const entry of data) {
      const size=Buffer.byteLength(stringify(entry));
      if(batch.length && (batch.length>=500 || bytes+size>8_000_000)) {
        await webhookOutbox.enqueue(event,info,batch);batch=[];bytes=0;
      }
      batch.push(entry);bytes+=size;
    }
    if(batch.length)await webhookOutbox.enqueue(event,info,batch);
  } else await webhookOutbox.enqueue(event,info,data);
}
