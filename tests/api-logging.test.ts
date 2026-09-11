import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafeLogger, instanceReference, errorSummary, sanitizeText, type LogSink, type Method } from '../src/infra/logging/safe-logger.js';
function setup(level='info') {
  const lines: Array<{level: string; data: unknown; message?: string}> = [];
  const sink: LogSink = {level, fatal:()=>{},error:()=>{},warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}};
  const priorities: Record<string, number> = {trace:10,debug:20,info:30,warn:40,error:50,fatal:60,silent:Infinity};
  for (const key of ['fatal','error','warn','info','debug','trace'] as Method[]) sink[key]=(data,message)=>{
    if (priorities[key]!>=priorities[sink.level]!) lines.push({level:key,data,...(message?{message}:{})});
  };
  return {sink,lines};
}
test('logger observes warnings even while output is silent', () => {
  const {sink,lines}=setup('silent'); const observed: unknown[]=[];
  const logger=createSafeLogger(sink,{},true,(level,args)=>observed.push([level,...args]));
  logger.warn({name:'critical_unblock_low'},'LTHash verification failed');
  logger.child({source:'child'}).warn('warning from child');
  assert.equal(observed.length,2); assert.equal(lines.length,0);
});
test('sensitive objects, message content and buffers are omitted at trace level', () => {
  const {sink,lines}=setup('trace'); const logger=createSafeLogger(sink);
  logger.trace({creds:{advSecretKey:'DO_NOT_PRINT'},qr:'QR_SECRET',token:'JWT_SECRET',patch:{fullName:'PRIVATE_CONTACT'},
    message:'PRIVATE_MESSAGE',messages:['PRIVATE_MESSAGE'],keyData:Buffer.alloc(32,99),name:'PRIVATE_CONTACT',
    event:'test',version:12},'trace diagnostic');
  const output=JSON.stringify(lines); for(const secret of ['DO_NOT_PRINT','QR_SECRET','JWT_SECRET','PRIVATE_CONTACT','PRIVATE_MESSAGE','keyData']) assert.ok(!output.includes(secret));
  assert.ok(output.includes('"version":12')); assert.ok(output.includes('trace diagnostic'));
});
test('collection, version, stack and disconnect status are retained without raw stanza', () => {
  const {sink,lines}=setup(); const logger=createSafeLogger(sink);
  const err=Object.assign(new Error('Stream Errored (conflict)'),{output:{statusCode:401},data:{tag:'stream:error',attrs:{code:'401'},content:[{tag:'conflict',attrs:{private:'secret'}}]}});
  logger.warn({name:'critical_unblock_low',version:8,err},'failed to sync critical_unblock_low');
  const out=JSON.stringify(lines); assert.ok(out.includes('critical_unblock_low'));assert.ok(out.includes('401'));assert.ok(out.includes('conflict'));assert.ok(!out.includes('secret'));
  assert.ok(typeof errorSummary(err).stack==='string');
});
test('redaction controls identifiers only; secrets remain omitted', () => {
  assert.ok(!sanitizeText('lookup 5511999999999@s.whatsapp.net').includes('5511999999999'));
  assert.ok(sanitizeText('lookup 5511999999999@s.whatsapp.net',false).includes('5511999999999'));
  const {sink,lines}=setup();createSafeLogger(sink,{},false).info({token:'STILL_SECRET'},'metadata');
  assert.ok(!JSON.stringify(lines).includes('STILL_SECRET'));
  assert.ok(!sanitizeText('keyData=ABC123').includes('ABC123'));
});
test('child logger retains safe correlation and omits unsupported bindings', () => {
  const {sink,lines}=setup(); const logger=createSafeLogger(sink,{instanceRef:instanceReference('owner:instance')});
  logger.child({token:'secret',source:'signal'}).info({version:1},'hello');
  const out=JSON.stringify(lines);assert.ok(out.includes(instanceReference('owner:instance')));assert.ok(!out.includes('owner:instance'));assert.ok(!out.includes('secret'));
});
test('level setter changes output filtering without losing observer', () => {
  const {sink,lines}=setup();let count=0;const logger=createSafeLogger(sink,{},true,()=>count++);
  logger.info('first');logger.level='silent';logger.info('second');assert.equal(lines.length,1);assert.equal(count,2);
});
