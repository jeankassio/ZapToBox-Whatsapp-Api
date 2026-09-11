import { apiLogger } from '../logging/logger.js';
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { HistoryChunkMetadata, InstanceInfo } from "../../shared/types.js";
import { jsonValue, stringify } from "../../shared/serialization.js";

export interface WebhookEvent {
  id: string;
  timestamp: string;
  event: string;
  instance: InstanceInfo;
  data: unknown;
  history?: HistoryChunkMetadata;
}
interface RecordData { payload: WebhookEvent; attempts: number; nextAttemptAt: number; epoch?: string }
type HistoryReference = { key: string; runId: string | undefined; epoch: string | undefined };
type HistoryIndex = Map<string, Set<string | undefined>>;
export interface OutboxDiagnostic {
  component: "webhook-outbox";
  phase: "enqueue" | "startup" | "retry";
  pid: number;
  code: string;
  directory: string;
  advice: string;
}
export interface OutboxOptions {
  directory: string;
  url: string;
  secret: string;
  timeoutMs: number;
  maxAttempts: number;
  concurrency: number;
  retryMs: number;
  durable: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  logError?: (diagnostic: OutboxDiagnostic) => void;
  canDeliver?: (event: WebhookEvent) => boolean;
}

const storageErrorCodes = new Set([
  "EACCES", "EPERM", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT", "EROFS", "EIO",
  "EMFILE", "ENFILE", "ENOENT", "EEXIST", "EBUSY", "ETXTBSY", "ENAMETOOLONG",
]);

/** One process owns this directory; each lane keeps retries ordered within an instance. */
export class WebhookOutbox {
  private flight: Promise<void> | undefined;
  private pending = false;
  private sequence = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly directory: string;
  private readonly now: () => number;
  private readonly lifecycle: WebhookOutbox | undefined;
  private readonly epochs = new Map<string, string>();
  private readonly deliveries = new Map<string, HistoryReference & { event: string; history: boolean; controller: AbortController }>();
  private readonly historyWrites = new Map<symbol, HistoryReference>();
  private historyIndex: { value: HistoryIndex; expiresAt: number } | undefined;
  private historyScan: { promise: Promise<HistoryIndex>; additions: HistoryReference[] } | undefined;
  private lastDiagnostic: { code: string; loggedAt: number } | undefined;
  constructor(private readonly options: OutboxOptions, lifecycleLane = false) {
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? Date.now;
    // Connection events must reach the receiver even while a message/history
    // request is slow or retrying. They retain their own durable ordered lane.
    if (!lifecycleLane) this.lifecycle = new WebhookOutbox({ ...options, directory: path.join(this.directory, 'lifecycle') }, true);
  }
  private reportQueueError(error: unknown, phase: OutboxDiagnostic["phase"]): void {
    const value = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const code = typeof value === "string" && storageErrorCodes.has(value) ? value : "UNKNOWN";
    const now = this.now();
    if (this.lastDiagnostic?.code === code && now >= this.lastDiagnostic.loggedAt && now - this.lastDiagnostic.loggedAt < 60_000) return;
    // Throttle duplicate logs only. Every scheduled delivery still runs, and
    // a different storage error is reported immediately, even within a minute.
    this.lastDiagnostic = { code, loggedAt: now };
    const advice = code === "EACCES" || code === "EPERM" || code === "EROFS"
      ? "Check that the API process user can read and write WEBHOOK_QUEUE_DIR and that the volume is writable."
      : code === "ENOTDIR" || code === "EISDIR"
        ? "Check WEBHOOK_QUEUE_DIR: the queue path and its parents must be directories, not files."
        : code === "ENOSPC" || code === "EDQUOT"
          ? "Check free disk space and the storage quota for WEBHOOK_QUEUE_DIR."
          : "Check WEBHOOK_QUEUE_DIR, filesystem access, and that only one API process owns this queue directory.";
    // Do not log arbitrary error messages, stacks or causes: they may contain
    // webhook URLs, credentials or event contents. The path is configuration.
    const diagnostic: OutboxDiagnostic = { component: "webhook-outbox", phase, pid: process.pid, code, directory: this.directory, advice };
    if (this.options.logError) {
      try { this.options.logError(diagnostic); return; } catch { /* Logging must not change retry behavior. */ }
    }
    apiLogger.error("Webhook queue storage processing failed; persisted events remain available", diagnostic);
  }
  async enqueue(event: string, instance: InstanceInfo, data: unknown, history?: HistoryChunkMetadata, identity?: { id: string; timestamp: string }): Promise<string | undefined> {
    if (this.lifecycle && event.startsWith('connection.')) return this.lifecycle.enqueue(event, instance, data, history, identity);
    if (!this.options.url) return undefined;
    if (identity && (!/^[a-f0-9-]{32,64}$/.test(identity.id) || !Number.isFinite(Date.parse(identity.timestamp)))) throw new Error('Invalid durable event identity');
    const payload = jsonValue<WebhookEvent>({ id: identity?.id ?? randomUUID(), timestamp: identity?.timestamp ?? new Date(this.now()).toISOString(), event, instance, data, ...(history ? { history } : {}) });
    const key = this.instanceKey(payload), epoch = this.epochs.get(key);
    const completeHistoryWrite = this.trackHistoryWrite(payload, epoch);
    try {
    if (!this.options.durable) { if (this.options.canDeliver && !this.options.canDeliver(payload)) return undefined; await this.deliver(payload); return payload.id; }
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const filename = `${this.now()}-${String(this.sequence++).padStart(8, "0")}-${payload.id}.json`;
    await this.write(path.join(this.directory, filename), {payload, attempts:0, nextAttemptAt:0, ...(epoch ? { epoch } : {})});
    if (this.epochs.get(key) !== epoch) { await fs.unlink(path.join(this.directory, filename)).catch(error => { if (error.code !== 'ENOENT') throw error; }); return undefined; }
    this.pending = true;
    if (!this.stopped) void this.flush().catch(error => this.reportQueueError(error, "enqueue"));
    return payload.id;
    } finally { completeHistoryWrite(); }
  }
  private async write(filename: string, record: RecordData): Promise<void> {
    const temporary = filename + "." + randomUUID() + ".tmp";
    const handle = await fs.open(temporary,"wx",0o600);
    try { await handle.writeFile(stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary,filename);
  }
  private async deliver(payload: WebhookEvent): Promise<void> {
    const controller = new AbortController();
    const key = this.instanceKey(payload);
    this.deliveries.set(payload.id, { key, epoch: this.epochs.get(key), event: payload.event, history: this.isHistory(payload), runId: this.historyRunId(payload), controller });
    try {
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method:"POST", headers:{"Content-Type":"application/json", "X-Webhook-Secret":this.options.secret, "X-Webhook-Id":payload.id},
      body:stringify(payload), signal:AbortSignal.any([AbortSignal.timeout(this.options.timeoutMs), controller.signal]), redirect:"error",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Webhook HTTP " + response.status);
    } finally { this.deliveries.delete(payload.id); }
  }
  private instanceKey(payload: WebhookEvent): string { return JSON.stringify([payload.instance.owner, payload.instance.instanceName]); }
  private discarded(record: RecordData): boolean {
    if (record.payload.event.startsWith('connection.')) return false;
    const epoch = this.epochs.get(this.instanceKey(record.payload));
    return epoch !== undefined && record.epoch !== epoch;
  }
  /** Clear only this connection's old data/QR work; lifecycle and a new epoch survive. */
  async discardInstance(owner: string, instanceName: string): Promise<void> {
    const key = JSON.stringify([owner, instanceName]), epoch = randomUUID();
    this.epochs.set(key, epoch);
    this.historyIndex?.value.delete(key);
    for (const task of this.deliveries.values()) if (task.key === key && !task.event.startsWith('connection.')) task.controller.abort();
    for (const directory of [this.directory, path.join(this.directory, 'dead-letter')]) {
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const item of entries) {
        if (!item.isFile() || !item.name.endsWith('.json')) continue;
        const filename = path.join(directory, item.name), record = await this.read(filename);
        if (record && !record.payload.event.startsWith('connection.') && this.epochs.get(key) === epoch && this.instanceKey(record.payload) === key && record.epoch !== epoch) await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }
  private async quarantine(filename: string, suffix = ""): Promise<void> {
    const dead = path.join(this.directory,"dead-letter");
    await fs.mkdir(dead,{recursive:true,mode:0o700});
    await fs.rename(filename,path.join(dead,path.basename(filename) + suffix)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  private async read(filename: string, retried = false): Promise<RecordData | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(filename,"utf8"));
      // Upgrade legacy queue files, ignoring their persisted targetUrl.
      const record: RecordData = raw.payload ? raw : {payload:{...raw,
        id:createHash("sha256").update(path.basename(filename)).digest("hex"), timestamp:new Date((await fs.stat(filename)).mtimeMs).toISOString()},attempts:0,nextAttemptAt:0};
      if (typeof record.payload.event !== "string" || !record.payload.event || typeof record.payload.id !== "string" || !record.payload.id
        || typeof record.payload.timestamp !== "string" || !Number.isFinite(Date.parse(record.payload.timestamp))
        || typeof record.payload.instance?.owner !== "string" || typeof record.payload.instance?.instanceName !== "string") throw new Error("Invalid event");
      delete (record.payload as unknown as Record<string,unknown>).targetUrl;
      if (!Number.isSafeInteger(record.attempts) || record.attempts < 0 || !Number.isFinite(record.nextAttemptAt) || record.nextAttemptAt < 0) throw new Error("Invalid retry metadata");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      // On Windows a concurrently unlinked file may briefly be delete-pending
      // and report EPERM rather than ENOENT. Retry once; genuine ACL failures
      // still surface to queue diagnostics instead of being silently ignored.
      if (!retried && process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') {
        await new Promise(resolve => setTimeout(resolve, 10));
        return this.read(filename, true);
      }
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code) throw error;
      await this.quarantine(filename,".invalid");
      apiLogger.error("Invalid webhook file moved to dead-letter");
      return undefined;
    }
  }
  async flush(): Promise<void> {
    if (!this.options.url || !this.options.durable) return;
    const lifecycle = this.lifecycle?.flush();
    if (!this.flight) {
      const flight = this.process();
      this.flight = flight;
      // A failure in the independent lifecycle directory must not release this
      // lane's lock while its HTTP request is still running.
      void flight.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
    }
    await Promise.all([this.flight, lifecycle]);
  }
  private async process(): Promise<void> {
    do {
      this.pending = false;
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      const entries = await fs.readdir(this.directory,{withFileTypes:true});
      // Keep only small scheduling metadata, never every pending message body.
      const groups = new Map<string, { filename: string; timestamp: string; nextAttemptAt: number }[]>();
      for (const file of entries.filter(entry=>entry.isFile() && entry.name.endsWith(".json")).sort((a,b)=>a.name.localeCompare(b.name))) {
        const filename = path.join(this.directory,file.name);
        const record = await this.read(filename);
        if (!record) continue;
        const key = JSON.stringify([record.payload.instance.owner,record.payload.instance.instanceName]);
        const group = groups.get(key) ?? [];
        group.push({ filename, timestamp: record.payload.timestamp, nextAttemptAt: record.nextAttemptAt }); groups.set(key,group);
      }
      const ready = [...groups.values()].map(items => ({ items: items.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.filename.localeCompare(b.filename)), offset: 0 }));
      let nextGroup = 0;
      const worker = async () => {
        while (nextGroup < ready.length && !this.stopped) {
          const group = ready[nextGroup++]!;
          let blocked = false;
          // A large import may use a slot for at most 16 deliveries per turn.
          for (let sent = 0; sent < 16 && group.offset < group.items.length; sent++) {
            const item = group.items[group.offset++]!;
            if (this.stopped || item.nextAttemptAt > this.now()) { blocked = true; break; }
            const { filename } = item;
            const record = await this.read(filename);
            if (!record) continue;
            if (this.discarded(record)) { await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); continue; }
            if (this.options.canDeliver && !this.options.canDeliver(record.payload)) { blocked = true; break; }
            try { await this.deliver(record.payload); await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
            catch {
              if (this.discarded(record)) { await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); blocked = true; break; }
              record.attempts++;
              record.nextAttemptAt = this.now() + Math.min(this.options.retryMs * 2 ** Math.min(record.attempts-1,10),3_600_000);
              await this.write(filename,record);
              if (this.discarded(record)) { await fs.unlink(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }); blocked = true; break; }
              if (record.attempts >= this.options.maxAttempts) {
                await this.quarantine(filename);
                apiLogger.error("Webhook retry limit reached; event retained in dead-letter");
              }
              blocked = true; break;
            }
          }
          if (!blocked && group.offset < group.items.length) ready.push(group);
          if (nextGroup > 1024 && nextGroup * 2 > ready.length) { ready.splice(0, nextGroup); nextGroup = 0; }
        }
      };
      await Promise.all(Array.from({length:this.options.concurrency},worker));
    } while(this.pending && !this.stopped);
  }
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.lifecycle?.start();
    this.timer = setInterval(()=>{void this.flush().catch(error=>this.reportQueueError(error,"retry"));},this.options.retryMs);
    this.timer.unref();
    void this.flush().catch(error=>this.reportQueueError(error,"startup"));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await Promise.allSettled([this.flight, this.lifecycle?.stop()]);
  }
  async stats(): Promise<{pending:number; deadLetter:number}> {
    const count = async(dir:string) => {
      try { return (await fs.readdir(dir,{withFileTypes:true})).filter(item=>item.isFile() && (item.name.endsWith(".json") || item.name.endsWith(".invalid"))).length; }
      catch(error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0; throw error; }
    };
    const lifecycle = await this.lifecycle?.stats();
    return {pending:await count(this.directory) + (lifecycle?.pending ?? 0),deadLetter:await count(path.join(this.directory,"dead-letter")) + (lifecycle?.deadLetter ?? 0)};
  }
  private isHistory(payload: WebhookEvent): boolean {
    return Boolean(payload.history) || payload.event === 'messaging-history.progress' || ['messages.set', 'chats.set', 'contacts.set'].includes(payload.event);
  }
  private historyRunId(payload: WebhookEvent): string | undefined {
    if (payload.history) return payload.history.runId;
    const value = payload.event === 'messaging-history.progress' && payload.data && typeof payload.data === 'object' && 'runId' in payload.data ? payload.data.runId : undefined;
    return typeof value === 'string' ? value : undefined;
  }
  private addHistory(index: HistoryIndex, reference: HistoryReference): void {
    if (reference.epoch !== this.epochs.get(reference.key)) return;
    const runs = index.get(reference.key) ?? new Set<string | undefined>();
    runs.add(reference.runId); index.set(reference.key, runs);
  }
  private trackHistoryWrite(payload: WebhookEvent, epoch: string | undefined): () => void {
    if (!this.isHistory(payload)) return () => {};
    const ticket = Symbol(), reference = { key: this.instanceKey(payload), epoch, runId: this.historyRunId(payload) };
    this.historyWrites.set(ticket, reference);
    if (this.historyIndex) this.addHistory(this.historyIndex.value, reference);
    this.historyScan?.additions.push(reference);
    return () => { this.historyWrites.delete(ticket); };
  }
  private historySnapshot(): Promise<HistoryIndex> {
    if (this.historyIndex && this.historyIndex.expiresAt > this.now()) return Promise.resolve(this.historyIndex.value);
    if (this.historyScan) return this.historyScan.promise;
    const additions: HistoryReference[] = [], epochs = new Map(this.epochs);
    const promise = (async () => {
      const index: HistoryIndex = new Map();
      const files = await fs.readdir(this.directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.json')) continue;
        const record = await this.read(path.join(this.directory, file.name));
        if (record && !this.discarded(record) && this.isHistory(record.payload)) this.addHistory(index,
          { key: this.instanceKey(record.payload), runId: this.historyRunId(record.payload), epoch: record.epoch });
      }
      // A close may have discarded already-scanned files. New events use the
      // new epoch and are merged after removing observations from the old one.
      for (const key of index.keys()) if (epochs.get(key) !== this.epochs.get(key)) index.delete(key);
      for (const reference of additions) this.addHistory(index, reference);
      for (const reference of this.historyWrites.values()) this.addHistory(index, reference);
      this.historyIndex = { value: index, expiresAt: this.now() + 1000 };
      return index;
    })();
    this.historyScan = { promise, additions };
    void promise.finally(() => { if (this.historyScan?.promise === promise) this.historyScan = undefined; }).catch(() => {});
    return promise;
  }
  /** Shared one-second metadata snapshot for rescan requests and status polls. */
  async hasPendingHistory(owner: string, instanceName: string, runId?: string): Promise<boolean> {
    const key = JSON.stringify([owner, instanceName]);
    const matches = (item: HistoryReference) => item.key === key && item.epoch === this.epochs.get(key) && (!runId || item.runId === runId);
    if ([...this.deliveries.values()].some(item => item.history && matches(item)) || [...this.historyWrites.values()].some(matches)) return true;
    const runs = (await this.historySnapshot()).get(key);
    return Boolean(runs && (!runId || runs.has(runId)));
  }
  async replayDeadLetters(): Promise<number> {
    const dead = path.join(this.directory,"dead-letter");
    let files: string[];
    try { files = await fs.readdir(dead); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
    let count = await this.lifecycle?.replayDeadLetters() ?? 0;
    for (const file of files.filter(item=>item.endsWith(".json"))) {
      const record = await this.read(path.join(dead,file));
      if (!record) continue;
      if (this.discarded(record)) { await fs.unlink(path.join(dead, file)).catch(error => { if (error.code !== 'ENOENT') throw error; }); continue; }
      if (this.options.canDeliver && !this.options.canDeliver(record.payload)) continue;
      record.attempts=0;record.nextAttemptAt=0;
      const completeHistoryWrite = this.trackHistoryWrite(record.payload, record.epoch);
      try {
        await this.write(path.join(this.directory,file),record);
        // A close racing the replay must not put an old cancelled run back in
        // the active directory after discardInstance already scanned it.
        if (this.discarded(record)) await fs.unlink(path.join(this.directory,file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        else count++;
        await fs.unlink(path.join(dead,file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      } finally { completeHistoryWrite(); }
    }
    return count;
  }
}
