import express, { Request, Response } from "express";
import GroupController from "../controllers/group";
import { ParticipantAction } from "@whiskeysockets/baileys";


export default class GroupRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .post("/create/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupName, participants } = req.body;

                if(!groupName || !groupName){
                    return res.status(400).json({ error: "Field 'id' is required." });
                }else if(!Array.isArray(participants) || participants.length < 2){
                    return res.status(400).json({ error: "Minimum of 2 participants required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.create(groupName, participants);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/participantsUpdate/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, participants, method } = req.body;

                if(!groupJid || !method || !participants){
                    return res.status(400).json({ error: "Fields 'groupJid', 'method', 'participants' is required." });
                }else if(!Array.isArray(participants) || participants.length < 1){
                    return res.status(400).json({ error: "Minimum of 1 participant required." });
                }else if(!['add', 'remove', 'demote', 'promote'].includes(method)){
                    return res.status(400).json({ error: "Invalid participant action method." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.participantsUpdate(groupJid, participants, method);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/subject/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, subject } = req.body;

                if(!groupJid || !subject){
                    return res.status(400).json({ error: "Fields 'groupJid' and 'subject' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.updateSubject(groupJid, subject);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/description/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, description } = req.body;

                if(!groupJid || !description){
                    return res.status(400).json({ error: "Fields 'groupJid' and 'description' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.updateDescription(groupJid, description);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/setting/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, setting } = req.body;

                if(!groupJid || !setting){
                    return res.status(400).json({ error: "Fields 'groupJid' and 'setting' is required." });
                }else if(!["announcement", "not_announcement", "locked", "unlocked"].includes(setting)){
                    return res.status(400).json({ error: "Invalid setting option" });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.updateSetting(groupJid, setting);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/leave/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid } = req.body;

                if(!groupJid){
                    return res.status(400).json({ error: "Field 'groupJid' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.leave(groupJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/getInviteCode/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid } = req.body;

                if(!groupJid){
                    return res.status(400).json({ error: "Field 'groupJid' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.getInviteCode(groupJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/revokeInviteCode/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid } = req.body;

                if(!groupJid){
                    return res.status(400).json({ error: "Field 'groupJid' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.revokeInviteCode(groupJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/join/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { code } = req.body;

                if(!code){
                    return res.status(400).json({ error: "Field 'code' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.join(code);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/joinByInviteMessage/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, messageId } = req.body;

                if(!messageId || !groupJid){
                    return res.status(400).json({ error: "Fields 'messageId' and 'groupJid' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.joinByInviteMessage(groupJid, messageId);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/infoByCode/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { code } = req.body;

                if(!code){
                    return res.status(400).json({ error: "Field 'code' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.getInfoByCode(code);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/metadata/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid } = req.body;

                if(!groupJid){
                    return res.status(400).json({ error: "Field 'groupJid' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.queryMetadata(groupJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/participantsList/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid } = req.body;

                if(!groupJid){
                    return res.status(400).json({ error: "Field 'groupJid' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.participantsList(groupJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .get("/allParticipantsGroups/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.fetchAllParticipants();

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/requestParticipants/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, participants, action } = req.body;

                if(!groupJid || !participants || !action){
                    return res.status(400).json({ error: "Fields 'groupJid', 'action' and 'participants' is required." });
                }else if(!['approve', 'reject'].includes(action)){
                    return res.status(400).json({ error: "Invalid action value" });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.requestParticipants(groupJid, participants, action);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/expirationMessage/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, time } = req.body;

                if(!groupJid || !time){
                    return res.status(400).json({ error: "Fields 'groupJid' and 'time' is required." });
                }else if(!['0', '24h', '7d', '90d'].includes(time)){
                    return res.status(400).json({ error: "Invalid action value" });
                }

                let ephemeralTime;

                switch(time){
                    case '24h':{
                            ephemeralTime = 86400;
                        break;
                    }
                    case '7d':{
                            ephemeralTime = 604800;
                        break;
                    }
                    case '90d':{
                            ephemeralTime = 7776000;
                        break;
                    }
                    default:{
                        ephemeralTime = 0;
                    }
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.ephemeralMessages(groupJid, ephemeralTime);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/addMode/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { groupJid, onlyAdmin } = req.body;

                if(!groupJid || !onlyAdmin){
                    return res.status(400).json({ error: "Fields 'groupJid' and 'onlyAdmin' is required." });
                }

                const groupController = new GroupController(owner, instanceName);
                const result = await groupController.addMode(groupJid, onlyAdmin);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
        return this.router;

    }

}