import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WASocket } from '@whiskeysockets/baileys';
import ProfileController, { type ProfileDependencies } from '../src/infra/http/controllers/profile.js';
import type { Contact } from '../src/shared/types.js';
import { instances, instanceStatus } from '../src/shared/constants.js';

const pn = '5531998765432@s.whatsapp.net', canonical = '553198765432@s.whatsapp.net', lid = '123456789012345@lid';
const device = (jid: string) => jid.replace('@', ':7@');
const repo = (contact?: Contact): NonNullable<ProfileDependencies['repository']> => ({ getContactById: async () => contact, getMessageById: async () => undefined, getLastMessageByInstance: async () => undefined });
const controller = (socket: unknown, repository = repo()) => new ProfileController('owner', 'one', { socket: socket as WASocket, repository });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

test('exact self PN and LID normalize device identifiers without calling storage or USync', async () => {
  let calls = 0;
  const repository = { ...repo(), getContactById: async () => { calls++; return undefined; } };
  const socket = { user: { id: device(pn), lid: device(lid), name: 'Meu perfil' }, onWhatsApp: async () => { calls++; return []; } };
  for (const query of [pn, device(pn), lid, device(lid)]) {
    const result = await controller(socket, repository).onWhatsapp(query);
    assert.equal(result.success, true); assert.equal(result.data.id, lid); assert.equal(result.data.phoneNumber, pn);
    assert.equal(result.data.queriedJid, query.replace(':7@', '@')); assert.equal(result.data.lookupSource, 'self');
    assert.equal(result.data.notify, 'Meu perfil'); assert.equal(result.data.name, undefined); assert.equal(result.data.savedName, undefined);
  }
  assert.equal(calls, 0);
  const result = await controller({ user: { id: device(lid) }, authState: { creds: { me: { id: device(pn), lid } } } }).onWhatsapp(pn);
  assert.equal(result.data.phoneNumber, pn); assert.equal(result.data.lookupSource, 'self');
});

test('cached PN/LID aliases keep saved names and remove every device suffix', async () => {
  const contact = { id: device(lid), lid: device(lid), phoneNumber: device(pn), name: 'Nome salvo', savedName: 'Nome salvo', nameSource: 'saved' as const };
  const lookups: string[] = [];
  const repository = { ...repo(), getContactById: async (_instance: string, id: string) => { lookups.push(id); return contact; } };
  const result = await controller({}, repository).onWhatsapp(device(pn));
  assert.deepEqual(lookups, [pn]); assert.equal(result.success, true);
  assert.deepEqual(result.data, { ...contact, id: lid, lid, phoneNumber: pn, queriedJid: pn, lookupSource: 'cache' });
});

test('LID resolution requires a known reverse mapping and never uses LID digits as a phone', async () => {
  let queries = 0; const mapped: string[] = [];
  const socket = { onWhatsApp: async () => { queries++; return []; }, signalRepository: { lidMapping: { getPNForLID: async (id: string) => { mapped.push(id); return device(pn); } } } };
  const result = await controller(socket, repo({ id: lid })).onWhatsapp(device(lid));
  assert.equal(result.success, true); assert.equal(result.data.phoneNumber, pn); assert.equal(result.data.id, lid); assert.equal(result.data.lookupSource, 'cache');
  assert.deepEqual(mapped, [lid]); assert.equal(queries, 0);
  const absent = await controller({ onWhatsApp: async () => { queries++; return []; } }).onWhatsapp(lid);
  assert.equal(absent.success, false); assert.equal(absent.statusCode, 502); assert.equal(queries, 0);
});

test('one positive provider result may confirm only the exact narrow Brazilian ninth-digit alias', async () => {
  for (const [input, output] of [[pn, canonical], [canonical, pn], [pn, pn]]) {
    const calls: string[] = [];
    const socket = { user: { id: '5511999999999@s.whatsapp.net', name: 'Outro perfil' }, onWhatsApp: async (query: string) => { calls.push(query); return [{ exists: true, jid: device(output) }]; } };
    const result = await controller(socket).onWhatsapp(device(input));
    assert.equal(result.success, true); assert.deepEqual(calls, [input]);
    assert.deepEqual(result.data, { id: output, phoneNumber: output, queriedJid: input, lookupSource: 'provider' });
    assert.equal(result.data.name, undefined); assert.equal(result.data.notify, undefined);
  }
  const selfAlias = await controller({ user: { id: canonical }, onWhatsApp: async () => [{ exists: true, jid: canonical }] }).onWhatsapp(pn);
  assert.equal(selfAlias.data.lookupSource, 'provider', 'a self spelling variant still requires provider confirmation');
});

test('unrelated, ambiguous or inconsistent destinations remain rejected', async () => {
  for (const resultId of ['553198765433@s.whatsapp.net', '553298765432@s.whatsapp.net', '543198765432@s.whatsapp.net', '553118765432@s.whatsapp.net', '120363123456@g.us', lid]) {
    const result = await controller({ onWhatsApp: async () => [{ exists: true, jid: resultId }] }).onWhatsapp(pn);
    assert.equal(result.success, false); assert.equal(result.statusCode, 502);
  }
  for (const candidates of [[{ exists: true, jid: pn }, { exists: true, jid: canonical }], [{ exists: true, jid: pn }, { exists: true, jid: pn }]]) {
    const result = await controller({ onWhatsApp: async () => candidates }).onWhatsapp(pn);
    assert.equal(result.success, false); assert.equal(result.statusCode, 502);
  }
  const missing = await controller({ onWhatsApp: async () => [] }).onWhatsapp(pn);
  assert.equal(missing.statusCode, 404);
  const mismatched = await controller({}, repo({ id: '553298765432@s.whatsapp.net', phoneNumber: pn })).onWhatsapp(pn);
  assert.equal(mismatched.statusCode, 502);
  const unconfirmedAlias = await controller({}, repo({ id: canonical })).onWhatsapp(pn);
  assert.equal(unconfirmedAlias.statusCode, 502, 'cached data alone cannot confirm a Brazilian spelling alias');
});

test('provider LID output can resolve only through a known matching PN mapping', async () => {
  const socket = { onWhatsApp: async () => [{ exists: true, jid: device(lid) }], signalRepository: { lidMapping: { getPNForLID: async () => device(canonical) } } };
  const result = await controller(socket).onWhatsapp(pn);
  assert.equal(result.success, true); assert.deepEqual(result.data, { id: lid, phoneNumber: canonical, queriedJid: pn, lookupSource: 'provider' });
});

test('disconnects during storage, provider or reverse-mapping awaits reject late successful responses', async () => {
  for (const phase of ['cache', 'provider', 'mapping']) {
    const delayed = deferred<any>(), entered = deferred<void>();
    const wait = async () => { entered.resolve(); return delayed.promise; };
    const socket: any = { ws: { isOpen: true }, onWhatsApp: phase === 'provider' ? wait : async () => [{ exists: true, jid: lid }], signalRepository: { lidMapping: { getPNForLID: wait } } };
    const repository = phase === 'cache' ? { ...repo(), getContactById: wait } : repo();
    const pending = controller(socket, repository).onWhatsapp(pn);
    await entered.promise; socket.ws.isOpen = false;
    delayed.resolve(phase === 'cache' ? { id: pn } : phase === 'provider' ? [{ exists: true, jid: pn }] : pn);
    const result = await pending;
    assert.equal(result.success, false); assert.equal(result.statusCode, 409); assert.equal(result.data, undefined);
  }
});

test('an older socket cannot resolve a recipient after the instance switches to another connected socket', async () => {
  const owner = `lookup_${randomUUID()}`, key = `${owner}/one`, entered = deferred<void>(), response = deferred<any>();
  let activeSocket: any = { onWhatsApp: async () => { entered.resolve(); return response.promise; } };
  instances[key] = { getSock: () => activeSocket } as any; instanceStatus.set(key, 'ONLINE');
  try {
    const pending = new ProfileController(owner, 'one', { repository: repo() }).onWhatsapp(pn);
    await entered.promise;
    activeSocket = { onWhatsApp: async () => [{ exists: true, jid: pn }] };
    response.resolve([{ exists: true, jid: pn }]);
    const result = await pending;
    assert.equal(result.success, false); assert.equal(result.statusCode, 409); assert.equal(result.data, undefined);
  } finally { delete instances[key]; instanceStatus.delete(key); }
});
