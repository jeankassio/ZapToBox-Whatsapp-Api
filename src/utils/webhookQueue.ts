import fs from "fs/promises";
import path from "path";
import { WebhookPayload } from "../types/webhook";

const WEBHOOK_DIR = path.resolve("./webhook");
const RETRY_INTERVAL_MS = 60 * 1000; // 1 minuto


async function ensureDir() {
  try {
    await fs.mkdir(WEBHOOK_DIR, { recursive: true });
  } catch (err) {
    console.error("Erro ao criar diretório de webhooks:", err);
  }
}

export async function saveWebhookEvent(payload: WebhookPayload) {
  try {
    await ensureDir();
    const filename = `${payload.instance.instanceName}-${Date.now()}.json`;
    const filePath = path.join(WEBHOOK_DIR, filename);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
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
    const files = await fs.readdir(WEBHOOK_DIR);

    for (const file of files) {
      const filePath = path.join(WEBHOOK_DIR, file);
      const raw = await fs.readFile(filePath, "utf8");
      const payload: WebhookPayload = JSON.parse(raw);

      const status = getInstanceStatus(payload.instance.instanceName);
      if (status === "REMOVED") {
        await fs.unlink(filePath);
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
          await fs.unlink(filePath);
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

/**
 * Remove todos os webhooks vinculados a uma instância específica
 */
export async function clearInstanceWebhooks(instanceName: string) {
  try {
    await ensureDir();
    const files = await fs.readdir(WEBHOOK_DIR);
    const related = files.filter(f => f.startsWith(`${instanceName}-`));

    for (const file of related) {
      await fs.unlink(path.join(WEBHOOK_DIR, file));
    }
  } catch (err) {
    console.error(`Erro ao remover webhooks da instância ${instanceName}:`, err);
  }
}

/**
 * Inicia o loop automático de reenvio
 */
export function startWebhookRetryLoop(getInstanceStatus: (name: string) => "ONLINE" | "OFFLINE" | "REMOVED") {
  setInterval(() => {
    processWebhookQueue(getInstanceStatus);
  }, RETRY_INTERVAL_MS);
}
