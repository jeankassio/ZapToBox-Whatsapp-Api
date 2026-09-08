import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const database=process.env.QA_DATABASE_URL;
test("PostgreSQL: tenant isolation, protobuf roundtrip, contact merge, Signal persistence and legacy migration",{skip:!database},async()=>{
  const url=new URL(database!);
  if(!["127.0.0.1","localhost"].includes(url.hostname) || !url.pathname.startsWith("/qa_"))throw new Error("Use a disposable local qa_ database");
  process.env.DATABASE_URL=database;
  const {default:Repository,prisma}=await import("../src/core/connection/prisma.js");
  const {databaseAuthRepository,createPersistentAuth}=await import("../src/infra/state/auth-state.js");
  const owner="qa_"+randomUUID().replaceAll("-","");
  const a=owner+"/one",b=owner+"/two",legacy=owner+"_legacy";
  try {
    const msg={key:{id:"SAME-ID",remoteJid:"123456789@s.whatsapp.net",fromMe:true,remoteJidAlt:"555000@lid"},message:{imageMessage:{caption:"A",mediaKey:Buffer.from([1,2,3])}},messageTimestamp:1234567890,status:2};
    await Repository.saveMessages(a,msg);
    await Repository.saveMessages(b,{...msg,message:{conversation:"B"}});
    assert.equal((await Repository.getMessageById("SAME-ID",a))?.message?.imageMessage?.caption,"A");
    assert.deepEqual(Buffer.from((await Repository.getMessageById("SAME-ID",a))!.message!.imageMessage!.mediaKey!),Buffer.from([1,2,3]));
    assert.equal((await Repository.getMessageById("SAME-ID",b))?.message?.conversation,"B");
    assert.equal(await Repository.getMessageById("SAME-ID",a,"unrelated@s.whatsapp.net"),undefined);
    const restored=await Repository.getMessageById("SAME-ID",a,"555000@lid");
    assert.deepEqual(Buffer.from(restored!.message!.imageMessage!.mediaKey!),Buffer.from([1,2,3]));
    assert.equal(restored?.key.remoteJidAlt,"555000@lid");
    await Repository.saveMessages(a,{key:msg.key,status:0});
    assert.equal((await Repository.getMessageById("SAME-ID",a))?.status,0);
    assert.equal((await Repository.getMessageById("SAME-ID",a))?.message?.imageMessage?.caption,"A");
    assert.deepEqual(Buffer.from((await Repository.getMessageById("SAME-ID",a))!.message!.imageMessage!.mediaKey!),Buffer.from([1,2,3]));
    assert.equal((await Repository.getLastMessageByInstance(a,"555000@lid"))?.key.id,"SAME-ID");
    await Repository.saveContact(a,{id:"555000@lid",name:"Pessoa"});
    await Repository.saveContact(a,{id:"123456789@s.whatsapp.net"});
    await Repository.saveContact(a,{id:"555000@lid",phoneNumber:"123456789@s.whatsapp.net"});
    assert.equal(await prisma.contact.count({where:{instance:a}}),1);
    assert.equal((await Repository.getContactById(a,"555000@lid"))?.name,"Pessoa");
    await Repository.saveContact(a,{id:"987654321@s.whatsapp.net"});
    await Repository.saveContact(a,{id:"888000@lid",name:"Nome preservado"});
    await Repository.saveContact(a,{id:"888000@lid",phoneNumber:"987654321@s.whatsapp.net"});
    assert.equal((await Repository.getContactById(a,"987654321@s.whatsapp.net"))?.name,"Nome preservado");
    await Repository.saveMessages(legacy,{...msg,key:{...msg.key,id:"OLD-ID"}});
    await Repository.migrateLegacyInstanceKey(owner,"legacy");
    assert.ok(await Repository.getMessageById("OLD-ID",owner+"/legacy"));
    await Repository.migrateLegacyInstanceKey(owner,"legacy");
    const auth=await createPersistentAuth(databaseAuthRepository(a));
    await auth.state.keys.set({"lid-mapping":{"123": "555"},"session":{"test":Buffer.from([8,7,6])}});
    await auth.saveCreds();
    const reloaded=await createPersistentAuth(databaseAuthRepository(a));
    assert.equal((await reloaded.state.keys.get("lid-mapping",["123"]))["123"],"555");
    assert.deepEqual((await reloaded.state.keys.get("session",["test"]))["test"],Buffer.from([8,7,6]));
    const other=await createPersistentAuth(databaseAuthRepository(b));
    assert.equal((await other.state.keys.get("session",["test"]))["test"],undefined);
    await Repository.deleteMessages(a,{all:true,jid:"555000@lid"});
    assert.equal(await Repository.getMessageById("SAME-ID",a),undefined);
    assert.ok(await Repository.getMessageById("SAME-ID",b));
  } finally {
    for(const instance of [a,b,legacy,owner+"/legacy"]) {
      await Repository.deleteByInstance(instance);await prisma.authState.deleteMany({where:{instance}});
    }
    await prisma.$disconnect();
  }
});
