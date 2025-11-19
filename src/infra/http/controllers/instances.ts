import Instance from "../../baileys/services";
import InstancesRepository from "../../../core/repositories/instances";
import { instances, instanceStatus, sessionsPath } from "../../../shared/constants";
import { clearInstanceWebhooks, removeInstancePath } from "../../../shared/utils";
import path from "path";

export default class InstancesController {

    async create(owner: string, instanceName: string) {
        try {
            
            const key = `${owner}_${instanceName}`;

            if(typeof instances[key] === 'undefined'){

                instances[key] = new Instance;

                const instance = await instances[key].create({ owner, instanceName });

                return {
                    success: true,
                    message: "Instance Created with Successfully!",
                    instance: {
                        owner: instance.owner,
                        instanceName: instance.instanceName,
                        connectionStatus: instance.connectionStatus,
                        profilePictureUrl: instance.profilePictureUrl || null,
                    }
                };

            }else{

                return {
                    success: false,
                    error: "Instance with this owner exists.",
                };

            }

            
        } catch (err: any) {
            console.error("Error in Instance Creator", err);
            return {
                success: false,
                error: "Internal Error in Instance Creator.",
                details: err.message,
            };
        }
    }

    async connect(owner: string, instanceName: string){

        try{

            const key = `${owner}_${instanceName}`;

            const status = instanceStatus.get(key);

            if(!status){
                return {
                    success: false,
                    error: "Error on get instance status",
                };
            }else if(status === "ONLINE"){
                return {
                    success: false,
                    error: "Instance is already connected",
                };
            }

            await clearInstanceWebhooks(key);
            const instancePath = path.join(sessionsPath, owner, instanceName);
            await removeInstancePath(instancePath);

            return this.create(owner, instanceName);

        }catch(err: any){
            console.error("Error on connect instance:", err);
            return {
                success: false,
                error: err.message,
            };
        }

    }

    async delete(owner: string, instanceName: string){

        try{

            const key = `${owner}_${instanceName}`;
            const instanceRemove = instances[key];

            instanceRemove?.clearInstance();

            return {
                success: true,
                message: "Instance removed with success"
            }

        }catch(err: any){
            console.error("Error on connect instance:", err);
            return {
                success: false,
                error: err.message,
            };
        }

    }

    async get(owner: string | undefined) {

        try{
            
            const repo = await (new InstancesRepository).list(owner);

            return {
                success: true,
                data: repo
            };

        }catch(err: any){
            console.error("Error in List Instances:", err);
            return {
                success: false,
                error: err.message,
            };
        }

    }

}

