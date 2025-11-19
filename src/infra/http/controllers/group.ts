import { instances } from "../../../shared/constants";
import { ParticipantAction, proto, WASocket } from "@whiskeysockets/baileys";
import PrismaConnection from "../../../core/connection/prisma";

export default class GroupController {

    private sock: WASocket | undefined;
    private instance: string | undefined;

    constructor(owner: string, instanceName: string){
        const key = `${owner}_${instanceName}`;
        this.instance = key;
        this.sock = instances[key]?.getSock();
    }

    async create(groupName: string, participants: string[]){

        try{

            const group = await this.sock?.groupCreate(groupName, participants);

            return {
                success: true,
                message: "Group created success",
                data: group
            };

        }catch(err){

            return {
                success: false,
                error: "Error creating group"
            };

        }

    }

    async participantsUpdate(remoteJid: string, participants: string[], method: ParticipantAction){

        try{

            await this.sock?.groupParticipantsUpdate(remoteJid, participants, method);

            return {
                success: true,
                message: "Participants status in group changed with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error on change status group"
            };

        }

    }
    
    async updateSubject(remoteJid: string, subject: string){

        try{

            await this.sock?.groupUpdateSubject(remoteJid, subject);

            return {
                success: true,
                message: "Group subject changed with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error on change group subject"
            };

        }

    }
    
    async updateDescription(remoteJid: string, description: string){

        try{

            await this.sock?.groupUpdateDescription(remoteJid, description);

            return {
                success: true,
                message: "Group description changed with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error on change group description"
            };

        }

    }
    
    async updateSetting(remoteJid: string, setting: "announcement" | "not_announcement" | "locked" | "unlocked"){

        try{

            await this.sock?.groupSettingUpdate(remoteJid, setting);

            return {
                success: true,
                message: "Group subject changed with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error on change subject group"
            };

        }

    }
    
    async leave(remoteJid: string){

        try{

            await this.sock?.groupLeave(remoteJid);

            return {
                success: true,
                message: "Leave group with success"
            };

        }catch(err){

            return {
                success: false,
                error: "Error on leave group"
            };

        }

    }
    
    async getInviteCode(remoteJid: string){

        try{

            const code = await this.sock?.groupInviteCode(remoteJid);

            return {
                success: true,
                message: "Get invite code with success",
                data: {
                    code,
                    link: "https://chat.whatsapp.com/" + code
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in get invite code"
            };

        }

    }
    
    async revokeInviteCode(remoteJid: string){

        try{

            const code = await this.sock?.groupRevokeInvite(remoteJid);

            return {
                success: true,
                message: "Revoke invite code with success",
                data: {
                    code,
                    link: "https://chat.whatsapp.com/" + code
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in revoke invite code"
            };

        }

    }
    
    async join(code: string){

        try{

            const response = await this.sock?.groupAcceptInvite(code.replace("https://chat.whatsapp.com/", ""));

            return {
                success: true,
                message: "Join with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in join group"
            };

        }

    }
    
    async joinByInviteMessage(groupJid: string, messageId: string){

        try{

            const messageInvite = await PrismaConnection.getMessageById(messageId) as proto.Message.IGroupInviteMessage;

            if(!messageInvite){
                return {
                    success: false,
                    error: "Invite message not found"
                };
            }

            const response = await this.sock?.groupAcceptInviteV4(groupJid, messageInvite);

            return {
                success: true,
                message: "Join with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in join group"
            };

        }

    }
    
    async getInfoByCode(code: string){

        try{

            const response = await this.sock?.groupGetInviteInfo(code.replace("https://chat.whatsapp.com/", ""));

            return {
                success: true,
                message: "Get infos with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in get group infos"
            };

        }

    }
    
    async queryMetadata(groupJid: string){

        try{

            const response = await this.sock?.groupMetadata(groupJid);

            return {
                success: true,
                message: "Get metadata with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in get group metadata"
            };

        }

    }
    
    async participantsList(groupJid: string){

        try{

            const response = await this.sock?.groupRequestParticipantsList(groupJid);

            return {
                success: true,
                message: "Get participants list with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in get group participants list"
            };

        }

    }

    async requestParticipants(groupJid: string, participants: string[], action: "approve" | "reject"){

        try{

            const response = await this.sock?.groupRequestParticipantsUpdate(groupJid, participants, action);

            return {
                success: true,
                message: "Update participants requests with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in update participants requests"
            };

        }

    }

    async fetchAllParticipants(){

        try{

            const response = await this.sock?.groupFetchAllParticipating();

            return {
                success: true,
                message: "Get all participants with success",
                data: {
                    response
                }
            };

        }catch(err){

            return {
                success: false,
                error: "Error in get groups participants"
            };

        }

    }
    
    async ephemeralMessages(groupJid: string, time: number){

        try{

            await this.sock?.groupToggleEphemeral(groupJid, time);

            return {
                success: true,
                message: "Message expiration defined"
            };

        }catch(err){

            return {
                success: false,
                error: "Error in set message expiration"
            };

        }

    }
    
    async addMode(groupJid: string, onlyAdmin: boolean){

        try{

            const addMode = (onlyAdmin ? 'admin_add' : 'all_member_add');
            await this.sock?.groupMemberAddMode(groupJid, addMode);

            return {
                success: true,
                message: "Group add Mode defined"
            };

        }catch(err){

            return {
                success: false,
                error: "Error in set add mode in group"
            };

        }

    }
    
}