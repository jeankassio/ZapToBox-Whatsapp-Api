import { createApp } from "./app.js";
import UserConfig from "./infra/config/env.js";
import Sessions from "./infra/state/sessions.js";
import Queue from "./infra/webhook/queue.js";
import { prisma } from "./core/connection/prisma.js";

async function bootstrap():Promise<void> {
  UserConfig.validate();
  await prisma.$connect();
  let ready=false,closing=false;
  const app=createApp({ready:async()=>{if(!ready)throw new Error('Starting');await prisma.$queryRawUnsafe('SELECT 1');}});
  const server=app.listen(Number(UserConfig.portConfig),UserConfig.host);
  const queue=new Queue(),sessions=new Sessions();
  const shutdown=async()=>{
    if(closing)return;closing=true;ready=false;
    const timeout=setTimeout(()=>{console.error('Shutdown timed out');process.exit(1);},25_000);timeout.unref();
    try {
      // Finish accepted HTTP operations before closing their sockets and persistence.
      await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});
      await sessions.shutdown();await queue.stop();await prisma.$disconnect();
    } finally {clearTimeout(timeout);}
  };
  const signal=()=>{void shutdown().catch(()=>{console.error('Shutdown failed');process.exitCode=1;});};
  process.once('SIGINT',signal);process.once('SIGTERM',signal);
  try {
    await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject);});
    queue.start();
    console.log('ZapToBox WhatsApp API listening on ' + UserConfig.host + ':' + UserConfig.portConfig);
    await sessions.start();
    if(!closing)ready=true;
  } catch(error) {await shutdown();throw error;}
}
bootstrap().catch(async error=>{
  console.error('API startup failed:',error instanceof Error?error.message:'Unknown error');
  await prisma.$disconnect();process.exitCode=1;
});
