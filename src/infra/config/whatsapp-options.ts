/** Runtime options only. No .env loading, database, sockets or credentials here. */
export const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = typeof logLevels[number];
export type ContactSyncMode = 'off' | 'check' | 'write';
export interface WhatsAppOptions {
  logLevel: LogLevel;
  baileysLogLevel: LogLevel;
  redactIdentifiers: boolean;
  browser: [string, string, string];
  legacyPhoneNameIgnored: boolean;
  queryTimeoutMs: number;
  contactMode: ContactSyncMode;
  contactDiagnostics: boolean;
  contactRequireLid: boolean;
  contactMinUptimeMs: number;
  contactCooldownMs: number;
}
type Environment = Readonly<Record<string, string | undefined>>;
function text(env: Environment, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value || fallback;
}
function level(env: Environment, key: string, fallback: LogLevel): LogLevel {
  const value = text(env, key, fallback).toLowerCase();
  if (!(logLevels as readonly string[]).includes(value)) throw new Error(`Invalid ${key}: expected ${logLevels.join(', ')}`);
  return value as LogLevel;
}
function boolean(env: Environment, key: string, fallback: boolean): boolean {
  const value = text(env, key, String(fallback)).toLowerCase();
  if (value !== 'true' && value !== 'false') throw new Error(`Invalid ${key}: expected true or false`);
  return value === 'true';
}
function integer(env: Environment, key: string, fallback: number, min: number, max: number): number {
  const value = text(env, key, String(fallback));
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`Invalid ${key}: expected an integer from ${min} to ${max}`);
  }
  return number;
}
const browserNames: Readonly<Record<string, string>> = {
  chrome: 'Chrome', 'google chrome': 'Chrome', firefox: 'Firefox', safari: 'Safari', edge: 'Edge',
  'microsoft edge': 'Edge', desktop: 'Desktop', opera: 'Opera',
};
const knownSystems: Readonly<Record<string, readonly [string, string]>> = {
  linux: ['Ubuntu', '22.04.4'], ubuntu: ['Ubuntu', '22.04.4'],
  windows: ['Windows', '10.0.22631'], win32: ['Windows', '10.0.22631'],
  mac: ['Mac OS', '14.4.1'], macos: ['Mac OS', '14.4.1'], 'mac os': ['Mac OS', '14.4.1'], darwin: ['Mac OS', '14.4.1'],
};
export function readWhatsAppOptions(env: Environment): WhatsAppOptions {
  const logLevel = level(env, 'LOG_LEVEL', 'info');
  const session = text(env, 'SESSION', 'ZapToBox');
  if (session.length > 64 || /[\u0000-\u001f\u007f]/u.test(session)) throw new Error('Invalid SESSION: use 1 to 64 printable characters');
  const explicitBrowser = text(env, 'BROWSER_NAME', '').toLowerCase();
  const legacyBrowser = text(env, 'PHONE_NAME', '').toLowerCase();
  if (explicitBrowser && !Object.hasOwn(browserNames, explicitBrowser)) throw new Error('Invalid BROWSER_NAME: use Chrome, Firefox, Safari, Edge, Opera or Desktop');
  const browserName = (Object.hasOwn(browserNames, explicitBrowser) ? browserNames[explicitBrowser] : undefined)
    ?? (Object.hasOwn(browserNames, legacyBrowser) ? browserNames[legacyBrowser] : undefined) ?? 'Chrome';
  const known = Object.hasOwn(knownSystems, session.toLowerCase()) ? knownSystems[session.toLowerCase()] : undefined;
  // An arbitrary SESSION is a device label, never an OS selector with Ubuntu fallback.
  // Baileys rc14 uses browser[0] for DeviceProps.os and browser[1] for platformType.
  const browser: [string, string, string] = [known?.[0] ?? session, browserName, known?.[1] ?? '1.3.0'];
  const mode = text(env, 'CONTACT_SYNC_MODE', 'off').toLowerCase();
  if (!['off', 'check', 'write'].includes(mode)) throw new Error('Invalid CONTACT_SYNC_MODE: expected off, check or write');
  return {
    logLevel, baileysLogLevel: level(env, 'BAILEYS_LOG_LEVEL', logLevel),
    redactIdentifiers: boolean(env, 'LOG_REDACT_IDENTIFIERS', true), browser,
    legacyPhoneNameIgnored: !explicitBrowser && Boolean(legacyBrowser) && !Object.hasOwn(browserNames, legacyBrowser),
    queryTimeoutMs: integer(env, 'WA_QUERY_TIMEOUT_MS', 30_000, 1000, 120_000),
    contactMode: mode as ContactSyncMode,
    contactDiagnostics: boolean(env, 'CONTACT_SYNC_DIAGNOSTICS', true),
    contactRequireLid: boolean(env, 'CONTACT_SYNC_REQUIRE_LID', true),
    contactMinUptimeMs: integer(env, 'CONTACT_SYNC_MIN_UPTIME_MS', 30_000, 0, 600_000),
    contactCooldownMs: integer(env, 'CONTACT_SYNC_COOLDOWN_MS', 30_000, 0, 600_000),
  };
}
