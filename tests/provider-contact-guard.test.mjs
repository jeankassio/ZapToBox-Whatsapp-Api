import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { patchContactGuard, MARKERS } from '../tools/patch-provider-contact-guard.mjs';

// Reduced fixture of rc14 appPatch's ordering, NOT a live Baileys socket.
// The patcher checks the installed rc14's real contexts again during build.
const source=`
const appPatch = async (patchCreate) => {
    const name = patchCreate.type;
    const myAppStateKeyId = authState.creds.myAppStateKeyId;
    let initial;
    let encodeResult;
    await appStatePatchMutex.mutex(async () => {
        await authState.keys.transaction(async () => {
            await resyncAppState([name], false);
            initial = state;
            encodeResult = await encodeSyncdPatch(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey);
            const node = {encoded: encodeResult};
            await query(node);
            await authState.keys.set({version: encodeResult.state.version});
        });
    });
};
const fetchProps = async () => {};
globalThis.runPatch = appPatch;
`;
function setup(guard) {
  const sequence=[];
  const context={config:guard?{zaptoboxContactGuard:async(input)=>{sequence.push(input.stage);return guard(input);}}:{},
    authState:{creds:{myAppStateKeyId:'fake'},keys:{transaction:async fn=>fn(),set:async()=>sequence.push('persist')}},
    appStatePatchMutex:{mutex:async fn=>fn()},resyncAppState:async()=>sequence.push('resync'),
    state:{version:5},getAppStateSyncKey:async()=>{},encodeSyncdPatch:async()=>{sequence.push('encode');return {state:{version:6}};},
    query:async()=>sequence.push('send'),runPatch:undefined};
  vm.runInNewContext(patchContactGuard(source,'7.0.0-rc14'),context);
  return {sequence,context};
}
test('both guards are inserted after internal resync and before encode/send',async()=>{
  const f=setup(async()=>{});await f.context.runPatch({type:'critical_unblock_low',index:['contact','fake']});
  assert.deepEqual(f.sequence,['resync','before-encode','encode','before-send','send','persist']);
});
test('pre-encode rejection prevents encoder, network mutation and persistence',async()=>{
  const f=setup(async()=>{throw new Error('unhealthy');});await assert.rejects(f.context.runPatch({type:'critical_unblock_low',index:['contact','fake']}),/unhealthy/);
  assert.deepEqual(f.sequence,['resync','before-encode']);
});
test('pre-send rejection prevents network mutation and persistence',async()=>{
  const f=setup(async input=>{if(input.stage==='before-send')throw new Error('new failure');});
  await assert.rejects(f.context.runPatch({type:'critical_unblock_low',index:['contact','fake']}),/new failure/);
  assert.deepEqual(f.sequence,['resync','before-encode','encode','before-send']);
});
test('unrelated app-state operations keep their original flow',async()=>{
  const f=setup();await f.context.runPatch({type:'regular_low',index:['pin','fake']});
  assert.deepEqual(f.sequence,['resync','encode','send','persist']);
});
test('contact write without configured callback is blocked',async()=>{
  const f=setup();await assert.rejects(f.context.runPatch({type:'critical_unblock_low',index:['contact','fake']}),/callback is missing/);
  assert.deepEqual(f.sequence,['resync']);
});
test('patch is idempotent and refuses unexpected provider versions/context',()=>{
  const once=patchContactGuard(source,'7.0.0-rc14');assert.equal(patchContactGuard(once,'7.0.0-rc14'),once);
  assert.throws(()=>patchContactGuard(source,'7.0.0-rc15'),/pinned/);
  assert.throws(()=>patchContactGuard(source.replace('await query(node);','await anotherQuery(node);'),'7.0.0-rc14'),/context changed/);
  assert.throws(()=>patchContactGuard(once.replace(MARKERS[1],'MISSING'),'7.0.0-rc14'),/partial/);
});
test('production source wires all options and a typed callback; no silent hardcoded logger',async()=>{
  const services=await readFile(new URL('../src/infra/baileys/services.ts',import.meta.url),'utf8');
  assert.ok(services.includes('providerLogger(this.key'));
  assert.ok(services.includes('zaptoboxContactGuard: (input: ProviderContactGuardInput)'));
  assert.ok(services.includes('defaultQueryTimeoutMs: UserConfig.whatsapp.queryTimeoutMs'));
  assert.ok(services.includes('registerContactSafety(sock, contactSafety)'));
  assert.ok(services.includes('appStateMacVerification: { snapshot: true, patch: true }'));
  assert.ok(!services.includes("pino({ level: 'silent' })"));
});
test('profile uses the guarded path and auth restores protobuf bytes',async()=>{
  const profile=await readFile(new URL('../src/infra/http/controllers/profile.ts',import.meta.url),'utf8');
  assert.ok(profile.includes('safety.execute(remoteJid, name'));
  assert.ok(profile.includes('await sock.addOrEditContact(pnJid, action)'));
  assert.ok(profile.includes('primaryAddressbookSyncConfirmed: false'));
  const auth=await readFile(new URL('../src/infra/state/auth-state.ts',import.meta.url),'utf8');
  assert.ok(auth.includes('proto.Message.AppStateSyncKeyData.fromObject(value)'));
});
