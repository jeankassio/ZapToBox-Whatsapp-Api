import type { InstanceInfo } from './types.js';

/** Runtime instance data also owns the socket and its credentials. Only expose these fields. */
export function publicInstanceInfo(instance: InstanceInfo): InstanceInfo {
  return {
    owner: instance.owner,
    instanceName: instance.instanceName,
    connectionStatus: instance.connectionStatus,
    ...(instance.profilePictureUrl === undefined ? {} : { profilePictureUrl: instance.profilePictureUrl }),
    instanceJid: instance.instanceJid ?? null,
  };
}
