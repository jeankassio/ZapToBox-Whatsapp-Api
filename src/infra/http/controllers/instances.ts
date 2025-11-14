import { Request, Response } from "express";
import Instance from "../../baileys/services";
import InstancesRepository from "../../../core/repositories/instances";
import { instances } from "../../../shared/constants";

export default class InstancesController {

    async create(req: Request, res: Response) {
        try {
            const { owner, instanceName } = req.body;

            if (!owner || !instanceName) {
                return res.status(400).json({ error: "Fields 'owner' and 'instanceName' is required" });
            }

            const key = `${owner}_${instanceName}`;
            instances[key] = new Instance;

            const instance = await instances[key].create({ owner, instanceName });

            return res.json({
                success: true,
                message: "Instance Created with Successfully!",
                instance: {
                    owner: instance.owner,
                    instanceName: instance.instanceName,
                    connectionStatus: instance.connectionStatus,
                    profilePictureUrl: instance.profilePictureUrl || null,
                },
            });
        } catch (err: any) {
            console.error("Error in Instance Creator", err);
            return res.status(500).json({
                success: false,
                error: "Internal Error in Instance Creator.",
                details: err.message,
            });
        }
    }

    async get(req: Request, res: Response){

        try{

            const owner = req.query?.owner?.toString().trim();

            res.json({
                success: true,
                data: (new InstancesRepository).list(owner)
            });

        }catch(err: any){
            console.error("Error in List Instances:", err);
            return res.status(500).json({
                success: false,
                details: err.message,
            });
        }

    }

}

