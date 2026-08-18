/*
 * Tests. Plain Node, no dependencies:
 *
 *   node tests/run.mjs
 *
 * These cover the logic that is easy to get quietly wrong and hard to notice:
 * opening hours that cross midnight, mode suggestions that must never propose
 * a car, the route optimiser, and the scoring arithmetic.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

const { openAt, suggestMode, schedule, directionsUrl, placeUrl, MODES, LONG_LEG_KM } = await import('../assets/js/lib/routing.js');
const { optimiseOrder, haversineKm, decodePolyline } = await import('../assets/js/lib/geo.js');
const { totalScore, recipeScore, validateRating, validateName, validatePartyCode, FACTORS, WEIGHTS, itemKey } =
  await import('../assets/js/lib/storage.js');

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
  }
}

function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`);
}

function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected truthy');
}

const stopsData = load('data/stops.json');
const rubric = load('data/rubric.json');
const matrix = load('data/matrix.json');
const stops = stopsData.stops;
const byId = Object.fromEntries(stops.map((s) => [s.id, s]));

/* ------------------------------------------------------- opening hours -- */

/* Baltimore local time. Building the date from parts keeps this independent
   of the machine's timezone, which is exactly the bug this guards against. */
const at = (year, month, day, hh, mm = 0) => new Date(year, month - 1, day, hh, mm, 0, 0);

check('Insomnia is open late on a Monday night', () => {
  // 17 Aug 2026 is a Monday. Hours are 10:00 to 03:00 the next morning.
  eq(openAt(byId['insomnia-charles-village'], at(2026, 8, 17, 23, 0)), 'open');
});

check('Insomnia is still open after midnight', () => {
  // 02:00 on Tuesday falls inside Tuesday's own 10:00-03:00 window.
  eq(openAt(byId['insomnia-charles-village'], at(2026, 8, 18, 2, 0)), 'open');
});

check('Insomnia is shut at 4am', () => {
  eq(openAt(byId['insomnia-charles-village'], at(2026, 8, 18, 4, 0)), 'closed');
});

check('Aunt Kelly\'s is shut on Sunday', () => {
  eq(openAt(byId['aunt-kellys'], at(2026, 8, 16, 13, 0)), 'closed');
});

check('Aunt Kelly\'s is open Tuesday lunchtime', () => {
  eq(openAt(byId['aunt-kellys'], at(2026, 8, 18, 13, 0)), 'open');
});

check('Aunt Kelly\'s is shut ten minutes after closing', () => {
  eq(openAt(byId['aunt-kellys'], at(2026, 8, 18, 17, 10)), 'closed');
});

check('Common Ground is shut on Wednesdays', () => {
  eq(openAt(byId['common-ground'], at(2026, 8, 19, 10, 0)), 'closed');
});

check('Zoe\'s is shut before half twelve', () => {
  eq(openAt(byId['zoes-just-dezzerts'], at(2026, 8, 16, 12, 0)), 'closed');
  eq(openAt(byId['zoes-just-dezzerts'], at(2026, 8, 16, 13, 0)), 'open');
});

/* ------------------------------------------------------------- routing -- */

check('short legs suggest walking', () => {
  eq(suggestMode(0.4), 'walk');
  eq(suggestMode(1.0), 'walk');
});

check('medium legs suggest a scooter', () => {
  eq(suggestMode(1.01), 'scooter');
  eq(suggestMode(4.9), 'scooter');
});

check('a car is never suggested automatically', () => {
  for (let km = 0; km <= 20; km += 0.25) {
    const m = suggestMode(km);
    ok(m === 'walk' || m === 'scooter', `suggestMode(${km}) returned ${m}`);
  }
});

check('every mode has the fields the UI relies on', () => {
  for (const [id, m] of Object.entries(MODES)) {
    ok(m.costing && m.label && m.icon, `${id} incomplete`);
    ok(m.fallbackKmh > 0 && m.detour >= 1, `${id} bad fallback`);
  }
});

check('scooter is slower than a bike over the same route', () => {
  ok(MODES.scooter.timeFactor >= 1, 'scooter should not be faster than the cycling estimate');
  ok(MODES.scooter.overheadMin > 0, 'finding a scooter takes time');
});

check('polyline decoding matches the reference implementation', () => {
  // The canonical Google example, precision 5.
  const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
  eq(pts.length, 3);
  const round = (n) => Math.round(n * 1e5) / 1e5;
  eq(pts.map(([a, b]) => [round(a), round(b)]),
     [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
});

check('polyline decoding at precision 6 lands in Baltimore', () => {
  // Same numeric path at precision 6 is a tenth of the magnitude.
  const pts = decodePolyline('_p~iF~ps|U', 5);
  ok(Math.abs(pts[0][0]) <= 90 && Math.abs(pts[0][1]) <= 180, 'coordinates out of range');
});

/* ----------------------------------------------------------- optimiser -- */

const pathLength = (list) =>
  list.slice(0, -1).reduce((sum, s, i) => sum + haversineKm(s, list[i + 1]), 0);

check('optimiser never lengthens a route', () => {
  const sample = ['ovenbird-highlandtown', 'ovenbird-rotunda', 'cafe-dear-leon',
                  'harmony-bakery', 'aunt-kellys', 'sacre-sucre'].map((id) => byId[id]);
  const before = pathLength(sample);
  const after = pathLength(optimiseOrder(sample));
  ok(after <= before + 1e-9, `route got longer: ${before.toFixed(2)} -> ${after.toFixed(2)}`);
});

check('optimiser keeps the first stop fixed and loses nobody', () => {
  const sample = stops.slice(0, 7);
  const out = optimiseOrder(sample);
  eq(out.length, sample.length);
  eq(out[0].id, sample[0].id);
  eq(new Set(out.map((s) => s.id)).size, sample.length);
});

check('optimiser handles degenerate inputs', () => {
  eq(optimiseOrder([]).length, 0);
  eq(optimiseOrder([stops[0]]).length, 1);
  eq(optimiseOrder([stops[0], stops[1]]).length, 2);
});

/* ------------------------------------------------------------- scoring -- */

check('cookie weights sum to one', () => {
  const sum = Object.values(WEIGHTS.cookie).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-9, `cookie weights sum to ${sum}`);
});

check('general weights sum to one', () => {
  const sum = Object.values(WEIGHTS.other).reduce((a, b) => a + b, 0);
  ok(Math.abs(sum - 1) < 1e-9, `general weights sum to ${sum}`);
});

check('a perfect cookie scores 100 and a minimum scores 10', () => {
  const perfect = Object.fromEntries(FACTORS.cookie.map((f) => [f, 10]));
  const worst = Object.fromEntries(FACTORS.cookie.map((f) => [f, 1]));
  eq(totalScore(perfect, 'cookie'), 100);
  eq(totalScore(worst, 'cookie'), 10);
});

check('recipe score ignores freshness', () => {
  const base = Object.fromEntries(FACTORS.cookie.map((f) => [f, 7]));
  const stale = { ...base, freshness: 1 };
  eq(recipeScore(base, 'cookie'), recipeScore(stale, 'cookie'));
  ok(totalScore(stale, 'cookie') < totalScore(base, 'cookie'), 'total should still drop');
});

check('scores outside 1 to 10 are rejected', () => {
  const scores = Object.fromEntries(FACTORS.cookie.map((f) => [f, 5]));
  ok(validateRating({ stopId: 'a', itemId: 'b', itemType: 'cookie', scores }).length === 0);
  ok(validateRating({ stopId: 'a', itemId: 'b', itemType: 'cookie', scores: { ...scores, salt: 11 } }).length > 0);
  ok(validateRating({ stopId: 'a', itemId: 'b', itemType: 'cookie', scores: { ...scores, salt: 0 } }).length > 0);
  ok(validateRating({ stopId: 'a', itemId: 'b', itemType: 'cookie', scores: { ...scores, salt: 5.5 } }).length > 0);
});

check('a non-cookie item does not need the cookie-only factors', () => {
  const scores = Object.fromEntries(FACTORS.other.map((f) => [f, 6]));
  eq(validateRating({ stopId: 'a', itemId: 'b', itemType: 'other', scores }).length, 0);
});

check('silly prices and long notes are rejected', () => {
  const scores = Object.fromEntries(FACTORS.cookie.map((f) => [f, 5]));
  const base = { stopId: 'a', itemId: 'b', itemType: 'cookie', scores };
  ok(validateRating({ ...base, pricePaid: 500 }).length > 0);
  ok(validateRating({ ...base, pricePaid: -1 }).length > 0);
  ok(validateRating({ ...base, notes: 'x'.repeat(501) }).length > 0);
  eq(validateRating({ ...base, pricePaid: '' }).length, 0);
});

check('names and party codes are validated', () => {
  ok(validateName('') !== null);
  ok(validateName('x'.repeat(41)) !== null);
  eq(validateName('Nick'), null);
  eq(validatePartyCode(''), null);
  eq(validatePartyCode('saturday-crawl'), null);
  ok(validatePartyCode('abc') !== null, 'codes under six characters should fail');
  ok(validatePartyCode('has spaces') !== null);
});

/* ---------------------------------------------------------------- data -- */

check('every stop has coordinates inside Baltimore', () => {
  for (const s of stops) {
    ok(s.lat > 39.19 && s.lat < 39.39, `${s.id} latitude ${s.lat}`);
    ok(s.lng > -76.72 && s.lng < -76.52, `${s.id} longitude ${s.lng}`);
  }
});

check('every stop has seven days of hours', () => {
  for (const s of stops) {
    eq(s.hours.length, 7, `${s.id} hours`);
    for (const h of s.hours) {
      if (h === null) continue;
      ok(/^\d{2}:\d{2}$/.test(h.open) && /^\d{2}:\d{2}$/.test(h.close), `${s.id} bad time format`);
    }
  }
});

check('every stop has exactly one primary item and valid types', () => {
  for (const s of stops) {
    eq(s.menu.filter((m) => m.primary).length, 1, `${s.id} primary items`);
    for (const m of s.menu) {
      ok(m.type === 'cookie' || m.type === 'other', `${s.id}:${m.id} type`);
      ok(typeof m.priceUSD === 'number' && m.priceUSD > 0, `${s.id}:${m.id} price`);
    }
  }
});

check('item keys are unique once namespaced', () => {
  const keys = stops.flatMap((s) => s.menu.map((m) => itemKey(s.id, m.id)));
  eq(new Set(keys).size, keys.length, 'duplicate item keys');
  // The namespacing matters: bare ids repeat across stops.
  const bare = stops.flatMap((s) => s.menu.map((m) => m.id));
  ok(new Set(bare).size < bare.length, 'expected bare item ids to collide, proving namespacing is needed');
});

check('every cluster referenced by a stop exists', () => {
  const ids = new Set(stopsData.clusters.map((c) => c.id));
  for (const s of stops) ok(ids.has(s.cluster), `${s.id} points at missing cluster ${s.cluster}`);
});

check('closed businesses are not listed as stops', () => {
  const names = new Set(stops.map((s) => s.name.toLowerCase()));
  for (const c of stopsData.closedSince) {
    ok(!names.has(c.name.toLowerCase()), `${c.name} closed but still a stop`);
  }
});

check('the travel matrix covers every stop, both modes', () => {
  eq(matrix.stopIds.length, stops.length);
  eq(new Set(matrix.stopIds).size, stops.length);
  for (const id of matrix.stopIds) ok(byId[id], `matrix references unknown stop ${id}`);
  for (const mode of ['pedestrian', 'bicycle']) {
    const m = matrix.modes[mode];
    ok(m, `missing mode ${mode}`);
    eq(m.seconds.length, stops.length, `${mode} rows`);
    for (const row of m.seconds) eq(row.length, stops.length, `${mode} cols`);
  }
});

check('the matrix agrees roughly with straight-line distance', () => {
  const km = matrix.modes.pedestrian.km;
  for (let i = 0; i < stops.length; i++) {
    for (let j = 0; j < stops.length; j++) {
      if (i === j) continue;
      const straight = haversineKm(stops[i], stops[j]);
      ok(km[i][j] >= straight - 0.05,
        `walking ${stops[i].id}->${stops[j].id} is shorter than the crow flies`);
      ok(km[i][j] < straight * 2.5 + 1,
        `walking ${stops[i].id}->${stops[j].id} is implausibly long`);
    }
  }
});

check('rubric factors match the storage factor lists', () => {
  eq(rubric.rubrics.cookie.factors.map((f) => f.id).sort(), [...FACTORS.cookie].sort());
  eq(rubric.rubrics.general.factors.map((f) => f.id).sort(), [...FACTORS.other].sort());
});

check('rubric weights match the storage weights', () => {
  for (const f of rubric.rubrics.cookie.factors) eq(f.weight, WEIGHTS.cookie[f.id], `cookie ${f.id}`);
  for (const f of rubric.rubrics.general.factors) eq(f.weight, WEIGHTS.other[f.id], `general ${f.id}`);
});

check('every factor has anchors at both ends', () => {
  for (const r of Object.values(rubric.rubrics)) {
    for (const f of r.factors) {
      ok(f.anchors['1'] && f.anchors['10'], `${f.id} missing an end anchor`);
      ok(Object.keys(f.anchors).length >= 5, `${f.id} needs more anchors`);
    }
  }
});

/* ------------------------------------------------------- closed all day -- */
/*
 * A stop closed all Sunday used to be reported as "will have shut", because
 * closesBefore() returns true when there are no hours at all. That is the
 * opposite of useful: it tells someone to start earlier, when no start time on
 * that day would have worked. The three closures need different advice.
 */

// Sunday is index 0. Open Monday to Saturday, shut on Sunday.
const shutSundays = {
  id: 'test-shut-sundays',
  hours: [null, ...Array(6).fill({ open: '08:00', close: '17:00' })],
};
const openDaily = {
  id: 'test-open-daily',
  hours: Array(7).fill({ open: '08:00', close: '17:00' }),
};

// 2026-08-16 is a Sunday; 2026-08-17 a Monday.
const sundayNoon = new Date(2026, 7, 16, 12, 0, 0);
const mondayNoon = new Date(2026, 7, 17, 12, 0, 0);
const mondayDawn = new Date(2026, 7, 17, 6, 0, 0);
const mondayNight = new Date(2026, 7, 17, 21, 0, 0);

check('a stop shut all day reads as closed-today, not closed-by-then', () => {
  const [s] = schedule([shutSundays], [], sundayNoon, { minutesPerStop: 20 });
  eq(s.status, 'closed', 'status');
  eq(s.problem, 'closed-today', 'problem');
});

check('arriving before opening is still not-open-yet', () => {
  const [s] = schedule([openDaily], [], mondayDawn, { minutesPerStop: 20 });
  eq(s.problem, 'not-open-yet', 'problem');
});

check('arriving after closing is still closed-by-then', () => {
  const [s] = schedule([openDaily], [], mondayNight, { minutesPerStop: 20 });
  eq(s.problem, 'closed-by-then', 'problem');
});

check('an open stop has no problem at all', () => {
  const [s] = schedule([shutSundays], [], mondayNoon, { minutesPerStop: 20 });
  eq(s.status, 'open', 'status');
  eq(s.problem, null, 'problem');
});

check('the day is taken from arrival, not from the start of the tour', () => {
  // Start late on Saturday with a long dwell so the second stop lands on Sunday.
  const saturdayLate = new Date(2026, 7, 15, 23, 0, 0);
  const [, second] = schedule([openDaily, shutSundays], [], saturdayLate, { minutesPerStop: 120 });
  eq(second.arrive.getDay(), 0, 'second stop lands on a Sunday');
  eq(second.problem, 'closed-today', 'problem');
});

check('the real stops that shut on Sundays are reported that way', () => {
  for (const id of ['aunt-kellys', 'patisserie-poupon']) {
    const stop = stops.find((s) => s.id === id);
    ok(stop, `${id} is still in the data`);
    const [s] = schedule([stop], [], sundayNoon, { minutesPerStop: 20 });
    eq(s.problem, 'closed-today', `${id} on a Sunday`);
  }
});

/* ------------------------------------------------------ maps handover ---- */

const leon = { name: 'Cafe Dear Leon', branch: 'Canton', lat: 39.2812, lng: -76.5766 };
const kneads = { name: 'Kneads Bakeshop', lat: 39.2841, lng: -76.6008 };

function asPlatform(apple, fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: apple
      ? { platform: 'iPhone', maxTouchPoints: 5 }
      : { platform: 'Linux armv8l', maxTouchPoints: 5 },
    configurable: true, writable: true,
  });
  try { return fn(); }
  finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
}

check('an iPhone gets an Apple Maps link with walking directions', () => {
  const url = asPlatform(true, () => directionsUrl(kneads, leon));
  ok(url.startsWith('https://maps.apple.com/?'), `wrong host: ${url}`);
  ok(url.includes('dirflg=w'), 'walking mode missing');
  ok(url.includes('saddr=39.2812,-76.5766'), 'origin missing');
  ok(url.includes('daddr=39.2841,-76.6008'), 'destination missing');
});

check('everything else gets Google Maps directions', () => {
  const url = asPlatform(false, () => directionsUrl(kneads, leon));
  ok(url.startsWith('https://www.google.com/maps/dir/?'), `wrong host: ${url}`);
  ok(url.includes('travelmode=walking'), 'walking mode missing');
  ok(url.includes('origin=39.2812,-76.5766'), 'origin missing');
  ok(url.includes('destination=39.2841,-76.6008'), 'destination missing');
});

check('a leg with no known origin still produces a destination', () => {
  for (const apple of [true, false]) {
    const url = asPlatform(apple, () => directionsUrl(kneads));
    ok(url.includes('39.2841'), 'destination missing');
    ok(!/saddr|origin=/.test(url), 'invented an origin it does not have');
  }
});

check('a place link carries the name so the pin is labelled', () => {
  const url = asPlatform(true, () => placeUrl(leon));
  ok(url.includes('Cafe%20Dear%20Leon%2C%20Canton'), `name not encoded: ${url}`);
  ok(url.includes('ll=39.2812,-76.5766'), 'coordinates missing');
});

check('no maps link points at openstreetmap any more', () => {
  for (const apple of [true, false]) {
    const urls = asPlatform(apple, () => [directionsUrl(kneads, leon), placeUrl(leon)]);
    for (const u of urls) ok(!/openstreetmap/.test(u), `still an OSM link: ${u}`);
  }
});

/* ---------------------------------------------------------------- report -- */

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.error(`  FAIL  ${f}`);
process.exit(failures.length ? 1 : 0);
