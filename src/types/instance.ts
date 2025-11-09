// src/types/instance.ts
export type ConnectionStatus = "ONLINE" | "OFFLINE";

export interface InstanceInfo {
  instanceName: string;
  owner: string;
  connectionStatus: ConnectionStatus;
  profilePictureUrl?: string | undefined;
}
