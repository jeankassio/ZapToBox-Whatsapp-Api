import express, { Request, Response } from "express";
import MessagesController from "../controllers/messages";

export default class MessageRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .post("/send", (req: Request, res: Response) => {

                const { owner, instanceName, jid, delay, messageOptions } = req.body;

                if(!owner || !instanceName || !jid || !messageOptions){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' e 'messageOptions' is required." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                messagesController.sendMessage(messageOptions);
                return res.json({
                     success: true, 
                     message: "Message Sent Successfully!" 
                });

            })
        return this.router;

    }

}