import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactSafety, ContactWriteError, contactFailureHttpStatus, resolveContactPlan, inspectSyncState, inspectSyncKey, registerContactSafety, getContactSafety,
  type ContactContext, type ContactAction, type ProviderContactGuardInput } from '../src/infra/baileys/contact-safety.js';
import { readWhatsAppOptions } from '../src/infra/config/whatsapp-options.js';
import { createSafeLogger, type LogSink, type Method } from '../src/infra/logging/safe-logger.js';
const PN='5511000000001@s.whatsapp.net', LID='123456789000001@lid', OTHER='5511000000002@s.whatsapp.net';
const goodKey=()=>({keyData:Buffer.alloc(32,1)});
const goodState=()=>({version:5,hash:Buffer.alloc(128),indexValueMap:{[Buffer.alloc(32,2).toString('base64')]:{valueMac:Buffer.alloc(32,3)}}});
function fixture(mode:'off'|'check'|'write'='write', extra: Record<string,string>={}) {
  const options=readWhatsAppOptions({CONTACT_SYNC_MODE:mode,CONTACT_SYNC_MIN_UPTIME_MS:'0',CONTACT_SYNC_COOLDOWN_MS:'0',...extra});
  const logs: unknown[]=[];
  const sink:LogSink={level:'info',fatal:()=>{},error:()=>{},warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}};
  for(const level of ['fatal','error','warn','info','debug','trace'] as Method[]) sink[level]=(data,msg)=>{logs.push({data,msg});};
  const logger=createSafeLogger(sink);
  let clock=100_000;
  const safety=new ContactSafety(options,logger,true,()=>clock);
  const counts={lookup:0,sync:0,write:0,sent:0};
  let written:{pn:string;action:ContactAction}|undefined;
  const context:ContactContext={assertCurrent:()=>{},lookup:async()=>{counts.lookup++;return undefined;},getPNForLID:async()=>PN,
    getLIDForPN:async()=>LID,currentKeyId:()=> 'dummy-key-id',readKey:async()=>goodKey(),readState:async()=>goodState(),
    sync:async()=>{counts.sync++;},write:async(pn,action)=>{
      counts.write++;written={pn,action};
      await guard('before-encode',pn,action);
      await guard('before-send',pn,action);
      counts.sent++;
    }};
  const guard=(stage:ProviderContactGuardInput['stage'],pn=PN,action:ContactAction={firstName:'João',fullName:'João Silva',lidJid:LID,saveOnPrimaryAddressbook:true})=>
    safety.guardProviderWrite({stage,name:'critical_unblock_low',patchCreate:{index:['contact',pn],syncAction:{contactAction:action}},initial:goodState(),keyId:'dummy-key-id'});
  safety.setConnected(true);
  return {safety,context,counts,logs,guard,options,logger,setTime:(t:number)=>{clock=t;},written:()=>written};
}
const code=(expected:string)=>(error:unknown)=>error instanceof ContactWriteError&&error.code===expected;
test('OFF rejects before lookup, sync or contact write',async()=>{
  const f=fixture('off');await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_SYNC_DISABLED'));
  assert.deepEqual(f.counts,{lookup:0,sync:0,write:0,sent:0});
});
test('CHECK runs preflight, signals diagnostic-only and never submits a contact',async()=>{
  const f=fixture('check');await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_DIAGNOSTIC_ONLY'));
  assert.equal(f.counts.sync,1);assert.equal(f.counts.write,0);assert.equal(f.safety.snapshot().lastContactEvent,'contact.check.complete');
});
test('WRITE uses confirmed PN target and native contact payload with LID',async()=>{
  const f=fixture();const plan=await f.safety.execute(LID,'  João Silva  ',f.context);
  assert.equal(plan.id,LID);assert.equal(f.counts.sent,1);
  assert.deepEqual(f.written(),{pn:PN,action:{firstName:'João',fullName:'João Silva',lidJid:LID,saveOnPrimaryAddressbook:true}});
  assert.ok(!JSON.stringify(f.logs).includes('João'));assert.ok(!JSON.stringify(f.logs).includes(PN));
});
test('phone device suffix is normalized without converting LID digits to phone',async()=>{
  const f=fixture();const plan=await resolveContactPlan(PN.replace('@',':4@'),'User',f.context,true);
  assert.equal(plan.pnJid,PN);assert.equal(plan.id,PN);
  f.context.getPNForLID=async()=>null;
  await assert.rejects(resolveContactPlan(LID,'User',f.context,true),code('CONTACT_PHONE_UNRESOLVED'));
});
test('known forward/reverse conflicts block any write',async()=>{
  const f=fixture();f.context.getPNForLID=async()=>OTHER;
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_IDENTITY_CONFLICT'));assert.equal(f.counts.sent,0);
});
test('cached identity mismatch is not overwritten or used as a guess',async()=>{
  const f=fixture();f.context.lookup=async()=>({id:PN,phoneNumber:OTHER,lid:LID});
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_IDENTITY_CONFLICT'));assert.equal(f.counts.sync,0);
});
test('LID requirement is configurable only when no conflicting known LID exists',async()=>{
  const f=fixture('write',{CONTACT_SYNC_REQUIRE_LID:'false'});f.context.getLIDForPN=async()=>null;
  await f.safety.execute(PN,'João Silva',f.context);assert.equal(f.written()?.action.lidJid,undefined);
  const g=fixture();g.context.getLIDForPN=async()=>null;
  await assert.rejects(g.safety.execute(PN,'User',g.context),code('CONTACT_LID_UNRESOLVED'));
});
test('invalid names and non-individual addresses are rejected',async()=>{
  const f=fixture();for(const id of ['123@g.us','status@broadcast','12345@lid@s.whatsapp.net','abc@s.whatsapp.net']) await assert.rejects(resolveContactPlan(id,'User',f.context,true),code('CONTACT_INVALID_JID'));
  for(const name of ['', ' ', 'x\u0000y', 'x'.repeat(201)]) await assert.rejects(resolveContactPlan(PN,name,f.context,true),code('CONTACT_INVALID_NAME'));
});
test('missing or malformed keys block preflight before sync',async()=>{
  const f=fixture();f.context.currentKeyId=()=>undefined;
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_KEY_MISSING'));
  const g=fixture();g.context.readKey=async()=>({keyData:Buffer.alloc(32).toString('base64')});
  await assert.rejects(g.safety.execute(PN,'User',g.context),code('CONTACT_SYNC_KEY_INVALID'));assert.equal(g.counts.sync,0);
});
test('structural state validation rejects zero versions, string versions and malformed MACs',()=>{
  for(const state of [undefined,{...goodState(),version:0},{...goodState(),version:'5'},{...goodState(),hash:Buffer.alloc(64)},
    {...goodState(),indexValueMap:{bad:{valueMac:Buffer.alloc(32)}}},{...goodState(),indexValueMap:{[Buffer.alloc(32).toString('base64')]:{valueMac:'base64'}}}]) assert.throws(()=>inspectSyncState(state),code('CONTACT_SYNC_STATE_INVALID'));
  assert.deepEqual(inspectSyncState(goodState()),{version:5,hashBytes:128,entries:1});assert.deepEqual(inspectSyncKey(goodKey()),{keyBytes:32});
});
test('state failure after preflight prevents all writes',async()=>{
  const f=fixture();f.context.readState=async()=>undefined;
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_STATE_INVALID'));assert.equal(f.counts.write,0);
});
test('snapshot integrity warning latches unhealthy despite later success log',async()=>{
  const f=fixture();f.context.sync=async()=>{
    f.safety.observe('warn',[{name:'critical_unblock_low',version:5},'LTHash verification failed on snapshot, continuing with partial state']);
    f.safety.observe('info',['synced critical_unblock_low to v5']);
  };
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_UNHEALTHY'));assert.equal(f.counts.write,0);
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_UNHEALTHY'));
});
test('unhealthy warnings from OTHER named collections do not block contacts',async()=>{
  const f=fixture();f.safety.observe('warn',[{name:'regular_low'},'LTHash verification failed on snapshot, continuing with partial state']);
  f.safety.observe('error',[new Error('Bad MAC in libsignal/session_cipher.js')]);
  await f.safety.execute(PN,'João Silva',f.context);assert.equal(f.counts.sent,1);
});
test('unhealthy internal resync between preflight and encode blocks before encoding/sending',async()=>{
  const f=fixture();f.context.write=async(pn,action)=>{
    f.counts.write++;
    f.safety.observe('warn',[{name:'critical_unblock_low'},'failed to sync critical_unblock_low from v5, giving up']);
    await f.guard('before-encode',pn,action);f.counts.sent++;
  };
  await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_SYNC_UNHEALTHY'));assert.equal(f.counts.sent,0);
});
test('new sync problem during encoding is caught by second guard before send',async()=>{
  const f=fixture();f.context.write=async(pn,action)=>{
    await f.guard('before-encode',pn,action);
    f.safety.observe('warn',[{name:'critical_unblock_low'},'LTHash verification failed']);
    await f.guard('before-send',pn,action);f.counts.sent++;
  };
  await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_SYNC_UNHEALTHY'));assert.equal(f.counts.sent,0);
});
test('missing provider adapter refuses writes before any network I/O',async()=>{
  const f=fixture();const gate=new ContactSafety(f.options,f.logger,false);gate.setConnected(true);
  await assert.rejects(gate.execute(PN,'User',f.context),code('CONTACT_GUARD_MISSING'));assert.equal(f.counts.sync,0);
});
test('provider hook cannot be invoked outside an explicitly prepared contact write',async()=>{
  const f=fixture();await assert.rejects(f.guard('before-encode'),code('CONTACT_GUARD_DENIED'));
});
test('modified payload rejected by final guard',async()=>{
  const f=fixture();f.context.write=async(pn,action)=>{await f.guard('before-encode',pn,{...action,fullName:'Different'});f.counts.sent++;};
  await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_PATCH_MISMATCH'));assert.equal(f.counts.sent,0);
});
test('no acknowledgement after transmission: do not retry; latch uncertain',async()=>{
  const f=fixture();f.context.write=async(pn,action)=>{await f.guard('before-encode',pn,action);await f.guard('before-send',pn,action);f.counts.sent++;throw new Error('Timed Out');};
  await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_WRITE_UNCERTAIN'));
  await assert.rejects(f.safety.execute(PN,'João Silva',f.context),code('CONTACT_WRITE_UNCERTAIN'));assert.equal(f.counts.sent,1);
});
test('concurrent contact requests are rejected, not enqueued',async()=>{
  const f=fixture();let resume!:()=>void;f.context.sync=()=>new Promise<void>(resolve=>{resume=resolve;});
  const first=f.safety.execute(PN,'João Silva',f.context);await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.safety.execute(PN,'Other',f.context),code('CONTACT_SYNC_BUSY'));resume();await first;assert.equal(f.counts.sent,1);
});
test('minimum uptime and cooldown are enforced',async()=>{
  const f=fixture('check',{CONTACT_SYNC_MIN_UPTIME_MS:'1000',CONTACT_SYNC_COOLDOWN_MS:'2000'});
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_NOT_READY'));
  f.setTime(101_001);await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_DIAGNOSTIC_ONLY'));
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_COOLDOWN'));
});
test('socket replacement during read invalidates the operation',async()=>{
  const f=fixture();let current=true;f.context.assertCurrent=()=>{if(!current)throw new Error('stale socket');};
  f.context.sync=async()=>{current=false;};await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_PREFLIGHT_FAILED'));assert.equal(f.counts.write,0);
});
test('turning off contact diagnostics never disables safety checks',async()=>{
  const f=fixture('write',{CONTACT_SYNC_DIAGNOSTICS:'false'});
  f.safety.observe('warn',[{name:'critical_unblock_low'},'failed to sync critical_unblock_low from v5, giving up']);
  await assert.rejects(f.safety.execute(PN,'User',f.context),code('CONTACT_SYNC_UNHEALTHY'));assert.equal(f.logs.length,0);
});
test('registry isolates socket generations',()=>{
  const a={},b={},f=fixture();registerContactSafety(a,f.safety);assert.equal(getContactSafety(a),f.safety);assert.equal(getContactSafety(b),undefined);
});

test('HTTP integration does not label a policy refusal as socket-disconnected', () => {
  for (const code of ['CONTACT_SYNC_DISABLED', 'CONTACT_DIAGNOSTIC_ONLY', 'CONTACT_SYNC_BUSY', 'CONTACT_SYNC_COOLDOWN', 'CONTACT_SYNC_STATE_INVALID', 'CONTACT_PREFLIGHT_FAILED']) {
    assert.equal(contactFailureHttpStatus(new ContactWriteError(409, code, 'fixture')), 422);
  }
  for (const code of ['CONTACT_WRITE_UNCERTAIN', 'CONTACT_GUARD_NOT_EXECUTED']) {
    assert.equal(contactFailureHttpStatus(new ContactWriteError(502, code, 'fixture')), 502);
  }
});
test('an integrity failure detected after acknowledgement is returned as UNCERTAIN, not as a pre-send rejection', async () => {
  const f = fixture();
  const write = f.context.write;
  f.context.write = async (pn, action) => {
    await write(pn, action);
    f.safety.observe('warn', [{ name: 'critical_unblock_low' }, 'LTHash verification failed on snapshot, continuing with partial state']);
  };
  await assert.rejects(f.safety.execute(PN, 'João Silva', f.context), code('CONTACT_WRITE_UNCERTAIN'));
  assert.equal(f.counts.sent, 1);
  await assert.rejects(f.safety.execute(PN, 'João Silva', f.context), code('CONTACT_WRITE_UNCERTAIN'));
  assert.equal(f.counts.sent, 1);
});
