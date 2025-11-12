import { Request, Response } from "express";
import Instance from "../../baileys/services";
import InstancesRepository from "../../../core/whatsapp/repositories/instances";
import { instances } from "../../../shared/constants";

export default class InstancesController {

    async create(req: Request, res: Response) {
        try {
            const { owner, instanceName } = req.body;

            if (!owner || !instanceName) {
                return res.status(400).json({ error: "Campos 'owner' e 'instanceName' são obrigatórios." });
            }

            const key = `${owner}_${instanceName}`;
            instances[key] = new Instance;

            const instance = await instances[key].create({ owner, instanceName });

            return res.json({
                success: true,
                message: "Instância criada com sucesso!",
                instance: {
                    owner: instance.owner,
                    instanceName: instance.instanceName,
                    connectionStatus: instance.connectionStatus,
                    profilePictureUrl: instance.profilePictureUrl || null,
                },
            });
        } catch (err: any) {
            console.error("Erro ao criar instância:", err);
            return res.status(500).json({
                success: false,
                error: "Erro interno ao criar instância.",
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
            console.error("Erro ao listar instâncias:", err);
            return res.status(500).json({
                success: false,
                details: err.message,
            });
        }

    }

}

