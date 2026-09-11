import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Only metadata/source is read. Never imports a session, queries WA, or touches auth data. */
export function isProviderContactGuardInstalled(): boolean {
  try {
    const entry = createRequire(import.meta.url).resolve('@whiskeysockets/baileys');
    const root = path.resolve(path.dirname(entry), '..');
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    if (manifest.version !== '7.0.0-rc14') return false;
    const source = readFileSync(path.join(root, 'lib', 'Socket', 'chats.js'), 'utf8');
    const start = source.indexOf('const appPatch = async (patchCreate) => {');
    const end = source.indexOf('const fetchProps = async () => {', start);
    if (start < 0 || end < 0) return false;
    const block = source.slice(start, end);
    const beforeEncode = block.indexOf('ZAPTOBOX_CONTACT_GUARD_BEFORE_ENCODE_V1');
    const beforeSend = block.indexOf('ZAPTOBOX_CONTACT_GUARD_BEFORE_SEND_V1');
    return beforeEncode > 0 && beforeEncode < block.indexOf('encodeResult = await encodeSyncdPatch') &&
      beforeSend > beforeEncode && beforeSend < block.indexOf('await query(node)') &&
      (block.match(/await config\.zaptoboxContactGuard\(/gu) ?? []).length === 2;
  } catch { return false; }
}
