import type { ConnectionState, ConnectionStatus, InstanceData, InstanceInfo } from './types.js';

let lastTimestamp = 0;
/** Keep lifecycle observations ordered even when several arrive in the same millisecond. */
export function connectionTimestamp(): string {
  lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
  return new Date(lastTimestamp).toISOString();
}

export function updateConnectionStatus(instance: InstanceData, status: ConnectionStatus, state: ConnectionState = status === 'ONLINE' ? 'connected' : 'disconnected'): void {
  if (instance.connectionStatus !== status || instance.connectionState !== state || !instance.connectionUpdatedAt) instance.connectionUpdatedAt = connectionTimestamp();
  instance.connectionStatus = status;
  instance.connectionState = state;
}

/** Runtime instance data also owns the socket and its credentials. Only expose these fields. */
export function publicInstanceInfo(instance: InstanceData): InstanceInfo {
  // Status reads cannot turn a momentarily closed transport into a permanent
  // lifecycle transition. The socket owner alone timestamps those transitions.
  const transportClosed = instance.connectionStatus === 'ONLINE' && instance.socket?.ws?.isOpen === false;
  return {
    owner: instance.owner,
    instanceName: instance.instanceName,
    connectionStatus: transportClosed ? 'OFFLINE' : instance.connectionStatus,
    connectionState: transportClosed ? 'reconnecting' : instance.connectionState ?? (instance.connectionStatus === 'ONLINE' ? 'connected' : 'disconnected'),
    connectionUpdatedAt: instance.connectionUpdatedAt ?? new Date(0).toISOString(),
    ...(instance.profilePictureUrl === undefined ? {} : { profilePictureUrl: instance.profilePictureUrl }),
    instanceJid: instance.instanceJid ?? null,
  };
}
