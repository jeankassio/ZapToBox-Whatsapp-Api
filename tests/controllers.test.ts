import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { WAMessage, WASocket, downloadMediaMessage } from '@whiskeysockets/baileys';
import MessagesController from '../src/infra/http/controllers/messages.js';
import ChatController from '../src/infra/http/controllers/chat.js';
import GroupController from '../src/infra/http/controllers/group.js';
import ProfileController from '../src/infra/http/controllers/profile.js';
import PrivacyController from '../src/infra/http/controllers/privacy.js';
import MediaController from '../src/infra/http/controllers/media.js';
import { RequestError, type ControllerDependencies } from '../src/infra/http/controllers/base.js';
import { downloadPublicMedia, isPublicAddress } from '../src/infra/http/controllers/remote-media.js';
import MessageRoutes from '../src/infra/http/routes/messages.js';
import ChatRoutes from '../src/infra/http/routes/chat.js';
import GroupRoutes from '../src/infra/http/routes/group.js';
import MediaRoutes from '../src/infra/http/routes/media.js';
import ProfileRoutes from '../src/infra/http/routes/profile.js';
import PrivacyRoutes from '../src/infra/http/routes/privacy.js';
import Token from '../src/infra/state/auth.js';
import { isContactMessage, isGifMessage, isLocationMessage, isMediaUrl, isPinMessage, isPollMessage, isTextMessage, normalizeJid } from '../src/shared/guards.js';

const jid = '5511999999999@s.whatsapp.net';
const group = '120363123456789@g.us';
const secret = 'test-only-secret-never-used-outside-tests-123456';
function message(id = 'message-1', fromMe = true): WAMessage { return { key: { id, remoteJid: jid, fromMe }, message: { conversation: 'Texto armazenado' }, messageTimestamp: 1_700_000_000 }; }
function repository(): NonNullable<ControllerDependencies['repository']> { return { getMessageById: async () => undefined, getLastMessageByInstance: async () => undefined, getContactById: async () => undefined }; }

async function httpFixture(t: TestContext) {
  const sent: Array<{ jid: string; content: any; options: any }> = [];
  const changes: any[] = [];
  const persisted: WAMessage[] = [];
  const calls: string[] = [];
  const lookup: unknown[][] = [];
  const socket = {
    sendMessage: async (remoteJid: string, content: any, options: any) => { sent.push({ jid: remoteJid, content, options }); return { ...message('sent-message'), message: { conversation: content.text ?? 'sent' } }; },
    chatModify: async (change: any) => { changes.push(change); }, readMessages: async () => {}, sendPresenceUpdate: async () => { calls.push('presence'); },
    rejectCall: async () => {}, groupCreate: async () => ({ id: group }), groupSettingUpdate: async () => {}, groupMemberAddMode: async () => {},
    groupJoinApprovalMode: async () => {}, groupToggleEphemeral: async () => {}, groupRequestParticipantsUpdate: async () => [],
    updateDefaultDisappearingMode: async () => {}, updateBlockStatus: async () => {}, updateDisableLinkPreviewsPrivacy: async () => {},
    updateProfileStatus: async () => {}, removeProfilePicture: async () => {}, fetchPrivacySettings: async () => ({}),
  } as unknown as WASocket;
  const repo = repository();
  repo.getMessageById = async (...args) => { lookup.push(args); return args[0] === 'message-1' && args[1] === 'owner/session' ? message() : undefined; };
  repo.getLastMessageByInstance = async () => message();
  const deps = { socket, repository: repo, onSent: async (msg: WAMessage) => { persisted.push(msg); } };
  const app = express();
  app.use(express.json());
  app.use(new Token(secret).verify);
  app.use('/messages', new MessageRoutes((owner, name, remoteJid, delay) => new MessagesController(owner, name, remoteJid, delay, deps)).get());
  app.use('/chat', new ChatRoutes((owner, name) => new ChatController(owner, name, deps)).get());
  app.use('/group', new GroupRoutes((owner, name) => new GroupController(owner, name, deps)).get());
  app.use('/privacy', new PrivacyRoutes((owner, name) => new PrivacyController(owner, name, deps)).get());
  app.use('/profile', new ProfileRoutes((owner, name) => new ProfileController(owner, name, deps)).get());
  app.use('/media', new MediaRoutes((owner, name) => new MediaController(owner, name, deps)).get());
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, body?: unknown, method = 'POST', token: string | null = secret) {
    const response = await fetch(origin + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  return { request, sent, changes, persisted, calls, lookup };
}

test('canonical and legacy sendText return actual keys and persist before responding', async t => {
  const f = await httpFixture(t);
  for (const body of [{ remoteJid: jid, text: 'Canônico' }, { jid, message: { text: 'Legado' } }]) {
    const result = await f.request('/messages/sendText/owner/session', body);
    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.messageId, 'sent-message');
    assert.equal(result.body.key.id, 'sent-message');
    assert.equal(result.body.data.key.id, 'sent-message');
  }
  assert.equal(f.sent.length, 2);
  assert.equal(f.persisted.length, 2);
  assert.equal(f.calls.length, 0, 'delay=0 should not send simulated typing or wait');
});

test('scoped JWTs cannot select another owner or session and invalid bodies never send', async t => {
  const f = await httpFixture(t);
  const token = jwt.sign({ owner: 'owner', instanceName: 'session' }, secret, { algorithm: 'HS256', expiresIn: 60 });
  assert.equal((await f.request('/messages/sendText/owner/session', { remoteJid: jid, text: 'Permitido' }, 'POST', token)).status, 200);
  for (const path of ['/messages/sendText/other/session', '/messages/sendText/owner/other']) assert.equal((await f.request(path, { remoteJid: jid, text: 'Negado' }, 'POST', token)).status, 403);
  assert.equal((await f.request('/messages/sendText/owner/session', { remoteJid: jid, text: 'Negado' }, 'POST', null)).status, 401);
  for (const body of [{ remoteJid: {}, text: 'x' }, { remoteJid: jid, text: '' }, { remoteJid: jid, text: 'x', delay: -1 }, { remoteJid: jid, text: 'x', options: [] }, []]) assert.equal((await f.request('/messages/sendText/owner/session', body)).status, 400);
  assert.equal(f.sent.length, 1);
});

test('false flags are accepted for delete, unstar, mute, archive, pin and privacy', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/messages/deleteMessage/owner/session', { remoteJid: jid, messageId: 'message-1', forEveryone: false }, 'DELETE')).status, 200);
  assert.equal((await f.request('/messages/unstar/owner/session', { remoteJid: jid, messageId: 'message-1', star: false }, 'PATCH')).status, 200);
  assert.equal((await f.request('/chat/archiveChat/owner/session', { remoteJid: jid, archive: false }, 'PATCH')).status, 200);
  assert.equal((await f.request('/chat/unpin/owner/session', { remoteJid: jid, pin: false }, 'PATCH')).status, 200);
  assert.equal((await f.request('/chat/mute/owner/session', { remoteJid: jid, mute: 0 }, 'PATCH')).status, 200);
  assert.equal((await f.request('/privacy/unblock/owner/session', { remoteJid: jid, block: false }, 'PATCH')).status, 200);
  assert.equal((await f.request('/privacy/expirationMessage/owner/session', { ephemeral: 0 }, 'PATCH')).status, 200);
  assert.equal((await f.request('/group/expirationMessage/owner/session', { groupJid: group, time: '0' }, 'PATCH')).status, 200);
  assert.equal(f.changes[0].deleteForMe.key.id, 'message-1');
  assert.equal(f.changes[1].star.star, false);
  assert.equal(f.changes.at(-1).mute, null);
});

test('quote, reaction, pin and edit use instance/chat scoped stored keys; forwarding stays inside instance', async t => {
  const f = await httpFixture(t);
  assert.equal((await f.request('/messages/sendText/owner/session', { remoteJid: jid, text: 'Quote', options: { quoted: 'message-1' } })).status, 200);
  assert.deepEqual(f.lookup[0], ['message-1', 'owner/session', jid]);
  assert.equal(f.sent[0].options.quoted.key.id, 'message-1');
  assert.equal((await f.request('/messages/sendReaction/owner/session', { jid, message: { emoji: '', messageId: 'message-1' } })).status, 200);
  assert.equal(f.sent[1].content.react.text, '');
  assert.equal((await f.request('/messages/sendPin/owner/session', { jid, message: { pin: { key: { id: 'message-1' }, type: 1, time: 86400 } } })).status, 200);
  assert.equal(f.sent[2].content.pin.id, 'message-1', 'Baileys 7 pin key is top-level pin, not pin.key');
  assert.equal((await f.request('/messages/editMessage/owner/session', { remoteJid: jid, messageId: 'message-1', text: 'Editado' }, 'PATCH')).status, 200);
  assert.equal(f.sent[3].content.edit.id, 'message-1');
  assert.equal((await f.request('/messages/sendForward/owner/session', { jid, message: { forward: 'message-1' } })).status, 200);
  assert.deepEqual(f.lookup.at(-1), ['message-1', 'owner/session', undefined]);
  const before = f.sent.length;
  assert.equal((await f.request('/messages/sendReaction/owner/session', { jid, message: { emoji: '👍', messageId: 'foreign-message' } })).status, 404);
  assert.equal(f.sent.length, before);
});

test('message payloads cannot smuggle delete/edit fields through text endpoints', async t => {
  const f = await httpFixture(t);
  const result = await f.request('/messages/sendText/owner/session', { jid, message: { text: 'Texto', delete: { id: 'other' }, edit: { id: 'other' }, forward: {} } });
  assert.equal(result.status, 200);
  assert.deepEqual(f.sent[0].content, { text: 'Texto' });
});

test('disconnected controllers return failure instead of optional-chaining success', async () => {
  const controllers = [
    new ChatController('offline', 'session').sendPresence('available'), new ChatController('offline', 'session').pinChat(jid, false),
    new GroupController('offline', 'session').create('Grupo', [jid]), new PrivacyController('offline', 'session').getPrivacySettings(),
    new ProfileController('offline', 'session').fetchStatus(jid), new MessagesController('offline', 'session', jid).sendMessageText({ text: 'Nunca enviar' }),
    new MediaController('offline', 'session').getMedia('message-1'),
  ];
  for (const result of await Promise.all(controllers)) { assert.equal(result.success, false); assert.equal(result.statusCode, 409); }
});

test('presence updates are awaited and failures do not expose provider errors', async () => {
  const socket = { sendPresenceUpdate: async () => { throw new Error('private-provider-token'); } } as unknown as WASocket;
  const result = await new ChatController('owner', 'session', { socket }).sendPresence('available');
  assert.equal(result.success, false);
  assert.equal(result.statusCode, 502);
  assert.doesNotMatch(JSON.stringify(result), /private-provider-token/);
});

test('successful delivery remains successful if persistence fails, preventing duplicate retries', async () => {
  const socket = { sendMessage: async () => message('confirmed') } as unknown as WASocket;
  const controller = new MessagesController('owner', 'session', jid, 0, { socket, onSent: async () => { throw new Error('storage unavailable'); } });
  const result = await controller.sendMessageText({ text: 'Texto' });
  assert.equal(result.success, true);
  assert.equal(result.messageId, 'confirmed');
  assert.equal(result.syncPending, true);
});

test('group invite acceptance unwraps the stored invite and uses its message key', async () => {
  let accepted: unknown[] = [];
  const socket = { groupAcceptInviteV4: async (...args: unknown[]) => { accepted = args; return group; } } as unknown as WASocket;
  const repo = repository();
  repo.getMessageById = async (_id, instance) => instance === 'owner/session' ? { ...message(), message: { ephemeralMessage: { message: { groupInviteMessage: { groupJid: group, inviteCode: 'abcdefghijklmnop', inviteExpiration: 1_800_000_000 } } } } } : undefined;
  const result = await new GroupController('owner', 'session', { socket, repository: repo }).joinByInviteMessage(group, 'message-1');
  assert.equal(result.success, true);
  assert.equal((accepted[0] as WAMessage['key']).id, 'message-1');
  assert.equal((accepted[1] as { groupJid: string }).groupJid, group);
  assert.equal((await new GroupController('owner', 'session', { socket, repository: repo }).joinByInviteMessage('120363000000000@g.us', 'message-1')).success, false);
});

test('download media is scoped and unwraps view-once content without a live socket', async () => {
  const repo = repository();
  let lookup: unknown[] = [];
  repo.getMessageById = async (...args) => { lookup = args; return { ...message(), message: { viewOnceMessageV2: { message: { imageMessage: { mimetype: 'image/png' } } } } }; };
  const socket = { logger: {}, updateMediaMessage: async (msg: WAMessage) => msg } as unknown as WASocket;
  let downloaded: WAMessage | undefined;
  const download = (async (msg: WAMessage) => { downloaded = msg; return Buffer.from('example'); }) as typeof downloadMediaMessage;
  const result = await new MediaController('owner', 'session', { socket, repository: repo, download }).getMedia('message-1', true);
  assert.deepEqual(lookup, ['message-1', 'owner/session', undefined]);
  assert.ok(downloaded?.message?.imageMessage);
  assert.equal(result.base64, 'data:image/png;base64,ZXhhbXBsZQ==');
});

test('guards reject malformed message primitives and private media hosts without making a request', async () => {
  assert.equal(normalizeJid('+5511999999999'), jid);
  assert.equal(normalizeJid({}), undefined);
  assert.equal(isTextMessage({ text: '', mentions: [] }), false);
  assert.equal(isLocationMessage({ location: { degreesLatitude: Infinity, degreesLongitude: 1 } }), false);
  assert.equal(isLocationMessage({ location: { degreesLatitude: 91, degreesLongitude: 1 } }), false);
  assert.equal(isContactMessage({ displayName: 'Nome\nTEL:outro', waid: 5511999999999, phoneNumber: '+5511999999999' }), false);
  assert.equal(isPollMessage({ poll: { name: 'Teste', values: ['A', 'A'], selectableCount: 1 } }), false);
  assert.equal(isGifMessage({ video: { url: 'https://example.com/a.mp4' }, gifPlayback: false }), false);
  assert.equal(isPinMessage({ pin: { key: { id: 'message' }, type: 5, time: 1 } }), false);
  assert.equal(isMediaUrl('file:///C:/Windows/win.ini'), false);
  assert.equal(isPublicAddress('127.0.0.1'), false);
  assert.equal(isPublicAddress('169.254.169.254'), false);
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  await assert.rejects(downloadPublicMedia('http://127.0.0.1/private'), (error: unknown) => error instanceof RequestError && error.statusCode === 400);
});
