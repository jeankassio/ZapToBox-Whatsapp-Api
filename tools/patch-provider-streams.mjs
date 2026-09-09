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
