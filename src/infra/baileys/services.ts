import makeWASocket, {
  Browsers, DisconnectReason, getAggregateVotesInPollMessage, getContentType, PROCESSABLE_HISTORY_TYPES,
  makeCacheableSignalKeyStore, proto, type BaileysEventMap, type GroupMetadata,
  type WAMessage, type WAMessageKey, type WASocket,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { BoundedCache } from '../../shared/bounded-cache.js';
import { pino } from 'pino';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import { baileysEvents, instanceConnection, instances, instanceStatus, sessionsPath } from '../../shared/constants.js';
import { instanceKey } from '../../shared/identity.js';
import { publicInstanceInfo, updateConnectionStatus } from '../../shared/instance-info.js';
import { genProxy, removeInstancePath, trySendWebhook } from '../../shared/utils.js';
import type { ConnectionState, ConnectionStatus, HistoryChunkMetadata, InstanceData, InstanceInfo } from '../../shared/types.js';
import UserConfig from '../config/env.js';
import PrismaConnection from '../../core/connection/prisma.js';
import { loadInstanceAuth, safeSessionDirectory, type PersistentAuth } from '../state/auth-state.js';
import { messageTimestamp, serializeBaileys, sourceEdit } from '../mappers/messageMapper.js';
import { HistoryProgressTracker } from './history-progress.js';
import { webhookChunks, WEBHOOK_CHUNK_ITEMS } from '../webhook/chunks.js';
import { RequestError } from '../http/controllers/base.js';
import { renewedMediaPath } from './media-reupload.js';

type StartData = { owner: string; instanceName: string; phoneNumber?: string | undefined };
type ConnectResult = { instance: InstanceInfo; qrCode?: string; pairingCode?: string };
type SocketConfig = Parameters<typeof makeWASocket>[0];
export interface InstanceDependencies {
  makeSocket: (config: SocketConfig) => WASocket;
  loadAuth: (owner: string, name: string) => Promise<PersistentAuth>;
  emit: typeof trySendWebhook;
  store: Pick<typeof PrismaConnection, 'saveMessages' | 'saveManyMessages' | 'saveManyContacts' | 'getMessageById' | 'deleteByInstance' | 'saveManyChats' | 'deleteChats' | 'deleteMessages'>;
  reconnectDelayMs: number;
  reconnectMaxDelayMs: number;
  conflictRetryDelayMs: number;
  refusalRetryDelayMs: number;
  handshakeTimeoutMs: number;
  random: () => number;
  qrTimeoutMs: number;
  qrLimit: number;
  removeSession: (owner: string, name: string) => Promise<void>;
}

/** One instance owns one socket, retry timer, auth state and set of caches. */
export default class Instance {
  private readonly dependencies: InstanceDependencies;
  private sock: WASocket | undefined;
  private instance: InstanceData | undefined;
  private auth: PersistentAuth | undefined;
  private owner = '';
  private instanceName = '';
  private key = '';
  private phoneNumber: string | undefined;
  private stopped = true;
  private revoked = false;
  private generation = 0;
  private reconnectAttempts = 0;
  private connectedAt = 0;
  private socketStartedAt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private startTask: Promise<ConnectResult> | undefined;
  private setupTask: Promise<void> | undefined;
  private shutdownTask: Promise<void> | undefined;
  private draining = false;
  private eventTail: Promise<void> = Promise.resolve();
  private eventTasks = new Set<Promise<void>>();
  private socketOperations = new Set<Promise<unknown>>();
  private authOperations = new Set<Promise<unknown>>();
  private qrCount = 0;
  private pairingRequested = false;
  private initialResolver: (() => void) | undefined;
  private initial: Promise<void> = Promise.resolve();
  private qrCode: string | undefined;
  private pairingCode: string | undefined;
  private history: HistoryProgressTracker | undefined;
  private msgRetryCounterCache = new BoundedCache(2048, 3600);
  private userDevicesCache = new BoundedCache(1024, 300);
  private groupCache = new BoundedCache(128, 300);

  constructor(dependencies: Partial<InstanceDependencies> = {}) {
    this.dependencies = {
      makeSocket: makeWASocket, loadAuth: loadInstanceAuth, emit: trySendWebhook, store: PrismaConnection,
      reconnectDelayMs: 1000, reconnectMaxDelayMs: 30_000, random: Math.random, qrTimeoutMs: UserConfig.qrCodeTimeout * 1000, qrLimit: UserConfig.qrCodeLimit,
      conflictRetryDelayMs: 60_000, refusalRetryDelayMs: 300_000, handshakeTimeoutMs: 120_000,
      removeSession: async (owner, name) => {
        try { await removeInstancePath(await safeSessionDirectory(sessionsPath, owner, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      },
      ...dependencies,
    };
  }

  getSock(): WASocket | undefined { return this.sock; }
  getHistoryActivity() { return this.history?.activity; }

  create(data: StartData): Promise<ConnectResult> {
    const key = instanceKey(String(data.owner), String(data.instanceName));
    if (this.key && this.key !== key) return Promise.reject(new Error('Instance identity cannot change'));
    if (this.startTask) return this.startTask;
    if (this.sock && !this.stopped) return Promise.resolve(this.result());
    if (instances[key] && instances[key] !== this) return Promise.reject(new Error('Instance already exists'));
    this.owner = String(data.owner); this.instanceName = String(data.instanceName); this.key = key;
    this.phoneNumber = data.phoneNumber?.replace(/\D/g, '');
    this.stopped = false;
    this.qrCode = undefined; this.pairingCode = undefined; this.qrCount = 0; this.pairingRequested = false;
    this.instance = { owner: this.owner, instanceName: this.instanceName, connectionStatus: 'OFFLINE' };
    instances[key] = this; instanceConnection[key] = this.instance;
    this.setStatus('OFFLINE', this.auth?.state.creds.registered ? 'reconnecting' : 'pairing');
    this.initial = new Promise(resolve => { this.initialResolver = resolve; });
    const task = this.startAndWait();
    this.startTask = task;
    void task.finally(() => { if (this.startTask === task) this.startTask = undefined; }).catch(() => {});
    return task;
  }

  private async startAndWait(): Promise<ConnectResult> {
    try { await this.startSocket(); }
    catch {
      if (!this.stopped) {
        console.error(`[${this.key}] Socket setup failed; credentials preserved`);
        this.scheduleReconnect();
      }
      return this.result();
    }
    if (this.auth?.state.creds.registered || this.stopped) return this.result();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.initial, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.min(this.dependencies.qrTimeoutMs, 10_000)); })]);
    } finally { if (timer) clearTimeout(timer); }
    return this.result();
  }

  private startSocket(): Promise<void> {
    if (this.setupTask) return this.setupTask;
    const generation = ++this.generation;
    const task = (async () => {
      this.detachSocket();
      // Old history writes may finish independently. Authentication operations
      // must settle before another socket can reuse the same Signal state.
      await Promise.allSettled([...this.authOperations]);
      await this.auth?.drain();
      this.auth ??= await this.dependencies.loadAuth(this.owner, this.instanceName);
      if (this.stopped || generation !== this.generation) return;
      this.setStatus('OFFLINE', this.auth.state.creds.registered ? 'reconnecting' : 'pairing');
      // Retry a failed credentials write before reopening the transport.
      if (this.auth.state.creds.registered) await this.auth.saveCreds();
      if (this.stopped || generation !== this.generation) return;
      const agents = await genProxy(UserConfig.proxyUrl);
      if (this.stopped || generation !== this.generation) return;
      const logger = pino({ level: 'silent' });
      const client = UserConfig.sessionClient.toLowerCase();
      const browser = ['windows', 'win32'].includes(client) ? Browsers.windows(UserConfig.sessionName)
        : ['mac', 'macos', 'mac os', 'darwin'].includes(client) ? Browsers.macOS(UserConfig.sessionName)
        : Browsers.ubuntu(UserConfig.sessionName);
      const active = () => !this.stopped && generation === this.generation;
      const auth = this.auth;
      const history = new HistoryProgressTracker(Boolean(auth.state.creds.accountSyncCounter));
      this.history = history;
      const authFailure = (error: unknown): never => {
        this.closeSocket(generation, history, undefined, 'auth.keys');
        throw error;
      };
      const keys = {
        get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          if (!active()) return Promise.reject(new Error('Socket is stopped'));
          return this.trackOperation(() => Promise.resolve(auth.state.keys.get(type, ids)), true).catch(authFailure);
        },
        set: (data: Parameters<typeof auth.state.keys.set>[0]) => {
          if (!active()) return Promise.reject(new Error('Socket is stopped'));
          return this.trackOperation(() => Promise.resolve(auth.state.keys.set(data)), true).catch(authFailure);
        },
      };
      // Release-pinned defaults avoid a remote version fetch on every reconnect.
      const sock = this.dependencies.makeSocket({
        auth: { creds: auth.state.creds, keys: makeCacheableSignalKeyStore(keys, logger, new BoundedCache(4096, 300)) },
        browser, emitOwnEvents: true,
        markOnlineOnConnect: false, syncFullHistory: true, generateHighQualityLinkPreview: false,
        shouldSyncHistoryMessage: notification => {
          if (!active() || this.sock?.ws?.isOpen === false) return false;
          // Baileys also calls this hook with bare syncType capability probes.
          // Only a real download/inline payload signals incoming history.
          if (PROCESSABLE_HISTORY_TYPES.some(type => type === Number(notification.syncType)) && (notification.directPath || notification.initialHistBootstrapInlinePayload?.length)) {
            const progress = history.download(notification);
            this.queueEvent('messaging-history.notification', generation, async () => {
              await this.emit('messaging-history.progress', progress, generation);
            }, history);
          }
          return true;
        },
        msgRetryCounterCache: this.msgRetryCounterCache,
        userDevicesCache: {
          get: <T>(key: string) => this.userDevicesCache.get<T>(key),
          set: <T>(key: string, value: T) => this.userDevicesCache.set(key, value),
          del: (key: string) => this.userDevicesCache.del(key),
          flushAll: () => this.userDevicesCache.flushAll(),
        },
        enableAutoSessionRecreation: true, maxMsgRetryCount: 5, retryRequestDelayMs: 3000,
        logger, ...agents.wsAgent ? { agent: agents.wsAgent } : {}, ...agents.fetchAgent ? { fetchAgent: agents.fetchAgent } : {},
        cachedGroupMetadata: async jid => this.groupCache.get<GroupMetadata>(jid),
        getMessage: key => active() ? this.trackOperation(() => this.getMessage(key)) : Promise.resolve(undefined), qrTimeout: this.dependencies.qrTimeoutMs,
      });
      this.sock = sock;
      this.socketStartedAt = Date.now();
      this.connectedAt = 0;
      this.instance!.socket = sock;
      this.attachEvents(sock, generation, history);
    })();
    this.setupTask = task;
    void task.finally(() => { if (this.setupTask === task) this.setupTask = undefined; }).catch(() => {});
    return task;
  }

  private result(): ConnectResult {
    const info = this.instance!;
    return {
      instance: publicInstanceInfo(info),
      ...(this.qrCode ? { qrCode: this.qrCode } : {}), ...(this.pairingCode ? { pairingCode: this.pairingCode } : {}),
    };
  }

  private finishInitial(): void { this.initialResolver?.(); this.initialResolver = undefined; }

  private trackOperation<T>(operation: () => Promise<T>, authentication = false): Promise<T> {
    const task = operation();
    this.socketOperations.add(task);
    if (authentication) this.authOperations.add(task);
    void task.finally(() => { this.socketOperations.delete(task); this.authOperations.delete(task); }).catch(() => {});
    return task;
  }

  private detachSocket(): void {
    const old = this.sock;
    this.sock = undefined;
    if (this.instance) delete this.instance.socket;
    if (!old) return;
    for (const event of baileysEvents) old.ev.removeAllListeners(event);
    try { old.end(new Error('Local socket stopped')); } catch { /* Already closed. */ }
  }

  private queueEvent(event: string, generation: number, handler: () => Promise<void>, history: HistoryProgressTracker): Promise<void> {
    if (this.stopped || generation !== this.generation) return Promise.resolve();
    const task = this.eventTail.then(async () => {
      if ((this.stopped || generation !== this.generation) && (!this.draining || event === 'connection.update')) return;
      await handler();
    }).catch(async () => {
      // Payloads/errors may contain QR codes, tokens or message text.
      console.error(`[${this.key}] Failed to process ${event}`);
      // A pending write from an old socket must never stop its replacement.
      if (!this.stopped && generation === this.generation) this.closeSocket(generation, history, undefined, event);
    });
    this.eventTail = task;
    this.eventTasks.add(task);
    void task.finally(() => this.eventTasks.delete(task)).catch(() => {});
    return task;
  }

  private backgroundEvent(task: Promise<void>, label: string): void {
    const handled = task.catch(() => console.error(`[${this.key}] Could not enqueue ${label}`));
    this.eventTasks.add(handled);
    void handled.finally(() => this.eventTasks.delete(handled));
  }

  private closeSocket(generation: number, history: HistoryProgressTracker, reason?: number, failedEvent?: string): void {
    if (this.stopped || generation !== this.generation) return;
    const revoked = reason === DisconnectReason.loggedOut;
    // These responses do not confirm revocation. Keep the session recoverable,
    // with a longer cooldown to avoid rapidly contesting a replacement or refusal.
    const retry = !revoked;
    const cooldown = reason === DisconnectReason.connectionReplaced ? this.dependencies.conflictRetryDelayMs
      : reason === DisconnectReason.forbidden || reason === DisconnectReason.multideviceMismatch ? this.dependencies.refusalRetryDelayMs : 0;
    // Repeated open→failure loops must also back off. Reset only after a stable
    // minute, without allocating another timer per connected number.
    if (this.connectedAt && Date.now() - this.connectedAt >= 60_000) this.reconnectAttempts = 0;
    this.connectedAt = 0;
    this.generation++;
    this.stopped = !retry;
    this.revoked = revoked;
    this.setStatus(revoked ? 'REMOVED' : 'OFFLINE', retry ? (this.auth?.state.creds.registered ? 'reconnecting' : 'pairing') : 'disconnected');
    this.detachSocket();
    // Do not queue recovery behind a blocked message/history database write.
    this.eventTail = Promise.resolve();
    this.qrCode = undefined; this.pairingCode = undefined;
    const snapshot = { ...this.instance! };
    console.info(`[${this.key}] Transport closed code=${reason ?? 'unknown'} state=${snapshot.connectionState}${failedEvent ? ' cause=EVENT_PROCESSING_FAILED' : ''}`);
    this.backgroundEvent(this.dependencies.emit(revoked ? 'connection.removed' : 'connection.close', snapshot,
      { reason: reason ?? null, ...(failedEvent ? { error: 'EVENT_PROCESSING_FAILED' } : {}) }), 'connection closure');
    const progress = failedEvent?.startsWith('messaging-history.') ? history.failure() : history.snapshot('interrupted');
    this.backgroundEvent(this.dependencies.emit('messaging-history.progress', snapshot, progress), 'history interruption');
    if (failedEvent) this.backgroundEvent(this.dependencies.emit('connection.error', snapshot, { event: failedEvent, error: 'EVENT_PROCESSING_FAILED' }), 'connection.error');
    if (revoked) {
      const pendingAuth = [...this.authOperations];
      const reset = (async () => {
        await Promise.allSettled(pendingAuth);
        await this.auth?.reset();
        this.revoked = false;
      })();
      this.backgroundEvent(reset, 'revoked credentials reset');
    }
    if (retry) this.scheduleReconnect(cooldown);
    else this.finishInitial();
  }

  private attachEvents(sock: WASocket, generation: number, history: HistoryProgressTracker): void {
    let socketClosed = false;
    const connected = () => !socketClosed && !this.stopped && generation === this.generation && this.sock === sock
      && this.instance?.connectionStatus === 'ONLINE' && sock.ws?.isOpen !== false;
    const closeReason = (update: BaileysEventMap['connection.update']) => (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
    const on = <K extends keyof BaileysEventMap>(event: K, handler: (data: BaileysEventMap[K]) => Promise<void>) => {
      sock.ev.on(event, data => {
        // Lifecycle and auth persistence cannot wait behind history imports.
        if (event === 'creds.update') {
          if (!socketClosed && !this.stopped && generation === this.generation) {
            const saving = this.trackOperation(() => this.auth!.saveCreds(), true);
            this.backgroundEvent(saving.catch(() => {
              this.closeSocket(generation, history, undefined, 'creds.update');
            }), 'credentials update');
          }
          return;
        }
        if (event === 'connection.update' && !this.stopped && generation === this.generation) {
          if (socketClosed) return;
          const update = data as BaileysEventMap['connection.update'];
          if (update.connection === 'close') {
            socketClosed = true;
            this.closeSocket(generation, history, closeReason(update));
            return;
          } else if (update.connection === 'open') { this.connectedAt = Date.now(); this.setStatus('ONLINE'); }
          else if (update.connection === 'connecting') this.setStatus('OFFLINE', this.auth?.state.creds.registered ? 'reconnecting' : 'pairing');
        }
        const historyBatch = event === 'messaging-history.set';
        const settleBatch = historyBatch ? history.queueBatch() : undefined;
        const queued = this.queueEvent(event, generation, () => {
          settleBatch?.();
          if (socketClosed && event !== 'connection.update') return Promise.resolve();
          const imports = event === 'messaging-history.set' || /^(messages|contacts|chats)\./.test(event);
          if (imports && (this.instance?.connectionStatus !== 'ONLINE' || sock.ws?.isOpen === false)) return Promise.resolve();
          return handler(data);
        }, history);
        if (settleBatch) void queued.finally(settleBatch).catch(() => {});
      });
    };
    const emit = (event: string, data: unknown, metadata?: HistoryChunkMetadata) => this.emit(event, data, generation, metadata);
    on('creds.update', async () => { await this.auth!.saveCreds(); });
    on('connection.update', async update => {
      // An open/QR event can already be waiting behind a large history import
      // when the phone revokes this device. It must never revive that socket.
      if (socketClosed && update.connection !== 'close') return;
      if (typeof update.receivedPendingNotifications === 'boolean') {
        await emit('messaging-history.progress', history.pendingNotifications(update.receivedPendingNotifications));
      }
      if (update.qr && !sock.authState.creds.registered) {
        if (++this.qrCount > this.dependencies.qrLimit) {
          await emit(this.phoneNumber ? 'pairingcode.limit' : 'qrcode.limit', { qrCodeLimit: this.dependencies.qrLimit });
          this.stopped = true; this.generation++; this.detachSocket(); this.setStatus('OFFLINE'); this.finishInitial();
          return;
        }
        if (this.phoneNumber) {
          if (!this.pairingRequested) {
            this.pairingRequested = true;
            try {
              const pairingCode = await sock.requestPairingCode(this.phoneNumber);
              if (socketClosed || this.stopped || generation !== this.generation) return;
              this.pairingCode = pairingCode;
              await emit('pairingcode.updated', { pairingCode });
            } catch { this.pairingRequested = false; throw new Error('Pairing code request failed'); }
          }
        } else {
          const qrCode = await QRCode.toDataURL(update.qr);
          if (socketClosed || this.stopped || generation !== this.generation) return;
          this.qrCode = qrCode;
          await emit('qrcode.updated', { qrCode });
        }
        this.finishInitial();
      }
      if (update.connection === 'connecting') {
        await emit('connection.connecting', { connection: 'connecting' });
      } else if (update.connection === 'open') {
        this.qrCode = undefined; this.pairingCode = undefined;
        this.instance!.instanceJid = sock.user?.id ?? null;
        this.finishInitial();
        await this.trackOperation(() => this.auth!.saveCreds(), true);
        if (socketClosed || this.stopped || generation !== this.generation) return;
        console.info(`[${this.key}] Transport connected`);
        await emit('connection.open', { connection: 'open' });
        await emit('messaging-history.progress', history.snapshot());
        // Photo lookup failure must not suppress the connection event or block startup.
        void this.getProfilePicture().catch(() => undefined);
      }
    });
    on('messaging-history.status', async data => { await emit('messaging-history.progress', history.providerStatus(data)); });
    on('messaging-history.set', async ({ messages, chats, contacts, ...progress }) => {
      if (!connected()) return;
      const visibleMessages = this.webhookMessages(messages);
      // Plan all chunks before announcing the watermark. Never silently skip an
      // oversized entry, and count precisely the visible arrays that are sent.
      const plans = { contacts: webhookChunks(contacts), chats: webhookChunks(chats), messages: webhookChunks(visibleMessages) };
      const batchId = randomUUID();
      const metadata = (event: string, index: number): HistoryChunkMetadata => ({ ...history.identity, batchId, chunkId: `${batchId}:${event}:${index}` });
      await emit('messaging-history.progress', history.beginBatch(progress,
        { contacts: contacts.length, chats: chats.length, messages: visibleMessages.length },
        plans.contacts.length + plans.chats.length + plans.messages.length));
      await emit('messaging-history.progress', history.snapshot('importing'));
      for (const [index, chunk] of plans.contacts.entries()) {
        if (!connected()) return;
        await this.dependencies.store.saveManyContacts(this.key, chunk as typeof contacts);
        if (!connected()) return;
        await emit('contacts.set', chunk, metadata('contacts.set', index));
      }
      for (const [index, chunk] of plans.chats.entries()) {
        if (!connected()) return;
        await this.dependencies.store.saveManyChats(this.key, chunk as any);
        if (!connected()) return;
        await emit('chats.set', chunk, metadata('chats.set', index));
      }
      // Persist each slice before delivering it; the first messages should not
      // wait for tens of thousands of later messages in the same history event.
      // Internal protocol messages remain available for getMessage without
      // contributing to the visible webhook watermark.
      let savedVisible = 0, deliveredVisible = 0, chunkIndex = 0;
      for (let offset = 0; offset < messages.length; offset += WEBHOOK_CHUNK_ITEMS) {
        if (!connected()) return;
        const slice = messages.slice(offset, offset + WEBHOOK_CHUNK_ITEMS);
        await this.dependencies.store.saveManyMessages(this.key, slice);
        if (!connected()) return;
        savedVisible += slice.filter(message => this.isWebhookMessage(message)).length;
        while (chunkIndex < plans.messages.length && deliveredVisible + plans.messages[chunkIndex]!.length <= savedVisible) {
          const chunk = plans.messages[chunkIndex]!;
          await emit('messages.set', chunk, metadata('messages.set', chunkIndex));
          deliveredVisible += chunk.length;
          chunkIndex++;
        }
      }
      await emit('messaging-history.progress', history.importedBatch());
    });
    on('messages.upsert', async ({ messages }) => {
      await this.dependencies.store.saveManyMessages(this.key, messages);
      const visible = this.webhookMessages(messages);
      if (visible.length) await emit('messages.upsert', visible);
    });
    on('messages.update', async updates => {
      const results = [];
      for (const item of updates) {
        if (!connected()) return;
        const prior = item.key.id ? await this.dependencies.store.getMessageById(item.key.id, this.key, item.key.remoteJid ?? undefined) : undefined;
        // A previous generation may finish its lookup after the replacement
        // already stored a newer edit. Never write that stale snapshot back.
        if (!connected()) return;
        const stored = prior ? await this.dependencies.store.saveMessages(this.key, { ...prior, ...item.update, key: { ...prior.key, ...item.key } }) as any : undefined;
        // A renewed download URL changes stored transport metadata, not the message's text.
        if ((item.update as { mediaMetadataOnly?: boolean }).mediaMetadataOnly === true) continue;
        const marker = sourceEdit(stored?.content?.sourceEdit);
        const update = marker ? { ...item.update, sourceEdit: marker } : item.update;
        if (item.update.pollUpdates && prior?.message) {
          results.push({ ...item, update: { ...update, pollVotes: getAggregateVotesInPollMessage({ message: prior.message, pollUpdates: item.update.pollUpdates }) } });
        } else results.push({ ...item, update });
      }
      if (results.length) await emit('messages.update', results);
    });
    on('messages.delete', async data => { await this.dependencies.store.deleteMessages(this.key, data); await emit('messages.delete', data); });
    on('messages.media-update', async data => {
      const results = [];
      for (const item of data) {
        if (!connected()) return;
        let error: { code: string } | undefined;
        try {
          const prior = item.key.id ? await this.dependencies.store.getMessageById(item.key.id, this.key, item.key.remoteJid ?? undefined) : undefined;
          if (!connected()) return;
          if (!prior) throw new RequestError(404, 'Message not found.');
          renewedMediaPath(prior, item);
        } catch (failure) {
          error = { code: failure instanceof RequestError && failure.statusCode === 410 ? 'MEDIA_UNAVAILABLE' : 'MEDIA_RENEWAL_FAILED' };
        }
        results.push({ key: item.key, ...(error ? { error } : {}) });
      }
      await emit('messages.media-update', results);
    });
    on('chats.upsert', async data => { await this.dependencies.store.saveManyChats(this.key, data as any); await emit('chats.upsert', data); });
    on('chats.update', async data => { await this.dependencies.store.saveManyChats(this.key, data as any); await emit('chats.update', data); });
    on('chats.delete', async data => { await this.dependencies.store.deleteChats(this.key, data); await emit('chats.delete', data); });
    on('contacts.upsert', async data => { await this.dependencies.store.saveManyContacts(this.key, data); await emit('contacts.upsert', data); });
    on('contacts.update', async data => { await this.dependencies.store.saveManyContacts(this.key, data); await emit('contacts.update', data); });
    on('lid-mapping.update', async data => {
      // Baileys has already persisted forward/reverse Signal mappings via keys.set.
      await this.dependencies.store.saveManyContacts(this.key, [{ id: data.lid, phoneNumber: data.pn }]);
      await emit('lid-mapping.update', data);
    });
    on('groups.upsert', async data => { for (const group of data) this.groupCache.set(group.id, group); await emit('groups.upsert', data); });
    on('groups.update', async data => { for (const group of data) if (group.id) this.groupCache.del(group.id); await emit('groups.update', data); });
    on('group-participants.update', async data => { this.groupCache.del(data.id); await emit('group-participants.update', data); });
    const passthrough = ['presence.update', 'messages.reaction', 'message-receipt.update', 'group.join-request', 'blocklist.set', 'blocklist.update', 'call', 'labels.edit', 'labels.association', 'newsletter.reaction', 'newsletter.view', 'newsletter-participants.update', 'newsletter-settings.update'] as const;
    for (const event of passthrough) on(event, data => emit(event, data));
  }

  private isWebhookMessage(message: WAMessage): boolean {
    if (!message.message || message.message.senderKeyDistributionMessage) return false;
    const protocol = message.message.protocolMessage;
    return !protocol || protocol.type === proto.Message.ProtocolMessage.Type.REVOKE || protocol.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT;
  }

  private webhookMessages(messages: WAMessage[]): unknown[] {
    return messages.filter(message => this.isWebhookMessage(message)).map(message => ({
      ...serializeBaileys(message), messageTimestamp: messageTimestamp(message.messageTimestamp), messageType: getContentType(message.message!),
    }));
  }

  private async emit(event: string, data: unknown, generation?: number, history?: HistoryChunkMetadata): Promise<void> {
    if (!this.instance || (!this.draining && (this.stopped || (generation !== undefined && generation !== this.generation)))) return;
    await this.dependencies.emit(event, { ...this.instance }, serializeBaileys(data), history);
  }

  private scheduleReconnect(minimumDelayMs = 0): void {
    if (this.stopped || this.retryTimer) { this.finishInitial(); return; }
    // A temporary network outage can last hours. Keep retrying registered
    // sessions with capped backoff; terminal logout reasons never reach here.
    const ceiling = Math.min(this.dependencies.reconnectMaxDelayMs, this.dependencies.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempts++, 16));
    const jitter = this.dependencies.random();
    const wait = Math.max(1, Math.round(ceiling * (0.5 + jitter * 0.5)), Math.round(minimumDelayMs * (1 + jitter * 0.25)));
    this.setStatus('OFFLINE', this.auth?.state.creds.registered || !this.auth ? 'reconnecting' : 'pairing');
    console.info(`[${this.key}] Reconnect attempt=${this.reconnectAttempts} delayMs=${wait}`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.stopped) return;
      void this.startSocket().catch(() => {
        console.error(`[${this.key}] Socket reconnect failed`);
        this.scheduleReconnect();
      });
    }, wait);
    this.retryTimer.unref();
  }

  setStatus(status: ConnectionStatus, state?: ConnectionState): void {
    if (this.instance) updateConnectionStatus(this.instance, status, state);
    if (this.key) instanceStatus.set(this.key, status);
  }

  /** Supervised independently of HTTP polling and the message/history queues. */
  checkHealth(now = Date.now()): void {
    if (this.stopped || this.retryTimer || this.setupTask || !this.sock || !this.history || !this.auth?.state.creds.registered) return;
    const transportClosed = this.instance?.connectionStatus === 'ONLINE' && this.sock.ws?.isOpen === false;
    const loginStalled = !this.connectedAt && now - this.socketStartedAt >= this.dependencies.handshakeTimeoutMs;
    if (transportClosed || loginStalled) {
      console.warn(`[${this.key}] Transport supervision detected ${transportClosed ? 'closed socket without notification' : 'login timeout'}`);
      this.closeSocket(this.generation, this.history, transportClosed ? DisconnectReason.connectionClosed : DisconnectReason.timedOut);
    }
  }

  async reconnect(): Promise<ConnectResult> {
    if (!this.key) throw new Error('Instance has not been created');
    if (this.startTask) return this.startTask;
    this.checkHealth();
    // The front polls connect for QR/status; polling must preserve a live socket.
    if (!this.stopped && (this.sock || this.retryTimer || this.setupTask)) return this.result();
    await this.shutdown();
    this.reconnectAttempts = 0;
    return this.create({ owner: this.owner, instanceName: this.instanceName, phoneNumber: this.phoneNumber });
  }

  /** Stops networking and drains writes without deleting credentials or message history. */
  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    const task = this.performShutdown();
    this.shutdownTask = task;
    void task.finally(() => { if (this.shutdownTask === task) this.shutdownTask = undefined; }).catch(() => {});
    return task;
  }

  private async performShutdown(): Promise<void> {
    const activeHistory = this.sock ? this.history : undefined;
    this.draining = true;
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.finishInitial(); this.detachSocket();
    try {
      await this.setupTask?.catch(() => {});
      this.detachSocket();
      await Promise.all([...this.eventTasks]);
      await Promise.allSettled([...this.socketOperations]);
      if (this.revoked) { await this.auth?.reset(); this.revoked = false; }
      else await this.auth?.drain();
      if (this.instance?.connectionStatus !== 'REMOVED') this.setStatus('OFFLINE');
      if (activeHistory && this.instance) {
        await this.dependencies.emit('messaging-history.progress', { ...this.instance }, activeHistory.snapshot('interrupted'));
      }
      this.msgRetryCounterCache.flushAll(); this.userDevicesCache.flushAll(); this.groupCache.flushAll();
    } finally { this.draining = false; }
  }

  async clearInstance(): Promise<void> {
    await this.shutdown();
    await this.auth?.remove();
    await this.dependencies.store.deleteByInstance(this.key);
    await this.dependencies.removeSession(this.owner, this.instanceName);
    this.setStatus('REMOVED');
    if (this.instance) await this.dependencies.emit('connection.removed', { ...this.instance }, {});
    delete instanceConnection[this.key]; delete instances[this.key];
  }

  /** Revoke this linked device while preserving the instance and its history. */
  async disconnect(): Promise<ConnectResult> {
    if (!this.instance) throw new RequestError(404, 'Instance not found.');
    const sock = this.sock;
    if (this.auth?.state.creds.registered) {
      if (!sock || this.instance.connectionStatus !== 'ONLINE' || (sock.ws && !sock.ws.isOpen)) throw new RequestError(409, 'Instance not connected.');
      // Do not erase credentials if the remote logout could not be sent.
      try { await sock.logout('Device disconnected by its owner'); }
      catch { throw new RequestError(502, 'Unable to disconnect the WhatsApp device.'); }
    }
    await this.shutdown();
    await this.auth?.reset();
    this.qrCode = undefined; this.pairingCode = undefined; this.phoneNumber = undefined;
    this.instance.instanceJid = null;
    delete this.instance.profilePictureUrl;
    this.setStatus('REMOVED');
    await this.dependencies.emit('connection.removed', { ...this.instance }, { reason: 'user_initiated' });
    return this.result();
  }

  async getProfilePicture(): Promise<string | undefined> {
    const sock = this.sock;
    const generation = this.generation;
    if (!sock?.user?.id) return undefined;
    try {
      const url = await sock.profilePictureUrl(sock.user.id, 'image', 10_000);
      if (generation === this.generation && !this.stopped && this.instance) this.instance.profilePictureUrl = url;
      return url;
    } catch { return undefined; }
  }

  async getMessage(key: WAMessageKey | string): Promise<proto.IMessage | undefined> {
    const id = typeof key === 'string' ? key : key.id;
    if (!id) return undefined;
    const remoteJid = typeof key === 'string' ? undefined : key.remoteJid ?? undefined;
    const message = await this.dependencies.store.getMessageById(id, this.key, remoteJid);
    return message?.message ? proto.Message.create(message.message) : undefined;
  }

  async publishSentMessage(sentMessage: WAMessage): Promise<void> {
    if (!this.key || this.stopped) throw new Error('Instance is not connected');
    await this.dependencies.store.saveMessages(this.key, sentMessage);
    await this.emit('send.message', this.webhookMessages([sentMessage]));
  }
}
