import test from 'node:test';
import assert from 'node:assert/strict';
import Repository, { prisma } from '../src/core/connection/prisma.js';

test('merging a named LID into an older unnamed phone contact retains the name and both identifiers', async t => {
  const instance = 'qa_owner/contact_merge';
  const jid = '5511999999999@s.whatsapp.net';
  const lid = '123456789@lid';
  const rows = [
    { id: 1, instance, name: null as string | null, jid: jid as string | null, lid: null as string | null },
    { id: 2, instance, name: 'Nome sincronizado', jid: null, lid },
  ];
  const tx = { contact: {
    findMany: async () => [...rows],
    deleteMany: async ({ where }: any) => {
      assert.equal(where.instance, instance);
      for (let i = rows.length - 1; i >= 0; i--) if (where.id.in.includes(rows[i]!.id)) rows.splice(i, 1);
    },
    update: async ({ where, data }: any) => {
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
  assert.deepEqual(rows, [{ id: 1, instance, name: 'Nome sincronizado', jid, lid }]);
  await Repository.saveContact(instance, { id: jid, name: 'Nome atualizado' });
  assert.deepEqual(rows, [{ id: 1, instance, name: 'Nome atualizado', jid, lid }]);
});
