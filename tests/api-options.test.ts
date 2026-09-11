import test from 'node:test';
import assert from 'node:assert/strict';
import { readWhatsAppOptions } from '../src/infra/config/whatsapp-options.js';

test('new defaults are informational logs and remote writes OFF', () => {
  const config = readWhatsAppOptions({});
  assert.equal(config.logLevel, 'info'); assert.equal(config.baileysLogLevel, 'info');
  assert.equal(config.contactMode, 'off'); assert.deepEqual(config.browser, ['ZapToBox', 'Chrome', '1.3.0']);
  assert.equal(config.redactIdentifiers, true);
});
test('SESSION custom label never falls back to Ubuntu', () => {
  assert.equal(readWhatsAppOptions({ SESSION: 'Atendimento Jean' }).browser[0], 'Atendimento Jean');
  assert.equal(readWhatsAppOptions({ SESSION: '__proto__' }).browser[0], '__proto__');
  assert.equal(readWhatsAppOptions({ SESSION: 'constructor' }).browser[0], 'constructor');
});
test('legacy OS aliases remain supported', () => {
  for (const [input, expected] of [['Linux', 'Ubuntu'], ['WIN32', 'Windows'], ['darwin', 'Mac OS']]) {
    assert.equal(readWhatsAppOptions({ SESSION: input }).browser[0], expected);
  }
});
test('BROWSER_NAME is separate and takes priority over PHONE_NAME', () => {
  assert.deepEqual(readWhatsAppOptions({SESSION: 'ZapToBox', BROWSER_NAME: 'Firefox', PHONE_NAME: 'Desktop'}).browser.slice(0,2), ['ZapToBox','Firefox']);
  assert.equal(readWhatsAppOptions({PHONE_NAME: 'Desktop'}).browser[1], 'Desktop');
  assert.equal(readWhatsAppOptions({PHONE_NAME: 'Custom app'}).legacyPhoneNameIgnored, true);
});
test('LOG_LEVEL inherits into Baileys unless explicitly overridden', () => {
  assert.equal(readWhatsAppOptions({LOG_LEVEL:'ERROR'}).baileysLogLevel,'error');
  assert.equal(readWhatsAppOptions({LOG_LEVEL:'silent',BAILEYS_LOG_LEVEL:'info'}).baileysLogLevel,'info');
  for (const level of ['fatal','error','warn','info','debug','trace','silent']) assert.equal(readWhatsAppOptions({LOG_LEVEL:level}).logLevel, level);
});
test('invalid configuration fails rather than silently selecting defaults', () => {
  for (const input of [{LOG_LEVEL:'verbose'}, {BAILEYS_LOG_LEVEL:'false'}, {BROWSER_NAME:'ZapToBox'}, {BROWSER_NAME:'constructor'},
    {CONTACT_SYNC_MODE:'on'}, {LOG_REDACT_IDENTIFIERS:'yes'}, {CONTACT_SYNC_DIAGNOSTICS:'0'},
    {WA_QUERY_TIMEOUT_MS:'0'}, {WA_QUERY_TIMEOUT_MS:'30000.5'}, {CONTACT_SYNC_COOLDOWN_MS:'-1'},
    {CONTACT_SYNC_MIN_UPTIME_MS:'600001'}, {SESSION:'bad\nlabel'}, {SESSION:'x'.repeat(65)}]) assert.throws(()=>readWhatsAppOptions(input));
});
test('explicit environment overrides map to all contact settings', () => {
  const c=readWhatsAppOptions({CONTACT_SYNC_MODE:'check',CONTACT_SYNC_REQUIRE_LID:'false',CONTACT_SYNC_DIAGNOSTICS:'false',
    CONTACT_SYNC_MIN_UPTIME_MS:'0',CONTACT_SYNC_COOLDOWN_MS:'1',WA_QUERY_TIMEOUT_MS:'45000',LOG_REDACT_IDENTIFIERS:'false'});
  assert.equal(c.contactMode,'check'); assert.equal(c.contactRequireLid,false); assert.equal(c.contactDiagnostics,false);
  assert.equal(c.contactMinUptimeMs,0); assert.equal(c.contactCooldownMs,1); assert.equal(c.queryTimeoutMs,45000); assert.equal(c.redactIdentifiers,false);
});
