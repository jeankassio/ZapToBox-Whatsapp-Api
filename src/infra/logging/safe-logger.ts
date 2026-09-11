import { createHash } from 'node:crypto';
import type { LogLevel } from '../config/whatsapp-options.js';

export type Method = Exclude<LogLevel, 'silent'>;
export type LogObserver = (level: Method, args: readonly unknown[]) => void;
export interface LogSink {
  level: string;
  fatal(data: unknown, message?: string): void;
  error(data: unknown, message?: string): void;
  warn(data: unknown, message?: string): void;
  info(data: unknown, message?: string): void;
  debug(data: unknown, message?: string): void;
  trace(data: unknown, message?: string): void;
}
export interface SafeLogger {
  level: string;
  child(bindings: Record<string, unknown>): SafeLogger;
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}
export const instanceReference = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 16);
const collections = new Set(['critical_block', 'critical_unblock_low', 'regular', 'regular_low', 'regular_high']);
const fields = new Set([
  'event', 'phase', 'stage', 'code', 'statusCode', 'reason', 'version', 'attempt', 'generation', 'count', 'durationMs',
  'connected', 'keyBytes', 'hashBytes', 'entries', 'instanceRef', 'connectionState', 'syncStatus', 'operationRef',
  'mode', 'queryTimeoutMs', 'sessionLabel', 'browserName', 'runtime', 'logLevel', 'baileysLogLevel',
  'collection', 'errorType', 'stack', 'error', 'time', 'tag', 'lastContactEvent', 'lastContactAt',
  'cooldownMs', 'remainingMs', 'healthy', 'issueCount', 'lastIssue', 'busy', 'nameLength', 'hasLid',
  'source', 'store', 'minUptimeMs', 'diagnostics', 'redactIdentifiers',
]);
export function sanitizeText(value: string, redactIdentifiers = true): string {
  // Do not dump protocol XML, QR payloads, JWTs, URLs or long binary/base64 strings.
  let out = value.replace(/<[^>]+>/gu, '[xml omitted]')
    .replace(/\b(?:https?|wss?):\/\/[^\s)]+/giu, '[url omitted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/gu, '[token omitted]')
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/gu, '[long value omitted]')
    .replace(/(?:Bearer\s+)[^\s]+/giu, 'Bearer [omitted]')
    .replace(/(["']?(?:password|token|secret|keyData|privateKey|advSecretKey|pairingCode|qrCode)["']?\s*[:=]\s*)[^\s,}]+/giu, '$1[omitted]');
  if (redactIdentifiers) out = out.replace(/\b\d+(?::\d+)?@(?:s\.whatsapp\.net|lid|g\.us|hosted(?:\.lid)?)/gu, '[jid]')
    .replace(/\b\d{8,}\b/gu, '[number]');
  return out.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 4000);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !ArrayBuffer.isView(value);
}
export function errorSummary(error: unknown, redactIdentifiers = true): Record<string, unknown> {
  if (!isRecord(error)) return typeof error === 'string' ? { message: sanitizeText(error, redactIdentifiers) } : {};
  const result: Record<string, unknown> = {};
  for (const key of ['name', 'message', 'stack', 'code']) {
    const value = error[key];
    if (typeof value === 'string') result[key === 'name' ? 'errorType' : key] = sanitizeText(value, redactIdentifiers);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  const output = error.output;
  if (isRecord(output) && typeof output.statusCode === 'number') result.statusCode = output.statusCode;
  // Inspect only stanza type/reason/code; never dump binary content, keys or payloads.
  const data = error.data;
  if (isRecord(data)) {
    if (typeof data.tag === 'string') result.tag = sanitizeText(data.tag, redactIdentifiers);
    if (isRecord(data.attrs)) {
      for (const key of ['code', 'reason', 'type']) if (typeof data.attrs[key] === 'string') result[`stanza_${key}`] = sanitizeText(data.attrs[key], redactIdentifiers);
    }
    if (Array.isArray(data.content)) {
      result.stanza_children = data.content.slice(0, 8).flatMap(child => isRecord(child) && typeof child.tag === 'string' ? [sanitizeText(child.tag, redactIdentifiers)] : []);
    }
  }
  return result;
}
function safeFields(value: unknown, redact: boolean): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'err' || key === 'lastDisconnect') { result[key] = errorSummary(item, redact); continue; }
    if (key === 'name' && typeof item === 'string' && collections.has(item)) { result.collection = item; continue; }
    if (!fields.has(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean' || item === null) result[key] = item;
    else if (typeof item === 'string') result[key] = sanitizeText(item, redact);
    else if (key === 'error') result.error = errorSummary(item, redact);
  }
  return result;
}
/** Observation runs BEFORE output filtering, even if the sink is silent. */
export function createSafeLogger(sink: LogSink, bindings: Record<string, unknown> = {}, redact = true, observer?: LogObserver): SafeLogger {
  const bound = safeFields(bindings, redact);
  const emit = (method: Method, args: unknown[]) => {
    observer?.(method, args);
    const message = args.filter((item): item is string => typeof item === 'string').map(item => sanitizeText(item, redact)).join(' ').slice(0, 4000);
    const meta = Object.assign({}, bound, ...args.map(item => item instanceof Error ? { err: errorSummary(item, redact) } : safeFields(item, redact)));
    sink[method](meta, message || 'provider diagnostic');
  };
  return {
    get level() { return sink.level; },
    set level(value: string) { sink.level = value; },
    child: extra => createSafeLogger(sink, { ...bound, ...safeFields(extra, redact) }, redact, observer),
    fatal: (...args) => emit('fatal', args), error: (...args) => emit('error', args), warn: (...args) => emit('warn', args),
    info: (...args) => emit('info', args), debug: (...args) => emit('debug', args), trace: (...args) => emit('trace', args),
  };
}
