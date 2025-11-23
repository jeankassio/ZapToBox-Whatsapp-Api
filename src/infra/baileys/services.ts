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
    proto,
    delay,
} from "@whiskeysockets/baileys";
import * as fs from "fs";
import * as path from "path";
import QRCode from "qrcode";
import { release } from "os";
import NodeCache from "node-cache"
import P from "pino";
import { baileysEvents, instanceConnection, instances, instanceStatus, sessionsPath } from "../../shared/constants";
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
    private qrCodeCount!: number;
    private qrCodeResolver?: (qrBase64: string) => void;
    private qrCodePromise?: Promise<string>;
    private phoneNumber?: string | undefined;

    getSock(): (WASocket | undefined){
        return this?.sock;
    }

    async create(data: { owner: string; instanceName: string , phoneNumber: string | undefined}) {
        this.owner = data.owner;
        this.instanceName = data.instanceName;
        this.phoneNumber = data.phoneNumber?.replace(/\D/g, "");
        
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
        const agents = await genProxy(UserConfig.proxyUrl);

        this.sock = makeWASocket({
            auth: state,
            version,
            emitOwnEvents: true,
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            msgRetryCounterCache: msgRetryCounterCache,
            userDevicesCache: userDevicesCache,
            enableAutoSessionRecreation: true,
            agent: agents.wsAgent,
            fetchAgent: agents.fetchAgent,
            retryRequestDelayMs: 3 * 1000,
            maxMsgRetryCount: 1000,
            logger: P({level: 'fatal'}),
            markOnlineOnConnect: false,
            cachedGroupMetadata: async (jid) => groupCache.get(jid),
            getMessage: async (key) => await this.getMessage(key.id!) as proto.IMessage,
            qrTimeout: UserConfig.qrCodeTimeout * 1000
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

        // Criar Promise para aguardar o QR code
        this.qrCodePromise = new Promise((resolve) => {
            this.qrCodeResolver = resolve;
        });

        this.instanceEvents(saveCreds);

        this.qrCodeCount = 0;

        let qrCodeReturn: string | undefined;
        let pairingCodeReturn: string | undefined;

        if(this.phoneNumber){

            if(!this.sock.authState.creds.registered){

                try {
                
                    const pNumber = this.phoneNumber;

                    await delay(500);

                    pairingCodeReturn = await this.sock.requestPairingCode(pNumber);

                    console.log(pairingCodeReturn);

                } catch(err) {
                    console.log("Error requesting pairing code:", err);
                    pairingCodeReturn = undefined;
                }

            }

        }else{

            try {
                const qrCode = await Promise.race([
                    this.qrCodePromise,
                    new Promise<string>((_, reject) => 
                        setTimeout(() => reject(new Error('QR code timeout')), UserConfig.qrCodeTimeout * 1000)
                    )
                ]);
                qrCodeReturn = qrCode;
            } catch {
                qrCodeReturn = undefined;
            }

        }

        return {
            instance: this.instance,
            qrCode: qrCodeReturn,
            pairingCode: pairingCodeReturn
        };

    }

    async instanceEvents(saveCreds: () => Promise<void>){

        this.sock.ev.on("creds.update", saveCreds as (data: BaileysEventMap["creds.update"]) => void);

        this.sock.ev.on("connection.update", async (update: BaileysEventMap['connection.update']) => {
            const { connection, lastDisconnect, qr } = update;

            if(this.phoneNumber && qr){

                await delay(1500);
                const pairingCode = await this.sock.requestPairingCode(this.phoneNumber);

                if(this.qrCodeCount > UserConfig.qrCodeLimit){

                    console.log(`[${this.owner}/${this.instanceName}] PAIRING CODE LIMIT REACHED`);
                    await trySendWebhook("pairingcode.limit", this.instance, [{ pairingCodeLimit: UserConfig.qrCodeLimit }]);

                    await this.clearInstance();

                }else{

                    this.qrCodeCount++;
                    console.log(`Pairing Code: ${pairingCode}`);

                    await trySendWebhook("pairingcode.updated", this.instance, [{ pairingCode }]);

                }

            }else if(qr){

                this.qrCodeCount++;

                if(this.qrCodeCount > UserConfig.qrCodeLimit){

                    console.log(`[${this.owner}/${this.instanceName}] QRCODE LIMIT REACHED`);

                    await trySendWebhook("qrcode.limit", this.instance, [{ qrCodeLimit: UserConfig.qrCodeLimit }]);

                    await this.clearInstance();

                }else{

                    const qrBase64 = await QRCode.toDataURL(qr);

                    QRCode.toString(qr, { type: "utf8" }, (err, qrTerminal) => {
                        if (!err){
                            console.log(qrTerminal);
                        }
                    });
                    
                    if (this.qrCodeResolver) {
                        this.qrCodeResolver(qrBase64);
                        delete this.qrCodeResolver;
                    }

                    await trySendWebhook("qrcode.updated", this.instance, [{ qrBase64 }]);

                }

            }else if (connection === "open"){

                this.setStatus("ONLINE");

                const ppUrl = await this.getProfilePicture();
                this.instance.profilePictureUrl = ppUrl;
                
                console.log(`[${this.owner}/${this.instanceName}] Connected to Whatsapp`);
                
                this.sock.sendPresenceUpdate('unavailable');

                await trySendWebhook("connection.open", this.instance, [update]);

                if (this.qrCodeResolver) {
                    this.qrCodeResolver('');
                    delete this.qrCodeResolver;
                }

            }else if(connection === "close"){

                this.setStatus("OFFLINE");

                const reason = (lastDisconnect?.error as any)?.output?.statusCode;

                const shouldReconnect = reason !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    
                    await trySendWebhook("connection.close", this.instance, [{ reason }]);
                    await this.create({ owner:this.owner, instanceName:this.instanceName, phoneNumber: this.phoneNumber});

                } else {
                    
                    console.log(`[${this.owner}/${this.instanceName}] REMOVED`);
                    console.log(`Reason: ${DisconnectReason[reason!]}`);

                    await trySendWebhook("connection.removed", this.instance, [{ reason }]);
                    
                    await this.clearInstance();

                }
            }
        });

        this.sock.ev.on("messaging-history.set", async({messages, chats}: BaileysEventMap['messaging-history.set']) => {

            if(chats && chats.length > 0){
                trySendWebhook("chats.set", this.instance, [{chats}]);
            }

            if(messages && messages.length > 0){
                PrismaConnection.saveManyMessages(`${this.instance.owner}_${this.instance.instanceName}`, messages);
                trySendWebhook("messages.set", this.instance, [{messages}]);
            }

        });

        this.sock.ev.on("chats.upsert", async (chats: BaileysEventMap['chats.upsert']) => {
            await trySendWebhook("chats.upsert", this.instance, [{chats}]);
        });

        this.sock.ev.on("chats.update", async (chats: BaileysEventMap['chats.update']) => {
            await trySendWebhook("chats.update", this.instance, [{chats}]);
        });

        this.sock.ev.on("chats.delete", async (ids: BaileysEventMap['chats.delete']) => {
            await trySendWebhook("chats.delete", this.instance, [{ids}]);
        });

        this.sock.ev.on("lid-mapping.update", async (mapping: BaileysEventMap['lid-mapping.update']) => {
            await trySendWebhook("lid-mapping.update", this.instance, [{mapping}]);
        });

        this.sock.ev.on("presence.update", async (presence: BaileysEventMap['presence.update']) => {
            await trySendWebhook("presence.update", this.instance, [{presence}]);
        });

        this.sock.ev.on("contacts.upsert", async (contacts: BaileysEventMap['contacts.upsert']) => {
            PrismaConnection.saveManyContacts(`${this.instance.owner}_${this.instance.instanceName}`, contacts);
            await trySendWebhook("contacts.upsert", this.instance, [{contacts}]);
        });

        this.sock.ev.on("contacts.update", async (contacts: BaileysEventMap['contacts.update']) => {
            PrismaConnection.saveManyContacts(`${this.instance.owner}_${this.instance.instanceName}`, contacts);
            await trySendWebhook("contacts.update", this.instance, [{contacts}]);
        });

        this.sock.ev.on("messages.upsert", async (messages: BaileysEventMap['messages.upsert']) => {
            this.sock.sendPresenceUpdate('unavailable');
            PrismaConnection.saveManyMessages(`${this.instance.owner}_${this.instance.instanceName}`, messages.messages);
            await trySendWebhook("messages.upsert", this.instance, [{messages: messages.messages}]);
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
            await trySendWebhook("messages.delete", this.instance, [{deletes}]);
        });

        this.sock.ev.on("messages.media-update", async (mediaUpdates: BaileysEventMap['messages.media-update']) => {
            await trySendWebhook("messages.media-update", this.instance, [{mediaUpdates}]);
        });

        this.sock.ev.on("messages.reaction", async (reactions: BaileysEventMap['messages.reaction']) => {
            await trySendWebhook("messages.reaction", this.instance, [{reactions}]);
        });

        this.sock.ev.on("message-receipt.update", async (receipts: BaileysEventMap['message-receipt.update']) => {
            await trySendWebhook("message-receipt.update", this.instance, [{receipts}]);
        });

        this.sock.ev.on("groups.upsert", async (groups: BaileysEventMap['groups.upsert']) => {
            await trySendWebhook("groups.upsert", this.instance, [{groups}]);
        });

        this.sock.ev.on("groups.update", async (groups: BaileysEventMap['groups.update']) => {
            const [event] = groups;
            const metadata = await this.sock.groupMetadata(event?.id!);
            groupCache.set(event?.id!, metadata);
            await trySendWebhook("groups.update", this.instance, [{groups}]);
        });

        this.sock.ev.on("group-participants.update", async (update: BaileysEventMap['group-participants.update']) => {
            const metadata = await this.sock.groupMetadata(update.id);
            groupCache.set(update.id, metadata);
            await trySendWebhook("group-participants.update", this.instance, [{update}]);
        });

        this.sock.ev.on("group.join-request", async (request: BaileysEventMap['group.join-request']) => {
            await trySendWebhook("group.join-request", this.instance, [{request}]);
        });

        this.sock.ev.on("blocklist.set", async (blocklist: BaileysEventMap['blocklist.set']) => {
            await trySendWebhook("blocklist.set", this.instance, [{blocklist}]);
        });

        this.sock.ev.on("blocklist.update", async (update: BaileysEventMap['blocklist.update']) => {
            await trySendWebhook("blocklist.update", this.instance, [{update}]);
        });

        this.sock.ev.on("call", async (calls: BaileysEventMap['call']) => {
            await trySendWebhook("call", this.instance, [{calls}]);
        });

        this.sock.ev.on("labels.edit", async (label: BaileysEventMap['labels.edit']) => {
            await trySendWebhook("labels.edit", this.instance, [{label}]);
        });

        this.sock.ev.on("labels.association", async (assoc: BaileysEventMap['labels.association']) => {
            await trySendWebhook("labels.association", this.instance, [{assoc}]);
        });

        this.sock.ev.on("newsletter.reaction", async (reaction: BaileysEventMap['newsletter.reaction']) => {
            await trySendWebhook("newsletter.reaction", this.instance, [{reaction}]);
        });

        this.sock.ev.on("newsletter.view", async (view: BaileysEventMap['newsletter.view']) => {
            await trySendWebhook("newsletter.view", this.instance, [{view}]);
        });

        this.sock.ev.on("newsletter-participants.update", async (update: BaileysEventMap['newsletter-participants.update']) => {
            await trySendWebhook("newsletter-participants.update", this.instance, [{update}]);
        });

        this.sock.ev.on("newsletter-settings.update", async (update: BaileysEventMap['newsletter-settings.update']) => {
            await trySendWebhook("newsletter-settings.update", this.instance, [{update}]);
        });


    }

    setStatus(status: ConnectionStatus): void{

        this.instance.connectionStatus = status;
        instanceStatus.set(this.key, status);

    }

    async clearInstance(){

        try{

            await this.sock?.ws?.close?.();

            this.setStatus("REMOVED");

            await clearInstanceWebhooks(`${this.owner}_${this.instanceName}`);
            await removeInstancePath(this.instancePath);
                        
            PrismaConnection.deleteByInstance(`${this.owner}_${this.instanceName}`);

            for(const event of baileysEvents){
                this.sock?.ev.removeAllListeners(event);
            }

            delete instanceConnection[this.key];
            delete instances[this.key];

        }catch{
            console.error("Error removing instance");
        }

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

    async getMessage(key: string): Promise<proto.IMessage> {

        await delay(2);

        const message: WAMessage | undefined = await PrismaConnection.getMessageById(key);

        if(message?.message){
            return proto.Message.fromObject(message.message);
        }

        return proto.Message.fromObject({});

    }

}


