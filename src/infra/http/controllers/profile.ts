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
        
    }

}