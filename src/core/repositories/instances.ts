import { promises as fs } from "node:fs";
import path from "node:path";
import type { InstanceInfo } from "../../shared/types.js";
import { instanceConnection, sessionsPath } from "../../shared/constants.js";
import { instanceKey, validateIdentity } from "../../shared/identity.js";
import UserConfig from "../../infra/config/env.js";
import { listDatabaseSessions, safeSessionDirectory } from "../../infra/state/auth-state.js";

export default class InstancesRepository {
  async list(ownerFilter?:string): Promise<InstanceInfo[]> {
    if(ownerFilter !== undefined) validateIdentity(ownerFilter,'owner');
    const known = new Map<string,{owner:string;instanceName:string}>();
    if(UserConfig.authStore==='database') for(const pair of await listDatabaseSessions()) known.set(instanceKey(pair.owner,pair.instanceName),pair);
    for(const owner of await this.getOwnersPath(sessionsPath)) {
      if(ownerFilter && owner!==ownerFilter)continue;
      for(const instanceName of await this.getOwnersPath(path.join(sessionsPath,owner))) {
        try { await safeSessionDirectory(sessionsPath,owner,instanceName); known.set(instanceKey(owner,instanceName),{owner,instanceName}); } catch { /* Invalid legacy paths are never traversed. */ }
      }
    }
    for(const item of Object.values(instanceConnection)) known.set(instanceKey(item.owner,item.instanceName),item);
    return [...known].filter(([,pair])=>!ownerFilter || pair.owner===ownerFilter).map(([key,pair])=>{
      const loaded=instanceConnection[key];
      return {...pair,connectionStatus:loaded?.connectionStatus ?? 'OFFLINE',profilePictureUrl:loaded?.profilePictureUrl,instanceJid:loaded?.instanceJid ?? null};
    });
  }
  async getOwnersPath(directory:string): Promise<string[]> {
    try {return (await fs.readdir(directory,{withFileTypes:true})).filter(item=>{
      if(!item.isDirectory() || item.isSymbolicLink())return false;
      try {validateIdentity(item.name);return true;}catch{return false;}
    }).map(item=>item.name);} catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}
  }
}
