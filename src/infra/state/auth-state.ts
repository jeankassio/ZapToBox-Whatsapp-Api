import { lstat, mkdir, readFile, readdir, realpath, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BufferJSON, initAuthCreds, proto, type AuthenticationState, type SignalDataTypeMap } from '@whiskeysockets/baileys';
import { prisma } from '../../core/connection/prisma.js';
import { instanceKey, splitInstanceKey } from '../../shared/identity.js';
import { sessionsPath } from '../../shared/constants.js';
import UserConfig from '../config/env.js';
import { serializeBaileys } from '../mappers/messageMapper.js';

export interface AuthEntry { type: string; key: string; value: unknown | null }
export interface AuthRepository {
  read(type: string, ids: string[]): Promise<Record<string, unknown>>;
  write(entries: AuthEntry[]): Promise<void>;
  replace(entries: AuthEntry[]): Promise<void>;
  clear(): Promise<void>;
}

const revive = (value: unknown) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);
const legacyFilename = (type: string, id: string) => `${type}-${id}.json`.replace(/\//g, '__').replace(/:/g, '-');

/** No symlink/junction in a session path may redirect credentials or removal. */
export async function safeSessionDirectory(root: string, owner: string, name: string, create = false): Promise<string> {
  instanceKey(owner, name);
  const absoluteRoot = path.resolve(root);
  if (create) await mkdir(absoluteRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Unsafe session root');
  const canonicalRoot = await realpath(absoluteRoot);
  let current = canonicalRoot;
  for (const component of [owner, name]) {
    current = path.join(current, component);
    if (create) await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe session directory');
    const resolved = await realpath(current);
    if (resolved !== current) throw new Error('Unsafe session directory');
  }
  return current;
}

async function readSafeJSON(directory: string, filename: string): Promise<unknown | undefined> {
  if (filename !== path.basename(filename) || filename.includes(':')) throw new Error('Unsafe auth filename');
  const target = path.join(directory, filename);
  let info;
  try { info = await lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error('Unsafe auth file');
  // Invalid JSON is an error: never silently replace a corrupt session with new keys.
  return JSON.parse(await readFile(target, 'utf8'));
}

export function databaseAuthRepository(instance: string): AuthRepository {
  return {
    async read(type, ids) {
      const rows = await prisma.authState.findMany({ where: { instance, type, key: { in: ids } } });
      return Object.fromEntries(rows.map(row => [row.key, row.value]));
    },
    async write(entries) {
      await prisma.$transaction(entries.map(entry => entry.value === null
        ? prisma.authState.deleteMany({ where: { instance, type: entry.type, key: entry.key } })
        : prisma.authState.upsert({ where: { instance_type_key: { instance, type: entry.type, key: entry.key } },
          create: { instance, type: entry.type, key: entry.key, value: serializeBaileys(entry.value) },
          update: { value: serializeBaileys(entry.value) } })));
    },
    async clear() { await prisma.authState.deleteMany({ where: { instance } }); },
    async replace(entries) {
      await prisma.$transaction(async tx => {
        await tx.authState.deleteMany({ where: { instance } });
        for (const entry of entries) if (entry.value !== null) await tx.authState.create({
          data: { instance, type: entry.type, key: entry.key, value: serializeBaileys(entry.value) },
        });
      });
    },
  };
}

/** Optional local store: atomic full snapshot, suitable for one process only. */
export async function filesystemAuthRepository(directory: string): Promise<AuthRepository> {
  const snapshot = await readSafeJSON(directory, 'auth-state.json');
  const records = new Map<string, AuthEntry>();
  if (snapshot !== undefined) {
    if (!Array.isArray(snapshot)) throw new Error('Invalid auth snapshot');
    for (const entry of snapshot) {
      if (!entry || typeof entry.type !== 'string' || typeof entry.key !== 'string') throw new Error('Invalid auth snapshot');
      records.set(JSON.stringify([entry.type, entry.key]), entry);
    }
  }
  const commit = async (next: Map<string, AuthEntry>) => {
    const temporary = path.join(directory, `.auth-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify([...next.values()])); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temporary, path.join(directory, 'auth-state.json')); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    records.clear(); for (const [key, value] of next) records.set(key, value);
  };
  return {
    async read(type, ids) {
      return Object.fromEntries(ids.flatMap(id => {
        const entry = records.get(JSON.stringify([type, id]));
        return entry ? [[id, entry.value]] : [];
      }));
    },
    async write(entries) {
      const next = new Map(records);
      for (const entry of entries) {
        const key = JSON.stringify([entry.type, entry.key]);
        if (entry.value === null) next.delete(key);
        else next.set(key, { ...entry, value: serializeBaileys(entry.value) });
      }
      await commit(next);
    },
    async clear() { await commit(new Map()); },
    async replace(entries) {
      await commit(new Map(entries.filter(entry => entry.value !== null).map(entry => [JSON.stringify([entry.type, entry.key]), { ...entry, value: serializeBaileys(entry.value) }])));
    },
  };
}

/** All key categories, including future Baileys additions, use the same durable path. */
export async function createPersistentAuth(repository: AuthRepository, legacyDirectory?: string) {
  let stored = (await repository.read('creds', ['current'])).current;
  if (!stored && legacyDirectory) {
    const snapshot = await readSafeJSON(legacyDirectory, 'auth-state.json');
    if (snapshot !== undefined) {
      if (!Array.isArray(snapshot)) throw new Error('Invalid auth snapshot');
      const entries = snapshot as AuthEntry[];
      if (entries.some(entry => !entry || typeof entry.type !== 'string' || typeof entry.key !== 'string')) throw new Error('Invalid auth snapshot');
      stored = entries.find(entry => entry.type === 'creds' && entry.key === 'current')?.value;
      if (!stored) throw new Error('Auth snapshot has no credentials');
      await repository.write(entries);
    } else {
      stored = await readSafeJSON(legacyDirectory, 'creds.json');
      if (stored) {
        const entries: AuthEntry[] = [{ type: 'creds', key: 'current', value: stored }];
        for (const filename of await readdir(legacyDirectory)) {
          if (!filename.endsWith('.json') || filename === 'creds.json') continue;
          const value = await readSafeJSON(legacyDirectory, filename);
          if (value !== undefined) entries.push({ type: 'legacy', key: filename, value });
        }
        // Legacy filenames irreversibly escaped ':' and '/'. Keep their original lookup
        // until each key is rewritten, instead of guessing and damaging Signal sessions.
        await repository.write(entries);
      }
    }
  }
  const creds = stored ? revive(stored) : initAuthCreds();
  if (!creds.noiseKey?.private || typeof creds.registered !== 'boolean') throw new Error('Invalid authentication credentials');
  if (!stored) await repository.write([{ type: 'creds', key: 'current', value: serializeBaileys(creds) }]);
  let pending: Promise<void> = Promise.resolve();
  const run = (operation: () => Promise<void>) => {
    const current = pending.then(operation);
    pending = current.catch(() => {});
    return current;
  };
  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        await pending;
        const records = await repository.read(type, ids);
        const missing = ids.filter(id => records[id] === undefined);
        const legacy = missing.length ? await repository.read('legacy', missing.map(id => legacyFilename(type, id))) : {};
        const result: Record<string, SignalDataTypeMap[T]> = Object.create(null);
        for (const id of ids) {
          const storedValue = records[id] ?? legacy[legacyFilename(type, id)];
          if (storedValue == null) continue;
          let value = revive(storedValue);
          if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.create(value);
          result[id] = value;
        }
        return result;
      },
      set(data) {
        const entries: AuthEntry[] = [];
        for (const [type, values] of Object.entries(data)) {
          for (const [key, value] of Object.entries(values ?? {})) {
            entries.push({ type, key, value: value == null ? null : serializeBaileys(value) });
            entries.push({ type: 'legacy', key: legacyFilename(type, key), value: null });
          }
        }
        return run(() => repository.write(entries));
      },
    },
  };
  return {
    state,
    saveCreds() {
      const value = serializeBaileys(state.creds);
      return run(() => repository.write([{ type: 'creds', key: 'current', value }]));
    },
    async drain() { await pending; },
    async reset() {
      await run(async () => {
        const fresh = initAuthCreds();
        // Persist a fresh marker to prevent re-importing a logged-out legacy session.
        await repository.replace([{ type: 'creds', key: 'current', value: serializeBaileys(fresh) }]);
        for (const key of Object.keys(state.creds)) delete (state.creds as any)[key];
        Object.assign(state.creds, fresh);
      });
    },
    async remove() { await run(() => repository.clear()); },
  };
}

export type PersistentAuth = Awaited<ReturnType<typeof createPersistentAuth>>;
const loading = new Map<string, Promise<PersistentAuth>>();

export function loadInstanceAuth(owner: string, name: string): Promise<PersistentAuth> {
  const key = instanceKey(owner, name);
  const existing = loading.get(key);
  if (existing) return existing;
  const task = (async () => {
    const directory = await safeSessionDirectory(sessionsPath, owner, name, true);
    const repository = UserConfig.authStore === 'filesystem' ? await filesystemAuthRepository(directory) : databaseAuthRepository(key);
    return createPersistentAuth(repository, directory);
  })();
  loading.set(key, task);
  void task.finally(() => { if (loading.get(key) === task) loading.delete(key); }).catch(() => {});
  return task;
}

export async function listDatabaseSessions(): Promise<Array<{ owner: string; instanceName: string }>> {
  const rows = await prisma.authState.findMany({ where: { type: 'creds', key: 'current' }, select: { instance: true } });
  return rows.map(row => splitInstanceKey(row.instance));
}
