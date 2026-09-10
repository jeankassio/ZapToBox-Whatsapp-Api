import test from 'node:test';
import assert from 'node:assert/strict';
import type { WASocket } from '@whiskeysockets/baileys';
import SectionsController from '../src/infra/http/controllers/sections.js';
import { groupSpaceRecord, newsletterSpaceRecord, sectionsFromRecords, type SpaceRecord } from '../src/infra/mappers/spaces.js';
import { noteGroupSpaceChanges } from '../src/infra/baileys/sections-state.js';

const channel = '120363123456789@newsletter', community = '120363123456780@g.us', child = '120363123456781@g.us';
const baseSocket = () => ({ ws: { isOpen: true }, groupFetchAllParticipating: async () => ({}), communityFetchAllParticipating: async () => ({}), newsletterMetadata: async () => null }) as unknown as WASocket;

test('catalog uses actual community flags and parent links; normal and status chats are excluded', () => {
  const catalog = sectionsFromRecords([
    { id: 'status@broadcast', name: 'Status' }, { id: '5511999999999@s.whatsapp.net' },
    groupSpaceRecord({ id: community, subject: 'Comunidade real', isCommunity: true }),
    groupSpaceRecord({ id: child, subject: 'Avisos', linkedParent: community, isCommunityAnnounce: true }),
    groupSpaceRecord({ id: '120363111111111@g.us', subject: 'Grupo comum' }),
    { id: channel, name: 'Canal real', picture: { mediaKey: 'never exposed' } },
  ]);
  assert.equal(catalog.channels.length, 1); assert.equal(catalog.channels[0]!.readOnly, true);
  assert.equal(catalog.communities.length, 1); assert.equal(catalog.communities[0]!.groups[0]!.jid, child);
  assert.equal(catalog.communities[0]!.groups[0]!.readOnly, true);
  assert.equal(JSON.stringify(catalog).includes('never exposed'), false);
  assert.equal(newsletterSpaceRecord(channel, { id: 'different@newsletter' }), null);
});

test('live metadata queries are scoped, persisted, deduplicated and never follow channels', async () => {
  const socket = baseSocket(), queries: unknown[][] = [], saved: SpaceRecord[] = [];
  socket.groupFetchAllParticipating = async () => ({ [child]: { id: child, subject: 'Discussões', owner: undefined, participants: [], linkedParent: community } });
  socket.communityFetchAllParticipating = async () => ({ [community]: { id: community, subject: 'Minha comunidade', owner: undefined, participants: [], isCommunity: true } });
  socket.newsletterMetadata = async (...args) => { queries.push(args); return { id: channel, name: 'Notícias reais' }; };
  socket.newsletterFollow = async () => assert.fail('catalog must never subscribe');
  const controller = new SectionsController('account', 'one', { socket,
    readSpaces: async instance => { assert.equal(instance, 'account/one'); return [{ id: channel }]; },
    saveSpaces: async (instance, rows) => { assert.equal(instance, 'account/one'); saved.push(...rows); } });
  const [first, concurrent] = await Promise.all([controller.getSections(), controller.getSections()]);
  assert.deepEqual(first, concurrent); assert.equal(queries.length, 1); assert.deepEqual(queries[0], ['jid', channel]);
  assert.equal(first.data.channels[0].name, 'Notícias reais'); assert.equal(first.data.communities[0].name, 'Minha comunidade');
  assert.equal(first.data.communities[0].groups[0].readOnly, false); assert.equal(first.data.available, true);
  assert.equal(saved.length, 3); assert.ok(first.data.limitations.includes('NEWSLETTER_OBSERVED_ONLY'));
  await controller.getSections(); assert.equal(queries.length, 1);
});

test('offline catalog retains real saved records and reports provider unavailability', async () => {
  const socket = baseSocket(); (socket.ws as any).isOpen = false;
  socket.groupFetchAllParticipating = async () => assert.fail('offline must not query provider');
  const result = await new SectionsController('account', 'offline', { socket, readSpaces: async () => [{ id: channel, name: 'Salvo' }], saveSpaces: async () => assert.fail('offline must not overwrite metadata') }).getSections();
  assert.equal(result.data.available, false); assert.equal(result.data.channels[0].name, 'Salvo');
  assert.ok(result.data.limitations.includes('CONNECTION_UNAVAILABLE'));
});

test('ordinary groups do not consume the channel and community output limit', async () => {
  const socket = baseSocket(); (socket.ws as any).isOpen = false;
  const records = Array.from({ length: 1001 }, (_, index) => ({ id: `${120363100000000 + index}@g.us`, name: 'Ordinary group' }));
  records.push({ id: channel, name: 'Observed channel' });
  const result = await new SectionsController('account', 'large', { socket, readSpaces: async () => records }).getSections();
  assert.equal(result.data.channels.length, 1); assert.equal(result.data.channels[0].jid, channel);
  assert.equal(result.data.communities.length, 0);
});

test('provider timeouts preserve observations, mark incomplete metadata, and do not fake names', async () => {
  const socket = baseSocket();
  socket.groupFetchAllParticipating = async () => new Promise(() => {});
  socket.communityFetchAllParticipating = async () => { throw new Error('unavailable'); };
  socket.newsletterMetadata = async () => new Promise(() => {});
  const result = await new SectionsController('account', 'timeout', { socket, timeoutMs: 2,
    readSpaces: async () => [{ id: channel }], saveSpaces: async () => assert.fail('no metadata returned') }).getSections();
  assert.equal(result.data.available, false); assert.equal(result.data.partial, true); assert.equal(result.data.channels[0].name, channel);
  assert.ok(result.data.limitations.includes('CHANNEL_METADATA_UNAVAILABLE'));
});

test('a socket lost during collection cannot persist late provider data', async () => {
  const socket = baseSocket();
  socket.newsletterMetadata = async () => { (socket.ws as any).isOpen = false; return { id: channel, name: 'Late response' }; };
  const result = await new SectionsController('account', 'late', { socket, readSpaces: async () => [{ id: channel, name: 'Stored' }],
    saveSpaces: async () => assert.fail('old socket response must be discarded') }).getSections();
  assert.equal(result.data.available, false); assert.equal(result.data.channels[0].name, 'Stored');
});

test('complete group snapshots explicitly unlink old memberships while partial updates retain them', async () => {
  const stored = { id: child, name: 'Antes', linkedParent: community, isCommunity: false, isCommunityAnnounce: true, announce: true, description: 'Antiga' };
  const patch = groupSpaceRecord({ id: child, subject: 'Renomeado' });
  assert.equal(Object.hasOwn(patch, 'linkedParent'), false);
  assert.equal(sectionsFromRecords([{ ...stored, ...patch }]).communities[0]!.groups[0]!.jid, child);
  const socket = baseSocket(), saved: SpaceRecord[] = [];
  socket.groupFetchAllParticipating = async () => ({ [child]: { id: child, subject: 'Grupo separado', participants: [], linkedParent: undefined } });
  const result = await new SectionsController('account', 'unlink', { socket, readSpaces: async () => [stored], saveSpaces: async (_instance, rows) => { saved.push(...rows); } }).getSections();
  assert.equal(saved[0]!.linkedParent, null); assert.equal(saved[0]!.description, '');
  assert.equal(result.data.communities.length, 0);
  assert.deepEqual(result.data.groups[0], { jid: child, name: 'Grupo separado', description: '', isCommunity: false, linkedParent: null, isCommunityAnnounce: false, announce: false, readOnly: false });
});

test('new group events invalidate the catalog cache and win over an in-flight snapshot', async () => {
  const socket = baseSocket(), instance = 'account/events';
  let queries = 0, release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  socket.groupFetchAllParticipating = async () => { queries++; await pending; return { [child]: { id: child, subject: 'Old name', participants: [], linkedParent: community, announce: false } }; };
  const saved: SpaceRecord[] = [];
  const controller = new SectionsController('account', 'events', { socket, readSpaces: async () => [], saveSpaces: async (_instance, rows) => { saved.push(...rows); } });
  const request = controller.getSections();
  await new Promise(resolve => setImmediate(resolve));
  noteGroupSpaceChanges(socket, instance, [{ id: child, name: 'New name', announce: true }]);
  release();
  const result = await request;
  assert.equal(result.data.communities[0].groups[0].name, 'New name');
  assert.equal(result.data.communities[0].groups[0].readOnly, true);
  assert.equal(saved[0]!.name, 'New name'); assert.equal(saved[0]!.announce, true);
  await controller.getSections(); assert.equal(queries, 1, 'events already incorporated in the result do not disable caching');
  noteGroupSpaceChanges(socket, instance, [{ id: child, name: 'Another rename' }]);
  await controller.getSections(); assert.equal(queries, 2, 'a later event invalidates the completed cache');
});

test('a failed group snapshot cannot unlink stored memberships', async () => {
  const socket = baseSocket();
  socket.groupFetchAllParticipating = async () => { throw new Error('offline'); };
  socket.communityFetchAllParticipating = async () => { throw new Error('offline'); };
  const result = await new SectionsController('account', 'failed-unlink', { socket,
    readSpaces: async () => [{ id: child, linkedParent: community, isCommunityAnnounce: true }], saveSpaces: async () => assert.fail('failed snapshots must not write') }).getSections();
  assert.equal(result.data.groups[0].linkedParent, community);
  assert.equal(result.data.communities[0].groups[0].jid, child);
});
