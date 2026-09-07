import express, { type ErrorRequestHandler } from "express";
import Token from "./infra/state/auth.js";
import UserConfig from "./infra/config/env.js";
import InstanceRoutes from "./infra/http/routes/instances.js";
import MessageRoutes from "./infra/http/routes/messages.js";
import MediaRoutes from "./infra/http/routes/media.js";
import ChatRoutes from "./infra/http/routes/chat.js";
import GroupRoutes from "./infra/http/routes/group.js";
import ProfileRoutes from "./infra/http/routes/profile.js";
import PrivacyRoutes from "./infra/http/routes/privacy.js";
import { prisma } from "./core/connection/prisma.js";
import { webhookOutbox } from "./shared/utils.js";
import { jsonReplacer } from "./shared/serialization.js";

export function createApp(options: { token?:string; ready?:()=>Promise<void> } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.set("json replacer",jsonReplacer);
  app.use((_req,res,next)=>{
    res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("Cache-Control","no-store");next();
  });
  app.get("/health",(_req,res)=>res.json({status:"ok",version:"1.3.0",baileys:"7.0.0-rc14"}));
  app.use(new Token(options.token).verify);
  app.use(express.json({limit:UserConfig.bodyLimit}));
  app.get("/health/ready",async(_req,res)=>{
    try { await (options.ready ? options.ready() : prisma.$queryRaw`SELECT 1`);res.json({status:"ready"}); }
    catch {res.status(503).json({status:"unavailable"});}
  });
  app.get("/webhooks/queue",async(req,res)=>{
    if(!req.auth?.admin){res.status(403).json({error:"Administrator token required"});return;}
    res.json({success:true,...await webhookOutbox.stats()});
  });
  app.post("/webhooks/queue/replay",async(req,res)=>{
    if(!req.auth?.admin){res.status(403).json({error:"Administrator token required"});return;}
    const replayed = await webhookOutbox.replayDeadLetters();
    void webhookOutbox.flush().catch(()=>console.error("Webhook replay failed; events remain on disk"));
    res.json({success:true,replayed});
  });
  app.use("/instances",new InstanceRoutes().get());
  app.use("/messages",new MessageRoutes().get());
  app.use("/media",new MediaRoutes().get());
  app.use("/chat",new ChatRoutes().get());
  app.use("/group",new GroupRoutes().get());
  app.use("/profile",new ProfileRoutes().get());
  app.use("/privacy",new PrivacyRoutes().get());
  app.use((_req,res)=>res.status(404).json({success:false,error:"Route not found"}));
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
    const status=error?.type==="entity.too.large" ? 413 : error instanceof SyntaxError ? 400 : 500;
    res.status(status).json({success:false,error:status===413?"Request body too large":status===400?"Invalid JSON":"Internal server error"});
  };
  app.use(errors);
  return app;
}
