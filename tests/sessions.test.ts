import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import Sessions from '../src/infra/state/sessions.js';
import { instances } from '../src/shared/constants.js';
import type Instance from '../src/infra/baileys/services.js';
import type { PersistentAuth } from '../src/infra/state/auth-state.js';

const auth = (registered: boolean) => ({ state: { creds: { registered } }, drain: async () => {} }) as PersistentAuth;

test('startup retries failed auth restore, skips unpaired credentials, and never duplicates a restored socket', async t => {
  const owner = `restore_${randomUUID()}`;
  const pairs = ['ready', 'pending', 'unpaired'].map(instanceName => ({ owner, instanceName }));
  const keys = pairs.map(pair => `${owner}/${pair.instanceName}`);
  let attempts = 0;
  const starts: string[] = [];
  const sessions = new Sessions({
    discoverFiles: async () => pairs, useDatabase: () => false,
    migrate: async () => {},
    loadAuth: async (_owner, name) => {
      if (name === 'pending' && ++attempts === 1) throw new Error('Temporary credentials read failure');
      return auth(name !== 'unpaired');
    },
    createInstance: () => {
      const instance = {
        async create(pair: { owner: string; instanceName: string }) {
          starts.push(pair.instanceName); instances[`${pair.owner}/${pair.instanceName}`] = instance as unknown as Instance;
        },
        async shutdown() {},
      };
      return instance as unknown as Instance;
    },
    retryDelayMs: 1, retryMaxDelayMs: 1,
  });
  t.after(async () => { await sessions.shutdown(); for (const key of keys) delete instances[key]; });
  await sessions.start();
  assert.deepEqual(starts, ['ready']);
  await sleep(20);
  assert.deepEqual(starts, ['ready', 'pending']);
  assert.equal(attempts, 2);
  await sessions.start();
  assert.deepEqual(starts, ['ready', 'pending']);
});

test('startup discovery outages retry and shutdown cancels that recovery timer', async t => {
  let calls = 0;
  const sessions = new Sessions({
    discoverFiles: async () => { calls++; throw new Error('Storage unreachable'); },
    retryDelayMs: 1, retryMaxDelayMs: 1,
  });
  t.after(() => sessions.shutdown());
  await sessions.start(); await sleep(15);
  assert.ok(calls > 1);
  await sessions.shutdown(); const afterShutdown = calls;
  await sleep(15); await sessions.start();
  assert.equal(calls, afterShutdown);
});

test('one failed shutdown cannot release storage before every other instance has drained', async t => {
  const prefix = `drain_${randomUUID()}`, failedKey = `${prefix}/failed`, slowKey = `${prefix}/slow`;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  instances[failedKey] = { async shutdown() { throw new Error('Auth write unavailable'); } } as unknown as Instance;
  instances[slowKey] = { async shutdown() { await pending; } } as unknown as Instance;
  t.after(() => { release(); delete instances[failedKey]; delete instances[slowKey]; });
  const sessions = new Sessions();
  let finished = false;
  const stopping = sessions.shutdown().finally(() => { finished = true; });
  const assertion = assert.rejects(stopping, AggregateError);
  await sleep(10);
  assert.equal(finished, false, 'database and webhook shutdown must wait for the slow instance');
  release(); await assertion; assert.equal(finished, true);
});
