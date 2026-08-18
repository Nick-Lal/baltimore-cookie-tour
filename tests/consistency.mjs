/*
 * Cross-source consistency.
 *
 *   node tests/consistency.mjs
 *
 * The scoring rubric exists in three places that cannot import each other:
 * WEIGHTS in assets/js/lib/storage.js, the rubric_weights seed in
 * db/schema.sql, and the human-facing text in data/rubric.json. Postgres
 * computes total_score from its own copy in a trigger, precisely so a client
 * cannot submit a total that disagrees with its factor scores. The flip side
 * is that if the two copies ever drift, the site shows one number and stores
 * another, every score written in between is subtly wrong, and nothing
 * anywhere raises an error — the trigger is doing exactly its job.
 *
 * Same story for the menu: a rating carries a foreign key to stop_items, so an
 * item added to data/stops.json without regenerating db/seed.sql is a stop you
 * can select, walk to, and then fail to score.
 *
 * None of this can be caught at runtime by the app, so it is caught here.
 */

import { readFileSync, globSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const load = (p) => JSON.parse(read(p));

const { WEIGHTS, FACTORS, RUBRIC_VERSION } = await import('../assets/js/lib/storage.js');

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
};

const schema = read('db/schema.sql');
const seed = read('db/seed.sql');
const rubric = load('data/rubric.json');
const stops = load('data/stops.json');

/* ------------------------------------------------------------- weights --- */

// ('2.0.0', 'cookie', 'chocolate', 0.22)
const sqlWeights = {};
const sqlVersions = new Set();
// matchAll yields the whole match at index 0, so the groups start at 1.
for (const [, v, type, factor, w] of
     schema.matchAll(/\('([\d.]+)',\s*'(cookie|other)',\s*'(\w+)',\s*([\d.]+)\)/g)) {
  sqlVersions.add(v);
  (sqlWeights[type] ??= {})[factor] = Number(w);
}

check('db/schema.sql actually contains a rubric_weights seed', () => {
  const n = Object.values(sqlWeights).reduce((a, d) => a + Object.keys(d).length, 0);
  if (n === 0) throw new Error('parsed zero weights — the regex or the file shape changed');
});

for (const type of ['cookie', 'other']) {
  check(`${type} weights match between storage.js and db/schema.sql`, () => {
    const js = JSON.stringify(Object.entries(WEIGHTS[type]).sort());
    const sql = JSON.stringify(Object.entries(sqlWeights[type] ?? {}).sort());
    if (js !== sql) {
      throw new Error(
        `the browser would show a total the database disagrees with\n` +
        `      storage.js: ${js}\n      schema.sql: ${sql}`);
    }
  });

  check(`${type} weights sum to 1`, () => {
    const sum = Object.values(WEIGHTS[type]).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 1) > 1e-9) throw new Error(`sums to ${sum}, so totals are not out of 100`);
  });

  check(`${type} weights cover exactly its factor list`, () => {
    const a = [...FACTORS[type]].sort().join(',');
    const b = Object.keys(WEIGHTS[type]).sort().join(',');
    if (a !== b) throw new Error(`FACTORS ${a} but WEIGHTS ${b}`);
  });
}

check('data/rubric.json weights match storage.js', () => {
  const map = { cookie: 'cookie', other: 'general' };
  for (const [type, key] of Object.entries(map)) {
    for (const f of rubric.rubrics[key].factors) {
      const mine = WEIGHTS[type][f.id];
      if (f.weight != null && Math.abs(f.weight - mine) > 1e-9) {
        throw new Error(`${key}.${f.id}: rubric.json says ${f.weight}, storage.js says ${mine}`);
      }
    }
  }
});

/* ------------------------------------------------------------ versions --- */

check('the rubric version agrees everywhere', () => {
  if (rubric.version !== RUBRIC_VERSION) {
    throw new Error(`rubric.json ${rubric.version} vs storage.js ${RUBRIC_VERSION}`);
  }
  if (!sqlVersions.has(RUBRIC_VERSION)) {
    throw new Error(
      `schema.sql seeds ${[...sqlVersions].join(', ') || 'nothing'} but scores are written as ` +
      `${RUBRIC_VERSION}; the trigger looks weights up by version, so every insert would fail`);
  }
});

/* --------------------------------------------------------------- menu ---- */

const seedKeys = new Set([...seed.matchAll(/\('([^']+:[^']+)',/g)].map((m) => m[1]));
const jsonKeys = new Set();
const jsonTypes = new Map();
for (const s of stops.stops) {
  for (const item of s.menu ?? []) {
    const key = `${s.id}:${item.id}`;
    jsonKeys.add(key);
    jsonTypes.set(key, item.type);
  }
}

check('every menu item in data/stops.json exists in db/seed.sql', () => {
  const missing = [...jsonKeys].filter((k) => !seedKeys.has(k));
  if (missing.length) {
    throw new Error(
      `${missing.length} item(s) could be selected but not scored, because rating_events has a ` +
      `foreign key to stop_items. Run tools/build-seed.mjs. First few: ${missing.slice(0, 4).join(', ')}`);
  }
});

check('db/seed.sql has no items that data/stops.json dropped', () => {
  const extra = [...seedKeys].filter((k) => !jsonKeys.has(k));
  if (extra.length) {
    throw new Error(`stale rows in the seed: ${extra.slice(0, 4).join(', ')}`);
  }
});

check('item types agree between the seed and the JSON', () => {
  for (const m of seed.matchAll(/\('([^']+:[^']+)',\s*'[^']+',\s*'[^']+',\s*'(\w+)'\)/g)) {
    const [, key, type] = m;
    const want = jsonTypes.get(key);
    if (want && want !== type) {
      throw new Error(`${key} is '${type}' in the seed but '${want}' in stops.json, so it would be ` +
                      `scored on the wrong rubric`);
    }
  }
});

/* ------------------------------------------------- service worker cache --- */

const sw = read('sw.js');
const build = /const BUILD = '([0-9a-f]*)'/.exec(sw)?.[1];
const precache = [...sw.matchAll(/^\s*'(\.\/[^']+)',$/gm)].map((m) => m[1]);

check('sw.js declares a build id', () => {
  if (!build) throw new Error('no BUILD line — tools/stamp-version.mjs cannot version the cache');
});

check('every precached asset carries the current build stamp', () => {
  const unstamped = precache
    .filter((u) => /^\.\/assets\/(css|js)\//.test(u))
    .filter((u) => !u.endsWith(`?v=${build}`));
  if (unstamped.length) {
    throw new Error(
      `these are precached under a URL the page never requests, so each is fetched twice on the ` +
      `first load after a deploy: ${unstamped.slice(0, 4).join(', ')}. Run tools/stamp-version.mjs`);
  }
});

check('nothing outside assets/css and assets/js got stamped', () => {
  const wrong = precache.filter((u) => !/^\.\/assets\/(css|js)\//.test(u) && u.includes('?v='));
  if (wrong.length) {
    throw new Error(`navigations and runtime JSON are requested without a query: ${wrong.join(', ')}`);
  }
});

check('every JS module is precached, or it will not open offline', () => {
  // String.fromCharCode(92) is a backslash. Written this way because globSync
  // returns Windows separators and every layer between here and the file has
  // its own opinion about escaping one.
  const sep = String.fromCharCode(92);
  const onDisk = globSync('assets/js/**/*.js', { cwd: root })
    .map((f) => './' + f.split(sep).join('/'));
  const listed = new Set(precache.map((u) => u.replace(/\?v=[0-9a-f]{8}$/, '')));
  const missing = onDisk.filter((p) => !listed.has(p));
  if (missing.length) {
    throw new Error(`added to the module graph but not to PRECACHE: ${missing.join(', ')}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (!failures.length) {
  console.log('  The rubric and the menu say the same thing in the browser and in Postgres.\n');
}
process.exit(failures.length ? 1 : 0);
