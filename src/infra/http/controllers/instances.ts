import Instance from "../../baileys/services";
import InstancesRepository from "../../../core/repositories/instances";
import { instances } from "../../../shared/constants";

export default class InstancesController {

    async create(owner: string, instanceName: string) {
        try {
            

            const key = `${owner}_${instanceName}`;
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
        } catch (err: any) {
            console.error("Error in Instance Creator", err);
            return {
                success: false,
                error: "Internal Error in Instance Creator.",
                details: err.message,
            };
        }
    }

    async get(owner: string | undefined) {

        try{

            return {
                success: true,
                data: (new InstancesRepository).list(owner)
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

