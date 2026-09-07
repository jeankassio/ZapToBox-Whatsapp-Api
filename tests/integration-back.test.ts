import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import express from "express";

test("Back → API → socket and durable webhook → Back preserve send, edit, revoke and receipts",{
  skip:!process.env.QA_DATABASE_URL || !process.env.QA_BACKEND_PATH,
},async()=>{
  const url=new URL(process.env.QA_DATABASE_URL!);
  if(url.hostname!=="127.0.0.1" || !url.pathname.startsWith("/qa_"))throw new Error("Use an isolated local qa_ database");
  process.env.DATABASE_URL=url.toString();
  const secret="integration-only-"+randomUUID();
  process.env.WEBHOOK_SECRET=secret;
  const loadBack=(file:string)=>import(pathToFileURL(path.join(process.env.QA_BACKEND_PATH!,"dist",file+".js")).href);
  const [{SqliteDatabase},{migrate},{createWebhookRouter},{createChatRouter},{WhatsappClient},{errorHandler}]=await Promise.all([
    loadBack("db"),loadBack("migrate"),loadBack("whatsapp/webhook"),loadBack("whatsapp/chats"),loadBack("whatsapp/client"),loadBack("errors"),
  ]);
  const [{createApp},{default:Instance},{prisma,default:Repository},{createPersistentAuth,databaseAuthRepository},{WebhookOutbox}]=await Promise.all([
    import("../src/app.js"),import("../src/infra/baileys/services.js"),import("../src/core/connection/prisma.js"),import("../src/infra/state/auth-state.js"),import("../src/infra/webhook/outbox.js"),
  ]);
  const db=new SqliteDatabase();await migrate(db);
  const name="qa_"+randomUUID().replaceAll("-","");
  const key="1/"+name;
  await db.execute("INSERT INTO tbl_instances (_id,_user,_identify,_name,_label,_status,_expire,_created) VALUES (1,1,'qa-ident',?,'QA','1','2099-01-01 00:00:00','2026-01-01 00:00:00')",[name]);
  const api=createApp({token:secret,ready:async()=>{}}).listen(0,"127.0.0.1");await once(api,"listening");
  const apiUrl="http://127.0.0.1:"+(api.address() as {port:number}).port;
  const events:any[]=[];
  const back=express();back.use(express.json({limit:"10mb"}));
  const publish=(id:number,type:string,data:unknown)=>events.push({id,type,data});
  back.use("/webhook",createWebhookRouter(db,publish));
  back.use((req,_res,next)=>{(req as any).user={id:1};next();});
  back.use("/api/connections",createChatRouter(db,new WhatsappClient({baseUrl:apiUrl,token:secret}),publish));
  back.use(errorHandler);
  const server=back.listen(0,"127.0.0.1");await once(server,"listening");
  const backUrl="http://127.0.0.1:"+(server.address() as {port:number}).port;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"zaptobox-integration-"));
  const outbox=new WebhookOutbox({directory,url:backUrl+"/webhook",secret,timeoutMs:1000,maxAttempts:3,concurrency:1,retryMs:10,durable:true});
  const emitter=new EventEmitter();
  const jid="5511999999999@s.whatsapp.net";
  let sentCount=0;
  const instance=new Instance({
    loadAuth:async()=>{const auth=await createPersistentAuth(databaseAuthRepository(key));auth.state.creds.registered=true;return auth;},
    makeSocket:(config)=>({ev:emitter,authState:config.auth,ws:{isOpen:true},user:{id:"5511888888888@s.whatsapp.net"},end:()=>{},
      profilePictureUrl:async()=>undefined,sendMessage:async(remoteJid:string,content:any)=>{
        sentCount++;return {key:{id:"OUT-1",remoteJid,fromMe:true},message:{conversation:content.text},messageTimestamp:1_788_780_000,status:2};
      },
    } as any),
    emit:async(event,info,data)=>{await outbox.enqueue(event,{owner:info.owner,instanceName:info.instanceName,connectionStatus:info.connectionStatus},data);},
    removeSession:async()=>{},qrTimeoutMs:10,
  });
  const until=async(check:()=>Promise<boolean>)=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error("Expected integrated event was not delivered");};
  try {
    await instance.create({owner:"1",instanceName:name});
    emitter.emit("connection.update",{connection:"open"});
    emitter.emit("messages.upsert",{type:"notify",messages:[{key:{id:"IN-1",remoteJid:jid,fromMe:false},message:{conversation:"Olá"},messageTimestamp:1_788_780_000}]});
    await until(async()=>Number((await db.query("SELECT COUNT(*) AS n FROM tbl_messages"))[0].n)===1);
    const chat=(await db.query("SELECT _id FROM tbl_chat"))[0]._id;
    const send=await fetch(`${backUrl}/api/connections/qa-ident/chats/${chat}/messages`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:"Resposta integrada"})});
    assert.equal(send.status,202);assert.equal((await send.json()).data.messageId,"OUT-1");
    await until(async()=>Number((await db.query("SELECT COUNT(*) AS n FROM tbl_messages"))[0].n)===2);
    assert.equal(sentCount,1);assert.equal((await Repository.getMessageById("OUT-1",key))?.message?.conversation,"Resposta integrada");
    emitter.emit("message-receipt.update",[{key:{id:"OUT-1",remoteJid:jid},receipt:{readTimestamp:1_788_780_001,userJid:jid}}]);
    await until(async()=>(await db.query("SELECT _status FROM tbl_messages WHERE _messageId='OUT-1'"))[0]._status==="100");
    emitter.emit("messages.upsert",{type:"notify",messages:[{key:{id:"EDIT-1",remoteJid:jid,fromMe:false},message:{protocolMessage:{type:14,key:{id:"IN-1",remoteJid:jid},editedMessage:{conversation:"Olá editado"},timestampMs:1_788_780_002_000}},messageTimestamp:1_788_780_002}]});
    await until(async()=>(await db.query("SELECT _content FROM tbl_messages WHERE _messageId='IN-1'"))[0]._content==="Olá editado");
    emitter.emit("messages.upsert",{type:"notify",messages:[{key:{id:"REVOKE-1",remoteJid:jid,fromMe:false},message:{protocolMessage:{type:0,key:{id:"IN-1",remoteJid:jid}}},messageTimestamp:1_788_780_003}]});
    await until(async()=>events.some(event=>event.type==="message.delete"));
    assert.ok(events.some(event=>event.type==="message.upsert"));
    await outbox.flush();assert.equal((await outbox.stats()).pending,0);
  } finally {
    await instance.clearInstance();await outbox.stop();
    api.closeAllConnections();server.closeAllConnections();
    await Promise.all([new Promise<void>(resolve=>api.close(()=>resolve())),new Promise<void>(resolve=>server.close(()=>resolve()))]);
    await Repository.deleteByInstance(key);await prisma.authState.deleteMany({where:{instance:key}});await prisma.$disconnect();await db.close();
    const safe=path.resolve(directory);assert.ok(safe.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(safe).startsWith("zaptobox-integration-"));
    await fs.rm(safe,{recursive:true,force:true});
  }
});
