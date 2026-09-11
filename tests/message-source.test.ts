import test from 'node:test';
import assert from 'node:assert/strict';
import { makeEventBuffer, type BaileysEventMap, type WAMessage } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { upsertMessageSource } from '../src/infra/mappers/message-source.js';

const message = (id: string): WAMessage => ({ key: { id, remoteJid: '5511999999999@s.whatsapp.net', fromMe: false }, messageTimestamp: 1_700_000_000, message: { imageMessage: { directPath: '/encrypted-media', mediaKey: Buffer.from([1, 2, 3]) } } });

test('upsert origin uses provider type and observed connection state, never message age or history progress', () => {
  assert.equal(upsertMessageSource({ type: 'notify' }, true), 'live');
  assert.equal(upsertMessageSource({ type: 'notify' }, false), 'unknown');
  assert.equal(upsertMessageSource({ type: 'append' }, true), 'offline');
  assert.equal(upsertMessageSource({ type: 'notify', requestId: 'phone-recovery' }, true), 'recovery');
  assert.equal(upsertMessageSource({ type: undefined } as any, true), 'unknown');
});

test('actual provider buffer keeps offline, recovered and live messages separate in either order', () => {
  for (const reverse of [false, true]) {
    const buffer = makeEventBuffer(pino({ level: 'silent' }));
    const events: BaileysEventMap['messages.upsert'][] = [];
    buffer.on('messages.upsert', event => events.push(event));
    const inputs: BaileysEventMap['messages.upsert'][] = [
      { type: 'append', messages: [message('offline')] },
      { type: 'notify', requestId: 'recovery-1', messages: [message('recovery-1')] },
      { type: 'notify', requestId: 'recovery-2', messages: [message('recovery-2')] },
      { type: 'notify', messages: [message('live-1')] },
      { type: 'notify', messages: [message('live-2')] },
    ];
    try {
      buffer.buffer();
      for (const event of reverse ? inputs.toReversed() : inputs) buffer.emit('messages.upsert', event);
      buffer.flush();
      const delivered = events.flatMap(event => event.messages.map(message => ({ id: message.key.id, source: upsertMessageSource(event, true), requestId: event.requestId })));
      assert.equal(delivered.length, 5);
      assert.equal(delivered.find(item => item.id === 'offline')!.source, 'offline');
      for (const id of ['recovery-1', 'recovery-2']) assert.deepEqual(delivered.find(item => item.id === id), { id, source: 'recovery', requestId: id });
      for (const id of ['live-1', 'live-2']) assert.equal(delivered.find(item => item.id === id)!.source, 'live');
    } finally { buffer.destroy(); }
  }
});

test('provider history absorption does not turn a recovered or live duplicate into a new delivery', () => {
  const buffer = makeEventBuffer(pino({ level: 'silent' }));
  const upserts: unknown[] = [], histories: BaileysEventMap['messaging-history.set'][] = [];
  buffer.on('messages.upsert', event => upserts.push(event)); buffer.on('messaging-history.set', event => histories.push(event));
  try {
    buffer.buffer();
    buffer.emit('messaging-history.set', { chats: [], contacts: [], messages: [message('old')], isLatest: false });
    buffer.emit('messages.upsert', { type: 'notify', requestId: 'recovery', messages: [message('old')] });
    buffer.flush();
    assert.equal(upserts.length, 0); assert.equal(histories.length, 1); assert.equal(histories[0].messages[0].key.id, 'old');
  } finally { buffer.destroy(); }
});
