import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
async function run(executable: string, args: string[]) {
  const child = spawn(executable, args, { cwd: root, stdio: 'inherit', env: process.env });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
  if (code) throw new Error(`Validation command failed with exit code ${code}.`);
}
await run(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '--noEmit']);
await run(process.execPath, [
  join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'),
  'run',
  '--config',
  'vitest.harness.config.ts',
  '--reporter=default',
]);
const mode = process.argv[2] ?? 'certification';
if (!['smoke', 'e2e', 'certification'].includes(mode)) throw new Error('CI accepts only deterministic profiles.');
await run(process.execPath, ['--import', 'tsx', 'helpers/run-tests.ts', mode]);
