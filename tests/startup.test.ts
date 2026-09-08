import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApiRuntime, startupErrorMessage } from '../src/runtime.js';

function fixture(overrides:Partial<ConstructorParameters<typeof ApiRuntime>[0]>={}) {
  const events:string[]=[];
  const server=createServer((_req,res)=>res.end('fixture'));
  const runtime=new ApiRuntime({server,host:'127.0.0.1',port:0,
    connect:async()=>{assert.equal(server.listening,true);events.push('db.connect');},
    disconnect:async()=>{events.push('db.disconnect');},
    queue:{start:()=>{events.push('queue.start');},stop:async()=>{events.push('queue.stop');}},
    sessions:{start:async()=>{events.push('sessions.start');},shutdown:async()=>{events.push('sessions.stop');}},...overrides});
  return {runtime,server,events};
}

test('occupied port does not initialize database, WhatsApp or webhook workers and preserves the existing server',async t=>{
  const existing=createServer((_req,res)=>res.end('existing process'));
  existing.listen(0,'127.0.0.1');await once(existing,'listening');
  t.after(()=>new Promise<void>(resolve=>existing.close(()=>resolve())));
  const port=(existing.address() as AddressInfo).port;
  const f=fixture({port});t.after(()=>f.runtime.stop());
  await assert.rejects(f.runtime.start(),{code:'EADDRINUSE'});
  assert.equal(f.runtime.ready,false);assert.deepEqual(f.events,[]);
  await f.runtime.stop();
  assert.ok(existing.listening);assert.equal(await(await fetch(`http://127.0.0.1:${port}`)).text(),'existing process');
  assert.ok(!f.events.includes('queue.start'));assert.ok(!f.events.includes('sessions.start'));assert.ok(!f.events.includes('db.connect'));
  const diagnostic=startupErrorMessage(Object.assign(new Error('raw'),{code:'EADDRINUSE'}),'127.0.0.1',15960);
  assert.match(diagnostic,/15960/);assert.match(diagnostic,/npm run diagnose/);
});

test('startup and shutdown are idempotent and port precedes database/session initialization',async t=>{
  const f=fixture();t.after(()=>f.runtime.stop());
  const a=f.runtime.start(),b=f.runtime.start();assert.equal(a,b);await a;
  assert.equal(f.runtime.ready,true);assert.deepEqual(f.events,['db.connect','queue.start','sessions.start']);
  const stop=f.runtime.stop();assert.equal(f.runtime.ready,false);assert.equal(stop,f.runtime.stop());await stop;
  assert.equal(f.server.listening,false);
  assert.deepEqual(f.events,['db.connect','queue.start','sessions.start','sessions.stop','queue.stop','db.disconnect']);
  await assert.rejects(f.runtime.start(),/shutting down/);
});

test('shutdown during database connection never restores sessions after the connection completes',async()=>{
  let release!:()=>void,entered!:()=>void;
  const connected=new Promise<void>(resolve=>{entered=resolve;});
  const pending=new Promise<void>(resolve=>{release=resolve;});
  const f=fixture({connect:async()=>{entered();await pending;}});
  const starting=f.runtime.start();await connected;
  const stopping=f.runtime.stop();release();await Promise.all([starting,stopping]);
  assert.equal(f.runtime.ready,false);assert.equal(f.server.listening,false);
  assert.ok(!f.events.includes('queue.start'));assert.ok(!f.events.includes('sessions.start'));
  assert.equal(f.events.filter(value=>value==='db.disconnect').length,1);
});

test('failed initialization closes the port and still cleans other components after cleanup failures',async()=>{
  const f=fixture({connect:async()=>{throw new Error('DB unavailable');},sessions:{start:async()=>{},shutdown:async()=>{throw new Error('cleanup failure');}}});
  await assert.rejects(f.runtime.start(),/DB unavailable/);
  await assert.rejects(f.runtime.stop(),AggregateError);
  assert.equal(f.server.listening,false);assert.ok(f.events.includes('queue.stop'));assert.ok(f.events.includes('db.disconnect'));
});

test('diagnostic checks a port without stopping its owner and only extracts invalid npm key names',async t=>{
  const moduleUrl=new URL('../tools/diagnose.mjs',import.meta.url).href;
  const {checkPort,invalidNpmKeys}=await import(moduleUrl);
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  assert.deepEqual(await checkPort('127.0.0.1',(server.address() as AddressInfo).port),{available:false,code:'EADDRINUSE'});
  assert.ok(server.listening);
  assert.deepEqual(await checkPort('127.0.0.1',0),{available:true});
  assert.deepEqual(invalidNpmKeys('//registry/:_authToken=secret\n--init.module=private\n_-init.module=private\n# --init.module=comment'),[{line:2,key:'--init.module'},{line:3,key:'_-init.module'}]);
});

test('real entrypoint reports occupied port before attempting a database connection',async t=>{
  const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const port=(server.address() as AddressInfo).port;
  const child=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('../src/main.ts',import.meta.url))],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,
    env:{...process.env,HOST:'127.0.0.1',PORT:String(port),JWT_TOKEN:'startup-regression-only-not-a-production-key',
      WEBHOOK_URL:'',WEBHOOK_SECRET:'',AUTH_STORE:'database',TRUSTED_MEDIA_ORIGINS:'',
      DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:1/qa_no_connection?schema=public'},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
  const timer=setTimeout(()=>child.kill(),10000);timer.unref();
  try{const [code]=await once(child,'close');assert.equal(code,1,output);}finally{clearTimeout(timer);}
  assert.match(output,new RegExp(`127\\.0\\.0\\.1:${port}.*já está em uso`));
  assert.doesNotMatch(output,/Can't reach database|Webhook retry|PrismaClientInitializationError/);
  assert.ok(server.listening);
});

test('queue diagnostic detects a file in place of a directory and never creates or consumes queue data',async t=>{
  const {inspectQueue}=await import(new URL('../tools/diagnose.mjs',import.meta.url).href);
  const root=await mkdtemp(path.join(tmpdir(),'zaptobox-diagnostic-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const missing=path.join(root,'new','queue');
  assert.equal((await inspectQueue(missing)).missing,true);
  assert.deepEqual(await readdir(root),[]);
  const file=path.join(root,'not-a-directory');await writeFile(file,'private contents');
  assert.equal((await inspectQueue(file)).code,'ENOTDIR');
  const queue=path.join(root,'queue');await mkdir(queue);await writeFile(path.join(queue,'pending.json'),'not even parsed by diagnostic');
  assert.equal((await inspectQueue(queue)).pendingFiles,1);
  assert.deepEqual(await readdir(queue),['pending.json']);
  await writeFile(path.join(queue,'dead-letter'),'private contents');
  const invalid=await inspectQueue(queue);assert.equal(invalid.code,'ENOTDIR');assert.equal(invalid.part,'dead-letter');
});
