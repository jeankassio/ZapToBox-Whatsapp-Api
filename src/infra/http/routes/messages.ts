import express, { Request, Response } from "express";
import MessagesController from "../controllers/messages";
import { WAMessageKey } from "@whiskeysockets/baileys";
import { isAudioMessage, isContactMessage, isDocumentMessage, isGifMessage, isImageMessage, isLocationMessage, isPollMessage, isReactionMessage, isStickerMessage, isTextMessage, isVideoMessage } from "../../../shared/guards";

export default class MessageRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .post("/sendText/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isTextMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageText(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendLocation/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isLocationMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageLocation(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendContact/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isContactMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageContact(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendReaction/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isReactionMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageReaction(message);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendPoll/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isPollMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessagePoll(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendImage/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isImageMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageImage(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendVideo/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isVideoMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageVideo(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendGif/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isGifMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageGif(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendAudio/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isAudioMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageAudio(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/sendDocument/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isDocumentMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageDocument(message, options);
                
                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            
            .post("/sendSticker/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, delay, message, options } = req.body;

                if(!owner || !instanceName || !jid || !message){
                    return res.status(400).json({ error: "Fields 'owner', 'instanceName', 'jid' and 'message' is required." });
                }else if(!isStickerMessage(message)){
                    return res.status(400).json({ error: "Invalid message format." });
                }

                const messagesController = new MessagesController(owner, instanceName, jid, delay || 0);
                const result = await messagesController.sendMessageSticker(message, options);
                
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