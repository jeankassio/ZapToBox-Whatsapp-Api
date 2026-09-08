import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { instances, sessionsPath } from '../../shared/constants.js';
import { instanceKey, validateIdentity } from '../../shared/identity.js';
import Instance from '../baileys/services.js';
import { listDatabaseSessions, loadInstanceAuth, safeSessionDirectory } from './auth-state.js';
import PrismaConnection from '../../core/connection/prisma.js';
import UserConfig from '../config/env.js';

type SessionPair = { owner: string; instanceName: string };

export function ambiguousLegacyKeys(pairs: SessionPair[]): Set<string> {
  const keys = new Map<string, Set<string>>();
  for (const pair of pairs) {
    const old = `${pair.owner}_${pair.instanceName}`;
    const candidates = keys.get(old) ?? new Set();
    candidates.add(instanceKey(pair.owner, pair.instanceName));
    keys.set(old, candidates);
  }
  return new Set([...keys].filter(([, values]) => values.size > 1).map(([key]) => key));
}

export async function discoverFileSessions(root: string): Promise<SessionPair[]> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const pairs: SessionPair[] = [];
  for (const owner of await readdir(root, { withFileTypes: true })) {
    if (!owner.isDirectory() || owner.isSymbolicLink()) continue;
    try { validateIdentity(owner.name); } catch { continue; }
    for (const directory of await readdir(path.join(root, owner.name), { withFileTypes: true })) {
      if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
      try {
        await safeSessionDirectory(root, owner.name, directory.name);
        pairs.push({ owner: owner.name, instanceName: directory.name });
      } catch { console.error('Ignored unsafe session directory'); }
    }
  }
  return pairs;
}

export default class Sessions {
  private stopped = false;
  private starting: Promise<void> | undefined;

  start(): Promise<void> {
    if (this.starting) return this.starting;
    const task = this.restore();
    this.starting = task;
    return task;
  }

  private async restore(): Promise<void> {
    const all = new Map<string, SessionPair>();
    for (const pair of await discoverFileSessions(sessionsPath)) all.set(instanceKey(pair.owner, pair.instanceName), pair);
    if (UserConfig.authStore === 'database') {
      for (const pair of await listDatabaseSessions()) all.set(instanceKey(pair.owner, pair.instanceName), pair);
    }
    const ambiguous = ambiguousLegacyKeys([...all.values()]);
    for (const [key, pair] of all) {
      if (this.stopped) break;
      if (ambiguous.has(`${pair.owner}_${pair.instanceName}`)) {
        console.error(`[${key}] Legacy database key is ambiguous; resolve ownership before restoring`);
        continue;
      }
      if (instances[key]) continue;
      let startedInstance: Instance | undefined;
      try {
        await PrismaConnection.migrateLegacyInstanceKey(pair.owner, pair.instanceName);
        const auth = await loadInstanceAuth(pair.owner, pair.instanceName);
        // Unpaired/expired entries remain available in the REST listing for manual connect.
        if (this.stopped || !auth.state.creds.registered) { await auth.drain(); continue; }
        const instance = new Instance({ loadAuth: async () => auth });
        if (this.stopped) break;
        if (instances[key]) continue;
        startedInstance = instance;
        await instance.create(pair);
      } catch {
        console.error(`[${key}] Session restore failed; preserved stored credentials and history`);
        if (startedInstance) {
          await startedInstance.shutdown();
          if (instances[key] === startedInstance) delete instances[key];
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    // Stop current sockets promptly, then catch any setup that was already in progress.
    await Promise.all(Object.values(instances).map(instance => instance.shutdown()));
    await this.starting?.catch(() => {});
    await Promise.all(Object.values(instances).map(instance => instance.shutdown()));
  }
}
