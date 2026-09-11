import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import ts from 'typescript';
import * as safetyModule from '../src/infra/baileys/contact-safety.js';
import * as identity from '../src/shared/identity.js';
import { readWhatsAppOptions } from '../src/infra/config/whatsapp-options.js';
import { createSafeLogger, type LogSink } from '../src/infra/logging/safe-logger.js';

// Execute the actual controller sources. Only provider/storage imports are replaced.
// This is component integration, NOT an HTTP server, real database or WhatsApp session.
function moduleSource(relative: string, imports: Record<string, unknown>): any {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(js, { exports, Error, Date, Promise, require: (name: string) => {
    if (!Object.hasOwn(imports, name)) throw new Error(`Unmocked dependency: ${name}`);
    return imports[name];
  } }, { filename: relative });
  return exports;
}
const constants = { instances: {}, instanceStatus: new Map() };
const base = moduleSource('../src/infra/http/controllers/base.ts', {
  '../../../core/connection/prisma.js': {}, '../../../shared/constants.js': constants,
  '../../../shared/identity.js': identity,
});
const { default: ProfileController } = moduleSource('../src/infra/http/controllers/profile.ts', {
  './base.js': base, './remote-media.js': {}, '../../../shared/constants.js': constants,
  '../../baileys/presence-state.js': {}, '../../baileys/contact-safety.js': safetyModule,
});
const PN='5511000000001@s.whatsapp.net', LID='123456789000001@lid';
const state=()=>({version:5,hash:Buffer.alloc(128),indexValueMap:{}});
function fixture(mode: 'off'|'check'|'write' = 'write', register = true) {
  const options=readWhatsAppOptions({CONTACT_SYNC_MODE:mode,CONTACT_SYNC_MIN_UPTIME_MS:'0',CONTACT_SYNC_COOLDOWN_MS:'0'});
  const sink:LogSink={level:'silent',fatal(){},error(){},warn(){},info(){},debug(){},trace(){}};
  const gate=new safetyModule.ContactSafety(options,createSafeLogger(sink),true);
  gate.setConnected(true);
  const calls={lookup:0,sync:0,send:0,publish:0};
  let failPublish=false, failSend=false, internalWarning=false;
  const sock={ws:{isOpen:true},authState:{creds:{myAppStateKeyId:'fixture-key'},keys:{get:async(type:string,ids:string[])=>
    ({[ids[0]!]:type==='app-state-sync-key'?{keyData:Buffer.alloc(32)}:state()})}},
    signalRepository:{lidMapping:{getPNForLID:async()=>PN,getLIDForPN:async()=>LID}},
    resyncAppState:async()=>{calls.sync++;},
    addOrEditContact:async(pn:string,action:safetyModule.ContactAction)=>{
      // Same callback positions as the adapter; no network runs in this test.
      if(internalWarning)gate.observe('warn',[{name:'critical_unblock_low'},'LTHash verification failed on snapshot, continuing with partial state']);
      for(const stage of ['before-encode','before-send'] as const)await gate.guardProviderWrite({stage,name:'critical_unblock_low',initial:state(),
        keyId:'fixture-key',patchCreate:{index:['contact',pn],syncAction:{contactAction:action}}});
      calls.send++;
      if(failSend)throw new Error('Fixture timeout');
    }};
  if(register)safetyModule.registerContactSafety(sock,gate);
  const controller=new ProfileController('owner','fixture',{
    socket:sock,repository:{getContactById:async()=>{calls.lookup++;return undefined;}},
    onContact:async(contact:unknown)=>{calls.publish++;if(failPublish)throw new Error('Fixture webhook failure');return contact;},
  });
  return {controller,calls,sock,failPublish:()=>{failPublish=true;},failSend:()=>{failSend=true;},warn:()=>{internalWarning=true;}};
}
test('real controller OFF returns 422 and does not rename or query contact',async()=>{
  const f=fixture('off');const result=await f.controller.contactName(PN,'Test Contact');
  assert.equal(result.success,false);assert.equal(result.statusCode,422);assert.match(result.error,/CONTACT_SYNC_DISABLED/);
  assert.deepEqual(f.calls,{lookup:0,sync:0,send:0,publish:0});
});
test('real controller CHECK returns diagnostic refusal, not offline or successful save',async()=>{
  const f=fixture('check');const result=await f.controller.contactName(PN,'Test Contact');
  assert.equal(result.success,false);assert.equal(result.statusCode,422);assert.match(result.error,/CONTACT_DIAGNOSTIC_ONLY/);
  assert.equal(f.calls.sync,1);assert.equal(f.calls.send,0);assert.equal(f.calls.publish,0);
});
test('real controller refuses a socket without gate but preserves the real offline error',async()=>{
  const f=fixture('write',false);assert.equal((await f.controller.contactName(PN,'Test Contact')).statusCode,422);
  f.sock.ws.isOpen=false;assert.equal((await f.controller.contactName(PN,'Test Contact')).statusCode,409);
});
test('real controller preserves accepted contact aliases and does not assert phone-addressbook completion',async()=>{
  const f=fixture();const result=await f.controller.contactName(LID,'Test Contact');
  assert.equal(result.success,true);assert.equal(result.data.contact.id,LID);assert.equal(result.data.contact.phoneNumber,PN);
  assert.equal(result.data.contact.savedName,'Test Contact');assert.equal(result.data.syncedToWhatsApp,true);
  assert.equal(result.data.primaryAddressbookSyncRequested,true);assert.equal(result.data.primaryAddressbookSyncConfirmed,false);
  assert.equal(f.calls.send,1);assert.equal(f.calls.publish,1);
});
test('real controller does not repeat a remote write to repair a failed local publication',async()=>{
  const f=fixture();f.failPublish();const result=await f.controller.contactName(PN,'Test Contact');
  assert.equal(result.success,true);assert.equal(result.data.syncPending,true);assert.equal(f.calls.send,1);
});
test('real controller reports uncertain send as 502, never as a local saved name',async()=>{
  const f=fixture();f.failSend();const result=await f.controller.contactName(PN,'Test Contact');
  assert.equal(result.success,false);assert.equal(result.statusCode,502);assert.match(result.error,/CONTACT_WRITE_UNCERTAIN/);
  await f.controller.contactName(PN,'Test Contact');assert.equal(f.calls.send,1);assert.equal(f.calls.publish,0);
});
test('real controller uses 422 for a guard refusal after INTERNAL resync, without contact send',async()=>{
  const f=fixture();f.warn();const result=await f.controller.contactName(PN,'Test Contact');
  assert.equal(result.success,false);assert.equal(result.statusCode,422);assert.match(result.error,/CONTACT_SYNC_UNHEALTHY/);
  assert.equal(f.calls.send,0);assert.equal(f.calls.publish,0);
});
