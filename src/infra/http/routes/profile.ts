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

                const { id } = req.body;

                if(!id){
                    return res.status(400).json({ error: "Field 'id' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.onWhatsapp(id);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/fetchStatus/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { remoteJid } = req.body;

                if(!remoteJid){
                    return res.status(400).json({ error: "Field 'remoteJid' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.fetchStatus(remoteJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/fetchProfilePicture/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { remoteJid } = req.body;

                if(!remoteJid){
                    return res.status(400).json({ error: "Field 'remoteJid' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.fetchProfilePicture(remoteJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/fetchBusinessProfile/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { remoteJid } = req.body;

                if(!remoteJid){
                    return res.status(400).json({ error: "Field 'remoteJid' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.fetchBusinessProfile(remoteJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .post("/presenceSubscribe/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { remoteJid } = req.body;

                if(!remoteJid){
                    return res.status(400).json({ error: "Field 'remoteJid' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.presenceSubscribe(remoteJid);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/profileName/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { name } = req.body;

                if(!name){
                    return res.status(400).json({ error: "Field 'name' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.profileName(name);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .patch("/profileStatus/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { status } = req.body;

                if(!status){
                    return res.status(400).json({ error: "Field 'status' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await profileController.profileStatus(status);

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
            .put("/profilePicture/:owner/:instanceName", async(req: Request, res: Response) => {

                const owner = req.params.owner;
                const instanceName = req.params.instanceName;

                if(!owner || !instanceName){
                    return res.status(400).json({ error: "Owner and instanceName are required." });
                }

                const { jid, url } = req.body;

                if(!jid){
                    return res.status(400).json({ error: "Fields 'jid', 'url' and 'active' is required." });
                }

                const profileController = new ProfileController(owner, instanceName);
                const result = await (url ? profileController.updateProfilePicture(jid, url) : profileController.removeProfilePicture(jid));

                if(result?.error){
                    return res.status(500).json(result);
                }else{
                    return res.status(200).json(result);
                }

            })
        return this.router;

    }

}