import { randomUUID } from 'node:crypto';
import type { WhatsAppOptions } from '../config/whatsapp-options.js';
import type { Method, SafeLogger } from '../logging/safe-logger.js';

export const CONTACT_COLLECTION = 'critical_unblock_low';
export class ContactWriteError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'ContactWriteError';
  }
}
/** The unchanged ZapToBox backend interprets HTTP 409 as a disconnected socket.
 * Pre-send policy rejections use 422; only uncertain remote outcomes use 502.
 * The stable [CONTACT_...] code and detailed reason remain in the API response/logs.
 */
export function contactFailureHttpStatus(error: ContactWriteError): 422 | 502 {
  return error.code === 'CONTACT_WRITE_UNCERTAIN' || error.code === 'CONTACT_GUARD_NOT_EXECUTED' ? 502 : 422;
}
export interface ContactRecord { id?: string; phoneNumber?: string; lid?: string; }
export interface ContactAction { firstName: string; fullName: string; lidJid?: string; saveOnPrimaryAddressbook: true; }
export interface ContactPlan { id: string; pnJid: string; lidJid?: string; action: ContactAction; }
export interface ContactContext {
  assertCurrent(): void;
  lookup(id: string): Promise<ContactRecord | undefined>;
  getPNForLID(lid: string): Promise<string | null | undefined>;
  getLIDForPN(pn: string): Promise<string | null | undefined>;
  currentKeyId(): string | undefined;
  readKey(keyId: string): Promise<unknown>;
  readState(): Promise<unknown>;
  sync(): Promise<void>;
  write(pn: string, action: ContactAction): Promise<unknown>;
}
export interface ProviderContactGuardInput {
  stage: 'before-encode' | 'before-send';
  name: string;
  patchCreate: { index?: unknown; syncAction?: { contactAction?: unknown } };
  initial: unknown;
  keyId: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}
export function normalizedContactJid(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{5,20}(?::\d{1,5})?@(?:s\.whatsapp\.net|lid)$/u.test(value)) return;
  return value.replace(/:\d+@/u, '@');
}
const pnJid = (value: unknown): string | undefined => {
  const id = normalizedContactJid(value);
  return id && /^\d{8,15}@s\.whatsapp\.net$/u.test(id) ? id : undefined;
};
const lidJid = (value: unknown): string | undefined => {
  const id = normalizedContactJid(value);
  return id?.endsWith('@lid') ? id : undefined;
};
function fail(status: number, code: string, message: string): never { throw new ContactWriteError(status, code, message); }

export function inspectSyncKey(value: unknown): { keyBytes: number } {
  const bytes = record(value) ? value.keyData : undefined;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    fail(409, 'CONTACT_SYNC_KEY_INVALID', 'A chave de sincronização não está disponível em bytes válidos. Nenhum contato foi enviado.');
  }
  return { keyBytes: bytes.byteLength };
}
/** Structural validation is NOT proof of a matching server-side snapshot. */
export function inspectSyncState(value: unknown): { version: number; hashBytes: number; entries: number } {
  if (!record(value) || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1 ||
    !(value.hash instanceof Uint8Array) || value.hash.byteLength !== 128 || !record(value.indexValueMap)) {
    fail(409, 'CONTACT_SYNC_STATE_INVALID', 'Estado da coleção de contatos ausente, vazio ou inválido. Nenhum contato foi enviado.');
  }
  let entries = 0;
  for (const [index, entry] of Object.entries(value.indexValueMap)) {
    if (!/^[A-Za-z0-9+/]{43}=$/u.test(index) || !record(entry) || !(entry.valueMac instanceof Uint8Array) || entry.valueMac.byteLength !== 32) {
      fail(409, 'CONTACT_SYNC_STATE_INVALID', 'Formato inválido no índice da coleção de contatos. Nenhum contato foi enviado.');
    }
    entries++;
  }
  return { version: value.version, hashBytes: value.hash.byteLength, entries };
}

export async function resolveContactPlan(remoteJid: string, name: string, context: ContactContext, requireLid: boolean): Promise<ContactPlan> {
  const id = normalizedContactJid(remoteJid);
  if (!id || id.endsWith('@s.whatsapp.net') && !pnJid(id)) fail(400, 'CONTACT_INVALID_JID', 'Informe um contato individual com JID válido.');
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) {
    fail(400, 'CONTACT_INVALID_NAME', 'Nome de contato inválido.');
  }
  context.assertCurrent();
  const existing = await context.lookup(id);
  context.assertCurrent();
  const all = [id, existing?.id, existing?.phoneNumber, existing?.lid];
  const phoneCandidates = [...new Set(all.map(pnJid).filter((value): value is string => Boolean(value)))];
  const lidCandidates = [...new Set(all.map(lidJid).filter((value): value is string => Boolean(value)))];
  if (phoneCandidates.length > 1 || lidCandidates.length > 1) fail(409, 'CONTACT_IDENTITY_CONFLICT', 'Há identificadores conflitantes para este contato. Nenhuma alteração foi enviada.');
  const requestedLid = lidJid(id);
  let phone = pnJid(id);
  if (requestedLid) {
    phone = pnJid(await context.getPNForLID(requestedLid));
    context.assertCurrent();
    // A cached PN is only a candidate until the reverse direction confirms this LID.
    phone ??= phoneCandidates[0];
  }
  if (!phone) fail(409, 'CONTACT_PHONE_UNRESOLVED', 'O telefone correspondente ao LID ainda não foi confirmado pelo WhatsApp.');
  if (phoneCandidates.some(candidate => candidate !== phone)) fail(409, 'CONTACT_IDENTITY_CONFLICT', 'O telefone do cache diverge do mapeamento do provedor.');
  const resolvedLid = lidJid(await context.getLIDForPN(phone));
  context.assertCurrent();
  if (requestedLid && resolvedLid !== requestedLid || resolvedLid && lidCandidates.some(candidate => candidate !== resolvedLid)) {
    fail(409, 'CONTACT_IDENTITY_CONFLICT', 'A associação entre telefone e LID não foi confirmada. Nenhuma alteração foi enviada.');
  }
  if (requireLid && !resolvedLid) fail(409, 'CONTACT_LID_UNRESOLVED', 'O LID correspondente ao telefone ainda não está disponível.');
  if (!resolvedLid && lidCandidates.length) fail(409, 'CONTACT_IDENTITY_CONFLICT', 'Não foi possível validar o LID já associado ao contato.');
  if (resolvedLid) {
    const reverse = pnJid(await context.getPNForLID(resolvedLid));
    context.assertCurrent();
    if (reverse && reverse !== phone) fail(409, 'CONTACT_IDENTITY_CONFLICT', 'O mapeamento reverso do provedor está em conflito.');
  }
  const fullName = name.trim();
  const firstName = fullName.split(/\s+/u)[0]!;
  return { id, pnJid: phone, ...(resolvedLid ? { lidJid: resolvedLid } : {}),
    action: { firstName, fullName, ...(resolvedLid ? { lidJid: resolvedLid } : {}), saveOnPrimaryAddressbook: true } };
}

/** One gate per socket generation. Health observation is independent of log output. */
export class ContactSafety {
  private connectedAt: number | undefined;
  private busy = false;
  private issueCount = 0;
  private lastIssue: string | undefined;
  private lastAttemptAt: number | undefined;
  private lastContactAt: number | undefined;
  private lastContactEvent = 'none';
  private operationRef: string | undefined;
  private prepared: { plan: ContactPlan; context: ContactContext; visited: Set<string> } | undefined;
  private outcomeUncertain = false;

  constructor(private readonly options: WhatsAppOptions, private readonly logger: SafeLogger,
    private readonly guardInstalled: boolean, private readonly now: () => number = Date.now) {}

  setConnected(connected: boolean): void {
    if (connected) this.connectedAt ??= this.now();
    else this.connectedAt = undefined;
  }
  snapshot(): Record<string, unknown> {
    return { healthy: this.issueCount === 0 && !this.outcomeUncertain, issueCount: this.issueCount, lastIssue: this.lastIssue ?? null,
      busy: this.busy, mode: this.options.contactMode, lastContactEvent: this.lastContactEvent,
      lastContactAt: this.lastContactAt ?? null, ...(this.operationRef ? { operationRef: this.operationRef } : {}) };
  }
  observe(level: Method, args: readonly unknown[]): void {
    const data = args.find(record);
    const msg = args.filter((arg): arg is string => typeof arg === 'string').join(' ');
    const error = data?.err ?? data?.error;
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : typeof error === 'string' ? error : '';
    const text = `${msg} ${detail}`;
    const collection = typeof data?.name === 'string' ? data.name : typeof data?.collection === 'string' ? data.collection : undefined;
    const explicitlyOther = collection && collection !== CONTACT_COLLECTION;
    const failure = /LTHash verification failed|Invalid patch mac|HMAC (?:index |content )?verification failed|continuing with partial state|failed to sync|blocked on missing key|failed to find key|bad decrypt|App state key not present/iu.test(text);
    const appStateContext = /critical_unblock_low|LTHash|app.?state|syncd|decodeSyncd|decodePatches|snapshot|patch mac|decode mutation/iu.test(text);
    // Read failures from unrelated Signal sessions are not app-state evidence.
    if (!explicitlyOther && failure && (appStateContext || collection === CONTACT_COLLECTION) &&
      (level === 'warn' || level === 'error' || level === 'fatal' || /failed to sync|blocked on missing key/iu.test(text))) {
      this.issueCount++;
      this.lastIssue = /LTHash|partial state/iu.test(text) ? 'APP_STATE_PARTIAL'
        : /missing key|find key|key not present/iu.test(text) ? 'APP_STATE_MISSING_KEY' : 'APP_STATE_SYNC_FAILED';
    }
  }
  private note(event: string, data: Record<string, unknown> = {}, warning = false): void {
    this.lastContactEvent = event;
    this.lastContactAt = this.now();
    if (!this.options.contactDiagnostics) return;
    const details = { event, mode: this.options.contactMode, operationRef: this.operationRef, collection: CONTACT_COLLECTION, ...data };
    if (warning) this.logger.warn(details, 'contact-sync'); else this.logger.info(details, 'contact-sync');
  }
  private assertHealthy(): void {
    if (this.outcomeUncertain) fail(409, 'CONTACT_WRITE_UNCERTAIN', 'Uma tentativa anterior teve resultado incerto. A escrita está bloqueada nesta conexão; não repita na conta principal.');
    if (this.issueCount) fail(409, 'CONTACT_SYNC_UNHEALTHY', 'O provedor informou falha/estado parcial na sincronização. Escrita de contato bloqueada; consulte os logs da API.');
  }
  /** Invoked by the pinned provider adapter after its INTERNAL resync, and just before send. */
  async guardProviderWrite(input: ProviderContactGuardInput): Promise<void> {
    const prepared = this.prepared;
    if (this.options.contactMode !== 'write' || !prepared || !this.busy) fail(503, 'CONTACT_GUARD_DENIED', 'A escrita de contato não foi autorizada por esta API.');
    prepared.context.assertCurrent();
    this.assertHealthy();
    const index = input.patchCreate.index;
    if (input.name !== CONTACT_COLLECTION || !Array.isArray(index) || index.length !== 2 || index[0] !== 'contact' || index[1] !== prepared.plan.pnJid) {
      fail(409, 'CONTACT_PATCH_MISMATCH', 'O índice da alteração não corresponde ao contato validado.');
    }
    const action = input.patchCreate.syncAction?.contactAction;
    if (!record(action) || action.fullName !== prepared.plan.action.fullName || action.firstName !== prepared.plan.action.firstName ||
      action.lidJid !== prepared.plan.action.lidJid || action.saveOnPrimaryAddressbook !== true ||
      Object.keys(action).some(key => !['firstName', 'fullName', 'lidJid', 'saveOnPrimaryAddressbook'].includes(key))) {
      fail(409, 'CONTACT_PATCH_MISMATCH', 'O conteúdo da alteração difere do contato validado.');
    }
    if (prepared.context.currentKeyId() !== input.keyId) fail(409, 'CONTACT_SYNC_KEY_CHANGED', 'A chave de sincronização mudou durante a operação.');
    const state = inspectSyncState(input.initial);
    const key = inspectSyncKey(await prepared.context.readKey(input.keyId));
    prepared.context.assertCurrent();
    this.assertHealthy();
    prepared.visited.add(input.stage);
    this.note(`contact.guard.${input.stage}`, { ...state, ...key });
  }

  async execute(remoteJid: string, name: string, context: ContactContext): Promise<ContactPlan> {
    if (this.options.contactMode === 'off') {
      this.note('contact.blocked.disabled', {}, true);
      fail(503, 'CONTACT_SYNC_DISABLED', 'Salvamento remoto desativado no .env (CONTACT_SYNC_MODE=off). Nenhum contato foi enviado.');
    }
    if (this.busy) fail(409, 'CONTACT_SYNC_BUSY', 'Já existe uma verificação ou edição de contato nesta conexão.');
    this.assertHealthy();
    if (this.connectedAt === undefined || this.now() - this.connectedAt < this.options.contactMinUptimeMs) {
      fail(409, 'CONTACT_SYNC_NOT_READY', 'A conexão ainda está no intervalo inicial de sincronização configurado.');
    }
    if (this.lastAttemptAt !== undefined && this.now() - this.lastAttemptAt < this.options.contactCooldownMs) {
      fail(429, 'CONTACT_SYNC_COOLDOWN', 'Aguarde o intervalo CONTACT_SYNC_COOLDOWN_MS antes de outra operação.');
    }
    if (this.options.contactMode === 'write' && !this.guardInstalled) {
      fail(503, 'CONTACT_GUARD_MISSING', 'O adaptador de proteção do Baileys não está instalado. Execute npm run build antes de habilitar a escrita.');
    }
    this.busy = true;
    this.lastAttemptAt = this.now();
    this.operationRef = randomUUID();
    const startedAt = this.now();
    let writing = false;
    let acknowledged = false;
    try {
      const plan = await resolveContactPlan(remoteJid, name, context, this.options.contactRequireLid);
      context.assertCurrent();
      this.assertHealthy();
      const keyId = context.currentKeyId();
      if (!keyId) fail(409, 'CONTACT_SYNC_KEY_MISSING', 'A chave de sincronização ainda não chegou. Nenhum contato foi enviado.');
      const key = inspectSyncKey(await context.readKey(keyId));
      context.assertCurrent();
      this.note('contact.preflight.start', { nameLength: plan.action.fullName.length, hasLid: Boolean(plan.lidJid), ...key });
      // This reads/synchronizes app state; it is NOT an address-book mutation.
      await context.sync();
      context.assertCurrent();
      this.assertHealthy();
      const state = inspectSyncState(await context.readState());
      context.assertCurrent();
      this.assertHealthy();
      this.note('contact.preflight.ok', state);
      if (this.options.contactMode === 'check') {
        this.note('contact.check.complete', { durationMs: this.now() - startedAt });
        fail(409, 'CONTACT_DIAGNOSTIC_ONLY', 'Verificação concluída sem gravar contato. CONTACT_SYNC_MODE=check não aplica o nome solicitado.');
      }
      this.prepared = { plan, context, visited: new Set() };
      writing = true;
      this.note('contact.write.start');
      await context.write(plan.pnJid, plan.action);
      acknowledged = true;
      context.assertCurrent();
      this.assertHealthy();
      if (!this.prepared.visited.has('before-encode') || !this.prepared.visited.has('before-send')) {
        this.outcomeUncertain = true;
        fail(502, 'CONTACT_GUARD_NOT_EXECUTED', 'O provedor não executou as proteções esperadas. Resultado incerto; não repita a escrita.');
      }
      this.note('contact.write.acknowledged', { durationMs: this.now() - startedAt });
      return plan;
    } catch (error) {
      // A local guard rejection before query() is NOT an uncertain remote write.
      const deniedBeforeSend = error instanceof ContactWriteError && !this.prepared?.visited.has('before-send') && !acknowledged;
      if (writing && !deniedBeforeSend) this.outcomeUncertain = true;
      if (!(error instanceof ContactWriteError && error.code === 'CONTACT_DIAGNOSTIC_ONLY')) {
        this.note(this.outcomeUncertain ? 'contact.write.uncertain' : 'contact.blocked', {
          code: error instanceof ContactWriteError ? error.code : 'CONTACT_PROVIDER_ERROR', err: error,
          durationMs: this.now() - startedAt, ...this.snapshot(),
        }, true);
      }
      if (this.outcomeUncertain) {
        if (error instanceof ContactWriteError && error.code === 'CONTACT_GUARD_NOT_EXECUTED') throw error;
        fail(502, 'CONTACT_WRITE_UNCERTAIN', 'O provedor não confirmou a conclusão com segurança. Não repita a escrita; consulte os logs da API.');
      }
      if (error instanceof ContactWriteError) throw error;
      fail(502, 'CONTACT_PREFLIGHT_FAILED', 'Não foi possível concluir a verificação do contato. Nenhuma escrita de contato foi iniciada.');
    } finally {
      this.prepared = undefined;
      this.busy = false;
    }
  }
}

const gates = new WeakMap<object, ContactSafety>();
export function registerContactSafety(socket: object, gate: ContactSafety): void { gates.set(socket, gate); }
export function getContactSafety(socket: object): ContactSafety | undefined { return gates.get(socket); }
