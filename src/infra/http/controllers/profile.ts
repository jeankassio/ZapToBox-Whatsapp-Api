import { instances } from "../../../shared/constants";
import {  WAMessage, WASocket } from "@whiskeysockets/baileys";
import { StatusPresence } from "../../../shared/types";
import PrismaConnection from "../../../core/connection/prisma";

export default class ProfileController {

    private sock: WASocket | undefined;
    private instance: string | undefined;

    constructor(owner: string, instanceName: string){
        const key = `${owner}_${instanceName}`;
        this.instance = key;
        this.sock = instances[key]?.getSock();
    }

    async onWhatsapp(remoteJid: string){

        try{

            const contact = await PrismaConnection.getContactById(this.instance!, remoteJid);

            if(contact){

                return {
                    success: true,
                    message: "Contact exists on Whatsapp",
                    data: contact
                };

            }else{

                const results = await this.sock?.onWhatsApp(remoteJid);

                if (results && results.length > 0 && results[0]?.exists) {
                    
                    const result = results[0];
                    
                    return {
                        success: true,
                        message: "Contact exists on Whatsapp",
                        data: {
                            id: result?.jid
                        }
                    };

                }else{
                    return {
                        success: false,
                        error: "Contact dont exists on Whatsapp"
                    };
                }

            }

        }catch(err){

            return {
                success: false,
                error: "Error checking number exists on Whatsapp"
            };

        }

    }

    async fetchStatus(remoteJid: string){

        try{

            const status = await this.sock?.fetchStatus(remoteJid);

            return {
                success: true,
                message: "Status fetched",
                data: {
                    status
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error fetching status"
            };

        }
        
    }
    
    async fetchProfilePicture(remoteJid: string){

        try{

            const status = await this.sock?.profilePictureUrl(remoteJid, 'image');

            return {
                success: true,
                message: "Successfully",
                data: {
                    status
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error fetching profile picture"
            };

        }
        
    }
    
    async fetchBusinessProfile(remoteJid: string){

        try{

            const profile = await this.sock?.getBusinessProfile(remoteJid);

            return {
                success: true,
                message: "Successfully",
                data: {
                    profile
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error fetching profile Business"
            };

        }
        
    }
    
    async presenceSubscribe(remoteJid: string){

        try{

            await this.sock?.presenceSubscribe(remoteJid);

            return {
                success: true,
                message: "Successfully"
            };

        }catch(err){

            return {
                success: false,
                error: "Error subscribe presence"
            };

        }
        
    }
    
    async profileName(name: string){

        try{

            await this.sock?.updateProfileName(name);

            return {
                success: true,
                message: `Successfully, your new name is '${name}'`
            };

        }catch(err){

            return {
                success: false,
                error: "Error changing name"
            };

        }
        
    }
    
    async profileStatus(status: string){

        try{

            await this.sock?.updateProfileStatus(status);

            return {
                success: true,
                message: `Successfully, your new status is '${status}'`
            };

        }catch(err){

            return {
                success: false,
                error: "Error changing status"
            };

        }
        
    }
    
    async updateProfilePicture(remoteJid: string, url: string){

        try{

            await this.sock?.updateProfilePicture(remoteJid, {url});

            return {
                success: true,
                message: `Successfully`
            };

        }catch(err){

            return {
                success: false,
                error: "Error changing profile picture"
            };

        }
        
    }
    
    async removeProfilePicture(remoteJid: string){

        try{

            await this.sock?.removeProfilePicture(remoteJid);

            return {
                success: true,
                message: `Successfully`
            };

        }catch(err){

            return {
                success: false,
                error: "Error removing profile picture"
            };

        }
        
    }
    
}