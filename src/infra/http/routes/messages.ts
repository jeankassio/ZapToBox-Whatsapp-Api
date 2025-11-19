import express, { Request, Response } from "express";
import MessagesController from "../controllers/messages";
import { WAMessageKey } from "@whiskeysockets/baileys";

export default class MessageRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .post("/send/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, messageOptions } = req.body;

                if(!owner || !instanceName || !jid || !messageOptions){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'messageOptions' is required." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessage(messageOptions);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/readMessage/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { messageId, remoteJid, participant, isViewOnce } = req.body;

                const key: WAMessageKey = {
                    id: messageId,
                    remoteJid: remoteJid,
                    participant: participant,
                    isViewOnce: isViewOnce || false
                };

                const messagesController = new MessagesController(owner, instanceName, remoteJid, 0);

                const result = await messagesController.readMessage(key);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .delete("/deleteMessage/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName
                
                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { messageId, remoteJid, forEveryone } = req.body;
                
                if(!messageId || !remoteJid || !forEveryone){
                    return res.status(400).json({ error: "messageId, remoteJid and forEveryone are required." });
                }

                const key: WAMessageKey = {
                    id: messageId,
                    remoteJid: remoteJid
                };

                const messagesController = new MessagesController(owner, instanceName, remoteJid, 0);
                const result = await messagesController.deleteMessage(key, forEveryone || false);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/unstar/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName
                
                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { messageId, remoteJid, star } = req.body;

                if(!messageId || !remoteJid || !star){
                    return res.status(400).json({ error: "messageId, remoteJid and star are required." });
                }

                const messagesController = new MessagesController(owner, instanceName, remoteJid, 0);
                const result = await messagesController.unStar(messageId, remoteJid, star);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
        return this.router;

    }

}