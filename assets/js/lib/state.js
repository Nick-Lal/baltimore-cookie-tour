/*
 * Shared application state.
 *
 * A small observable object. The selected route also lives in the URL hash so
 * one person can send the other the plan they just built, which on a date for
 * two phones is the first thing anyone tries.
 */

const listeners = new Set();

const PICKS_KEY = 'cookietour.picks';

/*
 * The route people asked for by name: an east to west waterfront crawl from
 * Canton down through Fells Point to Harbor East. 3.4 km of walking in total,
 * and two of the legs are under 350 metres.
 *
 * Seeded only on a genuinely first visit. Clearing your stops sticks, because
 * an app that keeps re-adding what you just removed is infuriating.
 */
export const DEFAULT_ROUTE = [
  'cafe-dear-leon',
  'sacre-sucre',
  'pitango-bakery',
  'kneads-bakeshop',
  'ovenbird-little-italy',
];

export const state = {
  stops: [],
  clusters: [],
  rubric: null,
  store: null,
  taster: null,
  ratings: [],
  picked: [],          // stop ids, in visiting order
  legModes: {},        // index -> mode id, only when the user overrode it
  legs: [],
  filter: 'all',
  resultsScope: 'party',
  view: 'map',
  detailStopId: null,
  scoring: null,       // { stopId, itemId }
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason) {
  for (const fn of listeners) {
    try { fn(reason, state); } catch (err) { console.error('listener failed', err); }
  }
}

export function stopById(id) {
  return state.stops.find((s) => s.id === id) ?? null;
}

export function pickedStops() {
  return state.picked.map(stopById).filter(Boolean);
}

export function isPicked(id) {
  return state.picked.includes(id);
}

export function togglePick(id) {
  const at = state.picked.indexOf(id);
  if (at >= 0) {
    state.picked.splice(at, 1);
    // Overrides are keyed by leg index, so removing a stop invalidates them.
    state.legModes = {};
  } else {
    state.picked.push(id);
    state.legModes = {};
  }
  savePicks();
  writeHash();
  emit('picked');
}

export function setOrder(ids) {
  state.picked = ids.slice();
  state.legModes = {};
  savePicks();
  writeHash();
  emit('picked');
}

export function moveStop(from, to) {
  if (to < 0 || to >= state.picked.length) return;
  const [id] = state.picked.splice(from, 1);
  state.picked.splice(to, 0, id);
  state.legModes = {};
  savePicks();
  writeHash();
  emit('picked');
}

export function clearPicks() {
  state.picked = [];
  state.legModes = {};
  savePicks();
  writeHash();
  emit('picked');
}

/* ------------------------------------------------------------- URL sharing */

/* Stops are referenced by index into stops.json so a shared link stays short.
   An unknown index is dropped rather than throwing, so an old link opening
   against newer data degrades to the stops it can still resolve. */
/* Picks used to live only in the URL, so a reload lost the whole route. */
function savePicks() {
  try {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ picked: state.picked, seeded: true }));
  } catch { /* private mode */ }
}

export function restorePicks() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PICKS_KEY) || 'null'); } catch { /* ignore */ }

  if (saved && Array.isArray(saved.picked)) {
    const known = new Set(state.stops.map((s) => s.id));
    state.picked = saved.picked.filter((id) => known.has(id));
    return 'restored';
  }

  state.picked = DEFAULT_ROUTE.filter((id) => state.stops.some((s) => s.id === id));
  savePicks();
  return 'seeded';
}

export function writeHash() {
  const idx = state.picked
    .map((id) => state.stops.findIndex((s) => s.id === id))
    .filter((i) => i >= 0);
  const hash = idx.length ? `#r=${idx.join('.')}` : '';
  const url = location.pathname + location.search + hash;
  history.replaceState(null, '', url);
}

export function readHash() {
  const m = /[#&]r=([\d.]+)/.exec(location.hash);
  if (!m) return false;
  const ids = m[1]
    .split('.')
    .map((n) => state.stops[Number(n)]?.id)
    .filter(Boolean);
  if (!ids.length) return false;
  state.picked = [...new Set(ids)];
  return true;
}

export function shareUrl() {
  const idx = state.picked
    .map((id) => state.stops.findIndex((s) => s.id === id))
    .filter((i) => i >= 0);
  return `${location.origin}${location.pathname}${idx.length ? `#r=${idx.join('.')}` : ''}`;
}
