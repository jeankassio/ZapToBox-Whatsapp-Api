import express, { Request, Response } from "express";
import PrivacyController from "../controllers/privacy";

export default class PrivacyRoutes{

    private router = express.Router();

    get(){
        
        this.router
            .patch("/unblock/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { remoteJid, block } = req.body;

                if(!remoteJid || !block){
                    return res.status(400).json({ error: "Fields 'remoteJid' and 'block' is required." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.unBlockUser(remoteJid, block);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .get("/privacySettings/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.getPrivacySettings();

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .get("/blockList/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.getBlockList();

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/lastSeen/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { privacy } = req.body;

                if(!privacy){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['all', 'contacts', 'contact_blacklist', 'none'].includes(privacy)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.updateLastSeen(privacy);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/online/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { privacy } = req.body;

                if(!privacy){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['all', 'match_last_seen'].includes(privacy)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.updateOnline(privacy);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/picture/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { privacy } = req.body;

                if(!privacy){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['all', 'contacts', 'contact_blacklist', 'none'].includes(privacy)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.profilePicture(privacy);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/status/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { privacy } = req.body;

                if(!privacy){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['all', 'contacts', 'contact_blacklist', 'none'].includes(privacy)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.status(privacy);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/read/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { privacy } = req.body;

                if(!privacy){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['all', 'none'].includes(privacy)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.markRead(privacy);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/addGroups/:owner/:instanceName", async (req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { privacy } = req.body;

                if(!privacy){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['all', 'contacts', 'contact_blacklist'].includes(privacy)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.addGroups(privacy);

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

                const { ephemeral } = req.body;

                if(!ephemeral){
                    return res.status(400).json({ error: "Field 'privacy' is required." });
                }else if(!['0', '24h', '7d', '90d'].includes(ephemeral)){
                    return res.status(400).json({ error: "Field 'privacy' is invalid." });
                }

                let time: number = 0;

                switch(ephemeral){
                    case '24h':{
                            time = 86400;
                        break;
                    }
                    case '7d':{
                            time = 604800;
                        break;
                    }
                    case '90d':{
                            time = 7776000;
                        break;
                    }
                    
                }

                const privController = new PrivacyController(owner, instanceName);
                const result = await privController.ephemeral(time);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
        return this.router;

    }

}