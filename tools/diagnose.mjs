import { createServer } from 'node:net';
import { readFile, stat, access, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import dotenv from 'dotenv';

const execute = promisify(execFile);
export function invalidNpmKeys(text) {
  return text.split(/\r?\n/).flatMap((line,index)=>{
    const match=line.match(/^\s*((?:--|_-)?init\.module)\s*=/);
    return match ? [{line:index+1,key:match[1]}] : [];
  });
}

/** A temporary exclusive bind checks availability without contacting the database or WhatsApp. */
export async function checkPort(host,port) {
  const server=createServer();
  return new Promise(resolveResult=>{
    server.once('error',error=>resolveResult({available:false,code:error.code??'UNKNOWN'}));
    server.once('listening',()=>server.close(()=>resolveResult({available:true})));
    server.listen({host,port,exclusive:true});
  });
}

export async function inspectQueue(directory) {
  const path=resolve(directory);
  try {
    let information;
    try {information=await stat(path);} catch(error) {
      if(error.code!=='ENOENT')throw error;
      let parent=dirname(path);
      while(true){
        try {const info=await stat(parent);if(!info.isDirectory())return {directory:path,code:'ENOTDIR'};await access(parent,constants.R_OK|constants.W_OK|constants.X_OK);return {directory:path,missing:true,writable:true};}
        catch(parentError){if(parentError.code!=='ENOENT'||dirname(parent)===parent)throw parentError;parent=dirname(parent);}
      }
    }
    if(!information.isDirectory())return {directory:path,code:'ENOTDIR'};
    await access(path,constants.R_OK|constants.W_OK|constants.X_OK);
    const entries=await readdir(path,{withFileTypes:true});
    const files=entries.filter(entry=>entry.isFile()&&entry.name.endsWith('.json'));
    const fileErrors={};
    // Metadata/access checks only; message contents are never opened or printed.
    for(const file of files){try{await access(join(path,file.name),constants.R_OK|constants.W_OK);}catch(error){const code=error.code??'UNKNOWN';fileErrors[code]=(fileErrors[code]??0)+1;}}
    const dead=entries.find(entry=>entry.name==='dead-letter');
    if(dead){const info=await stat(join(path,dead.name));if(!info.isDirectory())return {directory:path,code:'ENOTDIR',part:'dead-letter'};await access(join(path,dead.name),constants.R_OK|constants.W_OK|constants.X_OK);}
    return {directory:path,writable:true,pendingFiles:files.length,fileErrors};
  } catch(error){return {directory:path,code:error.code??'UNKNOWN'};}
}

async function npmConfigPath(key) {
  const npmCli=process.env.npm_execpath;
  if(!npmCli)return undefined;
  try {
    const {stdout}=await execute(process.execPath,[npmCli,'config','get',key],{timeout:5000,windowsHide:true});
    const path=stdout.trim();
    return path&&!path.includes('\n')&&!path.includes('\r')?path:undefined;
  } catch {return undefined;}
}

async function main() {
  dotenv.config({quiet:true});
  const host=process.env.HOST||'127.0.0.1',port=Number(process.env.PORT??3001);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT deve ser um inteiro de 1 a 65535.');
  console.log(`ZapToBox WhatsApp API — diagnóstico local (PID ${process.pid})`);
  console.log(`Endereço configurado: ${host}:${port}`);
  const result=await checkPort(host,port);
  if(result.available)console.log('Porta disponível neste momento. O diagnóstico já liberou a porta.');
  else {
    console.log(`Não foi possível reservar a porta: ${result.code}.`);
    if(result.code==='EADDRINUSE') {
      console.log('Já existe um processo usando esse endereço. Reinicie a instância pelo mesmo painel/supervisor.');
      console.log(process.platform==='win32'
        ? `PowerShell: Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess`
        : `Linux: ss -ltnp 'sport = :${port}'`);
      console.log('No aaPanel, use Service status para reiniciar o cadastro da API. Use npm run restart:pm2 somente quando PM2 for seu único supervisor.');
    }
    process.exitCode=1;
  }
  const paths=new Set([resolve('.npmrc'),await npmConfigPath('userconfig'),await npmConfigPath('globalconfig')].filter(Boolean));
  let found=false;
  for(const path of paths){
    let text;try{text=await readFile(path,'utf8');}catch(error){if(error.code!=='ENOENT')console.log(`Não foi possível ler configuração npm: ${error.code??'UNKNOWN'}`);continue;}
    for(const item of invalidNpmKeys(text)){found=true;console.log(`Configuração npm obsoleta/inválida: ${path}:${item.line} — chave ${item.key} (valor omitido).`);}
  }
  for(const key of Object.keys(process.env).filter(key=>/^npm_config_(?:--|_-)?init\.module$/i.test(key))){found=true;console.log(`Variável npm inválida herdada: ${key} (valor omitido).`);}
  if(found)console.log('Remova essas chaves da configuração npm da hospedagem. Elas não configuram a porta da API.');
  else console.log('Nenhuma chave init.module inválida encontrada nas configurações npm acessíveis.');
  if(process.env.WEBHOOK_URL&&process.env.WEBHOOK_QUEUE!=='false'){
    const queue=await inspectQueue(process.env.WEBHOOK_QUEUE_DIR||'./webhook-queue');
    console.log('Diagnóstico da fila (sem ler mensagens):',JSON.stringify(queue));
    if(queue.code||Object.keys(queue.fileErrors??{}).length)process.exitCode=1;
    console.log('Execute este diagnóstico com o mesmo usuário selecionado no aaPanel para a API. O usuário do terminal pode ter permissões diferentes.');
  } else console.log('Fila persistente de webhooks desabilitada ou WEBHOOK_URL ausente.');
  console.log('Nenhum processo foi encerrado; banco, sessões WhatsApp e fila não foram iniciados.');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(error=>{console.error('Diagnóstico falhou:',error?.code??error?.name??'UNKNOWN');process.exitCode=1;});
}
