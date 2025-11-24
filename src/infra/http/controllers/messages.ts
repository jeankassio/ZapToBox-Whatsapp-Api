import { instances } from "../../../shared/constants";
import { AudioMessage, ContactMessage, DocumentMessage, GifMessage, ImageMessage, LocationMessage, PollMessage, ReactionMessage, StatusPresence, StickerMessage, TextMessage, VideoMessage } from "../../../shared/types";
import { AnyMessageContent, delay, MessageContentGenerationOptions, WAMessage, WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import PrismaConnection from "../../../core/connection/prisma";
import { JsonObject } from "@prisma/client/runtime/library";

export default class MessagesController {

    private sock: WASocket | undefined;
    private jid: string;
    private delay: number | string;

    constructor(owner: string, instanceName: string, jid: string, delay: (number | string)){
        const key = `${owner}_${instanceName}`;
        this.sock = instances[key]?.getSock();
        this.jid = this.formatJid(jid);
        this.delay = delay;
    }

    async filterOptions(rawOptions: JsonObject): Promise<MessageContentGenerationOptions>{

        const options: any = {};

        if(rawOptions?.quoted && typeof rawOptions.quoted == 'string'){

            const quoted = await PrismaConnection.getMessageById(rawOptions.quoted);

            if(quoted){
                options.quoted = quoted;
            }

        }

        return options;

    }

    async sendMessageText(message: TextMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }

    
    async sendMessageLocation(message: LocationMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }

    
    async sendMessageContact(message: ContactMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        const vcard = 'BEGIN:VCARD\n'
            + 'VERSION:3.0\n'
            + `FN:${message.displayName}\n`
            + 'ORG:ZapToBox Whatsapp Api;\n'
            + `TEL;type=CELL;type=VOICE;waid=${message.waid}:${message.phoneNumber}\n`
            + 'END:VCARD';

        const contact: AnyMessageContent = {
            contacts:{
                displayName: message.displayName,
                contacts: [{vcard}]
            }
        };

        return this.sendMessage(contact, options);

    }

    async sendMessageReaction(reaction: ReactionMessage){

        const options: undefined = undefined;

        const messageReact = await PrismaConnection.getMessageById(reaction.messageId);

        if(!messageReact){
            return {
                success: false,
                error: "Failed to send message.",
            };
        }

        const message:AnyMessageContent = {
            react:{
                text: reaction.emoji,
                key: messageReact.key
            }
        };

        return this.sendMessage(message, options);

    }

    async sendMessagePoll(message: PollMessage, rawOptions: JsonObject | undefined){

        const options: undefined = undefined;

        return this.sendMessage(message, options);

    }

    async sendMessageImage(message: ImageMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }

    async sendMessageVideo(message: VideoMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }

    async sendMessageGif(message: GifMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }

    async sendMessageAudio(message: AudioMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }

    async sendMessageDocument(message: DocumentMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }
    
    async sendMessageSticker(message: StickerMessage, rawOptions: JsonObject | undefined){

        const options: MessageContentGenerationOptions | undefined = (rawOptions ? await this.filterOptions(rawOptions) : undefined);

        return this.sendMessage(message, options);

    }
    
    async sendMessage(message: AnyMessageContent, options: MessageContentGenerationOptions | undefined): Promise<JsonObject>{
        
        try{

            const text = ("text" in message) ? message.text : ("caption" in message) ? message.caption : "";

            const presence: StatusPresence = ("audio" in message ? "recording" : "composing");
            
            await this.simulateTyping(presence, text);

            const sentMessage: WAMessage | undefined = await this.sock?.sendMessage(this.jid, message, options);

            if(!sentMessage || !sentMessage.key || !sentMessage.key.id){
                return {
                    success: false,
                    message: "Failed to send message.",
                };
            }

            return {
                success: true,
                message: "Message sent successfully.",
            };

        }catch(err){

            return {
                success: false,
                error: "Failed to send message: " + (err as Error).message,
            };

        }

    }

    async deleteMessage(key: WAMessageKey, forEveryone: boolean): Promise<JsonObject>{

        try{
        
            if(forEveryone){
                await this.sock?.sendMessage(this.jid, { delete: key });
            }else{
                await this.sock?.chatModify(
                    {
                        deleteForMe: {
                            deleteMedia: true,
                            key: key,
                            timestamp: Date.now() / 1000
                        }
                    }, 
                    this.jid
                )
            }

            return {
                success: true,
                message: "Message deleted successfully.",
            };

        }catch(err){

            return {
                success: false,
                error: "Failed to delete message.",
            };
        }

    }
    async readMessage(messageId: WAMessageKey): Promise<JsonObject>{

        try{

            await this.sock?.readMessages([messageId]);

            return {
                success: true,
                message: "Message marked as read successfully.",
            };

        }catch(err){

            return {
                success: false,
                error: "Failed to mark message as read.",
            };

        }

    }

    async unStar(messageId: string, remoteJid: string, star: boolean): Promise<JsonObject>{

        try{
            
            const message: WAMessage | undefined = await PrismaConnection.getMessageById(messageId);

            if(!message){
                return {
                    success: false,
                    error: "Failed to change star status in message, message not found.",
                };
            }

            await this.sock?.chatModify({
                star: {
                    messages: [{
                        id: message?.key.id!,
                        fromMe: message?.key?.fromMe!
                    }],
                    star
                }
            }, remoteJid);
            
            return {
                success: true,
                message: "Message marked star successfully.",
            };

        }catch(err){

            return {
                success: false,
                error: "Failed to change star status in message.",
            };

        }

    }

    formatJid(jid: string){
        if(jid.endsWith("@s.whatsapp.net") || jid.endsWith("@g.us") || jid.endsWith("@lid")){
            return jid;
        }
        return `${jid}@s.whatsapp.net`;
    }

    calculateDelay(text: string){
        const words = text.trim().split(/\s+/).length;
        const wpm = 40; // words per minute
        const delayInMinutes = words / wpm;
        return delayInMinutes * 60 * 1000; // convert to milliseconds
    }

    async simulateTyping(compose: StatusPresence, text: string): Promise<void>{
        
        await this.sock?.presenceSubscribe(this.jid);

        await delay(800);

        await this.sock?.sendPresenceUpdate(compose, this.jid);

        if(typeof this.delay === "string" && this.delay == "auto" && text.length > 0){
            await delay(this.calculateDelay(text));
        }else if(typeof this.delay === "number" && this.delay > 0){
            await delay(this.delay);
        }

        await this.sock?.sendPresenceUpdate("paused", this.jid);

    }

}