import { BoundedCache } from '../../shared/bounded-cache.js';
import { RequestError } from '../http/controllers/base.js';

export type ContactPresence = { lastKnownPresence: 'available' | 'unavailable' | 'composing' | 'recording' | 'paused'; lastSeen?: number };
export interface PresenceSnapshot { id: string; presences: Record<string, ContactPresence>; observedAt: string | null; expiresAt: string | null }
const TTL_MS = 90_000, SUBSCRIBE_MS = 30_000, MAXIMUM = 128;
const states = new Set(['available', 'unavailable', 'composing', 'recording', 'paused']);
export function presenceJid(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{5,20}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid)$/.test(value) ? value.replace(/:\d+@/, '@') : undefined;
}
const empty = (id: string): PresenceSnapshot => ({ id, presences: {}, observedAt: null, expiresAt: null });

/** Ephemeral derived state: owned by one instance and cleared with its socket. */
export class PresenceState {
  private readonly snapshots: BoundedCache;
  private readonly targets = new Map<string, { aliases: Set<string>; expires: number }>();
  private readonly requests = new Map<string, { completed?: number; pending?: Promise<void> }>();
  private epoch = 0;
  constructor(private readonly now = Date.now, private readonly timeoutMs = 4000) { this.snapshots = new BoundedCache(MAXIMUM, TTL_MS / 1000, now); }
  clear(): void { this.epoch++; this.snapshots.flushAll(); this.targets.clear(); this.requests.clear(); }
  link(id: string, aliases: string[]): void {
    const known = new Set([id, ...aliases.map(presenceJid).filter((item): item is string => Boolean(item))]);
    this.targets.delete(id);
    while (this.targets.size >= MAXIMUM) this.targets.delete(this.targets.keys().next().value!);
    this.targets.set(id, { aliases: known, expires: this.now() + TTL_MS });
  }
  snapshot(id: string): PresenceSnapshot {
    const target = this.targets.get(id), aliases = target && target.expires > this.now() ? target.aliases : new Set([id]);
    let newest: PresenceSnapshot | undefined;
    for (const alias of aliases) {
      const snapshot = this.snapshots.get<PresenceSnapshot>(alias);
      if (snapshot && (!newest || snapshot.observedAt! > newest.observedAt!)) newest = snapshot;
    }
    return newest ? this.forTarget(newest, id, aliases) : empty(id);
  }
  private forTarget(snapshot: PresenceSnapshot, id: string, aliases: Set<string>): PresenceSnapshot {
    const presences: Record<string, ContactPresence> = {};
    for (const [author, presence] of Object.entries(snapshot.presences)) if (aliases.has(author)) presences[id] = { ...presence };
    return Object.keys(presences).length ? { id, presences, observedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt } : empty(id);
  }
  observe(data: { id?: unknown; presences?: unknown }): PresenceSnapshot[] {
    const id = presenceJid(data.id), now = this.now();
    if (!id || !data.presences || typeof data.presences !== 'object' || Array.isArray(data.presences)) return [];
    const presences: Record<string, ContactPresence> = {};
    for (const [rawAuthor, value] of Object.entries(data.presences).slice(0, MAXIMUM)) {
      const author = presenceJid(rawAuthor), presence = value as Partial<ContactPresence> | null;
      if (!author || !presence || !states.has(String(presence.lastKnownPresence))) continue;
      const lastSeen = presence.lastSeen;
      presences[author] = { lastKnownPresence: presence.lastKnownPresence!, ...(typeof lastSeen === 'number' && Number.isSafeInteger(lastSeen) && lastSeen > 0 && lastSeen <= Math.floor(now / 1000) ? { lastSeen } : {}) };
    }
    if (!Object.keys(presences).length) return [];
    const snapshot: PresenceSnapshot = { id, presences, observedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_MS).toISOString() };
    this.snapshots.set(id, snapshot);
    const deliveries: PresenceSnapshot[] = [];
    for (const [targetId, target] of this.targets) {
      if (target.expires <= now) { this.targets.delete(targetId); continue; }
      if (target.aliases.has(id)) {
        const correlated = this.forTarget(snapshot, targetId, target.aliases);
        if (correlated.observedAt) deliveries.push(correlated);
      }
    }
    return deliveries.length ? deliveries : [structuredClone(snapshot)];
  }
  async subscribe(id: string, action: (active: () => boolean) => Promise<void>): Promise<PresenceSnapshot> {
    const existing = this.requests.get(id);
    if (existing?.pending) { await existing.pending; return this.snapshot(id); }
    if (existing?.completed !== undefined && this.now() - existing.completed < SUBSCRIBE_MS) return this.snapshot(id);
    if (!existing) {
      if (this.requests.size >= MAXIMUM) {
        const evict = [...this.requests].find(([, request]) => !request.pending);
        if (!evict) throw new RequestError(429, 'Too many pending presence subscriptions.');
        this.requests.delete(evict[0]);
      }
      this.link(id, [id]);
    }
    const request: { completed?: number; pending?: Promise<void> } = { ...existing }, epoch = this.epoch;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    const work = Promise.resolve().then(() => action(() => !expired && epoch === this.epoch));
    const pending = Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new RequestError(504, 'Presence subscription timed out.')); }, this.timeoutMs);
    })]).then(() => { if (epoch !== this.epoch) throw new RequestError(409, 'Instance connection changed during presence subscription.'); request.completed = this.now(); });
    request.pending = pending; this.requests.set(id, request);
    try { await pending; return this.snapshot(id); }
    finally {
      if (timer) clearTimeout(timer);
      const settled = () => { if (this.requests.get(id) === request) { delete request.pending; if (request.completed === undefined) this.requests.delete(id); } };
      // Keep timed-out work deduplicated/counted until it actually settles. A
      // hung provider call must not spawn an unbounded new request on every poll.
      if (expired) void work.finally(settled).catch(() => {}); else settled();
    }
  }
}
