import { Request, Response } from "express";
import { instances } from "../../../shared/constants";
import { StatusPresence } from "../../../shared/types";
import { AnyMessageContent, delay, WASocket } from "@whiskeysockets/baileys";

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

    async sendMessage(options: AnyMessageContent){
        
        const text = ("text" in options) ? options.text : ("caption" in options) ? options.caption : "";

        const presence: StatusPresence = ("audio" in options ? "recording" : "composing");
        
        await this.simulateTyping(presence, text);

        return this.sock?.sendMessage(this.jid, options);

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

    async simulateTyping(compose: StatusPresence, text: string){
        
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