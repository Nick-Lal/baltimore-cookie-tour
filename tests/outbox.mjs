/*
 * Outbox ownership tests.
 *
 *   node tests/outbox.mjs
 *
 * These exist because "two people, one phone" and "queue writes when offline"
 * are individually fine and together are a data-loss bug.
 *
 * A queued score carries taster_id, fixed at the moment it was written. The
 * insert policy on rating_events checks taster_id = auth.uid(). So flushing
 * person A's queued score while person B is the active session is a 403 — and
 * flushOutbox deliberately DROPS non-network errors, on the reasoning that a
 * row the server will never accept must not block the queue forever. That
 * reasoning is right for a malformed score and catastrophically wrong here:
 * the server would happily accept the row from the right session, five seconds
 * later, once the phone is handed back.
 *
 * So: rows that do not belong to the current session must be held, not sent
 * and not dropped. That is the whole subject of this file.
 */

import { LocalAdapter, SupabaseAdapter } from '../assets/js/lib/storage.js';

/* ------------------------------------------------------------- harness --- */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
// Node 24 ships a real navigator, and it is getter-only.
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true }, configurable: true, writable: true,
});
globalThis.document = { dispatchEvent() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
globalThis.window = { addEventListener() {} };

let passed = 0;
const failures = [];

function check(name, fn) {
  try { fn(); passed++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

/** A SupabaseAdapter with no network, posing as a given signed-in user. */
function adapterAs(userId, name, { accept = () => true } = {}) {
  const a = new SupabaseAdapter({ url: 'https://example.test', anonKey: 'k' });
  a.session = { access_token: 't', user: { id: userId } };
  a._taster = { id: userId, display_name: name };
  a.posted = [];
  a._rest = async (path, opts = {}) => {
    if (opts.method !== 'POST') return [];
    if (!accept(opts.body)) {
      // Shape of a PostgREST RLS refusal: a real HTTP response, not a fetch
      // failure, which is precisely what makes it dangerous.
      throw new Error('new row violates row-level security policy for table "rating_events"');
    }
    a.posted.push(opts.body);
    return [opts.body];
  };
  return a;
}

const ROW = (tasterId, itemKey) => ({
  taster_id: tasterId,
  item_key: itemKey,
  chocolate: 8, texture: 8, dough: 8, salt: 8, structure: 8, freshness: 8,
  rubric_version: '2.0.0',
});

/* --------------------------------------------------------------- tests --- */

// Run in sequence: two of these deliberately share state, because the bug
// being guarded against only appears across a handover.
const asyncChecks = [];
function acheck(name, fn) { asyncChecks.push([name, fn]); }

acheck('flushes only the active taster\'s rows, and holds the other\'s', async () => {
  store.clear();
  const a = adapterAs('user-A', 'Nick');
  a._writeOutbox([
    { ...ROW('user-A', 'kneads-bakeshop:cc-cookie'), _queued_at: '2026-08-16T12:00:00Z', _taster_name: 'Nick' },
    { ...ROW('user-B', 'cafe-dear-leon:cc-cookie'), _queued_at: '2026-08-16T12:01:00Z', _taster_name: 'Priya' },
  ]);

  const sent = await a.flushOutbox();
  eq(sent, 1, 'rows sent');
  eq(a.posted.length, 1, 'rows posted');
  eq(a.posted[0].taster_id, 'user-A', 'posted row owner');

  const left = a._readOutbox();
  eq(left.length, 1, 'rows still queued');
  eq(left[0].taster_id, 'user-B', 'held row owner');
});

acheck('the held row survives and sends when that person is switched back in', async () => {
  // Continues from the state the previous check left behind, which is the
  // real sequence: Nick flushes, hands the phone over, Priya comes back.
  const b = adapterAs('user-B', 'Priya');
  const sent = await b.flushOutbox();
  eq(sent, 1, 'rows sent for B');
  eq(b.posted[0].taster_id, 'user-B', 'posted row owner');
  eq(b._readOutbox().length, 0, 'queue drained');
});

acheck('the private _taster_name never reaches the database', async () => {
  store.clear();
  const a = adapterAs('user-A', 'Nick');
  a._writeOutbox([
    { ...ROW('user-A', 'ovenbird:cc-cookie'), _queued_at: '2026-08-16T12:00:00Z', _taster_name: 'Nick' },
  ]);
  await a.flushOutbox();
  const keys = Object.keys(a.posted[0]);
  if (keys.some((k) => k.startsWith('_'))) {
    throw new Error(`bookkeeping fields leaked to the insert: ${keys.filter((k) => k.startsWith('_')).join(', ')}`);
  }
});

acheck('a genuinely unsendable row is still dropped rather than jamming the queue', async () => {
  store.clear();
  // Owned by the current user, so the ownership guard does not apply, and
  // rejected on its merits. This must not come back forever.
  const a = adapterAs('user-A', 'Nick', { accept: () => false });
  a._writeOutbox([
    { ...ROW('user-A', 'gone-stop:cc-cookie'), _queued_at: '2026-08-16T12:00:00Z', _taster_name: 'Nick' },
  ]);
  const sent = await a.flushOutbox();
  eq(sent, 0, 'rows sent');
  eq(a._readOutbox().length, 0, 'queue drained of the bad row');
});

acheck('a network failure keeps the row for the next attempt', async () => {
  store.clear();
  const a = adapterAs('user-A', 'Nick');
  a._rest = async () => { throw new Error('Failed to fetch'); };
  a._writeOutbox([
    { ...ROW('user-A', 'pitango:cc-cookie'), _queued_at: '2026-08-16T12:00:00Z', _taster_name: 'Nick' },
  ]);
  const sent = await a.flushOutbox();
  eq(sent, 0, 'rows sent');
  eq(a._readOutbox().length, 1, 'row kept for retry');
});

acheck('pending scores are attributed to whoever wrote them, not whoever is active', async () => {
  store.clear();
  const a = adapterAs('user-A', 'Nick');
  a._writeOutbox([
    { ...ROW('user-B', 'sacre-sucre:cc-cookie'), _queued_at: '2026-08-16T12:00:00Z', _taster_name: 'Priya' },
  ]);
  a._rest = async () => [];
  const rows = await a.listRatings({ scope: 'all' });
  eq(rows.length, 1, 'rows listed');
  eq(rows[0].taster_name, 'Priya', 'attribution');
  eq(rows[0].taster_id, 'user-B', 'taster id preserved');
  eq(rows[0].pending, true, 'marked pending');
});

acheck('both adapters expose the same profile interface', async () => {
  for (const A of [LocalAdapter, SupabaseAdapter]) {
    for (const m of ['listProfiles', 'addProfile', 'switchProfile']) {
      if (typeof A.prototype[m] !== 'function') {
        throw new Error(`${A.name} is missing ${m}(), so the settings view would half-work in that mode`);
      }
    }
  }
});

acheck('a session naming a deleted auth user signs in again instead of dead-ending', async () => {
  store.clear();
  // The state left behind by db/reset-test-data.sql: the JWT is still valid,
  // because PostgREST checks the signature and not whether the account exists,
  // so the failure only surfaces when something touches the foreign key to
  // auth.users. Saving your name is exactly that.
  const a = adapterAs('ghost-user', null);
  a._taster = null;
  let attempts = 0;
  a._rest = async (path, opts) => {
    if (path !== 'tasters' || opts?.method !== 'POST') return [];
    attempts++;
    if (attempts === 1) {
      throw new Error('insert or update on table "tasters" violates foreign key constraint "tasters_id_fkey"');
    }
    return [{ id: a.userId, display_name: opts.body.display_name }];
  };
  let signedInAgain = false;
  a._signInAnonymously = async () => {
    signedInAgain = true;
    a.session = { access_token: 't2', user: { id: 'fresh-user' } };
  };
  a._scheduleRefresh = () => {};
  a._loadParties = async () => {};

  const taster = await a.signIn('Nick', null);
  eq(attempts, 2, 'write attempts');
  eq(signedInAgain, true, 'signed in again');
  eq(taster.display_name, 'Nick', 'name saved');
  eq(a.userId, 'fresh-user', 'now under the new identity');
});

acheck('a name that is merely invalid does not trigger a pointless re-sign-in', async () => {
  store.clear();
  const a = adapterAs('user-A', 'Nick');
  let signedInAgain = false;
  a._signInAnonymously = async () => { signedInAgain = true; };
  a._rest = async () => { throw new Error('value too long for type character varying'); };
  let threw = null;
  try { await a.signIn('Nick', null); } catch (err) { threw = err.message; }
  if (!threw) throw new Error('an unrelated failure was swallowed');
  eq(signedInAgain, false, 'identity churned for an unrelated error');
});

acheck('switching to an unknown profile fails loudly instead of silently doing nothing', async () => {
  store.clear();
  const a = adapterAs('user-A', 'Nick');
  let threw = null;
  try { await a.switchProfile('user-nope'); } catch (err) { threw = err.message; }
  if (!threw) throw new Error('switchProfile resolved for a profile that is not on the device');
});

/* ---------------------------------------------------------------- run --- */

for (const [name, fn] of asyncChecks) {
  try { await fn(); passed++; }
  catch (err) { failures.push(`${name}: ${err.message}`); }
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (!failures.length) {
  console.log('  Queued scores stay with the person who wrote them, and a stale identity recovers.\n');
}
process.exit(failures.length ? 1 : 0);
