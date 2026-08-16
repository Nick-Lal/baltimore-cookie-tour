/* Run everything: node tests/all.mjs */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = [
  ['syntax.mjs', ['--experimental-vm-modules']],
  ['run.mjs', []],
  ['contrast.mjs', []],
];

let failed = 0;
for (const [file, flags] of suites) {
  try {
    const out = execFileSync(process.execPath, [...flags, join(here, file)], { encoding: 'utf8', stdio: 'pipe' });
    process.stdout.write(out.replace(/^\(node:\d+\).*$/gm, ''));
  } catch (err) {
    failed++;
    process.stdout.write(String(err.stdout ?? ''));
    process.stderr.write(String(err.stderr ?? ''));
  }
}
process.exit(failed ? 1 : 0);
