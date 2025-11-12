import path from "path";
import { ConnectionStatus, InstanceData } from "./types";
import Instance from "../infra/baileys/services";

export const SessionFolderName = "sessions";
export const sessionsPath = path.join(__dirname, "..", SessionFolderName);

export const instanceConnection: Record<string, InstanceData> = {};
export const instanceStatus = new Map<string, ConnectionStatus>();
export const instances: Record<string, Instance> = {};
