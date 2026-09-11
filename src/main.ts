import { apiLogger } from './infra/logging/logger.js';
import { createServer } from 'node:http';
import { createApp } from "./app.js";
import UserConfig from "./infra/config/env.js";
import Sessions from "./infra/state/sessions.js";
import Queue from "./infra/webhook/queue.js";
import { prisma } from "./core/connection/prisma.js";
import { ApiRuntime, startupErrorMessage } from './runtime.js';

async function bootstrap():Promise<void> {
  UserConfig.validate();
  apiLogger.info({ event: 'api.configuration', runtime: process.version,
    sessionLabel: UserConfig.whatsapp.browser[0], browserName: UserConfig.whatsapp.browser[1],
    logLevel: UserConfig.whatsapp.logLevel, baileysLogLevel: UserConfig.whatsapp.baileysLogLevel,
    mode: UserConfig.whatsapp.contactMode, queryTimeoutMs: UserConfig.whatsapp.queryTimeoutMs }, 'Effective API options');
  if (UserConfig.whatsapp.legacyPhoneNameIgnored) apiLogger.warn({ event: 'api.legacy-phone-name' }, 'PHONE_NAME is a legacy browser alias. Use SESSION for the device label and BROWSER_NAME for Chrome/Firefox/etc.');
  const app=createApp({isReady:()=>runtime.ready,ready:async()=>{if(!runtime.ready)throw new Error('Starting');await prisma.$queryRawUnsafe('SELECT 1');}});
  const server=createServer(app);
  const runtime=new ApiRuntime({server,host:UserConfig.host,port:Number(UserConfig.portConfig),
    connect:()=>prisma.$connect(),disconnect:()=>prisma.$disconnect(),queue:new Queue(),sessions:new Sessions()});
  let stopping:Promise<void>|undefined;
  const shutdown=()=>stopping??=(async()=>{
    const timeout=setTimeout(()=>{apiLogger.error(`[pid=${process.pid}] Shutdown timed out`);process.exit(1);},25_000);timeout.unref();
    try {await runtime.stop();} finally {clearTimeout(timeout);process.off('SIGINT',signal);process.off('SIGTERM',signal);process.off('message',message);}
  })();
  const signal=()=>{void shutdown().catch(()=>{apiLogger.error(`[pid=${process.pid}] Shutdown failed`);process.exitCode=1;});};
  const message=(value:unknown)=>{if(value==='shutdown')signal();};
  process.once('SIGINT',signal);process.once('SIGTERM',signal);
  process.on('message',message);
  server.on('error',error=>{if(runtime.bound){apiLogger.error(`[pid=${process.pid}] HTTP server failed:`,(error as NodeJS.ErrnoException).code??'UNKNOWN');signal();process.exitCode=1;}});
  try {
    await runtime.start();
    if(runtime.ready){apiLogger.info(`[pid=${process.pid}] ZapToBox WhatsApp API ready on ${UserConfig.host}:${UserConfig.portConfig}`);process.send?.('ready');}
  } catch(error) {await shutdown().catch(()=>apiLogger.error(`[pid=${process.pid}] Startup cleanup failed`));throw error;}
}
bootstrap().catch(async error=>{
  apiLogger.error(`[pid=${process.pid}] API startup failed:`,startupErrorMessage(error,UserConfig.host,Number(UserConfig.portConfig)));
  process.exitCode=1;
});
