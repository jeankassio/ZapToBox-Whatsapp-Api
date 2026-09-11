import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKERS = ['ZAPTOBOX_CONTACT_GUARD_BEFORE_ENCODE_V1', 'ZAPTOBOX_CONTACT_GUARD_BEFORE_SEND_V1'];
export function patchContactGuard(source, version) {
  if (version !== '7.0.0-rc14') throw new Error('Contact safety adapter is pinned to Baileys 7.0.0-rc14. Review before upgrading.');
  const start = source.indexOf('const appPatch = async (patchCreate) => {');
  const end = source.indexOf('const fetchProps = async () => {', start);
  if (start < 0 || end < 0) throw new Error('Contact safety adapter: appPatch boundaries changed. No file was modified.');
  let block = source.slice(start, end);
  const counts = MARKERS.map(marker => block.split(marker).length - 1);
  if (counts.every(count => count === 1)) {
    if ((block.match(/await config\.zaptoboxContactGuard\(/g) ?? []).length !== 2 ||
      block.indexOf(MARKERS[0]) > block.indexOf('encodeResult = await encodeSyncdPatch') ||
      block.indexOf(MARKERS[1]) > block.indexOf('await query(node)')) throw new Error('Contact safety adapter: inconsistent patched file.');
    return source;
  }
  if (counts.some(Boolean)) throw new Error('Contact safety adapter: partial/duplicate patch detected. No file was modified.');
  function insert(pattern, stage, marker) {
    const matches = [...block.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`Contact safety adapter: ${stage} context changed. No file was modified.`);
    const match = matches[0], indent = match[1];
    const guard = `${indent}// ${marker}\n${indent}if (patchCreate.index?.[0] === 'contact') {\n${indent}    if (typeof config.zaptoboxContactGuard !== 'function') {\n${indent}        throw new Error('ZapToBox contact safety callback is missing; contact mutation refused');\n${indent}    }\n${indent}    await config.zaptoboxContactGuard({ stage: '${stage}', name, patchCreate, initial, keyId: myAppStateKeyId });\n${indent}}\n`;
    block = block.slice(0, match.index) + guard + block.slice(match.index);
  }
  insert(/^([\t ]*)encodeResult = await encodeSyncdPatch\(patchCreate, myAppStateKeyId, initial, getAppStateSyncKey\);?\r?$/gm, 'before-encode', MARKERS[0]);
  insert(/^([\t ]*)await query\(node\);?\r?$/gm, 'before-send', MARKERS[1]);
  return source.slice(0, start) + block + source.slice(end);
}
export async function installContactGuard(root, checkOnly = false) {
  const dependency = path.join(root, 'node_modules', '@whiskeysockets', 'baileys');
  const manifest = JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8'));
  const target = path.join(dependency, 'lib', 'Socket', 'chats.js');
  const source = await readFile(target, 'utf8');
  const patched = patchContactGuard(source, manifest.version);
  if (checkOnly && patched !== source) throw new Error('Contact safety adapter is missing. Run npm run build.');
  if (patched !== source) { await writeFile(target, patched); console.log('Applied scoped Baileys contact safety adapter (before encode/send).'); }
  return { installed: true, changed: source !== patched };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await installContactGuard(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), process.argv.includes('--check'));
}
