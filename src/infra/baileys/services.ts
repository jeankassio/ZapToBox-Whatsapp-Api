import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    fetchLatestBaileysVersion,
    BaileysEventMap,
    WABrowserDescription,
    CacheStore,
    AuthenticationCreds,
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

const msgRetryCounterCache: CacheStore = new NodeCache();
const userDevicesCache: CacheStore = new NodeCache();

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

        this.sock.ev.on("creds.update", saveCreds);

        this.sock.ev.on("messaging-history.set", async({messages, chats, contacts}: BaileysEventMap['messaging-history.set']) => {

            if(contacts && contacts.length > 0){
                const contactFiltered = contacts.filter(contact => !!contact.name);
                trySendWebhook("contacts.set", this.instance, contactFiltered);
            }

            if(chats && chats.length > 0){
                trySendWebhook("chats.set", this.instance, chats);
            }

            if(messages && messages.length > 0){
                trySendWebhook("messages.set", this.instance, messages);
            }

        });

        this.sock.ev.on("connection.update", async (update) => {
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
                
                console.log(`[${this.owner}/${this.instanceName}] Session Iniciated`);
                
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

                    await trySendWebhook("connection.removed", this.instance, [{ reason }]);
                    console.log(`[${this.owner}/${this.instanceName}] REMOVED`);
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

        this.sock.ev.on("messages.upsert", async (m) => {
            await trySendWebhook("messages.upsert", this.instance, [m]);
        });

        this.sock.ev.on("messages.update", async (m) => {
            await trySendWebhook("messages.update", this.instance, [m]);
        });

        this.sock.ev.on("contacts.upsert", async (m) => {
            await trySendWebhook("contacts.upsert", this.instance, [m]);
        });

        this.sock.ev.on("chats.upsert", async (m) => {
            await trySendWebhook("chats.upsert", this.instance, [m]);
        });

        this.sock.ev.on("presence.update", async (m) => {
            await trySendWebhook("presence.update", this.instance, [m]);
        });

        this.sock.ev.on("messages.delete", async (m) => {
            await trySendWebhook("messages.delete", this.instance, [m]);
        });

        this.sock.ev.on("groups.update", async (m) => {
            await trySendWebhook("groups.update", this.instance, [m]);
        });

        this?.sock.ev.on("group-participants.update", async (m) => {
            await trySendWebhook("group-participants.update", this.instance, [m]);
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


