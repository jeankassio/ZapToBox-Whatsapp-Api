import Instance from "../../baileys/services.js";
import InstancesRepository from "../../../core/repositories/instances.js";
import PrismaConnection, { prisma } from "../../../core/connection/prisma.js";
import { instances, instanceConnection, instanceStatus, sessionsPath } from "../../../shared/constants.js";
import { instanceKey } from "../../../shared/identity.js";
import { safeSessionDirectory } from "../../state/auth-state.js";
import { removeInstancePath, trySendWebhook } from "../../../shared/utils.js";
import { RequestError } from "./base.js";

const lifecycle = new Map<string,Promise<unknown>>();
async function exclusive<T>(key:string,action:()=>Promise<T>):Promise<T> {
  const pending=(lifecycle.get(key) ?? Promise.resolve()).catch(()=>{}).then(action);
  lifecycle.set(key,pending);
  try {return await pending;} finally {if(lifecycle.get(key)===pending)lifecycle.delete(key);}
}

export default class InstancesController {
  async create(owner:string,instanceName:string,phoneNumber?:string) {
    return exclusive(instanceKey(owner,instanceName),()=>this.createUnlocked(owner,instanceName,phoneNumber));
  }
  private async createUnlocked(owner:string,instanceName:string,phoneNumber?:string) {
    const key=instanceKey(owner,instanceName);
    if(instances[key]) throw new RequestError(409,'Instance already exists. Use connect to reconnect.');
    const instance=new Instance();
    instances[key]=instance;
    try {return {success:true,...await instance.create({owner,instanceName,phoneNumber})};}
    catch(error) {await instance.shutdown();delete instances[key];throw error;}
  }
  async connect(owner:string,instanceName:string) {
    const key=instanceKey(owner,instanceName);
    return exclusive(key,async()=>{
      const instance=instances[key];
      if(instance) return {success:true,...await instance.reconnect()};
      return this.createUnlocked(owner,instanceName);
    });
  }
  async delete(owner:string,instanceName:string) {
    const key=instanceKey(owner,instanceName);
    return exclusive(key,async()=>{
    const instance=instances[key];
    if(instance) await instance.clearInstance();
    else {
      const directory=await safeSessionDirectory(sessionsPath,owner,instanceName).catch(error=>{
        if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;
        throw error;
      });
      await PrismaConnection.deleteByInstance(key);
      await prisma.authState.deleteMany({where:{instance:key}});
      if(directory)await removeInstancePath(directory);
      delete instanceConnection[key];instanceStatus.set(key,'REMOVED');
      await trySendWebhook('connection.removed',{owner,instanceName,connectionStatus:'REMOVED'},{});
    }
    return {success:true,message:'Instance removed successfully'};
    });
  }
  async get(owner?:string) {return {success:true,data:await new InstancesRepository().list(owner)};}
}
