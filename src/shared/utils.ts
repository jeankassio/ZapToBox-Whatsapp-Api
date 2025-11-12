import * as fs from "fs";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
import { InstanceData, ProxyAgent, WebhookPayload } from './types';
import path from "path";
import UserConfig from "../infra/config/env"


export async function removeInstancePath(instancePath: string){

    fs.rmSync(instancePath, { recursive: true, force: true });

}

export function genProxy(wppProxy?: string): ProxyAgent{

    const proxys: ProxyAgent = {};

    if(!wppProxy){
        return proxys;
    }

    const isProtocol = (url: string) => url.split(":")[0]?.toLowerCase();

        const protocol = isProtocol(wppProxy);

        switch(protocol){
            case 'http':
            case 'https':{
                proxys.wsAgent = new HttpsProxyAgent(wppProxy);
                break;
            }
            case 'socks':
            case 'socks4':
            case 'socks5':{
                proxys.wsAgent = new SocksProxyAgent(wppProxy);
                break;
            }
            default:{
                console.warn(`Unknown Protocol in Proxy: ${wppProxy}`);
            }
        }

        proxys.fetchAgent = new UndiciProxyAgent(wppProxy);

    return proxys;
}
export async function trySendWebhook(event: string, instance: InstanceData, data: any[]) {
    const payload = {
        event,
        instance: {
            instanceName: instance.instanceName,
            owner: instance.owner,
            connectionStatus: instance.connectionStatus,
            profilePictureUrl: instance.profilePictureUrl,
        },
        data,
        targetUrl: UserConfig.webhookUrl
    };

    try {
        const res = await fetch(UserConfig.webhookUrl, {
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

async function ensureDir() {
    try {
        await fs.promises.mkdir(UserConfig.webhook_queue_dir, { recursive: true });
    } catch (err) {
        console.error("Erro ao criar diretório de webhooks:", err);
    }
}

export async function saveWebhookEvent(payload: WebhookPayload) {
    try {
        await ensureDir();
        const filename = `${payload.instance.instanceName}-${Date.now()}.json`;
        const filePath = path.join(UserConfig.webhook_queue_dir, filename);
        await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
        console.error("Erro ao salvar webhook:", err);
    }
}

/**
 * Tenta reenviar todos os webhooks pendentes no diretório
 */
export async function processWebhookQueue(getInstanceStatus: (name: string) => "ONLINE" | "OFFLINE" | "REMOVED") {
    try {
        await ensureDir();
        const files = await fs.promises.readdir(UserConfig.webhook_queue_dir);

        for (const file of files) {
        const filePath = path.join(UserConfig.webhook_queue_dir, file);
        const raw = await fs.promises.readFile(filePath, "utf8");
        const payload: WebhookPayload = JSON.parse(raw);

        const status = getInstanceStatus(payload.instance.instanceName);
        if (status === "REMOVED") {
            await fs.promises.unlink(filePath);
            continue;
        }
        if (status !== "ONLINE"){
            continue;
        }

        try {
            const res = await fetch(payload.targetUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            });

            if (res.ok) {
            await fs.promises.unlink(filePath);
            } else {
            console.warn(`Falha ao reenviar webhook ${file}: ${res.statusText}`);
            }
        } catch (err) {
            console.warn(`Erro ao tentar reenviar webhook ${file}:`, (err as Error).message);
        }
        }
    } catch (err) {
        console.error("Erro ao processar fila de webhooks:", err);
    }
}

export async function clearInstanceWebhooks(instanceName: string) {
    try {
        await ensureDir();
        const files = await fs.promises.readdir(UserConfig.webhook_queue_dir);
        const related = files.filter(f => f.startsWith(`${instanceName}-`));

        for (const file of related) {
        await fs.promises.unlink(path.join(UserConfig.webhook_queue_dir, file));
        }
    } catch (err) {
        console.error(`Erro ao remover webhooks da instância ${instanceName}:`, err);
    }
}

export function startWebhookRetryLoop(getInstanceStatus: (name: string) => "ONLINE" | "OFFLINE" | "REMOVED") {
    setInterval(() => {
        processWebhookQueue(getInstanceStatus);
    }, UserConfig.webhook_interval);
}
