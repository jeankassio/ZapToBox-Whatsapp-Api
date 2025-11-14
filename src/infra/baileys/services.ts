import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    fetchLatestBaileysVersion,
    BaileysEventMap,
    WABrowserDescription,
    CacheStore,
    getAggregateVotesInPollMessage,
    WAMessage,
} from "@whiskeysockets/baileys";
import * as fs from "fs";
import * as path from "path";
import QRCode from "qrcode";
import { release } from "os";
import NodeCache from "node-cache"
import P from "pino";
import { instanceConnection, instanceStatus, sessionsPath } from "../../shared/constants";
import { clearInstanceWebhooks, genProxy, removeInstancePath, trySendWebhook } from "../../shared/utils";
import { ConnectionStatus, InstanceData } from "../../shared/types";
import UserConfig from "../config/env";
import PrismaConnection from "../../core/connection/prisma";

const msgRetryCounterCache: CacheStore = new NodeCache();
const userDevicesCache: CacheStore = new NodeCache();
const groupCache = new NodeCache({stdTTL: 5 * 60, useClones: false});

export default class Instance{

    private sock!: WASocket;
    private instance!: InstanceData;
    private owner!: string;
    private instanceName!: string;
    private key!: string;
    private instancePath!: string;

    getSock(): (WASocket | undefined){
        return this?.sock;
    }

    async create(data: { owner: string; instanceName: string }) {
        this.owner = data.owner;
        this.instanceName = data.instanceName;
        
        this.instancePath = path.join(sessionsPath, this.owner, this.instanceName);
        if (!fs.existsSync(path.join(sessionsPath, this.owner))){
            fs.mkdirSync(path.join(sessionsPath, this.owner));
        }
        if (!fs.existsSync(this.instancePath)) {
            fs.mkdirSync(this.instancePath);
        }

        const { state, saveCreds } = await useMultiFileAuthState(this.instancePath);
        const { version } = await fetchLatestBaileysVersion();

        const browser: WABrowserDescription  = [UserConfig.sessionClient, UserConfig.sessionName, release()];
        const agents = genProxy(UserConfig.proxyUrl);

        this.sock = makeWASocket({
            browser,
            auth: state,
            version,
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            msgRetryCounterCache: msgRetryCounterCache,
            userDevicesCache: userDevicesCache,
            agent: agents.wsAgent,
            fetchAgent: agents.fetchAgent,
            retryRequestDelayMs: 3 * 1000,
            maxMsgRetryCount: 1000,
            logger: P({level: 'silent'}) as any,
            markOnlineOnConnect: false,
            cachedGroupMetadata: async (jid) => groupCache.get(jid),
        });

        this.key = `${this.owner}_${this.instanceName}`;

        this.instance = {
            owner: this.owner,
            instanceName: this.instanceName,
            socket: this.sock,
            connectionStatus: "OFFLINE",
        };

        instanceConnection[this.key] = this.instance;

        this.setStatus("OFFLINE");

        this.instanceEvents(saveCreds);

        return this.instance;

    }

    async instanceEvents(saveCreds: () => Promise<void>){

        this.sock.ev.on("creds.update", saveCreds as (data: BaileysEventMap["creds.update"]) => void);

        this.sock.ev.on("connection.update", async (update: BaileysEventMap['connection.update']) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {

                const qrBase64 = await QRCode.toDataURL(qr);

                QRCode.toString(qr, { type: "utf8" }, (err, qrTerminal) => {
                    if (!err){
                        console.log(qrTerminal);
                    }
                });
                
                await trySendWebhook("qrcode", this.instance, [{ qrBase64 }]);

            }

            if (connection === "open") {

                this.setStatus("ONLINE");

                const ppUrl = await this.getProfilePicture();
                this.instance.profilePictureUrl = ppUrl;
                
                console.log(`[${this.owner}/${this.instanceName}] Session Opened`);
                
                this.sock.sendPresenceUpdate('unavailable');

                await trySendWebhook("connection.open", this.instance, [update]);

            } else if (connection === "close") {

                this.setStatus("OFFLINE");

                const reason = (lastDisconnect?.error as any)?.output?.statusCode;

                const shouldReconnect = reason !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    
                    await trySendWebhook("connection.close", this.instance, [{ reason }]);
                    await this.create({ owner:this.owner, instanceName:this.instanceName });

                } else {
                    
                    console.log(`[${this.owner}/${this.instanceName}] REMOVED`);
                    console.log(`Reason: ${DisconnectReason[reason!]}`);

                    await trySendWebhook("connection.removed", this.instance, [{ reason }]);
                    
                    this.setStatus("REMOVED");

                    await clearInstanceWebhooks(this.instanceName);
                    removeInstancePath(this.instancePath);

                    this.sock?.ev.removeAllListeners('connection.update');
                    this.sock?.ev.removeAllListeners('messages.upsert');
                    this.sock?.ev.removeAllListeners('messages.update');
                    this.sock?.ev.removeAllListeners('messaging-history.set');
                    this.sock?.ev.removeAllListeners('contacts.upsert');
                    this.sock?.ev.removeAllListeners('chats.upsert');
                    this.sock?.ev.removeAllListeners('creds.update');

                }
            }
        });

        this.sock.ev.on("messaging-history.set", async({messages, chats, contacts}: BaileysEventMap['messaging-history.set']) => {

            if(contacts && contacts.length > 0){
                const contactFiltered = contacts.filter(contact => !!contact.name);
                trySendWebhook("contacts.set", this.instance, contactFiltered);
            }

            if(chats && chats.length > 0){
                trySendWebhook("chats.set", this.instance, chats);
            }

            if(messages && messages.length > 0){
                PrismaConnection.saveMany(`${this.instance.owner}_${this.instance.instanceName}`, messages);
                trySendWebhook("messages.set", this.instance, messages);
            }

        });

        this.sock.ev.on("chats.upsert", async (chats: BaileysEventMap['chats.upsert']) => {
            await trySendWebhook("chats.upsert", this.instance, [chats]);
        });

        this.sock.ev.on("chats.update", async (chats: BaileysEventMap['chats.update']) => {
            await trySendWebhook("chats.update", this.instance, [chats]);
        });

        this.sock.ev.on("chats.delete", async (ids: BaileysEventMap['chats.delete']) => {
            await trySendWebhook("chats.delete", this.instance, [ids]);
        });

        this.sock.ev.on("lid-mapping.update", async (mapping: BaileysEventMap['lid-mapping.update']) => {
            await trySendWebhook("lid-mapping.update", this.instance, [mapping]);
        });

        this.sock.ev.on("presence.update", async (presence: BaileysEventMap['presence.update']) => {
            await trySendWebhook("presence.update", this.instance, [presence]);
        });

        this.sock.ev.on("contacts.upsert", async (contacts: BaileysEventMap['contacts.upsert']) => {
            await trySendWebhook("contacts.upsert", this.instance, [contacts]);
        });

        this.sock.ev.on("contacts.update", async (contacts: BaileysEventMap['contacts.update']) => {
            await trySendWebhook("contacts.update", this.instance, [contacts]);
        });

        this.sock.ev.on("messages.upsert", async (messages: BaileysEventMap['messages.upsert']) => {
            PrismaConnection.saveMany(`${this.instance.owner}_${this.instance.instanceName}`, messages.messages);
            await trySendWebhook("messages.upsert", this.instance, [messages]);
        });

        this.sock.ev.on("messages.update", async (updates: BaileysEventMap['messages.update']) => {

            const nupdates = await Promise.all(
                updates.map(async (message) => {
                    const { key, update } = message;
                    if(update.pollUpdates){
                        const pollCreation = await PrismaConnection.getMessageById(key.id!) as any;
                        if(pollCreation?.message){
                            const pollVotes = getAggregateVotesInPollMessage({
                                message: pollCreation.message, 
                                pollUpdates: update.pollUpdates
                            });

                            const newUpdate = { 
                                ...update, 
                                pollVotes
                            } as any;

                            return { ...message, update: newUpdate } as Partial<WAMessage>;
                            
                        }
                    }
                    return message;
                })
            );

            await trySendWebhook("messages.update", this.instance, [nupdates]);
        });

        this.sock.ev.on("messages.delete", async (deletes: BaileysEventMap['messages.delete']) => {
            await trySendWebhook("messages.delete", this.instance, [deletes]);
        });

        this.sock.ev.on("messages.media-update", async (mediaUpdates: BaileysEventMap['messages.media-update']) => {
            await trySendWebhook("messages.media-update", this.instance, [mediaUpdates]);
        });

        this.sock.ev.on("messages.reaction", async (reactions: BaileysEventMap['messages.reaction']) => {
            await trySendWebhook("messages.reaction", this.instance, [reactions]);
        });

        this.sock.ev.on("message-receipt.update", async (receipts: BaileysEventMap['message-receipt.update']) => {
            await trySendWebhook("message-receipt.update", this.instance, [receipts]);
        });

        this.sock.ev.on("groups.upsert", async (groups: BaileysEventMap['groups.upsert']) => {
            await trySendWebhook("groups.upsert", this.instance, [groups]);
        });

        this.sock.ev.on("groups.update", async (groups: BaileysEventMap['groups.update']) => {
            const [event] = groups;
            const metadata = await this.sock.groupMetadata(event?.id!);
            groupCache.set(event?.id!, metadata);
            await trySendWebhook("groups.update", this.instance, [groups]);
        });

        this.sock.ev.on("group-participants.update", async (update: BaileysEventMap['group-participants.update']) => {
            const metadata = await this.sock.groupMetadata(update.id);
            groupCache.set(update.id, metadata);
            await trySendWebhook("group-participants.update", this.instance, [update]);
        });

        this.sock.ev.on("group.join-request", async (request: BaileysEventMap['group.join-request']) => {
            await trySendWebhook("group.join-request", this.instance, [request]);
        });

        this.sock.ev.on("blocklist.set", async (blocklist: BaileysEventMap['blocklist.set']) => {
            await trySendWebhook("blocklist.set", this.instance, [blocklist]);
        });

        this.sock.ev.on("blocklist.update", async (update: BaileysEventMap['blocklist.update']) => {
            await trySendWebhook("blocklist.update", this.instance, [update]);
        });

        this.sock.ev.on("call", async (calls: BaileysEventMap['call']) => {
            await trySendWebhook("call", this.instance, [calls]);
        });

        this.sock.ev.on("labels.edit", async (label: BaileysEventMap['labels.edit']) => {
            await trySendWebhook("labels.edit", this.instance, [label]);
        });

        this.sock.ev.on("labels.association", async (assoc: BaileysEventMap['labels.association']) => {
            await trySendWebhook("labels.association", this.instance, [assoc]);
        });

        this.sock.ev.on("newsletter.reaction", async (reaction: BaileysEventMap['newsletter.reaction']) => {
            await trySendWebhook("newsletter.reaction", this.instance, [reaction]);
        });

        this.sock.ev.on("newsletter.view", async (view: BaileysEventMap['newsletter.view']) => {
            await trySendWebhook("newsletter.view", this.instance, [view]);
        });

        this.sock.ev.on("newsletter-participants.update", async (update: BaileysEventMap['newsletter-participants.update']) => {
            await trySendWebhook("newsletter-participants.update", this.instance, [update]);
        });

        this.sock.ev.on("newsletter-settings.update", async (update: BaileysEventMap['newsletter-settings.update']) => {
            await trySendWebhook("newsletter-settings.update", this.instance, [update]);
        });


    }

    setStatus(status: ConnectionStatus){

        this.instance.connectionStatus = status;
        instanceStatus.set(this.key, status);

    }

    async getProfilePicture(): Promise<string | undefined> {
        try {

            const jid = this.sock?.user?.id;

            if (!jid){
                return undefined;
            }

            return await this.sock?.profilePictureUrl(jid, "image");

        } catch {
            return undefined;
        }
    }

}


