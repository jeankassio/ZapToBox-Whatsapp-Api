import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    WASocket,
    Browsers,
} from "@whiskeysockets/baileys";
import * as fs from "fs";
import * as path from "path";
import * as qrcode from "qrcode-terminal";
import { sendWebhook } from "../utils/webhook";
import { saveWebhookEvent, startWebhookRetryLoop, clearInstanceWebhooks } from "../utils/webhookQueue";

interface InstanceData {
    owner: string;
    instanceName: string;
    socket?: WASocket;
    connectionStatus: "ONLINE" | "OFFLINE";
    profilePictureUrl?: string | undefined;
}

const sessionsPath = path.join(__dirname, "..", "sessions");
const instances: Record<string, InstanceData> = {};

// Novo: mapa de status para o sistema de fila
const instanceStatus = new Map<string, "ONLINE" | "OFFLINE" | "REMOVED">();

// Função auxiliar para o webhookQueue saber o status
function getInstanceStatus(name: string): "ONLINE" | "OFFLINE" | "REMOVED" {
    return instanceStatus.get(name) || "OFFLINE";
}

// Inicia o loop de reenvio automático a cada 1 minuto
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
    if (!fs.existsSync(path.join(sessionsPath, owner))) fs.mkdirSync(path.join(sessionsPath, owner));
    if (!fs.existsSync(instancePath)) fs.mkdirSync(instancePath);

    const { state, saveCreds } = await useMultiFileAuthState(instancePath);

    const sock = makeWASocket({
        printQRInTerminal: false,
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

    // Atualiza credenciais
    sock.ev.on("creds.update", saveCreds);

    // Eventos de conexão
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

    // Eventos principais do Baileys
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

/**
 * Tenta enviar o webhook e salva localmente se falhar.
 */
async function trySendWebhook(event: string, instance: InstanceData, data: any[]) {
    const payload = {
        event,
        instance: {
            instanceName: instance.instanceName,
            owner: instance.owner,
            connectionStatus: instance.connectionStatus,
            profilePictureUrl: instance.profilePictureUrl,
        },
        data,
        targetUrl: process.env.WEBHOOK_URL!,
    };

    try {
        const res = await fetch(process.env.WEBHOOK_URL!, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        console.warn(`[${instance.owner}/${instance.instanceName}] Falha ao enviar webhook ${event}, salvando localmente...`);
        await saveWebhookEvent(payload);
    }
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
