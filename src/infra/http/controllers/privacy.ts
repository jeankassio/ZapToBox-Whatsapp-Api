import { instances } from "../../../shared/constants";
import {  WAMessage, WAPrivacyGroupAddValue, WAPrivacyOnlineValue, WAPrivacyValue, WAReadReceiptsValue, WASocket } from "@whiskeysockets/baileys";
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

    async unBlockUser(remoteJid: string, block: boolean){

        try{

            const action: "block" | "unblock" = (block ? 'block' : 'unblock');

            await this.sock?.updateBlockStatus(remoteJid, action);

            return {
                success: true,
                message: "Block status of user changed with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error change block status of user"
            };

        }

    }

    async getPrivacySettings(){

        try{

            const privacy = await this.sock?.fetchPrivacySettings();

            return {
                success: true,
                message: "Get privacy settings with success",
                data: {
                    privacy
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error getting privacy settings"
            };

        }

    }
    
    async getBlockList(){

        try{

            const privacy = await this.sock?.fetchBlocklist();

            return {
                success: true,
                message: "Get block list with success",
                data: {
                    privacy
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error getting block list"
            };

        }

    }
    
    async updateLastSeen(privacy: WAPrivacyValue){

        try{

            await this.sock?.updateLastSeenPrivacy(privacy);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }

    async updateOnline(privacy: WAPrivacyOnlineValue){

        try{

            await this.sock?.updateOnlinePrivacy(privacy);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }
    
    async profilePicture(privacy: WAPrivacyValue){

        try{

            await this.sock?.updateProfilePicturePrivacy(privacy);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }
    
    async status(privacy: WAPrivacyValue){

        try{

            await this.sock?.updateStatusPrivacy(privacy);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }
    
    async markRead(privacy: WAReadReceiptsValue){

        try{

            await this.sock?.updateReadReceiptsPrivacy(privacy);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }
    
    async addGroups(privacy: WAPrivacyGroupAddValue){

        try{

            await this.sock?.updateGroupsAddPrivacy(privacy);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }
    
    async ephemeral(time: number){

        try{

            await this.sock?.updateDefaultDisappearingMode(time);

            return {
                success: true,
                message: "Set privacy last seen with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error setting privacy last seen"
            };

        }

    }
    
    
}