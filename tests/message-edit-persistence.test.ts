import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import Repository, { prisma } from '../src/core/connection/prisma.js';
import { isEditedMessage } from '../src/infra/mappers/messageMapper.js';

function stubMessages(t: TestContext, methods: { findUnique: (query: any) => Promise<any>; upsert: (query: any) => Promise<any> }) {
  // Prisma delegates expose methods through a Proxy rather than own descriptors.
  const delegate = prisma.message as any;
  for (const [name, replacement] of Object.entries(methods)) {
    const original = delegate[name]; delegate[name] = replacement;
    assert.equal((prisma.message as any)[name], replacement, 'Database calls must remain stubbed');
    t.after(() => { delegate[name] = original; });
  }
}

test('edits preserve original send time and current content while deletion stays deleted', async t => {
  const rows = new Map<string, any>();
  stubMessages(t, { findUnique: async ({ where }: any) => rows.get(where.instance_messageId.instance + '/' + where.instance_messageId.messageId) ?? null,
  upsert: async ({ where, create, update }: any) => {
    const id = where.instance_messageId.instance + '/' + where.instance_messageId.messageId;
    const row = rows.has(id) ? { ...rows.get(id), ...update } : { id: rows.size + 1, ...create };
    rows.set(id, row); return row;
  } });
  const key = { id: 'original', remoteJid: '5511999999999@s.whatsapp.net', fromMe: false };
  await Repository.saveMessages('owner/session', { key, message: { conversation: 'Texto original' }, messageTimestamp: 1700000000 });
  await Repository.saveMessages('owner/session', { key, message: { editedMessage: { message: { conversation: 'Última revisão' } } }, messageTimestamp: 1700000300 });
  const saved = await Repository.getMessageById('original', 'owner/session');
  assert.equal(saved?.messageTimestamp, 1700000000);
  assert.equal(saved?.message?.editedMessage?.message?.conversation, 'Última revisão');
  assert.equal(rows.get('owner/session/original').content.messageTimestamp, '1700000000');
  assert.deepEqual(rows.get('owner/session/original').content.sourceEdit, {
    version: 1, editedAtMs: 1700000300000, sourceUpdatedAt: rows.get('owner/session/original').content.sourceEdit.sourceUpdatedAt,
  });
  await Repository.saveMessages('owner/session', { key, message: { editedMessage: { message: { conversation: 'Última revisão' } } }, messageTimestamp: 1700000300 });
  assert.equal(rows.get('owner/session/original').content.sourceEdit.version, 1, 'a duplicate store update does not invent another revision');
  await Repository.saveMessages('owner/session', { key, message: { protocolMessage: { editedMessage: { conversation: 'Revisão seguinte' }, timestampMs: 1700000300000 } } as any, messageTimestamp: 1700000300 });
  assert.equal(rows.get('owner/session/original').content.sourceEdit.version, 2);
  assert.equal(isEditedMessage(saved?.message), true);
  await Repository.saveMessages('owner/session', { key, message: null, messageTimestamp: 1700000500 });
  assert.equal((await Repository.getMessageById('original', 'owner/session'))?.message, null);
  assert.equal(isEditedMessage((await Repository.getMessageById('original', 'owner/session'))?.message), false);
});

test('edit detection handles wrappers and unknown original dates can still acquire a usable timestamp', async t => {
  const rows = new Map<string, any>();
  stubMessages(t, { findUnique: async ({ where }: any) => rows.get(where.instance_messageId.messageId) ?? null,
  upsert: async ({ where, create, update }: any) => {
    const id = where.instance_messageId.messageId, row = rows.has(id) ? { ...rows.get(id), ...update } : { id: 1, ...create };
    rows.set(id, row); return row;
  } });
  const key = { id: 'no-original-time', remoteJid: '5511999999999@s.whatsapp.net' };
  await Repository.saveMessages('owner/session', { key, message: { conversation: 'Sem data' } });
  await Repository.saveMessages('owner/session', { key, message: { editedMessage: { message: { conversation: 'Revisão' } } }, messageTimestamp: 1700000600 });
  assert.equal((await Repository.getMessageById(key.id, 'owner/session'))?.messageTimestamp, 1700000600);
  assert.equal(isEditedMessage({ ephemeralMessage: { message: { editedMessage: { message: { conversation: 'x' } } } } }), true);
  assert.equal(isEditedMessage({ protocolMessage: { editedMessage: { conversation: 'x' } } }), true);
  for (const value of [null, undefined, {}, { conversation: 'x' }, { editedMessage: 'invalid' }]) assert.equal(isEditedMessage(value), false);
});
