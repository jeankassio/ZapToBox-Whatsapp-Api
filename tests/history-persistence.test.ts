import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import type { WAMessage } from '@whiskeysockets/baileys';
import Repository, { prisma } from '../src/core/connection/prisma.js';

function fixture(t: TestContext) {
  const rows = new Map<string, any>();
  const calls = { findMany: 0, findUnique: 0, createMany: 0, upsert: 0 };
  const key = (instance: string, id: string) => `${instance}/${id}`;
  const delegate = prisma.message as any;
  const original = Object.fromEntries(Object.keys(calls).map(name => [name, delegate[name]]));
  const methods = {
    async findMany({ where }: any) {
      calls.findMany++;
      return [...rows.values()].filter(row => row.instance === where.instance && where.messageId.in.includes(row.messageId));
    },
    async findUnique({ where }: any) {
      calls.findUnique++;
      return rows.get(key(where.instance_messageId.instance, where.instance_messageId.messageId)) ?? null;
    },
    async createMany({ data }: any) {
      calls.createMany++;
      assert.ok(data.length <= 100);
      for (const row of data) assert.equal(rows.has(key(row.instance, row.messageId)), false, 'bulk insertion must not clobber an existing message');
      for (const row of data) rows.set(key(row.instance, row.messageId), { id: rows.size + 1, ...row });
      return { count: data.length };
    },
    async upsert({ where, create, update }: any) {
      calls.upsert++;
      const id = key(where.instance_messageId.instance, where.instance_messageId.messageId);
      const row = rows.has(id) ? { ...rows.get(id), ...update } : { id: rows.size + 1, ...create };
      rows.set(id, row);
      return row;
    },
  };
  for (const [name, method] of Object.entries(methods)) { delegate[name] = method; assert.equal(delegate[name], method); }
  t.after(() => { for (const [name, method] of Object.entries(original)) delegate[name] = method; });
  return { rows, calls, delegate, methods };
}

test('history inserts bounded batches, skips unchanged replay writes and isolates tenants', async t => {
  const f = fixture(t);
  const messages: WAMessage[] = Array.from({ length: 251 }, (_, index) => ({
    key: { id: `message-${index}`, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false },
    message: { imageMessage: { caption: String(index), mediaKey: Buffer.from([1, 2, 3]) } },
    messageTimestamp: 1700000000 + index, status: 2,
  }));
  await Repository.saveManyMessages('owner/a', messages);
  assert.equal(f.rows.size, 251);
  assert.deepEqual(f.calls, { findMany: 3, createMany: 3, findUnique: 0, upsert: 0 });
  await Repository.saveManyMessages('owner/a', messages);
  assert.equal(f.rows.size, 251);
  assert.deepEqual(f.calls, { findMany: 6, createMany: 3, findUnique: 0, upsert: 0 });
  const saved = await Repository.getMessageById('message-0', 'owner/a');
  assert.deepEqual(saved?.message?.imageMessage?.mediaKey, Buffer.from([1, 2, 3]));
  await Repository.saveManyMessages('owner/b', [{ ...messages[0]!, message: { conversation: 'Other account' } }]);
  assert.equal(f.rows.size, 252);
  assert.equal((await Repository.getMessageById('message-0', 'owner/a'))?.message?.imageMessage?.caption, '0');
  assert.equal((await Repository.getMessageById('message-0', 'owner/b'))?.message?.conversation, 'Other account');
});

test('history duplicates preserve edit order, timestamps and partial status updates', async t => {
  const f = fixture(t);
  const key = { id: 'edited', remoteJid: '123@lid', fromMe: false };
  await Repository.saveManyMessages('owner/a', [
    { key, message: { conversation: 'Original' }, messageTimestamp: 1700000000, status: 2 },
    { key, message: { editedMessage: { message: { conversation: 'Edited' } } }, messageTimestamp: 1700000060 },
    { key, status: 3 },
  ]);
  const row = f.rows.get('owner/a/edited');
  assert.equal(row.messageTimestamp, 1700000000n);
  assert.equal(row.status, '3');
  assert.equal(row.content.message.editedMessage.message.conversation, 'Edited');
  assert.equal(row.content.sourceEdit.version, 1);
  assert.equal(f.calls.createMany, 0);
  await Repository.saveManyMessages('owner/a', [{ key: { id: key.id, remoteJid: '5511999999999@s.whatsapp.net' }, status: 4 }]);
  const updated = f.rows.get('owner/a/edited');
  assert.equal(updated.content.key.remoteJidAlt, key.remoteJid);
  assert.equal(updated.content.message.editedMessage.message.conversation, 'Edited');
  assert.equal(updated.messageTimestamp, 1700000000n);
  assert.equal(updated.status, '4');
});

test('live edits wait for an in-flight bulk insert for the same instance', async t => {
  const f = fixture(t);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  f.delegate.createMany = async (query: any) => { entered(); await gate; return f.methods.createMany(query); };
  const key = { id: 'race', remoteJid: '123@lid' };
  const importing = Repository.saveManyMessages('owner/a', [{ key, message: { conversation: 'Original' }, messageTimestamp: 1700000000 }]);
  await ready;
  const editing = Repository.saveMessages('owner/a', { key, message: { editedMessage: { message: { conversation: 'Edited' } } }, messageTimestamp: 1700000060 });
  await tick();
  assert.equal(f.calls.upsert, 0);
  release(); await Promise.all([importing, editing]);
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.get('owner/a/race').content.message.editedMessage.message.conversation, 'Edited');
  assert.equal(f.rows.get('owner/a/race').messageTimestamp, 1700000000n);
});

test('interleaved new messages and duplicates retain the original timestamp tie order', async t => {
  const f = fixture(t);
  const first = { key: { id: 'first', remoteJid: '123@lid' }, message: { conversation: 'First' }, messageTimestamp: 1700000000 };
  const second = { ...first, key: { ...first.key, id: 'second' }, message: { conversation: 'Second' } };
  await Repository.saveManyMessages('owner/a', [first, second, { key: first.key, status: 4 }]);
  assert.ok(f.rows.get('owner/a/first').id < f.rows.get('owner/a/second').id);
  await Repository.saveManyMessages('owner/b', [
    { ...first, message: { editedMessage: { message: { conversation: 'Edited first' } } } }, second,
  ]);
  assert.ok(f.rows.get('owner/b/first').id < f.rows.get('owner/b/second').id);
});
