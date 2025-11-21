import * as fs from "fs";
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { ProxyAgent as UndiciProxyAgent } from 'undici';
import { ConnectionStatus, InstanceData, ProxyAgent, WebhookPayload } from './types';
import path from "path";
import UserConfig from "../infra/config/env"
import { Worker } from 'worker_threads';


export async function removeInstancePath(instancePath: string){

    fs.rmSync(instancePath, { recursive: true, force: true });

}

export async function genProxy(wppProxy?: string): Promise<ProxyAgent>{

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

    const worker = new Worker(path.join(__dirname, 'webhookWorker.js'));
    
    worker.postMessage(payload);
    
    worker.on('message', async (result) => {
        if (!result.success) {
            console.warn(`[${instance.owner}/${instance.instanceName}] Fail to send webhook ${event}, saving locally...`);
            await saveWebhookEvent(payload);
        }
        worker.terminate();
    });

    worker.on('error', async (err) => {
        console.warn(`[${instance.owner}/${instance.instanceName}] Fail in webhook worker ${event}:`, err);
        await saveWebhookEvent(payload);
        worker.terminate();
    });

}

async function ensureDir() {
    try {
        await fs.promises.mkdir(UserConfig.webhook_queue_dir, { recursive: true });
    } catch (err) {
        console.error("Error creating webhook directory:", err);
    }
}

export async function saveWebhookEvent(payload: WebhookPayload) {
    try {
        await ensureDir();
        const filename = `${payload.instance.instanceName}-${Date.now()}.json`;
        const filePath = path.join(UserConfig.webhook_queue_dir, filename);
        await fs.promises.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
        console.error("Error saving webhook:", err);
    }
}

export async function processWebhookQueue(getInstanceStatus: (name: string) => ConnectionStatus) {
    try {
        await ensureDir();
        const files = await fs.promises.readdir(UserConfig.webhook_queue_dir);

        for (const file of files) {
            const filePath = path.join(UserConfig.webhook_queue_dir, file);
            const raw = await fs.promises.readFile(filePath, "utf8");
            const payload: WebhookPayload = JSON.parse(raw);

            const status = getInstanceStatus(payload.instance.instanceName);

            if(status !== "ONLINE"){
                if(status === "REMOVED"){
                    await fs.promises.unlink(filePath);
                }
                continue;
            }

            // Usa worker para reenviar webhook
            const worker = new Worker(path.join(__dirname, 'webhookWorker.js'));
            
            worker.postMessage(payload);
            
            worker.on('message', async (result) => {
                if (result.success) {
                    await fs.promises.unlink(filePath);
                } else {
                    console.warn(`Fail to resend webhook ${file}: ${result.error}`);
                }
                worker.terminate();
            });

            worker.on('error', async (err) => {
                console.warn(`Error trying to resend webhook ${file}:`, err.message);
                worker.terminate();
            });
        }
    } catch (err) {
        console.error("Error processing webhook queue:", err);
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
        console.error(`Error removing webhooks for instance ${instanceName}:`, err);
    }
}

export function startWebhookRetryLoop(getInstanceStatus: (name: string) => "ONLINE" | "OFFLINE" | "REMOVED") {
    setInterval(() => {
        processWebhookQueue(getInstanceStatus);
    }, UserConfig.webhook_interval);
}
