/*
 * Stamps a content hash onto every asset URL:
 *
 *   node tools/stamp-version.mjs
 *
 * Run this before pushing. Without it, a returning visitor can end up holding
 * a cached copy of one module and a fresh copy of another, which is a class of
 * bug that only shows up in production and only for some people.
 *
 * It rewrites the stylesheet and script tags in index.html and every relative
 * import specifier inside assets/js, so one hash busts the whole graph at once.
 * The hash is computed from the files with any existing stamp stripped, so
 * running it twice on unchanged sources produces the same id.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP = /\?v=[0-9a-f]{8}/g;

const assets = [
  ...globSync('assets/css/*.css', { cwd: root }),
  ...globSync('assets/js/**/*.js', { cwd: root }),
  ...globSync('data/*.json', { cwd: root }),
  'index.html',
  'sw.js',
].sort();

const BUILD_LINE = /const BUILD = '[^']*';/;
const hash = createHash('sha256');
for (const rel of assets) {
  hash.update(rel);
  hash.update(
    readFileSync(join(root, rel), 'utf8')
      .replace(STAMP, '')
      .replace(BUILD_LINE, "const BUILD = '';")  // ignore the stamp we are about to write
  );
}
const version = hash.digest('hex').slice(0, 8);

let touched = 0;

// index.html: stylesheet links and the module entry point
{
  const p = join(root, 'index.html');
  const before = readFileSync(p, 'utf8');
  const after = before
    .replace(STAMP, '')
    .replace(/(href="assets\/css\/[a-z-]+\.css)"/g, `$1?v=${version}"`)
    .replace(/(src="assets\/js\/app\.js)"/g, `$1?v=${version}"`);
  if (after !== before) { writeFileSync(p, after); touched++; }
}

// every relative import inside the module graph
for (const rel of globSync('assets/js/**/*.js', { cwd: root })) {
  const p = join(root, rel);
  const before = readFileSync(p, 'utf8');
  const after = before
    .replace(STAMP, '')
    .replace(/(from\s+'(?:\.\.?\/)[^']+\.js)'/g, `$1?v=${version}'`);
  if (after !== before) { writeFileSync(p, after); touched++; }
}

// The service worker's cache name carries the build id, so a deploy retires
// the previous cache instead of serving last week's bug forever.
{
  const p = join(root, 'sw.js');
  const before = readFileSync(p, 'utf8');
  const after = before.replace(BUILD_LINE, `const BUILD = '${version}';`);
  if (after !== before) { writeFileSync(p, after); touched++; }
}

console.log(`build ${version}: stamped ${touched} files`);
