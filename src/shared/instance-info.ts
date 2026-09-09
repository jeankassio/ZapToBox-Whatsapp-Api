import type { ConnectionStatus, InstanceData, InstanceInfo } from './types.js';

let lastTimestamp = 0;
/** Keep lifecycle observations ordered even when several arrive in the same millisecond. */
export function connectionTimestamp(): string {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp).toISOString();
}

export function updateConnectionStatus(instance: InstanceData, status: ConnectionStatus): void {
  if (instance.connectionStatus !== status || !instance.connectionUpdatedAt) instance.connectionUpdatedAt = connectionTimestamp();
  instance.connectionStatus = status;
}

/** Runtime instance data also owns the socket and its credentials. Only expose these fields. */
export function publicInstanceInfo(instance: InstanceData): InstanceInfo {
  updateConnectionStatus(instance, instance.connectionStatus === 'ONLINE' && instance.socket?.ws?.isOpen === false ? 'OFFLINE' : instance.connectionStatus);
  return {
    owner: instance.owner,
    instanceName: instance.instanceName,
    connectionStatus: instance.connectionStatus,
    connectionUpdatedAt: instance.connectionUpdatedAt!,
    ...(instance.profilePictureUrl === undefined ? {} : { profilePictureUrl: instance.profilePictureUrl }),
    instanceJid: instance.instanceJid ?? null,
  };
}
