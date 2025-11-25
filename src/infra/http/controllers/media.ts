import PrismaConnection from "../../../core/connection/prisma";
import { instances } from "../../../shared/constants";
import { downloadMediaMessage, WASocket, WAMessage } from "@whiskeysockets/baileys";

export default class MediaController {

    private sock: WASocket | undefined;

    constructor(owner: string, instanceName: string){
        const key = `${owner}_${instanceName}`;
        this.sock = instances[key]?.getSock();
    }

    async getMedia(messageId: string, isBase64: boolean = false){

        if(!this.sock){
            return {
                success: false,
                error: "Instance not connected.",
            };
        }

        const msg = await PrismaConnection.getMessageById(messageId) as WAMessage | undefined;

        if(!msg || !msg.message){
            return {
                success: false,
                error: "Message not found.",
            };
        }

        try{

            const content = msg.message;
            const isMediaMessage = Object.keys(content).find(k => k.startsWith("image") || k.startsWith("video") || k.startsWith("audio") || k.startsWith("document") || k.startsWith("sticker"));

            if(!isMediaMessage){
                console.error("Message is not a media message.");
                return {
                    success: false,
                    error: "Message is not a media message.",
                };
            }

            try{

                const buffer = await downloadMediaMessage(msg, "buffer", {}, {logger: this.sock?.logger, reuploadRequest: this.sock?.updateMediaMessage!});

                const mimeType = (content as any)[isMediaMessage!].mimetype || "application/octet-stream";

                if(isBase64){

                    const base64Data = buffer.toString('base64');

                    return {
                        success: true,
                        base64: `data:${mimeType};base64,${base64Data}`,
                    };

                }else{
                    return {
                        success: true,
                        buffer: buffer,
                        mimeType: mimeType,
                    };
                }

            }catch(err){
                console.error("Error downloading media message:", err);
                return {
                    success: false,
                    error: "Error downloading media message.",
                };
            }

            

        }catch(err){
            console.error("Error fetching media message:", err);
            return {
                success: false,
                error: "Error fetching media message.",
            };
        }

    }

}