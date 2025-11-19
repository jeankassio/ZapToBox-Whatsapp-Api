import dotenv from "dotenv";
dotenv.config();

export default class UserConfig{

    static sessionFolderName: string = process.env.SESSION_FOLDER_NAME || "sessions";
    static portConfig: string = process.env.PORT || "3000";
    static jwtToken: string = process.env.JWT_TOKEN || "";
    static webhookUrl: string  = process.env.WEBHOOK_URL || "https://localhost";
    static sessionClient: string = process.env.SESSION || "Linux";
    static sessionName: string = process.env.PHONE_NAME || "Edge";
    static proxyUrl: (string | undefined) = process.env.PROXY_URL;
    static webhook_queue_dir: string = process.env.WEBHOOK_QUEUE_DIR || "./webhook";
    static webhook_interval: number = (Number(process.env.QUEUE_INTERVAL) * 60 * 1000) || 5 * 60 * 1000;
    static qrCodeLimit: number = Number(process.env.QRCODE_LIMIT || 5);
    static qrCodeTimeout: number = Number(process.env.QRCODE_TIMEOUT || 20);

}