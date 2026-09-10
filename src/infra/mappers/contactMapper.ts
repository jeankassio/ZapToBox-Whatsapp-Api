import type { Contact } from '../../shared/types.js';

type NameMetadata = { savedName?: string | null; savedNameUpdatedAt?: string; notify?: string | null; verifiedName?: string | null; legacyName?: string | null };
type ContactRow = { jid?: string | null; lid?: string | null; name?: string | null; nameMetadata?: unknown };
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) || null : null;
const time = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const suppliedName = (contact: Contact) => contact.savedName !== undefined ? contact.savedName : !contact.nameSource || contact.nameSource === 'saved' ? contact.name : undefined;

/** Capture source and time when the provider event arrives, before queued imports. */
export function observeContact<T extends Contact>(contact: T, observedAt: string): T & Contact {
  const supplied = suppliedName(contact);
  return { ...contact, ...(typeof supplied === 'string' || supplied === null ? {
    name: clean(supplied), savedName: clean(supplied), savedNameUpdatedAt: time(contact.savedNameUpdatedAt) ?? observedAt,
    ...(clean(supplied) ? { nameSource: 'saved' as const } : {}) } : {}) };
}

export function contactNames(row: ContactRow): NameMetadata {
  const data = object(row.nameMetadata);
  if (!Object.keys(data).length) return row.name ? { legacyName: clean(row.name) } : {};
  const savedNameUpdatedAt = time(data.savedNameUpdatedAt);
  return { ...(data.savedName === null || typeof data.savedName === 'string' ? { savedName: clean(data.savedName), ...(savedNameUpdatedAt ? { savedNameUpdatedAt } : {}) } : {}),
    ...(typeof data.notify === 'string' || data.notify === null ? { notify: clean(data.notify) } : {}),
    ...(typeof data.verifiedName === 'string' || data.verifiedName === null ? { verifiedName: clean(data.verifiedName) } : {}),
    ...(typeof data.legacyName === 'string' || data.legacyName === null ? { legacyName: clean(data.legacyName) } : {}) };
}

/** Alias merges and replay use the original observed time, never replay time. */
export function mergeContactNames(rows: ContactRow[], contact: Contact, observedAt = new Date().toISOString()) {
  const all = rows.map(contactNames), metadata: NameMetadata = {};
  const prior = all.filter(names => names.savedName !== undefined).sort((a, b) => (Date.parse(b.savedNameUpdatedAt ?? '') || 0) - (Date.parse(a.savedNameUpdatedAt ?? '') || 0))[0];
  if (prior?.savedName !== undefined) { metadata.savedName = prior.savedName; if (prior.savedNameUpdatedAt) metadata.savedNameUpdatedAt = prior.savedNameUpdatedAt; }
  for (const key of ['notify', 'verifiedName', 'legacyName'] as const) {
    const value = contact[key] !== undefined ? clean(contact[key]) : all.find(names => names[key])?.[key];
    if (value !== undefined) metadata[key] = value;
  }
  const supplied = suppliedName(contact);
  if (typeof supplied === 'string' || supplied === null) {
    const value = clean(supplied), incomingTime = time(contact.savedNameUpdatedAt) ?? new Date(Math.max(Date.parse(observedAt), (Date.parse(prior?.savedNameUpdatedAt ?? '') || 0) + 1)).toISOString();
    if (!prior || Date.parse(incomingTime) > (Date.parse(prior.savedNameUpdatedAt ?? '') || 0)) {
      metadata.savedName = value;
      // A newer observation advances the watermark even if its text is equal:
      // A@t1 -> A@t3 must reject a delayed B@t2 replay.
      metadata.savedNameUpdatedAt = incomingTime;
    }
    // An explicit address-book change supersedes an unclassified legacy label.
    delete metadata.legacyName;
  }
  if (metadata.savedName !== undefined) delete metadata.legacyName;
  return { name: metadata.savedName || metadata.notify || metadata.verifiedName || metadata.legacyName || null, nameMetadata: metadata };
}

export class ContactMapper {
  static event(row: ContactRow, original: Contact): Contact {
    const stored = this.toContact(row), event = { ...original, ...stored };
    if (stored.savedName === undefined) { delete event.name; delete event.savedName; delete event.savedNameUpdatedAt; }
    if (!stored.nameSource) delete event.nameSource;
    return event;
  }
  static toContact(row: ContactRow): Contact {
    const pn = row.jid?.endsWith('@s.whatsapp.net') ? row.jid : undefined;
    const lid = row.lid || (row.jid?.endsWith('@lid') ? row.jid : undefined);
    const id = lid || pn || row.jid;
    if (!id) throw new Error('Contact has no WhatsApp identifier');
    const names = contactNames(row);
    const nameSource = names.savedName ? 'saved' : names.notify ? 'notify' : names.verifiedName ? 'verified' : names.legacyName ? 'legacy' : undefined;
    return { id, ...(pn && id !== pn ? { phoneNumber: pn } : {}), ...(lid && id !== lid ? { lid } : {}),
      ...names, ...(names.savedName !== undefined ? { name: names.savedName } : {}), ...(nameSource ? { nameSource } : {}) };
  }
}
