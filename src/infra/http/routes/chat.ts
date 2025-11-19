import express, { Request, Response } from "express";
import ChatController from "../controllers/chat";

export default class ChatRoutes{

    private router = express.Router();
   
    get(){
        
        this.router
            .patch("/rejectCall/:owner/:instanceName", async (req: Request, res: Response) => {

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
            .patch("/archiveChat/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const { remoteJid, archive } = req.body;

                if(!remoteJid || typeof archive === 'undefined'){
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
            .patch("/mute/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName

                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const { remoteJid, mute } = req.body;
                
                if(!remoteJid || typeof mute === 'undefined'){
                    return res.status(400).json({
                         error: "Parameters jid and mute are required"
                    });
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.muteChat(remoteJid, mute);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/markChatAsRead/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;
                
                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const { remoteJid, markAsRead } = req.body;

                if(!remoteJid || typeof markAsRead === 'undefined'){
                    return res.status(400).json({error: "remoteJid is required"});
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.markChatAsRead(remoteJid, markAsRead);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .delete("/deleteChat/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;
                
                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const {remoteJid} = req.body;

                if(!remoteJid){
                    return res.status(400).json({
                         error: "messageId is required"
                    });
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.deleteChat(remoteJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/unpin/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;
                
                if(!owner || !instanceName){
                    return res.status(400).json({
                         error: "Owner and instanceName are required"
                    });
                }

                const {remoteJid, pin} = req.body;

                if(!remoteJid || typeof pin === 'undefined'){
                    return res.status(400).json({
                         error: "messageId and pin is required"
                    });
                }

                const chatController = new ChatController(owner, instanceName);
                const result = await chatController.pinChat(remoteJid, pin);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
        return this.router;

    }

}