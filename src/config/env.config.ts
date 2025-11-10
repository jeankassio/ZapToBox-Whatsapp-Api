import dotenv from "dotenv";
dotenv.config();

export const SessionFolderName = process.env.SESSION_FOLDER_NAME || "sessions";
export const PortConfig = process.env.PORT || 3005;
export const JwtToken = process.env.JWT_TOKEN || "";
export const WebhookUrl = process.env.WEBHOOK_URL || "http://localhost";
export const SessionClient = process.env.SESSION || "Linux";
export const SessionName = process.env.PHONE_NAME || "Chrome";
export const ProxyUrl = process.env.PROXY_URL;