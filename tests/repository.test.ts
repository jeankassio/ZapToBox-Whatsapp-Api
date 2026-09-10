import test from 'node:test';
import assert from 'node:assert/strict';
import Repository, { prisma } from '../src/core/connection/prisma.js';

test('merging a named LID into an older unnamed phone contact retains the name and both identifiers', async t => {
  const instance = 'qa_owner/contact_merge';
  const jid = '5511999999999@s.whatsapp.net';
  const lid = '123456789@lid';
  const rows: any[] = [
    { id: 1, instance, name: null as string | null, jid: jid as string | null, lid: null as string | null },
    { id: 2, instance, name: 'Nome sincronizado', jid: null, lid },
  ];
  let updates = 0, reads = 0;
  const tx = { contact: {
    findMany: async () => { reads++; return [...rows]; },
    deleteMany: async ({ where }: any) => {
      assert.equal(where.instance, instance);
      for (let i = rows.length - 1; i >= 0; i--) if (where.id.in.includes(rows[i]!.id)) rows.splice(i, 1);
    },
    update: async ({ where, data }: any) => {
      updates++;
      const row = rows.find(entry => entry.id === where.id)!;
      Object.assign(row, data);
      return row;
    },
  } };
  // Prisma exposes methods through a proxy, so MockTracker cannot find a descriptor.
  const transaction = prisma.$transaction;
  prisma.$transaction = (async (operation: any) => operation(tx)) as typeof transaction;
  t.after(() => { prisma.$transaction = transaction; });
  await Repository.saveContact(instance, { id: lid, phoneNumber: jid });
  assert.equal(rows.length, 1); assert.equal(rows[0].name, 'Nome sincronizado'); assert.equal(rows[0].jid, jid); assert.equal(rows[0].lid, lid);
  assert.deepEqual(rows[0].nameMetadata, { legacyName: 'Nome sincronizado' });
  await Repository.saveContact(instance, { id: jid, name: 'Nome atualizado' });
  const observed = rows[0].nameMetadata.savedNameUpdatedAt;
  assert.equal(rows[0].name, 'Nome atualizado'); assert.equal(rows[0].nameMetadata.savedName, 'Nome atualizado');
  const published = await Repository.saveContact(instance, { id: lid, notify: 'Nome do perfil' });
  assert.equal(rows[0].name, 'Nome atualizado'); assert.equal(published?.name, 'Nome atualizado'); assert.equal(published?.notify, 'Nome do perfil');
  assert.equal(published?.savedNameUpdatedAt, observed);
  const priorUpdates = updates, priorReads = reads;
  const repeated = await Repository.saveManyContacts(instance, Array.from({ length: 100 }, () => ({ id: lid, notify: 'Nome do perfil' })));
  assert.equal(repeated.length, 100, 'deduplication preserves webhook counts');
  assert.equal(reads - priorReads, 1, 'identical adjacent replays share one lookup');
  assert.equal(updates - priorUpdates, 0, 'unchanged names and provenance need no UPDATE');
});
