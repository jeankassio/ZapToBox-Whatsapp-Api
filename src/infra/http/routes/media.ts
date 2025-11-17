import express, { Request, Response } from "express";
import MediaController from "../controllers/media";

export default class MediaRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .post("/download", async (req: Request, res: Response) => {

                const { owner, instanceName, messageId, isBase64} = req.body;

                if(!owner || !instanceName || !messageId){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'messageId' is required." });
                }

                const mediaController = new MediaController(owner, instanceName);
                const result = await mediaController.getMedia(messageId, isBase64);

                if(!result?.success || result?.base64){
                    return res.json(result);
                }else{
                    res.setHeader("Content-Type", result.mimeType);
                    res.send(result.buffer);
                }

            })
        return this.router;

    }

}