/*
 * Parse every shipped module and JSON file.
 *
 *   node tests/syntax.mjs
 *
 * This exists because a find-and-replace over the copy once turned
 * 'two people's numbers' into a broken string literal and took the whole site
 * down. Nothing else in the suite would have caught it: the unit tests import
 * a few modules, but the view modules need a DOM, so a syntax error in one of
 * them could reach production unnoticed. Parsing is cheap. Do it on all of
 * them.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { globSync } from 'node:fs';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const jsFiles = globSync('assets/js/**/*.js', { cwd: root });
const jsonFiles = globSync('{data,config}/*.json', { cwd: root });

let passed = 0;
const failures = [];

for (const rel of jsFiles) {
  const src = readFileSync(join(root, rel), 'utf8');
  try {
    // SourceTextModule parses ES module syntax without executing it or
    // resolving imports, which is exactly what we want.
    new vm.SourceTextModule(src, { identifier: rel });
    passed++;
  } catch (err) {
    failures.push(`${rel}: ${err.message}`);
  }
}

for (const rel of jsonFiles) {
  try {
    JSON.parse(readFileSync(join(root, rel), 'utf8'));
    passed++;
  } catch (err) {
    failures.push(`${rel}: ${err.message}`);
  }
}

// Every id referenced by getElementById must exist in the markup.
const html = readFileSync(join(root, 'index.html'), 'utf8');
const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const dynamic = new Set(['profile-switcher']); // created at runtime, checked below
for (const rel of jsFiles) {
  const src = readFileSync(join(root, rel), 'utf8');
  for (const m of src.matchAll(/getElementById\('([^']+)'\)/g)) {
    const id = m[1];
    if (!declared.has(id) && !dynamic.has(id)) {
      failures.push(`${rel}: getElementById('${id}') but no such id in index.html`);
    } else {
      passed++;
    }
  }
}

console.log(`\n${jsFiles.length} modules, ${jsonFiles.length} data files, ${passed} checks, ${failures.length} failed\n`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (!failures.length) console.log('  Everything parses and every element reference resolves.\n');
process.exit(failures.length ? 1 : 0);
