/*
 * Routing.
 *
 * Valhalla's public OpenStreetMap instance, because it runs genuinely separate
 * profiles. This was worth checking: OSRM's demo server aliases every profile
 * to driving, so asking it for a walk returns a car's time. On a Mount Vernon
 * to downtown leg it claimed four minutes for a walk that takes twenty five.
 *
 * A Lime scooter rides the bicycle network, obeys the same one way streets and
 * gets the same route geometry, so we route it as a bicycle and then adjust
 * the time: scooters are capped at about 24 km/h so they lose a little on open
 * stretches, and there is real overhead in finding and unlocking one.
 *
 * The public instance is a free community service. Every result is cached, and
 * requests are spaced out. If it fails we fall back to straight-line distance
 * and label the answer an estimate rather than quietly serving a worse number
 * as though it were measured.
 */

import { haversineKm, decodePolyline } from './geo.js';

/*
 * A 14x14 street-network matrix for both profiles is committed to the repo,
 * generated once at build time. It gives an exact input to the route
 * optimiser and an instant, network-free estimate for every leg, so a cold
 * open costs the public routing service nothing at all. Live calls happen
 * only for the final ordered legs, where the drawn line matters.
 */
let MATRIX = null;

export async function loadMatrix() {
  if (MATRIX) return MATRIX;
  try {
    const res = await fetch('data/matrix.json');
    if (res.ok) MATRIX = await res.json();
  } catch {
    MATRIX = null;
  }
  return MATRIX;
}

function matrixLookup(fromId, toId, costing) {
  if (!MATRIX) return null;
  const i = MATRIX.stopIds.indexOf(fromId);
  const j = MATRIX.stopIds.indexOf(toId);
  if (i < 0 || j < 0) return null;
  const m = MATRIX.modes[costing];
  const seconds = m?.seconds?.[i]?.[j];
  const km = m?.km?.[i]?.[j];
  return seconds == null || km == null ? null : { seconds, km };
}

/** Street-network kilometres between two stops, for ordering. */
export function matrixKm(a, b, mode = 'walk') {
  const hit = matrixLookup(a.id, b.id, MODES[mode]?.costing ?? 'pedestrian');
  return hit ? hit.km : haversineKm(a, b) * 1.3;
}

const ENDPOINT = 'https://valhalla1.openstreetmap.de/route';
const CACHE_KEY = 'cookietour.routes.v1';
const CACHE_LIMIT = 400;
const TIMEOUT_MS = 12_000;
const MIN_GAP_MS = 260;

export const MODES = {
  walk: {
    id: 'walk',
    label: 'Walk',
    costing: 'pedestrian',
    timeFactor: 1,
    overheadMin: 0,
    fallbackKmh: 4.8,
    detour: 1.28,
    colour: '#2b8a5f',
    icon: 'walk',
    blurb: 'Best under a kilometre. You can talk the whole way.',
  },
  scooter: {
    id: 'scooter',
    label: 'Scooter',
    costing: 'bicycle',
    timeFactor: 1.05,
    overheadMin: 2,
    fallbackKmh: 14,
    detour: 1.22,
    colour: '#c2410c',
    icon: 'scooter',
    blurb: 'Lime and Bird cover most of the city. Two riders, two scooters.',
  },
  car: {
    id: 'car',
    label: 'Car',
    costing: 'auto',
    timeFactor: 1,
    overheadMin: 5,
    fallbackKmh: 26,
    detour: 1.3,
    colour: '#475569',
    icon: 'car',
    blurb: 'Rideshare or your own. Add time for parking in Fells Point.',
  },
};

/* Rough Baltimore scooter pricing, used only for a budget estimate. Providers
   change these often, so it is shown as an estimate and is easy to edit. */
export const SCOOTER_PRICING = { unlock: 1.0, perMinute: 0.39 };

/*
 * Only walk and scooter are ever suggested. This is a date, and the brief was
 * a mix of walking and Lime scooters, so a car is something you have to ask
 * for rather than something the site quietly picks for you. Long legs get an
 * advisory instead of a mode change.
 */
export function suggestMode(km) {
  return km <= 1.0 ? 'walk' : 'scooter';
}

export const LONG_LEG_KM = 5.0;

/** Advisory text for a leg that is long enough to be worth warning about. */
export function legAdvisory(km, minutes) {
  if (km < LONG_LEG_KM) return null;
  return `That is a ${Math.round(minutes)} minute scooter ride. Worth splitting the tour ` +
    `across two afternoons, or driving this leg and scootering the rest.`;
}

/** Both realistic modes for a leg, so the user picks rather than accepts. */
export function modeOptionsFor(km) {
  return km <= LONG_LEG_KM ? ['walk', 'scooter'] : ['scooter', 'walk'];
}

/* ------------------------------------------------------------------ cache */

function loadCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

let cache = loadCache();

function saveCache() {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    for (const k of keys.slice(0, keys.length - CACHE_LIMIT)) delete cache[k];
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    cache = {};
  }
}

const round5 = (n) => Math.round(n * 1e5) / 1e5;
const keyFor = (a, b, costing) =>
  `${costing}:${round5(a.lat)},${round5(a.lng)}>${round5(b.lat)},${round5(b.lng)}`;

/* ------------------------------------------------------- polite request queue */

let chain = Promise.resolve();
let lastAt = 0;

function queued(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, MIN_GAP_MS - (Date.now() - lastAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

/* ---------------------------------------------------------------- fallback */

/*
 * Two fallbacks, in order of honesty. The committed matrix is real street
 * network data and only lacks a drawn line, so its numbers are trustworthy
 * and the map simply shows a straight connector. Great-circle times are a
 * genuine guess and get labelled as one.
 */
function estimate(a, b, mode) {
  const m = MODES[mode];
  const straight = [[a.lat, a.lng], [b.lat, b.lng]];

  const hit = matrixLookup(a.id, b.id, m.costing);
  if (hit) {
    return {
      km: hit.km,
      minutes: (hit.seconds / 60) * m.timeFactor + m.overheadMin,
      shape: straight,
      mode: m.id,
      estimated: false,
      approximateLine: true,
    };
  }

  const km = haversineKm(a, b) * m.detour;
  return {
    km,
    minutes: (km / m.fallbackKmh) * 60 + m.overheadMin,
    shape: straight,
    mode: m.id,
    estimated: true,
    approximateLine: true,
  };
}

/* ------------------------------------------------------------------ fetch */

async function callValhalla(a, b, costing) {
  const body = {
    locations: [
      { lat: a.lat, lon: a.lng },
      { lat: b.lat, lon: b.lng },
    ],
    costing,
    directions_options: { units: 'kilometers' },
  };
  const url = `${ENDPOINT}?json=${encodeURIComponent(JSON.stringify(body))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Routing service returned ${res.status}`);
    const data = await res.json();
    const trip = data?.trip;
    if (!trip?.summary || !trip.legs?.length) throw new Error('No route found');
    return {
      km: trip.summary.length,
      seconds: trip.summary.time,
      shape: decodePolyline(trip.legs[0].shape, 6),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Route one leg. Always resolves: on failure it returns a flagged estimate
 * rather than throwing, so one bad leg cannot blank the whole itinerary.
 */
export async function routeLeg(a, b, mode = 'walk') {
  const m = MODES[mode] ?? MODES.walk;
  const key = keyFor(a, b, m.costing);

  let raw = cache[key];
  if (!raw) {
    try {
      raw = await queued(() => callValhalla(a, b, m.costing));
      cache[key] = raw;
      saveCache();
    } catch (err) {
      console.warn('Routing fell back to an estimate:', err.message);
      return estimate(a, b, m.id);
    }
  }

  return {
    km: raw.km,
    minutes: (raw.seconds / 60) * m.timeFactor + m.overheadMin,
    shape: raw.shape,
    mode: m.id,
    estimated: false,
  };
}

/**
 * Route a whole itinerary. `modes[i]` is the mode for the leg from stop i to
 * stop i+1; leave an entry null to let distance decide.
 */
export async function routeItinerary(stops, modes = []) {
  const legs = [];
  for (let i = 0; i < stops.length - 1; i++) {
    const from = stops[i];
    const to = stops[i + 1];
    const chosen = modes[i] ?? suggestMode(haversineKm(from, to));
    const leg = await routeLeg(from, to, chosen);
    legs.push({ ...leg, from, to, index: i, autoMode: modes[i] == null });
  }
  return legs;
}

export function itinerarySummary(legs, stops, { minutesPerStop = 20, partySize = 2 } = {}) {
  const travelMin = legs.reduce((s, l) => s + l.minutes, 0);
  const km = legs.reduce((s, l) => s + l.km, 0);
  const scooterLegsList = legs.filter((l) => l.mode === 'scooter');
  const scooterMin = scooterLegsList.reduce((s, l) => s + l.minutes, 0);
  const scooterCost =
    (SCOOTER_PRICING.unlock * scooterLegsList.length + SCOOTER_PRICING.perMinute * scooterMin) *
    partySize;

  const cookieCost = stops.reduce((s, st) => {
    const primary = st.menu?.find((m) => m.primary);
    return s + (primary?.priceUSD ?? 0) * partySize;
  }, 0);

  return {
    km,
    travelMin,
    dwellMin: stops.length * minutesPerStop,
    totalMin: travelMin + stops.length * minutesPerStop,
    stops: stops.length,
    scooterCost,
    cookieCost,
    totalCost: scooterCost + cookieCost,
    partySize,
    anyEstimated: legs.some((l) => l.estimated),
  };
}

/**
 * Walk the itinerary forward from a start time, so each stop gets an arrival
 * time and can be checked against its own opening hours. This is the part
 * that turns a list of distances into a plan you can actually follow.
 */
export function schedule(stops, legs, startAt, { minutesPerStop = 20 } = {}) {
  const out = [];
  let t = new Date(startAt.getTime());
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const status = openAt(stop, t);
    let problem = null;
    if (status === 'closed') {
      problem = closesBefore(stop, t) ? 'closed-by-then' : 'not-open-yet';
    } else if (status === 'unknown') {
      problem = 'unknown-hours';
    }
    out.push({ stop, arrive: new Date(t.getTime()), status, problem });
    t = new Date(t.getTime() + minutesPerStop * 60_000);
    if (legs[i]) t = new Date(t.getTime() + legs[i].minutes * 60_000);
  }
  return out;
}

/** Did we arrive after closing rather than before opening? */
function closesBefore(stop, when) {
  const hours = stop.hours?.[when.getDay()];
  if (!hours) return true;
  const mins = when.getHours() * 60 + when.getMinutes();
  const [oh, om] = hours.open.split(':').map(Number);
  return mins >= oh * 60 + om;
}

const toMins = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/**
 * Is the stop open at a given Date? Returns 'open' | 'closed' | 'unknown'.
 *
 * Two windows have to be checked, not one. Insomnia closes at 3am, so at 2am
 * on a Tuesday the relevant entry is Monday's, whose window runs past
 * midnight into Tuesday morning. Checking only the current day reports a shop
 * as shut while you are standing in it.
 */
export function openAt(stop, when) {
  if (!stop.hours) return 'unknown';
  const day = when.getDay();
  const mins = when.getHours() * 60 + when.getMinutes();

  const today = stop.hours[day];
  if (today === undefined) return 'unknown';

  if (today) {
    const open = toMins(today.open);
    let close = toMins(today.close);
    if (close <= open) close += 24 * 60;
    if (mins >= open && mins < close) return 'open';
  }

  // Yesterday's window, if it ran past midnight into today.
  const yesterday = stop.hours[(day + 6) % 7];
  if (yesterday) {
    const open = toMins(yesterday.open);
    const close = toMins(yesterday.close);
    if (close <= open && mins < close) return 'open';
  }

  return 'closed';
}

export function clearRouteCache() {
  cache = {};
  try { localStorage.removeItem(CACHE_KEY); } catch { /* ignore */ }
}
