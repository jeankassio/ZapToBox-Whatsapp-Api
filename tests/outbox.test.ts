import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { WebhookOutbox, type OutboxOptions } from "../src/infra/webhook/outbox.js";

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
    await state.queue.enqueue("connection.close",instance,{connection:"close"});await state.queue.flush();
    assert.equal(seen.length,1,"new event must not overtake a failed event");
    assert.equal((await state.queue.stats()).pending,2);
    fail=false;time+=20;await state.queue.flush();
    assert.deepEqual(seen.map(item=>item.body.event),["messages.upsert","messages.upsert","connection.close"]);
    assert.equal(seen[1]!.body.id,id);
    assert.equal(seen[1]!.body.data.timestamp,"9000000000000001");
    assert.equal(seen[1]!.body.data.bytes.type,"Buffer");
    assert.deepEqual(Buffer.from(seen[1]!.body.data.bytes.data,"base64"),Buffer.from([1,2,3]));
    assert.equal(seen[1]!.headers.get("X-Webhook-Secret"),"test-webhook-secret");
    assert.equal(seen[1]!.headers.get("X-Webhook-Id"),id);
    assert.equal((await state.queue.stats()).pending,0);
  } finally {await state.cleanup();}
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
