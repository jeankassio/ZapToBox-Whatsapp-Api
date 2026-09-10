import type { GroupMetadata } from '@whiskeysockets/baileys';

export type SpaceRecord = { id: string; [key: string]: unknown };
export const isNewsletter = (jid: unknown): jid is string => typeof jid === 'string' && /^\d{5,30}@newsletter$/.test(jid);
const isGroup = (jid: unknown): jid is string => typeof jid === 'string' && /^\d{5,30}(?:-\d{1,20})?@g\.us$/.test(jid);
const text = (value: unknown, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';

/** Full provider replies can clear fields; partial events must preserve omitted fields. */
export function groupSpaceRecord(group: Partial<GroupMetadata> & { id: string }, complete = false): SpaceRecord {
  return { id: group.id, ...(group.subject === undefined ? {} : { name: group.subject, subject: group.subject }),
    ...(complete ? { description: group.desc ?? '', isCommunity: group.isCommunity === true,
      isCommunityAnnounce: group.isCommunityAnnounce === true, linkedParent: group.linkedParent ?? null, announce: group.announce === true } : {
      ...(group.desc === undefined ? {} : { description: group.desc }),
      ...(group.isCommunity === undefined ? {} : { isCommunity: group.isCommunity }),
      ...(group.isCommunityAnnounce === undefined ? {} : { isCommunityAnnounce: group.isCommunityAnnounce }),
      ...(group.linkedParent === undefined ? {} : { linkedParent: group.linkedParent }),
      ...(group.announce === undefined ? {} : { announce: group.announce }) }) };
}

/** Baileys also emits its full fetch responses as groups.update. */
export function isCompleteGroupMetadata(group: Partial<GroupMetadata>) {
  return Array.isArray(group.participants) && typeof group.isCommunity === 'boolean' && typeof group.isCommunityAnnounce === 'boolean' && typeof group.announce === 'boolean';
}

export function newsletterSpaceRecord(jid: string, value: unknown): SpaceRecord | null {
  if (!isNewsletter(jid) || !value || typeof value !== 'object') return null;
  const metadata = value as Record<string, any>;
  if (metadata.id !== jid) return null;
  const thread = metadata.thread_metadata ?? {};
  const name = text(metadata.name) || text(thread.name?.text ?? thread.name);
  const description = text(metadata.description, 2048) || text(thread.description?.text ?? thread.description, 2048);
  return { id: jid, name: name || jid, description, readOnly: true, spaceKind: 'channel' };
}

export function sectionsFromRecords(records: SpaceRecord[]) {
  const channels = records.filter(row => isNewsletter(row.id)).map(row => ({ jid: row.id,
    name: text(row.name) || text(row.subject) || row.id, description: text(row.description, 2048), readOnly: true }));
  const groups = records.filter(row => isGroup(row.id));
  const parents = new Map(groups.filter(row => row.isCommunity === true).map(row => [row.id, row]));
  for (const row of groups) if (isGroup(row.linkedParent) && !parents.has(row.linkedParent)) parents.set(row.linkedParent, { id: row.linkedParent });
  const communities = [...parents.values()].map(parent => ({ jid: parent.id,
    name: text(parent.name) || text(parent.subject) || parent.id, description: text(parent.description ?? parent.desc, 2048), readOnly: true,
    groups: groups.filter(group => group.linkedParent === parent.id && group.id !== parent.id).map(group => ({ jid: group.id,
      name: text(group.name) || text(group.subject) || group.id, linkedParent: parent.id,
      isCommunityAnnounce: group.isCommunityAnnounce === true, readOnly: group.isCommunityAnnounce === true || group.announce === true })) }));
  // Explicit null/false records carry removals even when a group leaves the tree.
  const groupRecords = groups.map(group => ({ jid: group.id, name: text(group.name) || text(group.subject) || group.id,
    ...(group.description === undefined && group.desc === undefined ? {} : { description: text(group.description ?? group.desc, 2048) }),
    ...(typeof group.isCommunity === 'boolean' ? { isCommunity: group.isCommunity } : {}),
    ...(group.linkedParent === null || isGroup(group.linkedParent) ? { linkedParent: group.linkedParent } : {}),
    ...(typeof group.isCommunityAnnounce === 'boolean' ? { isCommunityAnnounce: group.isCommunityAnnounce } : {}),
    ...(typeof group.announce === 'boolean' ? { announce: group.announce } : {}),
    ...(typeof group.isCommunity === 'boolean' || typeof group.isCommunityAnnounce === 'boolean' || typeof group.announce === 'boolean'
      ? { readOnly: group.isCommunity === true || group.isCommunityAnnounce === true || group.announce === true } : {}) }));
  return { channels, communities, groups: groupRecords };
}
