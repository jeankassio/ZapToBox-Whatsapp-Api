import { Router, type Request, type Response } from "express";
import InstancesController from "../controllers/instances.js";
import { requireScope } from "../../state/auth.js";
import { validateIdentity } from "../../../shared/identity.js";
import { RequestError } from "../controllers/base.js";
import { connectionTimestamp } from '../../../shared/instance-info.js';
import { historyRescan } from '../../history-rescan/index.js';
import type { HistoryRescanService } from '../../history-rescan/service.js';

const identity=(value:unknown,label:string) => {
  try {return validateIdentity(typeof value==='number' && Number.isSafeInteger(value) ? String(value) : value,label);}
  catch {throw new RequestError(400,'Invalid '+label);}
};
const idempotencyKey=(req:Request) => {
  const key=req.get('Idempotency-Key');
  if(!key)throw new RequestError(400,'Idempotency-Key is required.');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))throw new RequestError(400,'Idempotency-Key must be a UUID v4.');
  return key;
};
function allowed(req:Request,owner:string,name?:string):void {
  if(!requireScope(req,owner,name))throw new RequestError(403,'Token is not authorized for this instance.');
}
const handle=(action:(req:Request)=>Promise<unknown>,status=200)=>async(req:Request,res:Response)=>{
  try {res.status(status).json(await action(req));} catch(error) {
    res.status(error instanceof RequestError ? error.statusCode : 500).json({success:false,error:error instanceof RequestError?error.message:'Unable to process instance request.',...(error instanceof RequestError && error.code ? {code:error.code} : {})});
  }
};
export default class InstanceRoutes {
  constructor(private readonly history: Pick<HistoryRescanService, 'request' | 'status'> = historyRescan) {}
  get() {
    const router=Router();const controller=new InstancesController();
    router.post('/create',handle(async req=>{
      idempotencyKey(req);
      const owner=identity(req.body?.owner,'owner'),name=identity(req.body?.instanceName,'instanceName');
      allowed(req,owner,name);
      const phone=req.body?.phoneNumber;
      if(phone!==undefined && (typeof phone!=='string' || !/^[1-9][0-9]{6,14}$/.test(phone))) throw new RequestError(400,'phoneNumber must contain country code and digits only.');
      return controller.create(owner,name,phone);
    }));
    router.get('/status/:owner/:instanceName',handle(async req=>{
      const owner=identity(req.params.owner,'owner'),name=identity(req.params.instanceName,'instanceName');
      allowed(req,owner,name);
      const data=await controller.find(owner,name);
      return {success:true,exists:data!==null,data,observedAt:connectionTimestamp()};
    }));
    router.get('/get',handle(async req=>{
      const owner=req.query.owner!==undefined?identity(req.query.owner,'owner'):req.auth?.owner;
      if(owner)allowed(req,owner,req.auth?.instanceName);
      if(!owner && !req.auth?.admin)throw new RequestError(403,'Owner is required.');
      const result=await controller.get(owner);
      if(req.auth?.instanceName)result.data=result.data.filter(row=>row.instanceName===req.auth?.instanceName);
      return result;
    }));
    const connect=handle(async req=>{
      const owner=identity(req.params.owner,'owner'),name=identity(req.params.instanceName,'instanceName');
      allowed(req,owner,name);return controller.connect(owner,name);
    });
    router.get('/connect/:owner/:instanceName',connect);
    router.post('/connect/:owner/:instanceName',connect);
    router.post('/disconnect/:owner/:instanceName',handle(async req=>{
      const owner=identity(req.params.owner,'owner'),name=identity(req.params.instanceName,'instanceName');
      allowed(req,owner,name);return controller.disconnect(owner,name);
    }));
    router.post('/history-rescan/:owner/:instanceName',handle(async req=>{
      const owner=identity(req.params.owner,'owner'),name=identity(req.params.instanceName,'instanceName');
      allowed(req,owner,name);
      return {success:true,data:await this.history.request(owner,name,idempotencyKey(req))};
    },202));
    router.get('/history-rescan/:owner/:instanceName/:jobId',handle(async req=>{
      const owner=identity(req.params.owner,'owner'),name=identity(req.params.instanceName,'instanceName');
      allowed(req,owner,name);
      return {success:true,data:await this.history.status(owner,name,String(req.params.jobId))};
    }));
    router.delete('/delete/:owner/:instanceName',handle(async req=>{
      const owner=identity(req.params.owner,'owner'),name=identity(req.params.instanceName,'instanceName');
      allowed(req,owner,name);return controller.delete(owner,name);
    }));
    return router;
  }
}
