// src/utils/webhook.ts
import axios from "axios";
import dotenv from "dotenv";
import { InstanceInfo } from "../types/instance";
import { saveWebhookEvent, startWebhookRetryLoop, clearInstanceWebhooks } from "../utils/webhookQueue";
import { InstanceData } from "../types/instance";

dotenv.config();

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