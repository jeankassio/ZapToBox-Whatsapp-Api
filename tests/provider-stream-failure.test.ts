import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('an upstream socket closing mid-body rejects media without killing the API process', async () => {
  // A child process proves there is no unhandled stream error; no global error listener is installed.
  const root = fileURLToPath(new URL('../', import.meta.url));
  const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tools/qa-provider-stream-failure.mjs'], { cwd: root, timeout: 10_000 });
  assert.deepEqual(JSON.parse(result.stdout.trim()), { partialBodyRejected: true, controllerError: 502, fetchAbort: true, subsequentDownload: true });
  assert.doesNotMatch(result.stderr, /Unhandled|uncaught|UND_ERR_SOCKET/);
});
