import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import Token from '../src/infra/state/auth.js';
import ProfileRoutes from '../src/infra/http/routes/profile.js';
import ProfileController from '../src/infra/http/controllers/profile.js';
import { PresenceState } from '../src/infra/baileys/presence-state.js';

// Real HTTP routes/adapters with isolated SQLite and a simulated WhatsApp lookup.
test('new conversation resolves the Brazilian ninth digit through the actual API and reuses its canonical chat', {
  skip: !process.env.QA_BACKEND_PATH,
}, async t => {
  const load = (file: string) => import(pathToFileURL(join(resolve(process.env.QA_BACKEND_PATH!), 'dist', `${file}.js`)).href);
  const [{ SqliteDatabase }, { migrate }, { WhatsappClient }, { createChatRouter }, { errorHandler }] = await Promise.all([
    load('db'), load('migrate'), load('whatsapp/client'), load('whatsapp/chats'), load('errors'),
  ]);
  const db = new SqliteDatabase(); t.after(() => db.close()); await migrate(db);
  const name = `qa_ninth_${randomUUID().replaceAll('-', '')}`, token = `qa-only-${randomUUID()}`;
  await db.execute("INSERT INTO tbl_users (_id,_email,_status) VALUES (1,'ninth@example.test',1)");
  await db.execute("INSERT INTO tbl_instances (_id,_user,_identify,_name,_label,_status,_expire,_created) VALUES (1,1,'qa-ninth',?,'Teste','1','2099-01-01 00:00:00','2026-01-01 00:00:00')", [name]);
  const requested = '5531998765432@s.whatsapp.net', canonical = '553198765432@s.whatsapp.net', lookups: string[] = [];
  const presence = new PresenceState(); let subscriptions = 0;
  const socket = { ws: { isOpen: true }, onWhatsApp: async (jid: string) => {
    lookups.push(jid); return [{ exists: true, jid: canonical }];
  } };
  const repository = { getContactById: async () => undefined, getMessageById: async () => undefined, getLastMessageByInstance: async () => undefined };
  const apiApp = express(); apiApp.use(new Token(token).verify); apiApp.use(express.json());
  apiApp.use('/profile', new ProfileRoutes((owner, instanceName) => {
    assert.equal(owner, '1'); assert.equal(instanceName, name);
    return new ProfileController(owner, instanceName, { socket: socket as any, repository, presenceSubscribe: async (jid, currentSocket) => {
      assert.equal(currentSocket, socket); assert.equal(jid, canonical);
      return presence.subscribe(jid, async () => {
        subscriptions++;
        presence.observe({ id: canonical, presences: { [canonical]: { lastKnownPresence: 'available' } } });
      });
    } });
  }).get());
  const api = apiApp.listen(0, '127.0.0.1'); await once(api, 'listening');
  const client = new WhatsappClient({ baseUrl: `http://127.0.0.1:${(api.address() as { port: number }).port}`, token });
  const backApp = express(); backApp.use(express.json());
  backApp.use((req: any, _res, next) => { req.user = { id: 1 }; next(); });
  backApp.use('/api/connections', createChatRouter(db, client, () => {}, undefined, false)); backApp.use(errorHandler);
  const back = backApp.listen(0, '127.0.0.1'); await once(back, 'listening');
  t.after(async () => {
    api.closeAllConnections(); back.closeAllConnections();
    await Promise.all([new Promise<void>(done => api.close(() => done())), new Promise<void>(done => back.close(() => done()))]);
  });
  const start = async (phoneNumber: string, name: string | null) => {
    const response = await fetch(`http://127.0.0.1:${(back.address() as { port: number }).port}/api/connections/qa-ninth/chats`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNumber, name, channelId: null }),
    });
    return { status: response.status, body: await response.json() };
  };
  const first = await start('+55 (31) 99876-5432', 'Contato confirmado');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await start('5531998765432', null), shorter = await start('553198765432', null);
  for (const result of [again, shorter]) {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.chatId, first.body.data.chatId);
  }
  assert.deepEqual(lookups, [requested, requested], 'the entered address is queried unchanged; no alternate recipient is probed');
  const rows = await db.query('SELECT c._jid,ct._name FROM tbl_chat c JOIN tbl_contacts ct ON ct._id=c._contact WHERE c._instanceId=1');
  assert.equal(rows.length, 1); assert.equal(rows[0]._jid, canonical); assert.equal(rows[0]._name, 'Contato confirmado');
  const unrelated = await start('5532998765432', null);
  assert.equal(unrelated.status, 424, JSON.stringify(unrelated.body));
  assert.equal((await db.query('SELECT _id FROM tbl_chat WHERE _instanceId=1')).length, 1, 'another area code is not treated as an alias');

  // The chat opened with nine digits also observes the canonical recipient.
  const observe = async () => {
    const response = await fetch(`http://127.0.0.1:${(back.address() as { port: number }).port}/api/connections/qa-ninth/chats/${first.body.data.chatId}/whatsapp-presence`);
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    return body.data;
  };
  const online = await observe();
  assert.equal(online.supported, true); assert.equal(online.id, canonical);
  assert.deepEqual(online.presences, { [canonical]: { lastKnownPresence: 'available' } });
  assert.equal(Date.parse(online.expiresAt) - Date.parse(online.observedAt), 90_000);
  const lastSeen = Math.floor(Date.now() / 1000) - 600;
  presence.observe({ id: canonical, presences: { [canonical]: { lastKnownPresence: 'unavailable', lastSeen } } });
  assert.deepEqual((await observe()).presences, { [canonical]: { lastKnownPresence: 'unavailable', lastSeen } });
  presence.observe({ id: canonical, presences: { [canonical]: { lastKnownPresence: 'unavailable' } } });
  assert.deepEqual((await observe()).presences, { [canonical]: { lastKnownPresence: 'unavailable' } }, 'last seen stays absent when the provider hides it');
  assert.equal(subscriptions, 1, 'repeated header refreshes share a subscription');
});
