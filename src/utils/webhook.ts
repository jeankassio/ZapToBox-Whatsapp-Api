// src/utils/webhook.ts
import axios from "axios";
import dotenv from "dotenv";
import { InstanceInfo } from "../types/instance";

dotenv.config();

export async function sendWebhook(event: string, instance: InstanceInfo, data: any[]) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return; // evita erros se não estiver configurado

  const payload = {
    event,
    instance,
    data,
  };

  try {
    await axios.post(url, payload, { timeout: 5000 });
  } catch (err: any) {
    console.error(`[Webhook] Falha ao enviar evento ${event}:`, err?.message || err);
  }
}
