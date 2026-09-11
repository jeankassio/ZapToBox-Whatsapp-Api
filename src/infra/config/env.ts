import dotenv from "dotenv";
dotenv.config({ quiet: true });
import { readWhatsAppOptions } from "./whatsapp-options.js";
const whatsappOptions = readWhatsAppOptions(process.env);

function numberEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error('Invalid ' + name);
  return value;
}

export default class UserConfig {
  static sessionFolderName = process.env.SESSION_FOLDER_NAME || "sessions";
  static portConfig = String(numberEnv("PORT", 3001, 1, 65535));
  static host = process.env.HOST || "127.0.0.1";
  static jwtToken = process.env.JWT_TOKEN || "";
  static webhookUrl = process.env.WEBHOOK_URL || "";
  static webhookSecret = process.env.WEBHOOK_SECRET || "";
  static whatsapp = whatsappOptions;
  static sessionClient = whatsappOptions.browser[0];
  static sessionName = whatsappOptions.browser[1];
  static proxyUrl = process.env.PROXY_URL || undefined;
  static useWebhookQueue = process.env.WEBHOOK_QUEUE !== "false";
  static webhook_queue_dir = process.env.WEBHOOK_QUEUE_DIR || "./webhook-queue";
  // QUEUE_INTERVAL retains the original unit: minutes.
  static webhook_interval = numberEnv("QUEUE_INTERVAL", 0.1, 0.01, 1440) * 60_000;
  static webhookTimeoutMs = numberEnv("WEBHOOK_TIMEOUT_MS", 10_000, 100, 60_000);
  static webhookMaxAttempts = numberEnv("WEBHOOK_MAX_ATTEMPTS", 30, 1, 1000);
  static webhookConcurrency = numberEnv("WEBHOOK_CONCURRENCY", 4, 1, 32);
  static qrCodeLimit = numberEnv("QRCODE_LIMIT", 5, 1, 100);
  static qrCodeTimeout = numberEnv("QRCODE_TIMEOUT", 20, 5, 120);
  static authStore = process.env.AUTH_STORE || "database";
  static bodyLimit = process.env.HTTP_BODY_LIMIT || "16mb";

  static validate(): void {
    if (this.jwtToken.length < 32 || /^(yourtoken|change[-_]?me|replace[-_]?me)/i.test(this.jwtToken)) {
      throw new Error("Set JWT_TOKEN to a random secret with at least 32 characters");
    }
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
    if (!["database", "filesystem"].includes(this.authStore)) throw new Error("Invalid AUTH_STORE");
    for (const value of (process.env.TRUSTED_MEDIA_ORIGINS || '').split(',').map(item => item.trim()).filter(Boolean)) {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash || url.pathname !== '/' || url.search) throw new Error("TRUSTED_MEDIA_ORIGINS must contain exact HTTP(S) origins");
    }
    if (this.webhookUrl) {
      const url = new URL(this.webhookUrl);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) {
        throw new Error("WEBHOOK_URL must be an HTTP(S) URL without credentials or fragment");
      }
      if (this.webhookSecret.length < 32) throw new Error("WEBHOOK_SECRET must have at least 32 characters");
    }
  }
}
