/*
 * Cross-module import check.
 *
 *   node tests/imports.mjs
 *
 * This exists because results.js called toast() without importing it, and
 * nothing caught it. The module parsed fine, so tests/syntax.mjs was happy. The
 * unit tests never load the view modules, because those need a DOM. And the
 * call site only runs when a background poll happens to find a new score, which
 * is exactly the moment nobody is looking at a console.
 *
 * The approach is deliberately narrow rather than a general undeclared-variable
 * analysis, which needs a real parser and produces false positives that get
 * ignored. Instead: collect every name this project exports from its own
 * modules, then flag any module that USES one of those names without importing
 * it. That is precisely the mistake that shipped, and it cannot fire on CSS
 * var(), arrow parameters, or anything else that tripped the general version.
 */

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = globSync('assets/js/**/*.js', { cwd: root }).sort();

/* Every named export across the project, and where it comes from. */
const exported = new Map(); // name -> module that exports it
for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8');
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) exported.set(m[1], rel);
  for (const m of src.matchAll(/export\s+(?:const|let|class)\s+(\w+)/g)) exported.set(m[1], rel);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.split(/\s+as\s+/).pop().trim();
      if (name) exported.set(name, rel);
    }
  }
}

const failures = [];

for (const rel of files) {
  const src = readFileSync(join(root, rel), 'utf8');

  // what this module pulls in
  const imported = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const piece of m[1].split(',')) {
      const name = piece.split(/\s+as\s+/).pop().trim();
      if (name) imported.add(name);
    }
  }

  // what it declares itself, so a local of the same name is not a false alarm
  const local = new Set();
  for (const m of src.matchAll(/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)) local.add(m[1]);
  for (const m of src.matchAll(/(?:^|\s)(?:export\s+)?(?:const|let|var|class)\s+(\w+)/g)) local.add(m[1]);

  const body = src.replace(/^import[^;]+;$/gm, '');

  for (const [name, from] of exported) {
    if (from === rel || imported.has(name) || local.has(name)) continue;
    // used as a bare call, not a property, and not inside a longer word
    const used = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`, 'm').exec(body);
    if (!used) continue;
    const line = body.slice(0, used.index).split('\n').length;
    failures.push(`${rel}:${line}  uses ${name}() but never imports it (exported by ${from})`);
  }
}

console.log(
  `\n${files.length} modules, ${exported.size} project exports, ` +
  `${failures.length} missing import${failures.length === 1 ? '' : 's'}\n`
);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (!failures.length) console.log('  Every project helper used is imported by the module using it.\n');
process.exit(failures.length ? 1 : 0);
