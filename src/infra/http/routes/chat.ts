import express, { Request, Response } from "express";
import ChatController from "../controllers/chat";

export default class ChatRoutes{

    private router = express.Router();
   
    get(){
        
        this.router
            .post("/rejectCall/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const { callId, callFrom} = req.body;

                if(!callId || !callFrom){
                    return res.status(400).json({
                         error: "callId and callFrom are required"
                    });
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.rejectCall(callId, callFrom);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendPresence/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }  

                const { presence, remoteJid} = req.body;

                if(!presence){
                    return res.status(400).json({
                         error: "presence is required"
                    });
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.sendPresence(presence, remoteJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }
            })
            .post("/archiveChat/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const { remoteJid, archive } = req.body;

                if(!remoteJid || !archive){
                    return res.status(400).json({
                         error: "jid and archive are required"
                    });
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.arquiveChat(remoteJid, archive);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("muteChat/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName

                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const { remoteJid, mute } = req.body;
                
                if(!remoteJid || !mute){
                    return res.status(400).json({
                         error: "jid, mute and until are required"
                    });
                }
                
                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.muteChat(remoteJid, mute);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            });
        return this.router;

    }

}