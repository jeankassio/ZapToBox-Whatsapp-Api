import type { WASocket } from '@whiskeysockets/baileys';
import PrismaConnection, { prisma } from '../../../core/connection/prisma.js';
import { SocketController, type ControllerDependencies, type ControllerResult } from './base.js';
import { groupSpaceRecord, isNewsletter, newsletterSpaceRecord, sectionsFromRecords, type SpaceRecord } from '../../mappers/spaces.js';
import { groupSpaceChangesSince, groupSpaceRevision } from '../../baileys/sections-state.js';

export type SectionsDependencies = ControllerDependencies & {
  readSpaces?: (instance: string) => Promise<SpaceRecord[]>;
  saveSpaces?: (instance: string, rows: SpaceRecord[]) => Promise<void>;
  timeoutMs?: number;
};
const current = new WeakMap<WASocket, Map<string, { expiresAt: number; observation: { revision: number }; result: Promise<ControllerResult> }>>();
const observedLimit = 1000;
async function readSpaces(instance: string): Promise<SpaceRecord[]> {
  const [chats, messages] = await Promise.all([
    prisma.chat.findMany({ where: { instance, OR: [{ jid: { endsWith: '@g.us' } }, { jid: { endsWith: '@newsletter' } }] }, orderBy: { id: 'desc' }, take: observedLimit + 1 }),
    prisma.message.findMany({ where: { instance, remoteJid: { endsWith: '@newsletter' } }, distinct: ['remoteJid'], select: { remoteJid: true }, take: 201 }),
  ]);
  const records = new Map(chats.map(row => [row.jid, { ...row.data as object, id: row.jid }]));
  for (const row of messages) if (!records.has(row.remoteJid)) records.set(row.remoteJid, { id: row.remoteJid });
  return [...records.values()];
}
async function timeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Provider catalog timed out')), ms); })]); }
  finally { clearTimeout(timer!); }
}

/** Queries metadata only; never follows a channel, joins a group or reads messages. */
export default class SectionsController extends SocketController {
  private readonly readSpaces: NonNullable<SectionsDependencies['readSpaces']>;
  private readonly saveSpaces: NonNullable<SectionsDependencies['saveSpaces']>;
  private readonly timeoutMs: number;
  constructor(owner: string, name: string, dependencies: SectionsDependencies = {}) {
    super(owner, name, dependencies);
    this.readSpaces = dependencies.readSpaces ?? readSpaces;
    this.saveSpaces = dependencies.saveSpaces ?? ((instance, rows) => PrismaConnection.saveManyChats(instance, rows));
    this.timeoutMs = dependencies.timeoutMs ?? 2000;
  }
  async getSections(): Promise<ControllerResult> {
    let socket: WASocket | undefined;
    try { socket = this.sock; } catch { /* Persisted observations remain usable offline. */ }
    if (socket) {
      const cache = current.get(socket) ?? new Map();
      current.set(socket, cache);
      const previous = cache.get(this.instance);
      const revision = groupSpaceRevision(socket, this.instance);
      if (previous && previous.observation.revision === revision && previous.expiresAt > Date.now()) return previous.result;
      const observation = { revision };
      const result = this.collect(socket, observation);
      cache.set(this.instance, { result, observation, expiresAt: Date.now() + 60_000 });
      void result.catch(() => { if (cache.get(this.instance)?.result === result) cache.delete(this.instance); });
      return result;
    }
    return this.collect();
  }
  private async collect(socket?: WASocket, observation?: { revision: number }): Promise<ControllerResult> {
    const revision = observation?.revision ?? 0;
    const stored = await this.readSpaces(this.instance);
    const records = new Map(stored.map(row => [row.id, row]));
    const limitations = ['NEWSLETTER_OBSERVED_ONLY', 'STATUS_RECEIVED_ONLY'];
    let partial = stored.length > observedLimit, available = Boolean(socket);
    const updates: SpaceRecord[] = [];
    if (socket) {
      const groups = async () => {
        const results = await Promise.allSettled([
          timeout(socket.groupFetchAllParticipating(), this.timeoutMs * 4),
          timeout(socket.communityFetchAllParticipating(), this.timeoutMs * 4),
        ]);
        let successful = 0;
        for (const result of results) {
          if (result.status === 'rejected') { partial = true; limitations.push('COMMUNITY_METADATA_UNAVAILABLE'); continue; }
          successful++;
          for (const group of Object.values(result.value).slice(0, observedLimit)) updates.push(groupSpaceRecord(group, true));
          if (Object.keys(result.value).length > observedLimit) partial = true;
        }
        if (!successful) available = false;
      };
      const channels = async () => {
        const known = [...records.values()].filter(row => isNewsletter(row.id));
        if (known.length > 20) { partial = true; limitations.push('CHANNEL_METADATA_BATCH_LIMIT'); }
        let index = 0;
        await Promise.all(Array.from({ length: Math.min(4, known.length) }, async () => {
          while (index < Math.min(20, known.length)) {
            const row = known[index++]!;
            try {
              const metadata = newsletterSpaceRecord(row.id, await timeout(socket.newsletterMetadata('jid', row.id), this.timeoutMs));
              if (!metadata) throw new Error('No channel metadata');
              updates.push(metadata);
            } catch { partial = true; limitations.push('CHANNEL_METADATA_UNAVAILABLE'); }
          }
        }));
      };
      await Promise.all([groups(), channels()]);
      const changes = groupSpaceChangesSince(socket, this.instance, revision);
      if (!changes.complete) { updates.length = 0; partial = true; }
      const latest = new Map(updates.map(row => [row.id, row]));
      for (const row of changes.rows) latest.set(row.id, { ...latest.get(row.id), ...row });
      updates.splice(0, updates.length, ...latest.values());
      try { if (this.sock !== socket) { available = false; updates.length = 0; } } catch { available = false; updates.length = 0; }
      if (updates.length) await this.saveSpaces(this.instance, updates);
      for (const row of updates) records.set(row.id, { ...records.get(row.id), ...row });
      if (available) for (const row of groupSpaceChangesSince(socket, this.instance, revision).rows) records.set(row.id, { ...records.get(row.id), ...row });
    } else limitations.push('CONNECTION_UNAVAILABLE');
    const relevant = [...records.values()].filter(row => isNewsletter(row.id) || row.isCommunity === true || row.isCommunityAnnounce === true || typeof row.linkedParent === 'string');
    if (relevant.length > observedLimit) partial = true;
    if (partial) limitations.push('PARTIAL_CATALOG');
    const data = sectionsFromRecords(relevant.slice(0, observedLimit));
    const groupRecords = [...records.values()].filter(row => row.id.endsWith('@g.us'));
    if (groupRecords.length > observedLimit) { partial = true; if (!limitations.includes('PARTIAL_CATALOG')) limitations.push('PARTIAL_CATALOG'); }
    data.groups = sectionsFromRecords(groupRecords.slice(0, observedLimit)).groups;
    if (socket && observation) observation.revision = groupSpaceRevision(socket, this.instance);
    return { success: true, data: { ...data, observedAt: new Date().toISOString(), available, partial, limitations: [...new Set(limitations)] } };
  }
}
