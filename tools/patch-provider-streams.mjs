import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependency = path.join(root, 'node_modules', '@whiskeysockets', 'baileys');
const manifest = JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8'));
if (manifest.version !== '7.0.0-rc14') throw new Error('Review the provider stream compatibility patch before changing the provider version.');
const target = path.join(dependency, 'lib', 'Utils', 'messages-media.js');
const source = await readFile(target, 'utf8');
let patched = source;
const replace = (before, after) => {
  if (patched.includes(after)) return;
  if (patched.split(before).length !== 2) throw new Error('Provider stream patch context changed. Installation/build stopped for review.');
  patched = patched.replace(before, after);
};
replace("import { Readable, Transform } from 'stream';", "import { Readable, Transform, pipeline } from 'stream';");
replace('        headers: options.headers\n    });\n    if (!response.ok) {', '        headers: options.headers,\n        signal: options.signal\n    });\n    if (!response.ok) {\n        // ZapToBox: release a rejected HTTP body instead of leaking the connection.\n        if (response.body instanceof Readable) response.body.destroy();\n        else await response.body?.cancel().catch(() => {});');
replace('    return fetched.pipe(output, { end: true });', '    // ZapToBox: pipe alone does not propagate source errors; pipeline also cancels\n    // the source when the bounded consumer closes its output early.\n    pipeline(fetched, output, () => {});\n    return output;');
if (patched !== source) { await writeFile(target, patched); console.log('Applied provider HTTP stream error/abort compatibility patch.'); }

// rc14 drops requestId while consolidating upserts. A placeholder recovery then
// looks like a new live message and can trigger downloads for restored history.
// Keep batches with different origins separate and preserve their requestId.
const eventsTarget = path.join(dependency, 'lib', 'Utils', 'event-buffer.js');
const eventsSource = await readFile(eventsTarget, 'utf8');
let eventsPatched = eventsSource;
const replaceEvent = (before, after) => {
  if (eventsPatched.includes(after)) return;
  if (eventsPatched.split(before).length !== 2) throw new Error('Provider event-origin patch context changed. Installation/build stopped for review.');
  eventsPatched = eventsPatched.replace(before, after);
};
replaceEvent('const { type } = evData;', 'const { type, requestId } = evData;');
replaceEvent('if (bufferedType !== type) {', 'if (bufferedType !== type || existingUpserts[0].requestId !== requestId) {');
replaceEvent('type: bufferedType\n', 'type: bufferedType,\n                                requestId: existingUpserts[0].requestId\n');
replaceEvent('const { messages, type } = eventData;', 'const { messages, type, requestId } = eventData;');
replaceEvent("type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type\n", "type: type === 'notify' || data.messageUpserts[key]?.type === 'notify' ? 'notify' : type,\n                        requestId\n");
replaceEvent('messages: messageUpsertList.map(m => m.message),\n            type\n', 'messages: messageUpsertList.map(m => m.message),\n            type,\n            requestId: messageUpsertList[0].requestId\n');
if (eventsPatched !== eventsSource) { await writeFile(eventsTarget, eventsPatched); console.log('Applied provider buffered message-origin compatibility patch.'); }

// Keep provider compatibility adaptations together for postinstall/build/test.
// This only gates contact mutations; it does not skip MACs, reset auth, or change other actions.
const { installContactGuard } = await import('./patch-provider-contact-guard.mjs');
await installContactGuard(root);
