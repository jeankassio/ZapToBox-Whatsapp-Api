import { Request, Response } from "express";
import { createInstance } from "../services/baileysService";
import { listInstances } from "../repositories/instanceRepository";

export async function createInstanceController(req: Request, res: Response) {
    try {
        const { owner, instanceName } = req.body;

        if (!owner || !instanceName) {
            return res.status(400).json({ error: "Campos 'owner' e 'instanceName' são obrigatórios." });
        }

        const instance = await createInstance({ owner, instanceName });

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

export async function getInstanceList(req: Request, res: Response){

    try{

        const owner = req.query?.owner?.toString().trim();

        const response = {
            success: true,
            message: "Get Instances Successfully",
            data: listInstances(owner)
        };

        res.json(response);

    }catch(err: any){
        console.error("Erro ao listar instâncias:", err);
        return res.status(500).json({
            success: false,
            error: "Erro interno ao listar instâncias.",
            details: err.message,
        });
    }

}