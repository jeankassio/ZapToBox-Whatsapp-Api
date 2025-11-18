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
                messagesController.sendMessage(messageOptions);
                return res.json({
                     success: true, 
                     message: "Message Sent Successfully!" 
                });

            })
            .post("/readMessage/:owner/:instanceName", async (req: Request, res: Response) => {

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

                await messagesController.readMessage(key);

                return res.json({
                     success: true, 
                     message: "Message Read Successfully!" 
                });

            })
        return this.router;

    }

}