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
}
export interface RescanEvent {
  id: string; timestamp: string; event: string; data: unknown; history?: HistoryChunkMetadata;
}
export interface RescanPending { events: RescanEvent[]; after: RescanState; complete: boolean }
export interface RescanJob {
  id: string; instance: string; idempotencyKey: string; runId: string; status: string;
  state: RescanState; pending: RescanPending | null; attempts: number; errorCode: string | null;
  createdAt: Date; updatedAt: Date; completedAt: Date | null;
}
export interface RescanStore {
  begin(instance: string, key: string, known: boolean, now: Date): Promise<RescanJob>;
  get(instance: string, jobId: string): Promise<RescanJob | null>;
  next(now: Date): Promise<string | null>;
  claim(id: string, token: string, until: Date, now: Date): Promise<RescanJob | null>;
  renew(id: string, token: string, until: Date): Promise<boolean>;
  stage(id: string, token: string, pending: RescanPending): Promise<boolean>;
  advance(id: string, token: string, pending: RescanPending, now: Date): Promise<boolean>;
  release(id: string, token: string, now: Date): Promise<void>;
  fail(id: string, token: string, code: string, retryAt: Date, terminal: boolean): Promise<void>;
  page(instance: string, kind: RescanKind, after: number, maximum: number, take: number): Promise<Array<{ id: number; data: unknown | null }>>;
}
export interface RescanOptions {
  emit(instance: InstanceInfo, event: RescanEvent): Promise<void>;
  configured(): boolean;
  exists(owner: string, name: string): Promise<boolean>;
  canProduce?(): Promise<boolean>;
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
    errorCode: job.errorCode, attempts: job.attempts, completionMeaning: 'enqueued' };
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
    const job = await this.store.begin(instanceKey(owner, name), key.toLowerCase(), await this.options.exists(owner, name), this.now());
    this.wake();
    return rescanDto(job);
  }
  async status(owner: string, name: string, id: string) {
    if (!uuid.test(id)) throw new RequestError(400, 'Invalid history job identifier.');
    const job = await this.store.get(instanceKey(owner, name), id.toLowerCase());
    if (!job) throw new RequestError(404, 'History job not found.');
    return rescanDto(job);
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake();
  }
  private wake() { if (!this.stopped) void this.runOnce().catch(() => console.error('History rescan cycle failed; durable jobs remain available.')); }
  async stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.flight; }
  runOnce(): Promise<void> {
    if (this.stopped || !this.options.configured()) return Promise.resolve();
    return this.flight ??= this.cycle().finally(() => { this.flight = undefined; });
  }
  private async cycle(): Promise<void> {
    const id = await this.store.next(this.now()); if (!id || this.stopped) return;
    const token = randomUUID(), until = () => new Date(this.now().getTime() + this.leaseMs);
    let job = await this.store.claim(id, token, until(), this.now()); if (!job) return;
    try {
      for (let page = 0; page < this.pagesPerCycle && !this.stopped; page++) {
        if (this.options.canProduce && !await this.options.canProduce()) return;
        if (!await this.store.renew(id, token, until())) return;
        const pending: RescanPending = job.pending ?? await this.plan(job);
        if (!job.pending && !await this.store.stage(id, token, pending)) return;
        const identity = splitInstanceKey(job.instance), instance: InstanceInfo = { ...identity, connectionStatus: 'OFFLINE' };
        for (const event of pending.events) {
          if (this.stopped || !await this.store.renew(id, token, until())) return;
          await this.options.emit(instance, event);
        }
        if (!await this.store.advance(id, token, pending, this.now())) return;
        if (pending.complete) return;
        job = { ...job, state: pending.after, pending: null };
      }
    } catch (error) {
      const oversized = error instanceof Error && error.message === 'Webhook entry exceeds supported size';
      await this.store.fail(id, token, oversized ? 'HISTORY_ENTRY_TOO_LARGE' : 'HISTORY_RESCAN_RETRY', new Date(this.now().getTime() + Math.min(300_000, 2000 * 2 ** Math.min(job.attempts, 7))), oversized || job.attempts >= 7);
    } finally { await this.store.release(id, token, this.now()); }
  }
  private async plan(job: RescanJob): Promise<RescanPending> {
    const after = structuredClone(job.state), events: RescanEvent[] = [], stamp = this.now().toISOString();
    const emit = (event: string, data: unknown, history?: HistoryChunkMetadata) => {
      const id = createHash('sha256').update(`${job.runId}:${after.sequence}:${events.length}:${event}`).digest('hex');
      events.push({ id, timestamp: stamp, event, data, ...(history ? { history } : {}) });
    };
    const progress = (phase: 'receiving' | 'waiting') => ({ version: 1, runId: job.runId, startedAt: job.createdAt.toISOString(), resumed: true,
      sequence: after.sequence, phase, expectedChunks: after.chunks, expected: { ...after.counts }, processedBatches: after.sequence,
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
      for (const [index, chunk] of chunks.entries()) emit(`${kind}.set`, chunk, { runId: job.runId, startedAt: job.createdAt.toISOString(), batchId, chunkId: `${batchId}:${index}` });
    }
    return jsonValue({ events, after, complete: false });
  }
}
