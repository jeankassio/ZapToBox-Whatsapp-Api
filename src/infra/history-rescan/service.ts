import { apiLogger } from '../logging/logger.js';
import { createHash, randomUUID } from 'node:crypto';
import { instanceKey, splitInstanceKey } from '../../shared/identity.js';
import type { HistoryChunkMetadata, InstanceInfo } from '../../shared/types.js';
import { jsonValue } from '../../shared/serialization.js';
import { webhookChunks } from '../webhook/chunks.js';
import { RequestError } from '../http/controllers/base.js';

export const RESCAN_KINDS = ['contacts', 'chats', 'messages'] as const;
export type RescanKind = typeof RESCAN_KINDS[number];
export type RescanCounts = Record<RescanKind, number>;
export interface RescanState {
  phase: RescanKind | 'done'; cursor: RescanCounts; max: RescanCounts; available: RescanCounts;
  scanned: RescanCounts; counts: RescanCounts; chunks: number; sequence: number;
  connectionUpdatedAt?: string;
}
export interface RescanEvent {
  id: string; timestamp: string; event: string; data: unknown; history?: HistoryChunkMetadata;
}
export interface RescanPending { events: RescanEvent[]; after: RescanState; complete: boolean }
export interface RescanJob {
  id: string; instance: string; idempotencyKey: string; runId: string; status: string;
  state: RescanState; pending: RescanPending | null; attempts: number; errorCode: string | null;
  createdAt: Date; updatedAt: Date; completedAt: Date | null;
  nextAttemptAt?: Date;
  reused?: boolean;
}
export interface RescanStore {
  findByKey(instance: string, key: string): Promise<RescanJob | null>;
  findActive(instance: string): Promise<RescanJob | null>;
  findLatestCompleted?(instance: string): Promise<RescanJob | null>;
  begin(instance: string, key: string, known: boolean, now: Date, connectionUpdatedAt?: string): Promise<RescanJob>;
  get(instance: string, jobId: string): Promise<RescanJob | null>;
  next(now: Date): Promise<string | null>;
  claim(id: string, token: string, until: Date, now: Date): Promise<RescanJob | null>;
  renew(id: string, token: string, until: Date): Promise<boolean>;
  stage(id: string, token: string, pending: RescanPending): Promise<boolean>;
  advance(id: string, token: string, pending: RescanPending, now: Date): Promise<boolean>;
  release(id: string, token: string, now: Date): Promise<void>;
  fail(id: string, token: string, code: string, retryAt: Date, terminal: boolean): Promise<void>;
  page(instance: string, kind: RescanKind, after: number, maximum: number, take: number): Promise<Array<{ id: number; data: unknown | null }>>;
  cancelInstance?(instance: string, before: Date): Promise<void>;
}
export interface RescanOptions {
  emit(instance: InstanceInfo, event: RescanEvent): Promise<void>;
  configured(): boolean;
  exists(owner: string, name: string): Promise<boolean>;
  canProduce?(): Promise<boolean>;
  connected?(instance: string): boolean;
  snapshot?(instance: string): InstanceInfo | undefined;
  naturalHistoryActive?(instance: string): boolean;
  historyPending?(owner: string, name: string, runId?: string): Promise<boolean>;
  now?: () => Date;
  pageSize?: number;
  pagesPerCycle?: number;
  leaseMs?: number;
}
export const zeroCounts = (): RescanCounts => ({ contacts: 0, chats: 0, messages: 0 });
export function rescanDto(job: RescanJob) {
  return { jobId: job.id, runId: job.runId, status: job.status, phase: job.state.phase,
    counts: job.state.counts, scanned: job.state.scanned, available: job.state.available, chunks: job.state.chunks,
    createdAt: job.createdAt.toISOString(), updatedAt: job.updatedAt.toISOString(), completedAt: job.completedAt?.toISOString() ?? null,
    errorCode: job.errorCode, attempts: job.attempts, completionMeaning: 'enqueued',
    nextAttemptAt: ['queued', 'running'].includes(job.status) ? job.nextAttemptAt?.toISOString() ?? null : null };
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Immutable pending pages make cross-store retries safe through receiver chunk deduplication. */
export class HistoryRescanService {
  private timer: NodeJS.Timeout | undefined;
  private flight: Promise<void> | undefined;
  private stopped = false;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly pagesPerCycle: number;
  private readonly leaseMs: number;
  constructor(private readonly store: RescanStore, private readonly options: RescanOptions) {
    this.now = options.now ?? (() => new Date());
    this.pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 50)));
    this.pagesPerCycle = Math.max(1, Math.min(100, Math.floor(options.pagesPerCycle ?? 20)));
    this.leaseMs = Math.max(1000, options.leaseMs ?? 60_000);
  }
  async request(owner: string, name: string, key: string) {
    if (!uuid.test(key)) throw new RequestError(400, 'Idempotency-Key must be a UUID v4.');
    if (this.stopped || !this.options.configured()) throw new RequestError(503, 'History delivery is unavailable. Configure the webhook before requesting a rescan.');
    const instance = instanceKey(owner, name);
    if (this.options.connected && !this.options.connected(instance)) throw new RequestError(409, 'Connect WhatsApp before synchronizing history.');
    const prior = await this.store.findByKey(instance, key.toLowerCase());
    const existing = prior ?? await this.store.findActive(instance);
    if (existing) { this.wake(); return { ...await this.dto(existing), reused: true, reuseMode: prior ? 'idempotent' : 'active' }; }
    if (this.options.naturalHistoryActive?.(instance)) throw new RequestError(409, 'History synchronization is already in progress.', 'HISTORY_SYNC_IN_PROGRESS');
    const known = await this.options.exists(owner, name);
    const pending = await this.options.historyPending?.(owner, name);
    if (this.options.naturalHistoryActive?.(instance)) throw new RequestError(409, 'History synchronization is already in progress.', 'HISTORY_SYNC_IN_PROGRESS');
    if (pending) {
      const completed = await this.store.findLatestCompleted?.(instance);
      if (completed && await this.options.historyPending?.(owner, name, completed.runId)) return { ...await this.dto(completed), reused: true, reuseMode: 'active' };
      throw new RequestError(409, 'History synchronization is already in progress.', 'HISTORY_SYNC_IN_PROGRESS');
    }
    if (this.options.connected && !this.options.connected(instance)) throw new RequestError(409, 'Connect WhatsApp before synchronizing history.');
    const current = this.options.snapshot?.(instance);
    if (this.options.snapshot && current?.connectionStatus !== 'ONLINE') throw new RequestError(409, 'History connection closed.');
    const job = await this.store.begin(instance, key.toLowerCase(), known, this.now(), current?.connectionUpdatedAt);
    this.wake();
    return { ...await this.dto(job), reused: Boolean(job.reused), reuseMode: job.reused ? (job.idempotencyKey === key.toLowerCase() ? 'idempotent' : 'active') : null };
  }
  async cancel(owner: string, name: string, before = this.now()): Promise<void> { await this.store.cancelInstance?.(instanceKey(owner, name), before); }
  async status(owner: string, name: string, id: string) {
    if (!uuid.test(id)) throw new RequestError(400, 'Invalid history job identifier.');
    const job = await this.store.get(instanceKey(owner, name), id.toLowerCase());
    if (!job) throw new RequestError(404, 'History job not found.');
    return this.dto(job);
  }
  private async dto(job: RescanJob) {
    const { owner, instanceName } = splitInstanceKey(job.instance);
    let waitingReason: 'natural-history' | 'webhook-backlog' | null = null;
    if (['queued', 'running'].includes(job.status)) {
      if (this.options.naturalHistoryActive?.(job.instance)) waitingReason = 'natural-history';
      else if (this.options.canProduce && !await this.options.canProduce()) waitingReason = 'webhook-backlog';
    } else if (job.status === 'completed' && await this.options.historyPending?.(owner, instanceName, job.runId)) waitingReason = 'webhook-backlog';
    return { ...rescanDto(job), waitingReason };
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  private wake() { if (!this.stopped) void this.runOnce().catch(() => apiLogger.error('History rescan cycle failed; durable jobs remain available.')); }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.flight; }
  runOnce(): Promise<void> {
    if (this.stopped || !this.options.configured()) return Promise.resolve();
    return this.flight ??= this.cycle().finally(() => { this.flight = undefined; });
  }
  private async cycle(): Promise<void> {
    const id = await this.store.next(this.now()); if (!id || this.stopped) return;
    const token = randomUUID(), until = () => new Date(this.now().getTime() + this.leaseMs);
    let job = await this.store.claim(id, token, until(), this.now()); if (!job) return;
    let releaseAt: Date | undefined;
    try {
      for (let page = 0; page < this.pagesPerCycle && !this.stopped; page++) {
        if (this.options.connected && !this.options.connected(job.instance)) throw new RequestError(409, 'History synchronization stopped because WhatsApp disconnected.');
        if (this.options.naturalHistoryActive?.(job.instance)) { releaseAt = new Date(this.now().getTime() + 1000); return; }
        if (this.options.canProduce && !await this.options.canProduce()) return;
        if (!await this.store.renew(id, token, until())) return;
        const identity = splitInstanceKey(job.instance);
        const snapshot = this.options.snapshot?.(job.instance);
        if (this.options.snapshot && snapshot?.connectionStatus !== 'ONLINE') throw new RequestError(409, 'History connection closed.');
        if (snapshot && (job.state.connectionUpdatedAt ? job.state.connectionUpdatedAt !== snapshot.connectionUpdatedAt
          : Date.parse(snapshot.connectionUpdatedAt ?? '') > job.createdAt.getTime())) throw new RequestError(409, 'History connection changed.', 'HISTORY_CONNECTION_CLOSED');
        const pending: RescanPending = job.pending ?? await this.plan(job);
        if (!job.pending && !await this.store.stage(id, token, pending)) return;
        const instance: InstanceInfo = snapshot ?? { ...identity, connectionStatus: 'OFFLINE' };
        for (const event of pending.events) {
          if (this.stopped || !await this.store.renew(id, token, until())) return;
          if (this.options.connected && !this.options.connected(job.instance)) throw new RequestError(409, 'History connection closed.');
          if (this.options.snapshot && this.options.snapshot(job.instance)?.connectionUpdatedAt !== snapshot?.connectionUpdatedAt) throw new RequestError(409, 'History connection changed.', 'HISTORY_CONNECTION_CLOSED');
          if (this.options.naturalHistoryActive?.(job.instance)) { releaseAt = new Date(this.now().getTime() + 1000); return; }
          await this.options.emit(instance, event);
        }
        if (this.options.connected && !this.options.connected(job.instance)) throw new RequestError(409, 'History connection closed.', 'HISTORY_CONNECTION_CLOSED');
        if (this.options.snapshot && this.options.snapshot(job.instance)?.connectionUpdatedAt !== snapshot?.connectionUpdatedAt) throw new RequestError(409, 'History connection changed.', 'HISTORY_CONNECTION_CLOSED');
        if (!await this.store.advance(id, token, pending, this.now())) return;
        if (pending.complete) return;
        job = { ...job, state: pending.after, pending: null };
      }
    } catch (error) {
      const oversized = error instanceof Error && error.message === 'Webhook entry exceeds supported size';
      const disconnected = (error instanceof RequestError && error.code === 'HISTORY_CONNECTION_CLOSED') || (this.options.connected && !this.options.connected(job.instance));
      await this.store.fail(id, token, disconnected ? 'HISTORY_CONNECTION_CLOSED' : oversized ? 'HISTORY_ENTRY_TOO_LARGE' : 'HISTORY_RESCAN_RETRY', new Date(this.now().getTime() + Math.min(300_000, 2000 * 2 ** Math.min(job.attempts, 7))), Boolean(disconnected) || oversized || job.attempts >= 7);
    } finally { await this.store.release(id, token, releaseAt ?? this.now()); }
  }
  private async plan(job: RescanJob): Promise<RescanPending> {
    const after = structuredClone(job.state), events: RescanEvent[] = [], stamp = this.now().toISOString();
    const emit = (event: string, data: unknown, history?: HistoryChunkMetadata) => {
      const id = createHash('sha256').update(`${job.runId}:${after.sequence}:${events.length}:${event}`).digest('hex');
      events.push({ id, timestamp: stamp, event, data, ...(history ? { history } : {}) });
    };
    const progress = (phase: 'receiving' | 'waiting') => ({ version: 1, runId: job.runId, startedAt: job.createdAt.toISOString(), resumed: true,
      sequence: after.sequence, phase, active: phase !== 'waiting', expectedChunks: after.chunks, expected: { ...after.counts }, processedBatches: after.sequence,
      source: 'stored-history', provider: { syncType: null, progress: null, isLatest: null, status: null, explicit: null, receivedPendingNotifications: null } });
    if (after.phase === 'done') {
      after.sequence++; emit('messaging-history.progress', progress('waiting'));
      return { events, after, complete: true };
    }
    const kind = after.phase;
    const rows = await this.store.page(job.instance, kind, after.cursor[kind], after.max[kind], this.pageSize);
    if (rows.some(row => row.id <= after.cursor[kind] || row.id > after.max[kind])) throw new Error('Invalid history page cursor');
    const chunks = webhookChunks(rows.map(row => row.data).filter(row => row !== null));
    after.cursor[kind] = rows.at(-1)?.id ?? after.max[kind];
    after.scanned[kind] += rows.length;
    after.counts[kind] += chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    after.chunks += chunks.length;
    if (rows.length < this.pageSize || after.cursor[kind] >= after.max[kind]) after.phase = RESCAN_KINDS[RESCAN_KINDS.indexOf(kind) + 1] ?? 'done';
    after.sequence++;
    if (chunks.length) {
      emit('messaging-history.progress', progress('receiving'));
      const batchId = `${job.runId}:${kind}:${job.state.cursor[kind]}`;
      for (const [index, chunk] of chunks.entries()) emit(`${kind}.set`, chunk, { source: 'stored-history', runId: job.runId, startedAt: job.createdAt.toISOString(), batchId, chunkId: `${batchId}:${index}` });
    }
    return jsonValue({ events, after, complete: false });
  }
}
