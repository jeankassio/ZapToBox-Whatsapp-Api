import path from "path";
import { ConnectionStatus, InstanceData } from "./types";
import Instance from "../infra/baileys/services";
import UserConfig from "../infra/config/env";

export const SessionFolderName = UserConfig.sessionFolderName;
export const sessionsPath = path.join(__dirname, "../..", SessionFolderName);

export const instanceConnection: Record<string, InstanceData> = {};
export const instanceStatus = new Map<string, ConnectionStatus>();
export const instances: Record<string, Instance> = {};

export const qrCodeLimit: number = UserConfig.qrCodeLimit;