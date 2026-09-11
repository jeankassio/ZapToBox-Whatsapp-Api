import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { instances, sessionsPath } from '../../shared/constants.js';
import { instanceKey, validateIdentity } from '../../shared/identity.js';
import Instance from '../baileys/services.js';
import { listDatabaseSessions, loadInstanceAuth, safeSessionDirectory, type PersistentAuth } from './auth-state.js';
import PrismaConnection from '../../core/connection/prisma.js';
import UserConfig from '../config/env.js';
import { hasLinkedCredentials } from '../../shared/auth-credentials.js';

type SessionPair = { owner: string; instanceName: string };
interface SessionDependencies {
  discoverFiles: () => Promise<SessionPair[]>;
  discoverDatabase: () => Promise<SessionPair[]>;
  useDatabase: () => boolean;
  migrate: (owner: string, name: string) => Promise<unknown>;
  loadAuth: typeof loadInstanceAuth;
  createInstance: (auth: PersistentAuth) => Instance;
  retryDelayMs: number;
  retryMaxDelayMs: number;
  healthIntervalMs: number;
  random: () => number;
}

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
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private attempts = 0;
  private readonly dependencies: SessionDependencies;

  constructor(dependencies: Partial<SessionDependencies> = {}) {
    this.dependencies = {
      discoverFiles: () => discoverFileSessions(sessionsPath), discoverDatabase: listDatabaseSessions,
      useDatabase: () => UserConfig.authStore === 'database',
      migrate: (owner, name) => PrismaConnection.migrateLegacyInstanceKey(owner, name),
      loadAuth: loadInstanceAuth, createInstance: auth => new Instance({ loadAuth: async () => auth }),
      retryDelayMs: 1000, retryMaxDelayMs: 30_000, random: Math.random,
      healthIntervalMs: 15_000,
      ...dependencies,
    };
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.stopped) return Promise.resolve();
    // One supervisor for all instances, including ones created later by HTTP.
    // Healthy sockets use Baileys keepalive; this does not issue extra requests.
    if (!this.healthTimer) {
      this.healthTimer = setInterval(() => {
        for (const [key, instance] of Object.entries(instances)) {
          try { instance.checkHealth(); }
          catch { console.error(`[${key}] Session supervision failed; credentials preserved`); }
        }
      }, this.dependencies.healthIntervalMs);
      this.healthTimer.unref();
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const task = this.restore().catch(() => {
      console.error('Session discovery failed; stored credentials preserved');
      this.scheduleRetry();
    });
    this.starting = task;
    void task.finally(() => { if (this.starting === task) this.starting = undefined; });
    return task;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const ceiling = Math.min(this.dependencies.retryMaxDelayMs, this.dependencies.retryDelayMs * 2 ** Math.min(this.attempts++, 16));
    const delay = Math.max(1, Math.round(ceiling * (0.5 + this.dependencies.random() * 0.5)));
    console.info(`Session restore retry attempt=${this.attempts} delayMs=${delay}`);
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; void this.start(); }, delay);
    this.retryTimer.unref();
  }

  private async restore(): Promise<void> {
    const all = new Map<string, SessionPair>();
    for (const pair of await this.dependencies.discoverFiles()) all.set(instanceKey(pair.owner, pair.instanceName), pair);
    if (this.dependencies.useDatabase()) {
      for (const pair of await this.dependencies.discoverDatabase()) all.set(instanceKey(pair.owner, pair.instanceName), pair);
    }
    let failed = false;
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
        await this.dependencies.migrate(pair.owner, pair.instanceName);
        const auth = await this.dependencies.loadAuth(pair.owner, pair.instanceName);
        // Unpaired/expired entries remain available in the REST listing for manual connect.
        if (this.stopped || !hasLinkedCredentials(auth.state.creds)) { await auth.drain(); continue; }
        const instance = this.dependencies.createInstance(auth);
        if (this.stopped) break;
        if (instances[key]) continue;
        startedInstance = instance;
        await instance.create(pair);
      } catch {
        failed = true;
        console.error(`[${key}] Session restore failed; preserved stored credentials and history`);
        if (startedInstance) {
          await startedInstance.shutdown();
          if (instances[key] === startedInstance) delete instances[key];
        }
      }
    }
    if (failed) this.scheduleRetry();
    else this.attempts = 0;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    // Stop current sockets promptly, then catch any setup that was already in progress.
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    const failures: unknown[] = [];
    const drain = async () => {
      const settled = await Promise.allSettled(Object.values(instances).map(instance => instance.shutdown()));
      for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
    };
    // A failed auth write must not let runtime disconnect the database while
    // another instance still drains accepted writes against that database.
    await drain();
    await this.starting?.catch(() => {});
    await drain();
    if (failures.length) throw new AggregateError(failures, 'Session shutdown failed');
  }
}
