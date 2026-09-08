import test from 'node:test';
import assert from 'node:assert/strict';
import type { WAMessage, WASocket } from '@whiskeysockets/baileys';
import MessagesController from '../src/infra/http/controllers/messages.js';
import ChatController from '../src/infra/http/controllers/chat.js';
import type { ControllerDependencies } from '../src/infra/http/controllers/base.js';

test('batch receipts resolve every key in its instance/chat, deduplicate and ignore outgoing messages', async () => {
  const jid='5511999999999@s.whatsapp.net', reads:any[]=[], lookups:any[]=[];
  const repository:NonNullable<ControllerDependencies['repository']>={getLastMessageByInstance:async()=>undefined,getContactById:async()=>undefined,getMessageById:async(id,instance,remoteJid)=>{lookups.push([id,instance,remoteJid]);return {key:{id,remoteJid:jid,fromMe:id==='sent'}} as WAMessage;}};
  const socket={readMessages:async(keys:any)=>reads.push(keys)} as unknown as WASocket;
  const controller=new MessagesController('owner','session',jid,0,{repository,socket});
  const result=await controller.readMessages(['incoming','sent','incoming']);assert.equal(result.success,true);assert.equal(reads.length,1);assert.deepEqual(reads[0],[{id:'incoming',remoteJid:jid,fromMe:false}]);assert.deepEqual(lookups,[['incoming','owner/session',jid],['sent','owner/session',jid]]);
});
test('one missing message rejects complete receipt batch before any WhatsApp call',async()=>{
  let reads=0;
  const repository:NonNullable<ControllerDependencies['repository']>={getLastMessageByInstance:async()=>undefined,getContactById:async()=>undefined,getMessageById:async(id)=>id==='valid'?{key:{id,remoteJid:'12345@s.whatsapp.net',fromMe:false}} as WAMessage:undefined};
  const controller=new MessagesController('owner','session','12345@s.whatsapp.net',0,{repository,socket:{readMessages:async()=>{reads++;}} as unknown as WASocket});
  await assert.rejects(controller.readMessages(['valid','forged']));assert.equal(reads,0);
});
test('Baileys receives recording, composing and paused scoped to destination chat',async()=>{
  const sent:any[]=[];const controller=new ChatController('owner','session',{socket:{sendPresenceUpdate:async(state:string,jid:string)=>{sent.push([state,jid]);}} as unknown as WASocket});
  for(const state of ['recording','composing','paused'] as const)assert.equal((await controller.sendPresence(state,'12345@s.whatsapp.net')).success,true);
  assert.deepEqual(sent,[['recording','12345@s.whatsapp.net'],['composing','12345@s.whatsapp.net'],['paused','12345@s.whatsapp.net']]);
});
