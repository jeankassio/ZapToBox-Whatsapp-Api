import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactMapper, mergeContactNames, observeContact } from '../src/infra/mappers/contactMapper.js';

const jid = '5511999999999@s.whatsapp.net', first = '2026-09-10T12:00:00.000Z', later = '2026-09-10T12:01:00.000Z';
test('profile names never replace a saved phone name, including after alias merge', () => {
  const saved = mergeContactNames([], { id: jid, name: 'Minha dentista', savedNameUpdatedAt: first });
  const merged = mergeContactNames([{ name: 'Antigo sem fonte' }, saved], { id: jid, notify: 'Maria', verifiedName: 'Consultório' });
  assert.equal(merged.name, 'Minha dentista');
  assert.equal(merged.nameMetadata.savedNameUpdatedAt, first);
  const contact = ContactMapper.toContact({ ...merged, jid });
  assert.equal(contact.nameSource, 'saved'); assert.equal(contact.savedName, 'Minha dentista'); assert.equal(contact.notify, 'Maria');
});
test('explicit saved-name removal has a durable timestamp and replay cannot resurrect the old name', () => {
  const initial = mergeContactNames([], { name: 'Agenda', savedNameUpdatedAt: first, notify: 'Perfil' });
  const removed = mergeContactNames([initial], observeContact({ name: '' }, later));
  assert.equal(removed.name, 'Perfil'); assert.equal(removed.nameMetadata.savedName, null);
  assert.equal(removed.nameMetadata.savedNameUpdatedAt, later);
  const replay = mergeContactNames([removed], { name: 'Agenda', savedNameUpdatedAt: first });
  assert.deepEqual(replay, removed);
  const wire = ContactMapper.toContact({ ...replay, jid });
  assert.equal(wire.name, null); assert.equal(wire.savedName, null); assert.equal(wire.savedNameUpdatedAt, later);
  assert.equal(wire.nameSource, 'notify');
});
test('legacy names remain fallbacks and missing contact names never mean removal', () => {
  const legacy = ContactMapper.toContact({ jid, name: 'Nome antigo' });
  assert.equal(legacy.name, undefined); assert.equal(legacy.savedName, undefined); assert.equal(legacy.legacyName, 'Nome antigo'); assert.equal(legacy.nameSource, 'legacy');
  const original = mergeContactNames([], { name: 'Agenda', savedNameUpdatedAt: first });
  assert.equal(observeContact({ id: jid, name: undefined, notify: 'Perfil' }, later).savedName, undefined);
  const partial = mergeContactNames([original], { id: jid, notify: 'Perfil' });
  assert.equal(partial.name, 'Agenda'); assert.equal(partial.nameMetadata.savedNameUpdatedAt, first);
  assert.equal(ContactMapper.toContact({ ...partial, jid }).savedNameUpdatedAt, first);
});
test('cleared metadata in either alias prevents an older named alias from restoring it', () => {
  const old = mergeContactNames([], { name: 'Agenda', savedNameUpdatedAt: first });
  const removed = mergeContactNames([], { savedName: null, savedNameUpdatedAt: later, notify: 'Perfil' });
  const combined = mergeContactNames([old, removed], { id: jid });
  assert.equal(combined.name, 'Perfil'); assert.equal(combined.nameMetadata.savedName, null);
  assert.equal(combined.nameMetadata.savedNameUpdatedAt, later);
});

test('an equal newer saved name advances the watermark and rejects an intermediate stale replay', () => {
  const middle = '2026-09-10T12:00:30.000Z';
  const initial = mergeContactNames([], { name: 'Agenda A', savedNameUpdatedAt: first });
  const newer = mergeContactNames([initial], { name: 'Agenda A', savedNameUpdatedAt: later });
  assert.equal(newer.nameMetadata.savedNameUpdatedAt, later);
  const stale = mergeContactNames([newer], { name: 'Agenda B', savedNameUpdatedAt: middle });
  assert.deepEqual(stale, newer);
  const alias = mergeContactNames([newer, mergeContactNames([], { name: 'Agenda B', savedNameUpdatedAt: middle })], { id: jid });
  assert.equal(alias.name, 'Agenda A'); assert.equal(alias.nameMetadata.savedNameUpdatedAt, later);
  assert.deepEqual(mergeContactNames([newer], { name: 'Agenda A', savedNameUpdatedAt: later }), newer, 'exact replay remains unchanged');
});
