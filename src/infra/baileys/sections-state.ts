import type { WASocket } from '@whiskeysockets/baileys';
import type { SpaceRecord } from '../mappers/spaces.js';

type Change = { revision: number; row: SpaceRecord };
const states = new WeakMap<WASocket, Map<string, { revision: number; changes: Change[] }>>();
function state(socket: WASocket, instance: string) {
  let instances = states.get(socket); if (!instances) { instances = new Map(); states.set(socket, instances); }
  let value = instances.get(instance); if (!value) { value = { revision: 0, changes: [] }; instances.set(instance, value); }
  return value;
}

/** Capture arrivals before the persistence/webhook queue, which may be importing history. */
export function noteGroupSpaceChanges(socket: WASocket, instance: string, rows: SpaceRecord[]) {
  const value = state(socket, instance);
  for (const row of rows) value.changes.push({ revision: ++value.revision, row });
  if (value.changes.length > 2000) value.changes.splice(0, value.changes.length - 2000);
}
export const groupSpaceRevision = (socket: WASocket, instance: string) => state(socket, instance).revision;
export function groupSpaceChangesSince(socket: WASocket, instance: string, revision: number) {
  const value = state(socket, instance);
  return { complete: !value.changes.length || value.changes[0]!.revision <= revision + 1,
    rows: value.changes.filter(change => change.revision > revision).map(change => change.row) };
}
