import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    Browsers,
} from "@whiskeysockets/baileys";
import * as fs from "fs";
import * as path from "path";
import * as qrcode from "qrcode-terminal";
import { trySendWebhook } from "../utils/webhook";
import { startWebhookRetryLoop, clearInstanceWebhooks } from "../utils/webhookQueue";
import { InstanceData, ConnectionStatus } from "../types/instance";
import {instances, instanceStatus, sessionsPath} from "../server";





function getInstanceStatus(name: string): ConnectionStatus {
    return instanceStatus.get(name) || "OFFLINE";
}

startWebhookRetryLoop(getInstanceStatus);

export async function initAllSessions() {
    if (!fs.existsSync(sessionsPath)) fs.mkdirSync(sessionsPath);

    const owners = fs.readdirSync(sessionsPath);
    for (const owner of owners) {
        const ownerPath = path.join(sessionsPath, owner);
        const instancesDirs = fs.readdirSync(ownerPath);
        for (const instanceName of instancesDirs) {
            await createInstance({ owner, instanceName });
        }
    }
}

export async function createInstance(data: { owner: string; instanceName: string }) {
    const { owner, instanceName } = data;

    const instancePath = path.join(sessionsPath, owner, instanceName);
    if (!fs.existsSync(path.join(sessionsPath, owner))){
        fs.mkdirSync(path.join(sessionsPath, owner));
    }
    if (!fs.existsSync(instancePath)) {
        fs.mkdirSync(instancePath);
    }

    const { state, saveCreds } = await useMultiFileAuthState(instancePath);

    const sock = makeWASocket({
        printQRInTerminal: true,
        browser: Browsers.macOS("Safari"),
        auth: state,
    });

    const key = `${owner}_${instanceName}`;
    const instance: InstanceData = {
        owner,
        instanceName,
        socket: sock,
        connectionStatus: "OFFLINE",
    };
    instances[key] = instance;

    instanceStatus.set(key, "OFFLINE");

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            await trySendWebhook("qrcode", instance, [{ qr }]);
        }

        if (connection === "open") {
            instance.connectionStatus = "ONLINE";
            instanceStatus.set(key, "ONLINE");

            const ppUrl = await getProfilePicture(sock);
            instance.profilePictureUrl = ppUrl;

            await trySendWebhook("connection.open", instance, [{ message: "Conectado com sucesso" }]);
        } else if (connection === "close") {
            instance.connectionStatus = "OFFLINE";
            instanceStatus.set(key, "OFFLINE");

            const reason = (lastDisconnect?.error as any)?.output?.statusCode;

            await trySendWebhook("connection.close", instance, [{ reason }]);

            const shouldReconnect = reason !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                await createInstance({ owner, instanceName });
            } else {
                console.log(`[${owner}/${instanceName}] Sessão encerrada permanentemente`);
                instanceStatus.set(key, "REMOVED");
                await clearInstanceWebhooks(instanceName);
            }
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        await trySendWebhook("messages.upsert", instance, [m]);
    });

    sock.ev.on("messages.update", async (m) => {
        await trySendWebhook("messages.update", instance, [m]);
    });

    sock.ev.on("contacts.upsert", async (m) => {
        await trySendWebhook("contacts.upsert", instance, [m]);
    });

    sock.ev.on("chats.upsert", async (m) => {
        await trySendWebhook("chats.upsert", instance, [m]);
    });

    sock.ev.on("presence.update", async (m) => {
        await trySendWebhook("presence.update", instance, [m]);
    });

    sock.ev.on("messages.delete", async (m) => {
        await trySendWebhook("messages.delete", instance, [m]);
    });

    sock.ev.on("groups.update", async (m) => {
        await trySendWebhook("groups.update", instance, [m]);
    });

    sock.ev.on("group-participants.update", async (m) => {
        await trySendWebhook("group-participants.update", instance, [m]);
    });

    console.log(`[${owner}/${instanceName}] Sessão iniciada`);
    return instance;
}

async function getProfilePicture(sock: WASocket): Promise<string | undefined> {
    try {
        const jid = sock.user?.id;
        if (!jid) return undefined;
        return await sock.profilePictureUrl(jid, "image");
    } catch {
        return undefined;
    }
}
