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
interface RecordData { payload: WebhookEvent; attempts: number; nextAttemptAt: number }
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
    console.error("Webhook queue storage processing failed; persisted events remain available", diagnostic);
  }
  async enqueue(event: string, instance: InstanceInfo, data: unknown, history?: HistoryChunkMetadata, identity?: { id: string; timestamp: string }): Promise<string | undefined> {
    if (this.lifecycle && event.startsWith('connection.')) return this.lifecycle.enqueue(event, instance, data, history, identity);
    if (!this.options.url) return undefined;
    if (identity && (!/^[a-f0-9-]{32,64}$/.test(identity.id) || !Number.isFinite(Date.parse(identity.timestamp)))) throw new Error('Invalid durable event identity');
    const payload = jsonValue<WebhookEvent>({ id: identity?.id ?? randomUUID(), timestamp: identity?.timestamp ?? new Date(this.now()).toISOString(), event, instance, data, ...(history ? { history } : {}) });
    if (!this.options.durable) { await this.deliver(payload); return payload.id; }
    await fs.mkdir(this.directory, {recursive: true, mode: 0o700});
    const filename = `${this.now()}-${String(this.sequence++).padStart(8, "0")}-${payload.id}.json`;
    await this.write(path.join(this.directory, filename), {payload, attempts:0, nextAttemptAt:0});
    this.pending = true;
    if (!this.stopped) void this.flush().catch(error => this.reportQueueError(error, "enqueue"));
    return payload.id;
  }
  private async write(filename: string, record: RecordData): Promise<void> {
    const temporary = filename + "." + randomUUID() + ".tmp";
    const handle = await fs.open(temporary,"wx",0o600);
    try { await handle.writeFile(stringify(record)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary,filename);
  }
  private async deliver(payload: WebhookEvent): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method:"POST", headers:{"Content-Type":"application/json", "X-Webhook-Secret":this.options.secret, "X-Webhook-Id":payload.id},
      body:stringify(payload), signal:AbortSignal.timeout(this.options.timeoutMs), redirect:"error",
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Webhook HTTP " + response.status);
  }
  private async quarantine(filename: string, suffix = ""): Promise<void> {
    const dead = path.join(this.directory,"dead-letter");
    await fs.mkdir(dead,{recursive:true,mode:0o700});
    await fs.rename(filename,path.join(dead,path.basename(filename) + suffix));
  }
  private async read(filename: string): Promise<RecordData | undefined> {
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
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code) throw error;
      await this.quarantine(filename,".invalid");
      console.error("Invalid webhook file moved to dead-letter");
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
      const groups = new Map<string, {filename:string;record:RecordData}[]>();
      for (const file of entries.filter(entry=>entry.isFile() && entry.name.endsWith(".json")).sort((a,b)=>a.name.localeCompare(b.name))) {
        const filename = path.join(this.directory,file.name);
        const record = await this.read(filename);
        if (!record) continue;
        const key = JSON.stringify([record.payload.instance.owner,record.payload.instance.instanceName]);
        const group = groups.get(key) ?? [];
        group.push({filename,record}); groups.set(key,group);
      }
      const iterator = groups.values();
      const worker = async () => {
        for (const group of iterator) {
          group.sort((a,b)=>a.record.payload.timestamp.localeCompare(b.record.payload.timestamp) || a.filename.localeCompare(b.filename));
          for (const {filename,record} of group) {
            if (this.stopped || record.nextAttemptAt > this.now()) break;
            try { await this.deliver(record.payload); await fs.unlink(filename); }
            catch {
              record.attempts++;
              record.nextAttemptAt = this.now() + Math.min(this.options.retryMs * 2 ** Math.min(record.attempts-1,10),3_600_000);
              await this.write(filename,record);
              if (record.attempts >= this.options.maxAttempts) {
                await this.quarantine(filename);
                console.error("Webhook retry limit reached; event retained in dead-letter");
              }
              break;
            }
          }
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
  async replayDeadLetters(): Promise<number> {
    const dead = path.join(this.directory,"dead-letter");
    let files: string[];
    try { files = await fs.readdir(dead); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; files = []; }
    let count = await this.lifecycle?.replayDeadLetters() ?? 0;
    for (const file of files.filter(item=>item.endsWith(".json"))) {
      const record = await this.read(path.join(dead,file));
      if (!record) continue;
      record.attempts=0;record.nextAttemptAt=0;
      await this.write(path.join(this.directory,file),record);
      await fs.unlink(path.join(dead,file));count++;
    }
    return count;
  }
}
