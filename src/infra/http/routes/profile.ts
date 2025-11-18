import express, { Request, Response } from "express";
import ProfileController from "../controllers/profile";

export default class ProfileRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .post("/onWhatsapp/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { id} = req.body;

                if(!id){
                    return res.status(400).json({ error: "Field 'id' is required." });
                }

                const mediaController = new ProfileController(owner, instanceName);
                const result = await mediaController.onWhatsapp(id);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
        return this.router;

    }

}