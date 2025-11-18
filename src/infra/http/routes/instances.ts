import express, { Request, Response } from "express";
import InstancesController from "../controllers/instances";

export default class InstanceRoutes{

    private router = express.Router();

    get(){
        
        const instancesController = new InstancesController();

        this.router
            .post("/create", async (req: Request, res: Response) => {

                const { owner, instanceName } = req.body;
                
                if (!owner || !instanceName) {
                    return res.status(400).json({ error: "Fields 'owner' and 'instanceName' is required" });
                }

                const result = await instancesController.create(owner, instanceName);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .get("/get", async (req: Request, res: Response) => {

                const owner = req.query?.owner?.toString().trim();

                const result = await instancesController.get(owner);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            });

        return this.router;

    }

}