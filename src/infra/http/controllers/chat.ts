import { instances } from "../../../shared/constants";
import { MinimalMessage, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { StatusPresence } from "../../../shared/types";
import PrismaConnection from "../../../core/connection/prisma";

export default class ChatController {

    private sock: WASocket | undefined;
    private instance: string | undefined;

    constructor(owner: string, instanceName: string){
        const key = `${owner}_${instanceName}`;
        this.instance = key;
        this.sock = instances[key]?.getSock();
    }

    async rejectCall(callId: string, callFrom: string){

        if(!this.sock){
            return {
                success: false,
                error: "Instance not connected.",
            };
        }

        try{

            await this.sock.rejectCall(callId, callFrom);

            return {
                success: true,
                message: "Call rejected successfully.",
            };
            
        }catch(err){
            return {
                success: false,
                error: "Failed to reject call.",
            };
        }
        

    }

    async sendPresence(presence: StatusPresence, jid: string | undefined){
        
        try{

            this.sock?.sendPresenceUpdate(presence, jid);

            return {
                success: true,
                message: "Presence sent successfully.",
            };

        }catch(err){
            return {
                success: false,
                error: "Failed to send presence.",
            };
        }
        
    }

    async arquiveChat(jid: string, archive: boolean){

        if(!this.sock){
            return {
                success: false,
                error: "Instance not connected.",
            };
        }

        try{

            await this.sock.chatModify({ archive, lastMessages: [] }, jid);

            return {
                success: true,
                message: "Chat archive status changed successfully.",
            };

        }catch(err){
            return {
                success: false,
                error: "Failed to change chat archive status.",
            };
        }
    }

    async muteChat(remoteJid: string, mute: number){

        if(!this.sock){
            return {
                success: false,
                error: "Instance not connected.",
            };
        }
        try{

            const muteDuration = (mute > 0 ? (mute == 1 ? 86400000 : 604800000) : null);
            await this.sock.chatModify({ mute: muteDuration}, remoteJid);

            return {
                success: true,
                message: "Chat mute status changed successfully.",
            };

        }catch(err){

            return {
                success: false,
                error: "Failed to change chat mute status.",
            };
            
        }
    }

}