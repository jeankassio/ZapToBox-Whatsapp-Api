import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { WebhookOutbox, type OutboxDiagnostic, type OutboxOptions } from "../src/infra/webhook/outbox.js";

const instance={owner:"qa",instanceName:"Atendimento@1_x",connectionStatus:"OFFLINE" as const};
async function setup(overrides: Partial<OutboxOptions>={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"zaptobox-outbox-"));
  const options:OutboxOptions={directory,url:"http://127.0.0.1/webhook",secret:"test-webhook-secret",timeoutMs:1000,maxAttempts:3,concurrency:2,retryMs:10,durable:true,...overrides};
  const queue=new WebhookOutbox(options);
  return {queue,options,cleanup:async()=>{await queue.stop();await fs.rm(directory,{recursive:true,force:true});}};
}

test("offline events retry in order with stable identity and protobuf bytes",async()=>{
  let time=1_000; let fail=true;
  const seen:{body:any;headers:Headers}[]=[];
  const state=await setup({now:()=>time,fetch:async(_url,init)=>{
    seen.push({body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});
    return new Response(null,{status:fail?503:204});
  }});
  try {
    const id=await state.queue.enqueue("messages.upsert",instance,{timestamp:9_000_000_000_000_001n,bytes:Buffer.from([1,2,3])});
    await state.queue.flush();
    await state.queue.enqueue("messages.update",instance,{status:2});await state.queue.flush();
    assert.equal(seen.length,1,"new event must not overtake a failed event");
    assert.equal((await state.queue.stats()).pending,2);
    fail=false;time+=20;await state.queue.flush();
    assert.deepEqual(seen.map(item=>item.body.event),["messages.upsert","messages.upsert","messages.update"]);
    assert.equal(seen[1]!.body.id,id);
    assert.equal(seen[1]!.body.data.timestamp,"9000000000000001");
    assert.equal(seen[1]!.body.data.bytes.type,"Buffer");
    assert.deepEqual(Buffer.from(seen[1]!.body.data.bytes.data,"base64"),Buffer.from([1,2,3]));
    assert.equal(seen[1]!.headers.get("X-Webhook-Secret"),"test-webhook-secret");
    assert.equal(seen[1]!.headers.get("X-Webhook-Id"),id);
    assert.equal((await state.queue.stats()).pending,0);
  } finally {await state.cleanup();}
});

test('phone logout has a durable delivery lane independent of a blocked history request', async () => {
  let release!: () => void, entered!: () => void, delivered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = new Promise<void>(resolve => { entered = resolve; });
  const notification = new Promise<void>(resolve => { delivered = resolve; });
  const events: string[] = [];
  const state = await setup({ concurrency: 1, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); events.push(body.event);
    if (body.event === 'messages.set') { entered(); await gate; }
    if (body.event === 'connection.removed') delivered();
    return new Response(null, { status: 204 });
  } });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await state.queue.enqueue('messages.set', instance, [{ key: { id: 'history' } }]);
    await busy;
    await state.queue.enqueue('messages.update', instance, [{ status: 2 }]);
    await state.queue.enqueue('connection.removed', { ...instance, connectionStatus: 'REMOVED' }, { reason: 401 });
    await Promise.race([notification, new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Logout remained blocked behind history')), 2000); })]);
    assert.deepEqual(events, ['messages.set', 'connection.removed']);
    release(); await state.queue.flush();
    assert.deepEqual(events, ['messages.set', 'connection.removed', 'messages.update']);
    assert.deepEqual(await state.queue.stats(), { pending: 0, deadLetter: 0 });
  } finally { if (timeout) clearTimeout(timeout); release(); await state.cleanup(); }
});

test('lifecycle retries retain identity and order across restart without blocking message delivery', async () => {
  let time = 1000, fail = true;
  const received: any[] = [];
  const state = await setup({ now: () => time, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); received.push(body);
    return new Response(null, { status: fail && body.event.startsWith('connection.') ? 503 : 204 });
  } });
  let replacement: WebhookOutbox | undefined;
  try {
    const id = await state.queue.enqueue('connection.close', instance, {}); await state.queue.flush();
    await state.queue.enqueue('connection.removed', { ...instance, connectionStatus: 'REMOVED' }, {}); await state.queue.flush();
    await state.queue.enqueue('messages.set', instance, []); await state.queue.flush();
    assert.deepEqual(received.map(item => item.event), ['connection.close', 'messages.set']);
    assert.equal((await state.queue.stats()).pending, 2);
    await state.queue.stop();
    fail = false; time += 20;
    replacement = new WebhookOutbox(state.options);
    await replacement.flush();
    assert.deepEqual(received.map(item => item.event), ['connection.close', 'messages.set', 'connection.close', 'connection.removed']);
    assert.equal(received[2].id, id);
    assert.deepEqual(await replacement.stats(), { pending: 0, deadLetter: 0 });
  } finally { await replacement?.stop(); await state.cleanup(); }
});

test('a lifecycle storage failure cannot start a second delivery of an in-flight history item', async () => {
  let release!: () => void, entered!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const busy = new Promise<void>(resolve => { entered = resolve; });
  const state = await setup({ logError: () => {}, fetch: async () => { calls++; entered(); await gate; return new Response(null, { status: 204 }); } });
  const blocker = path.join(state.options.directory, 'lifecycle');
  try {
    await fs.writeFile(blocker, 'not a queue directory');
    await state.queue.enqueue('messages.set', instance, []);
    await busy;
    await assert.rejects(state.queue.flush(), error => ['ENOTDIR', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? ''));
    assert.equal(calls, 1, 'failure of another lane must not release this lane lock');
    await fs.unlink(blocker);
    release(); await state.queue.flush();
    assert.equal(calls, 1);
    assert.deepEqual(await state.queue.stats(), { pending: 0, deadLetter: 0 });
  } finally { release(); await state.cleanup(); }
});

test("poison files are isolated and exhausted events remain replayable",async()=>{
  let fail=true;
  const state=await setup({maxAttempts:1,fetch:async()=>new Response(null,{status:fail?500:204})});
  try {
    await fs.writeFile(path.join(state.options.directory,"invalid.json"),"{");
    await fs.writeFile(path.join(state.options.directory,"invalid-schema.json"),JSON.stringify({payload:{event:"test",instance},attempts:0,nextAttemptAt:0}));
    await state.queue.enqueue("connection.removed",instance,{});await state.queue.flush();
    assert.deepEqual(await state.queue.stats(),{pending:0,deadLetter:3});
    fail=false;
    assert.equal(await state.queue.replayDeadLetters(),1);
    await state.queue.flush();
    assert.deepEqual(await state.queue.stats(),{pending:0,deadLetter:2});
  } finally {await state.cleanup();}
});

test("legacy queue restart ignores persisted targetUrl and delivers to configured receiver",async()=>{
  const destinations:string[]=[];
  const state=await setup({fetch:async(url)=>{destinations.push(String(url));return new Response(null,{status:204});}});
  try {
    await fs.writeFile(path.join(state.options.directory,"old-123.json"),JSON.stringify({event:"connection.close",instance,data:{},targetUrl:"http://wrong.invalid/"}));
    await state.queue.flush();
    assert.deepEqual(destinations,[state.options.url]);
    assert.deepEqual(await state.queue.stats(),{pending:0,deadLetter:0});
  } finally {await state.cleanup();}
});

test("real HTTP delivery sends the shared secret and rejects redirects",async()=>{
  const received:any[]=[];
  const server=createServer(async(req,res)=>{
    if(req.url==="/redirect"){res.writeHead(302,{Location:"/webhook"});res.end();return;}
    let body="";for await(const chunk of req)body+=String(chunk);
    received.push({headers:req.headers,body:JSON.parse(body)});res.writeHead(204);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address() as {port:number};
  const state=await setup({url:`http://127.0.0.1:${address.port}/webhook`});
  const redirect=await setup({url:`http://127.0.0.1:${address.port}/redirect`,maxAttempts:1});
  try {
    await state.queue.enqueue("qrcode.updated",instance,{qrCode:"test-data"});await state.queue.flush();
    assert.equal(received.length,1);assert.equal(received[0].headers["x-webhook-secret"],state.options.secret);
    await redirect.queue.enqueue("test",instance,{});await redirect.queue.flush();
    assert.equal(received.length,1);assert.equal((await redirect.queue.stats()).deadLetter,1);
  } finally {await state.cleanup();await redirect.cleanup();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("enqueue during an in-flight delivery is not lost",async()=>{
  let release:()=>void=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const delivered:string[]=[];
  const state=await setup({fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));delivered.push(body.event);if(body.event==="first")await gate;return new Response(null,{status:204});}});
  try {
    await state.queue.enqueue("first",instance,{});
    await state.queue.enqueue("second",instance,{});
    release();await state.queue.flush();
    assert.deepEqual(delivered,["first","second"]);assert.equal((await state.queue.stats()).pending,0);
  } finally {release();await state.cleanup();}
});

test('history watermark and stable chunk metadata survive dead-letter and replay', async () => {
  const runId = randomUUID(), batchId = randomUUID(), startedAt = new Date().toISOString();
  const history = { runId, batchId, startedAt, chunkId: `${batchId}:messages.set:0` };
  const seen: any[] = [], delivered: any[] = [];
  let fail = true;
  const state = await setup({ maxAttempts: 1, retryMs: 60_000, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); seen.push(body);
    const rejected = fail && body.history?.chunkId === history.chunkId;
    if (!rejected) delivered.push(body);
    return new Response(null, { status: rejected ? 503 : 204 });
  } });
  try {
    await state.queue.stop();
    const progress = { version: 1, runId, startedAt, sequence: 1, phase: 'receiving', expectedChunks: 2, expected: { contacts: 0, chats: 0, messages: 2 } };
    await state.queue.enqueue('messaging-history.progress', instance, progress);
    const missingId = await state.queue.enqueue('messages.set', instance, [{ key: { id: 'one' } }], history);
    await state.queue.enqueue('messages.set', instance, [{ key: { id: 'two' } }], { ...history, chunkId: `${batchId}:messages.set:1` });
    await state.queue.enqueue('messaging-history.progress', instance, { ...progress, sequence: 2, phase: 'waiting' });
    state.queue.start(); await state.queue.flush(); await state.queue.flush();
    assert.equal(delivered[0].event, 'messaging-history.progress');
    assert.equal(delivered.at(-1).data.phase, 'waiting');
    assert.equal(delivered.filter(item => item.history).length, 1, 'a terminal progress packet does not prove all chunks were delivered');
    assert.equal(delivered.at(-1).data.expectedChunks, 2);
    assert.deepEqual(await state.queue.stats(), { pending: 0, deadLetter: 1 });
    fail = false;
    await state.queue.replayDeadLetters(); await state.queue.flush();
    const retries = seen.filter(item => item.id === missingId);
    assert.equal(retries.length, 2);
    assert.deepEqual(retries[0], retries[1]);
    assert.deepEqual(retries[1].history, history);
    assert.equal(delivered.filter(item => item.history).length, 2);
  } finally { await state.cleanup(); }
});

test("startup and periodic storage failures identify the process and queue directory without leaking error contents", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "zaptobox-outbox-diagnostics-"));
  const blocker = path.join(directory, "file-instead-of-directory");
  await fs.writeFile(blocker, "fixture");
  const queueDirectory = path.join(blocker, "queue");
  const diagnostics: OutboxDiagnostic[] = [];
  let delivered = 0;
  let time = 0;
  let resolveObserved!: () => void;
  const observed = new Promise<void>(resolve => { resolveObserved = resolve; });
  const queue = new WebhookOutbox({
    directory: queueDirectory, url: "https://receiver.invalid/private?token=hidden-token", secret: "hidden-secret",
    timeoutMs: 1000, maxAttempts: 3, concurrency: 1, retryMs: 20, durable: true,
    now: () => time,
    fetch: async () => { delivered++; return new Response(null, { status: 204 }); },
    logError: diagnostic => {
      diagnostics.push(diagnostic);
      time += 60_000;
      if (diagnostics.some(item => item.phase === "startup") && diagnostics.some(item => item.phase === "retry")) resolveObserved();
    },
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    queue.start();
    await Promise.race([observed, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Expected startup and retry diagnostics")), 2000);
    })]);
    await queue.stop();
    assert.equal(delivered, 0);
    for (const diagnostic of diagnostics) {
      assert.equal(diagnostic.component, "webhook-outbox");
      assert.equal(diagnostic.code, "ENOTDIR");
      assert.ok([queueDirectory, path.join(queueDirectory, 'lifecycle')].includes(diagnostic.directory));
      assert.equal(diagnostic.pid, process.pid);
      assert.match(diagnostic.advice, /must be directories, not files/);
      assert.equal("stack" in diagnostic, false);
      assert.equal("message" in diagnostic, false);
    }
    assert.doesNotMatch(JSON.stringify(diagnostics), /receiver\.invalid|hidden-token|hidden-secret/);
  } finally {
    if (timeout) clearTimeout(timeout);
    await queue.stop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("duplicate storage diagnostics are limited to once a minute while attempts and changed errors continue", async () => {
  let time = 0, attempts = 0, code = "ENOTDIR";
  const diagnostics: OutboxDiagnostic[] = [];
  const state = await setup({ now: () => time, logError: diagnostic => diagnostics.push(diagnostic), retryMs: 60_000 });
  // A failed flush represents a local filesystem error, not a webhook delivery.
  // Repeated starts exercise the same reporting path without waiting a minute.
  state.queue.flush = async () => { attempts++; throw Object.assign(new Error("private error contents"), { code }); };
  const attempt = async () => { state.queue.start(); await state.queue.stop(); };
  try {
    await attempt();
    time = 20_000; await attempt();
    time = 59_999; await attempt();
    assert.equal(attempts, 3);
    assert.deepEqual(diagnostics.map(item => item.code), ["ENOTDIR"]);
    time = 60_000; await attempt();
    assert.deepEqual(diagnostics.map(item => item.code), ["ENOTDIR", "ENOTDIR"]);
    code = "EACCES"; time++; await attempt();
    assert.equal(diagnostics.at(-1)?.code, "EACCES");
    assert.match(diagnostics.at(-1)?.advice ?? "", /process user can read and write/);
    time++; await attempt();
    assert.equal(diagnostics.length, 3);
    code = "ENOTDIR"; time++; await attempt();
    assert.equal(diagnostics.length, 4, "a changed error must be reported immediately");
    assert.equal(attempts, 7, "log throttling must not suppress attempts");
    assert.doesNotMatch(JSON.stringify(diagnostics), /private error contents/);
  } finally { await state.cleanup(); }
});

test("HTTP and fetch failures remain delivery retries without misleading storage diagnostics", async () => {
  let time = 1000;
  let attempt = 0;
  const diagnostics: OutboxDiagnostic[] = [];
  const state = await setup({
    now: () => time, logError: diagnostic => diagnostics.push(diagnostic), maxAttempts: 5,
    fetch: async () => {
      attempt++;
      if (attempt === 1) throw new Error("fetch failed https://receiver.invalid?token=hidden-secret");
      return new Response(null, { status: attempt === 2 ? 503 : 204 });
    },
  });
  try {
    await state.queue.enqueue("messages.upsert", instance, { privateText: "do not log" });
    await state.queue.flush();
    assert.equal((await state.queue.stats()).pending, 1);
    time += 100; await state.queue.flush();
    assert.equal((await state.queue.stats()).pending, 1);
    time += 100; await state.queue.flush();
    assert.equal(attempt, 3);
    assert.deepEqual(await state.queue.stats(), { pending: 0, deadLetter: 0 });
    assert.deepEqual(diagnostics, []);
  } finally { await state.cleanup(); }
});

test('a durable producer identity survives duplicate handoff while unsafe event filenames are rejected', async () => {
  const seen: any[] = [];
  const state = await setup({ fetch: async (_url, init) => { seen.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); } });
  try {
    await state.queue.stop();
    const identity = { id: 'a'.repeat(64), timestamp: '2026-09-08T15:00:00.000Z' };
    const data = [{ key: { id: 'retained' }, message: { conversation: 'original' } }];
    await state.queue.enqueue('messages.set', instance, data, undefined, identity);
    await state.queue.enqueue('messages.set', instance, data, undefined, identity);
    await assert.rejects(state.queue.enqueue('messages.set', instance, data, undefined, { ...identity, id: '../outside' }), /Invalid durable event identity/);
    state.queue.start(); await state.queue.flush();
    assert.equal(seen.length, 2); assert.deepEqual(seen[0], seen[1]); assert.equal(seen[0].id, identity.id);
    assert.equal((await state.queue.stats()).pending, 0);
  } finally { await state.cleanup(); }
});
