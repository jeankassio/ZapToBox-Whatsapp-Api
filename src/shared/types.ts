import {WASocket} from "@whiskeysockets/baileys";

export type ConnectionStatus = "ONLINE" | "OFFLINE" | "REMOVED";
export type StatusPresence = "available" | "unavailable" | "composing" | "recording" | "paused";

export interface InstanceInfo {
  instanceName: string;
  owner: string;
  connectionStatus: ConnectionStatus;
  profilePictureUrl?: string | undefined;
}

export interface InstanceData extends InstanceInfo{
  socket?: WASocket;
}

export interface WebhookPayload {
  event: string;
  instance: InstanceInfo;
  data: any[];
  targetUrl: string;
}

export interface ProxyAgent{
  wsAgent?: any,
  fetchAgent?: any
}

export interface Contact{
  jid?: string;
  name?: string;
  lid?: string;
}
