// src/types/instance.ts
import {WASocket} from "@whiskeysockets/baileys";

export type ConnectionStatus = "ONLINE" | "OFFLINE" | "REMOVED";

export interface InstanceInfo {
  instanceName: string;
  owner: string;
  connectionStatus: ConnectionStatus;
  profilePictureUrl?: string | undefined;
}

export interface InstanceData extends InstanceInfo{
    socket?: WASocket;
}
