import path from "path";
import { ConnectionStatus, InstanceData } from "./types.js";
import type Instance from "../infra/baileys/services.js";
import UserConfig from "../infra/config/env.js";
import { BaileysEventMap } from "@whiskeysockets/baileys";

export const SessionFolderName = UserConfig.sessionFolderName;
export const sessionsPath = path.resolve(process.cwd(), SessionFolderName);

export const instanceConnection: Record<string, InstanceData> = Object.create(null);
export const instanceStatus = new Map<string, ConnectionStatus>();
export const instances: Record<string, Instance> = Object.create(null);

export const baileysEvents = [
    "creds.update",
    "connection.update",
    "messaging-history.set",
    "chats.upsert",
    "chats.update",
    "chats.delete",
    "lid-mapping.update",
    "presence.update",
    "contacts.upsert",
    "contacts.update",
    "messages.upsert",
    "messages.update",
    "messages.delete",
    "messages.media-update",
    "messages.reaction",
    "message-receipt.update",
    "groups.upsert",
    "groups.update",
    "group-participants.update",
    "group.join-request",
    "blocklist.set",
    "blocklist.update",
    "call",
    "labels.edit",
    "labels.association",
    "newsletter.reaction",
    "newsletter.view",
    "newsletter-participants.update",
    "newsletter-settings.update",
] as const satisfies (keyof BaileysEventMap)[]
