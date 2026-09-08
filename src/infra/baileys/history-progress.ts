import { randomUUID } from 'node:crypto';

export type HistoryPhase = 'awaiting' | 'receiving' | 'importing' | 'waiting' | 'paused' | 'interrupted' | 'error';
export interface HistoryCounts { contacts: number; chats: number; messages: number }
type Metadata = { syncType?: number | null; progress?: number | null; isLatest?: boolean; chunkOrder?: number | null };
export interface HistoryProgress {
  version: 1;
  runId: string;
  startedAt: string;
  resumed: boolean;
  sequence: number;
  phase: HistoryPhase;
  expectedChunks: number;
  expected: HistoryCounts;
  processedBatches: number;
  provider: {
    syncType: number | null;
    progress: number | null;
    isLatest: boolean | null;
    status: 'complete' | 'paused' | null;
    explicit: boolean | null;
    receivedPendingNotifications: boolean | null;
  };
  error?: 'HISTORY_PROCESSING_FAILED';
}
const bounded = (value: unknown, maximum: number) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;

/** Tracks observations and known imports, never a global WhatsApp completion. */
export class HistoryProgressTracker {
  private readonly state: HistoryProgress;
  private pendingDownloads: Metadata[] = [];
  constructor(resumed = false, startedAt = new Date().toISOString()) {
    this.state = { version: 1, runId: randomUUID(), startedAt, resumed, sequence: 0, phase: resumed ? 'waiting' : 'awaiting', expectedChunks: 0,
      expected: { contacts: 0, chats: 0, messages: 0 }, processedBatches: 0,
      provider: { syncType: null, progress: null, isLatest: null, status: null, explicit: null, receivedPendingNotifications: null } };
  }
  get identity() { return { runId: this.state.runId, startedAt: this.state.startedAt }; }
  private metadata(data: Metadata) {
    const syncType = bounded(data.syncType, 1000);
    if (syncType !== this.state.provider.syncType) { this.state.provider.status = null; this.state.provider.explicit = null; }
    this.state.provider.syncType = syncType;
    this.state.provider.progress = bounded(data.progress, 100);
    this.state.provider.isLatest = typeof data.isLatest === 'boolean' ? data.isLatest : null;
  }
  snapshot(phase?: HistoryPhase): HistoryProgress {
    if (phase) this.state.phase = phase;
    this.state.sequence++;
    return structuredClone(this.state);
  }
  pendingNotifications(received: boolean): HistoryProgress {
    this.state.provider.receivedPendingNotifications = received;
    // This flag says nothing about history transfer or media readiness.
    return this.snapshot();
  }
  download(data: Metadata): HistoryProgress {
    this.pendingDownloads.push({ syncType: data.syncType ?? null, progress: data.progress ?? null, chunkOrder: data.chunkOrder ?? null });
    this.metadata(data);
    return this.snapshot('receiving');
  }
  providerStatus(data: { syncType: number; status: 'complete' | 'paused'; explicit: boolean }): HistoryProgress {
    if (this.state.provider.syncType !== data.syncType) this.metadata({ syncType: data.syncType });
    this.state.provider.status = data.status;
    this.state.provider.explicit = data.explicit;
    // rc14 emits complete before downloading the notified history. It is not
    // an import-completion signal. A timeout means paused, never completed.
    return this.snapshot(data.status === 'paused' ? 'paused' : 'receiving');
  }
  beginBatch(data: Metadata, expected: HistoryCounts, chunks: number): HistoryProgress {
    this.metadata(data);
    // Buffered history combines data and retains its last notification marker.
    // Retire only a matching prefix. An unmatchable download stays receiving.
    const index = this.pendingDownloads.findIndex(item => item.syncType === (data.syncType ?? null) &&
      (typeof data.chunkOrder === 'number' ? item.chunkOrder === data.chunkOrder : item.progress === (data.progress ?? null)));
    if (index >= 0) this.pendingDownloads.splice(0, index + 1);
    for (const type of ['contacts', 'chats', 'messages'] as const) this.state.expected[type] += expected[type];
    this.state.expectedChunks += chunks;
    return this.snapshot('receiving');
  }
  importedBatch(): HistoryProgress {
    this.state.processedBatches++;
    return this.snapshot(this.pendingDownloads.length ? 'receiving' : this.state.provider.status === 'paused' ? 'paused' : 'waiting');
  }
  failure(): HistoryProgress {
    this.state.error = 'HISTORY_PROCESSING_FAILED';
    return this.snapshot('error');
  }
}
