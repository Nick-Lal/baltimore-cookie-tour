/*
 * Storage layer.
 *
 * Two adapters behind one interface. LocalAdapter keeps everything on the
 * device so the site works with zero setup. SupabaseAdapter talks to a real
 * Postgres over HTTPS so two phones see the same leaderboard. Nothing above
 * this module knows which one is running.
 *
 * Scores are append-only in both adapters. Re-scoring a cookie writes a new
 * event rather than overwriting the old one, which is what makes rankings
 * over time mean anything. "Current" is simply the newest event per person
 * per item.
 *
 * The Supabase anon key is public by design and is not a secret. Access is
 * controlled by row level security in the database. See db/schema.sql.
 */

export const RUBRIC_VERSION = '2.0.0';

/*
 * Every call to the database is bounded.
 *
 * A refused connection fails fast. A connection that opens and then stops
 * answering — a captive portal, a cell handoff, a phone waking in a basement —
 * hangs until the browser gives up, which can be over a minute. That used to be
 * a minute of blank screen at boot, because nothing rendered until the store
 * was ready.
 *
 * Ten seconds is chosen to be slower than any working request on a bad
 * connection and faster than a person deciding the app is broken.
 */
const NET_TIMEOUT_MS = 10_000;

export function withTimeout(ms = NET_TIMEOUT_MS) {
  // AbortSignal.timeout is Safari 16+. Older phones simply get no timeout,
  // which is what they had before, rather than a crash on boot.
  try { return AbortSignal.timeout(ms); } catch { return undefined; }
}

/* navigator.onLine is not a reliable signal: a phone with one bar, a captive
   portal, or a stalled cell handoff all report online while every fetch fails.
   Treat the shape of the error as the truth. */
export function isNetworkError(err) {
  if (!navigator.onLine) return true;
  // A timed-out request is a network problem, and AbortSignal reports it by
  // name rather than by message, so check both.
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return true;
  return /failed to fetch|networkerror|network request|load failed|timeout|aborted/i.test(String(err && err.message));
}

export const FACTORS = {
  cookie: ['chocolate', 'texture', 'dough', 'salt', 'structure', 'freshness'],
  other: ['dough', 'texture', 'structure', 'freshness'],
};

export const WEIGHTS = {
  cookie: { chocolate: 0.22, texture: 0.22, dough: 0.2, salt: 0.14, structure: 0.12, freshness: 0.1 },
  other: { dough: 0.35, texture: 0.3, structure: 0.2, freshness: 0.15 },
};

const NS = 'cookietour';
const KEYS = {
  profiles: `${NS}.profiles`,
  activeProfile: `${NS}.activeProfile`,
  events: `${NS}.events`,
  session: `${NS}.session`,
  outbox: `${NS}.outbox`,
  party: `${NS}.party`,
  roster: `${NS}.roster`,
};

export const itemKey = (stopId, itemId) => `${stopId}:${itemId}`;

export function totalScore(scores, itemType = 'cookie') {
  const w = WEIGHTS[itemType];
  let sum = 0;
  for (const f of FACTORS[itemType]) sum += w[f] * Number(scores[f] ?? 0);
  return Math.round(sum * 10 * 10) / 10;
}

/** The total with freshness dropped and the rest renormalised. */
export function recipeScore(scores, itemType = 'cookie') {
  const w = WEIGHTS[itemType];
  let sum = 0;
  let weight = 0;
  for (const f of FACTORS[itemType]) {
    if (f === 'freshness') continue;
    sum += w[f] * Number(scores[f] ?? 0);
    weight += w[f];
  }
  return weight ? Math.round((sum / weight) * 10 * 10) / 10 : null;
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16));
}

/** Reject anything the database would reject, so both adapters behave alike. */
export function validateRating(r) {
  const errors = [];
  const type = r.itemType === 'other' ? 'other' : 'cookie';
  if (!r.stopId || !r.itemId) errors.push('Pick a menu item first.');
  for (const f of FACTORS[type]) {
    const v = Number(r.scores?.[f]);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      errors.push('Every factor needs a score from 1 to 10.');
      break;
    }
  }
  if (r.pricePaid != null && r.pricePaid !== '') {
    const p = Number(r.pricePaid);
    if (!Number.isFinite(p) || p < 0 || p > 200) errors.push('Price should be between 0 and 200.');
  }
  if (r.notes && String(r.notes).length > 500) errors.push('Notes are limited to 500 characters.');
  return errors;
}

export function validateName(name) {
  const n = String(name ?? '').trim();
  if (!n) return 'Enter a name.';
  if (n.length > 40) return 'Keep the name under 40 characters.';
  return null;
}

export function validatePartyCode(code) {
  const c = String(code ?? '').trim();
  if (!c) return null;
  if (!/^[a-z0-9-]{6,40}$/i.test(c)) {
    return 'Party codes are 6 to 40 characters: letters, numbers and hyphens.';
  }
  return null;
}

/* ------------------------------------------------------------------ local */

export class LocalAdapter {
  mode = 'local';
  label = 'This device only';

  async init() {
    this._profiles = this._read(KEYS.profiles, []);
    const activeId = this._read(KEYS.activeProfile, null);
    this._taster = this._profiles.find((p) => p.id === activeId) ?? this._profiles[0] ?? null;
    this._events = this._read(KEYS.events, []);
    return this;
  }

  _read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  _write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  }

  async getTaster() { return this._taster; }
  async listProfiles() { return this._profiles.slice(); }

  /* Everyone who has entered a name. On this adapter that is everyone on this
     device, because there is nowhere else for them to be. */
  async listTasters() { return this._profiles.slice(); }

  async switchProfile(id) {
    const p = this._profiles.find((x) => x.id === id);
    if (!p) throw new Error('No such taster on this device.');
    this._taster = p;
    this._write(KEYS.activeProfile, p.id);
    return p;
  }

  async signIn(displayName, partyCode) {
    const nameError = validateName(displayName);
    if (nameError) throw new Error(nameError);
    const codeError = validatePartyCode(partyCode);
    if (codeError) throw new Error(codeError);

    const name = String(displayName).trim();
    const code = partyCode ? String(partyCode).trim().toLowerCase() : null;

    let profile = this._taster;
    if (!profile) {
      profile = this._profiles.find((p) => p.display_name.toLowerCase() === name.toLowerCase());
    }
    if (profile) {
      profile.display_name = name;
      profile.party_code = code;
    } else {
      profile = { id: uuid(), display_name: name, party_code: code, created_at: new Date().toISOString() };
      this._profiles.push(profile);
    }
    this._taster = profile;
    this._write(KEYS.profiles, this._profiles);
    this._write(KEYS.activeProfile, profile.id);
    return profile;
  }

  async addProfile(displayName, partyCode) {
    const nameError = validateName(displayName);
    if (nameError) throw new Error(nameError);
    const profile = {
      id: uuid(),
      display_name: String(displayName).trim(),
      party_code: partyCode ? String(partyCode).trim().toLowerCase() : null,
      created_at: new Date().toISOString(),
    };
    this._profiles.push(profile);
    this._taster = profile;
    this._write(KEYS.profiles, this._profiles);
    this._write(KEYS.activeProfile, profile.id);
    return profile;
  }

  async saveRating(input) {
    if (!this._taster) throw new Error('Add your name before scoring.');
    const errors = validateRating(input);
    if (errors.length) throw new Error(errors[0]);

    const type = input.itemType === 'other' ? 'other' : 'cookie';
    const now = new Date().toISOString();
    const scores = {};
    for (const f of FACTORS[type]) scores[f] = Number(input.scores[f]);

    const event = {
      id: uuid(),
      taster_id: this._taster.id,
      taster_name: this._taster.display_name,
      party_code: this._taster.party_code,
      item_key: itemKey(input.stopId, input.itemId),
      stop_id: input.stopId,
      item_id: input.itemId,
      item_type: type,
      ...scores,
      price_paid: input.pricePaid === '' || input.pricePaid == null ? null : Number(input.pricePaid),
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
      visited_on: input.visitedOn ?? now.slice(0, 10),
      rubric_version: RUBRIC_VERSION,
      total_score: totalScore(scores, type),
      recipe_score: recipeScore(scores, type),
      created_at: now,
    };
    event.value_index = event.price_paid > 0
      ? Math.round((event.total_score / event.price_paid) * 100) / 100
      : null;

    this._events.push(event);
    if (!this._write(KEYS.events, this._events)) {
      this._events.pop();
      throw new Error('Could not save. Device storage is full or blocked.');
    }
    return event;
  }

  _scoped(scope) {
    const t = this._taster;
    if (scope === 'mine') return this._events.filter((e) => e.taster_id === t?.id);
    if (scope === 'party') {
      if (!t?.party_code) return this._events.filter((e) => e.taster_id === t?.id);
      return this._events.filter((e) => e.party_code === t.party_code);
    }
    return this._events.slice();
  }

  /* Names are resolved at read time from the profile list rather than trusted
     from the snapshot written onto each event, so renaming a taster does not
     leave old scores attributed to the old name. */
  _named(e) {
    const p = this._profiles.find((x) => x.id === e.taster_id);
    return p ? { ...e, taster_name: p.display_name, party_code: p.party_code } : e;
  }

  /** Newest event per person per item. */
  async listRatings({ scope = 'all' } = {}) {
    const latest = new Map();
    for (const e of this._scoped(scope).map((x) => this._named(x))) {
      const k = `${e.taster_id}|${e.item_key}`;
      const prev = latest.get(k);
      if (!prev || e.created_at > prev.created_at) latest.set(k, e);
    }
    return [...latest.values()];
  }

  async listHistory({ scope = 'all' } = {}) {
    return this._scoped(scope)
      .map((e) => this._named(e))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async exportAll() {
    return {
      exported: new Date().toISOString(),
      rubricVersion: RUBRIC_VERSION,
      profiles: this._profiles,
      events: this._events,
    };
  }

  async importAll(payload) {
    if (!payload || !Array.isArray(payload.events)) throw new Error('That file is not a cookie tour export.');
    const seen = new Set(this._events.map((e) => e.id));
    let added = 0;
    let skipped = 0;
    for (const e of payload.events) {
      // A file off disk is untrusted input like any other. Anything that would
      // not survive being typed into the form does not get in.
      if (!e?.id || seen.has(e.id)) { skipped++; continue; }
      const type = e.item_type === 'other' ? 'other' : 'cookie';
      const scores = Object.fromEntries(FACTORS[type].map((f) => [f, e[f]]));
      const problems = validateRating({
        stopId: e.stop_id, itemId: e.item_id, itemType: type,
        scores, pricePaid: e.price_paid, notes: e.notes,
      });
      if (problems.length) { skipped++; continue; }
      e.item_type = type;
      e.total_score = totalScore(scores, type);
      e.recipe_score = recipeScore(scores, type);
      this._events.push(e);
      seen.add(e.id);
      added++;
    }
    if (skipped) console.warn(`Skipped ${skipped} events that failed validation.`);
    for (const p of payload.profiles ?? []) {
      if (p?.id && !this._profiles.some((x) => x.id === p.id)) this._profiles.push(p);
    }
    this._write(KEYS.events, this._events);
    this._write(KEYS.profiles, this._profiles);
    return added;
  }
}



/* A magic-link redirect returns a token but no user object. Reading the
   unverified claims here is fine: it is our own token, and the database
   re-derives auth.uid() from the signature on every request regardless. */
function parseJwtUser(token) {
  try {
    const body = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(decodeURIComponent(escape(atob(body))));
    return { id: json.sub, email: json.email || null, is_anonymous: json.is_anonymous ?? false, role: json.role };
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- supabase */

export class SupabaseAdapter {
  mode = 'cloud';
  label = 'Synced';

  constructor({ url, anonKey }) {
    this.url = String(url).replace(/\/+$/, '');
    this.anonKey = anonKey;
    this.session = null;
    this._partyIds = [];
    this._partyMemberIds = [];
  }

  get _headers() {
    return {
      apikey: this.anonKey,
      Authorization: `Bearer ${this.session?.access_token ?? this.anonKey}`,
      'Content-Type': 'application/json',
    };
  }

  async init() {
    // A magic link comes back with tokens in the URL fragment. Consume it
    // before anything else: minting a new anonymous identity first would
    // strand the very scores the link exists to recover.
    const returned = this._consumeAuthRedirect();
    if (returned) this.session = returned;

    if (!this.session) {
      try { this.session = JSON.parse(localStorage.getItem(KEYS.session) || 'null'); }
      catch { this.session = null; }
    }

    if (this.session?.expires_at && this.session.expires_at * 1000 < Date.now() + 60_000) {
      await this._refresh().catch(() => { this.session = null; });
    }
    if (!this.session) await this._signInAnonymously();
    this._scheduleRefresh();

    try {
      this._taster = await this._fetchOwnTaster();
      if (this._taster) await this._loadParties();
    } catch (err) {
      // Reachable but not answering. Stay on this adapter rather than falling
      // back: see the note on createStore about forking a user's data.
      console.warn('Cloud reachable but profile load failed:', err.message);
      this.degraded = 'Could not load your profile. Scores you add now are queued.';
    }

    this.flushOutbox();
    window.addEventListener('online', () => this.flushOutbox());
    return this;
  }

  /* ------------------------------------------------------------- outbox --
   * Saving a score outdoors on one bar is the whole point of the app, and a
   * failed fetch used to lose it: the toast said "Failed to fetch" and the
   * cookie was already eaten. Queued writes survive a reload and flush when
   * the network comes back.
   */

  _readOutbox() {
    try { return JSON.parse(localStorage.getItem(KEYS.outbox) || '[]'); }
    catch { return []; }
  }

  _writeOutbox(rows) {
    try { localStorage.setItem(KEYS.outbox, JSON.stringify(rows)); } catch { /* full */ }
  }

  get pending() { return this._readOutbox().length; }

  _queue(row) {
    const rows = this._readOutbox();
    rows.push({
      ...row,
      _queued_at: new Date().toISOString(),
      // Who wrote this, recorded at queue time. Two people can share a phone,
      // and the queue outlives whichever of them is currently active.
      _taster_name: this._taster?.display_name ?? 'You',
    });
    this._writeOutbox(rows);
  }

  async flushOutbox() {
    if (this._flushing) return 0;
    const rows = this._readOutbox();
    if (!rows.length || !navigator.onLine) return 0;

    this._flushing = true;
    const left = [];
    let sent = 0;
    try {
      for (const row of rows) {
        // Only send what the CURRENT session is allowed to send. The insert
        // policy checks taster_id = auth.uid(), so posting the other person's
        // queued score under this JWT is a 403 — and a 403 is not a network
        // error, so the catch below would have thrown their cookie away. Hold
        // it instead; it goes out when they are switched back in.
        if (row.taster_id !== this.userId) { left.push(row); continue; }

        const { _queued_at, _taster_name, ...body } = row;
        try {
          await this._rest('rating_events', { method: 'POST', body });
          sent++;
        } catch (err) {
          // A rejection the server will never accept (a bad score, a stale
          // item) must not block the queue forever. Only keep network errors.
          if (isNetworkError(err)) left.push(row);
          else console.warn('Dropping an unsendable queued score:', err.message);
        }
      }
    } finally {
      this._writeOutbox(left);
      this._flushing = false;
    }
    if (sent) document.dispatchEvent(new CustomEvent('outboxflushed', { detail: { sent } }));
    return sent;
  }

  _persist() {
    try { localStorage.setItem(KEYS.session, JSON.stringify(this.session)); } catch { /* ignore */ }
  }

  async _signInAnonymously() {
    const res = await fetch(`${this.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
      signal: withTimeout(),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Could not reach the database (${res.status}). ${body.slice(0, 160)}`);
    }
    this.session = await res.json();
    this._persist();
  }

  async _refresh() {
    const res = await fetch(`${this.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.session.refresh_token }),
      signal: withTimeout(),
    });
    if (!res.ok) throw new Error('Session expired.');
    this.session = await res.json();
    this._persist();
  }

  _scheduleRefresh() {
    clearTimeout(this._timer);
    if (!this.session?.expires_in) return;
    const ms = Math.max(30_000, (this.session.expires_in - 120) * 1000);
    this._timer = setTimeout(() => {
      this._refresh().then(() => this._scheduleRefresh()).catch(() => {});
    }, ms);
  }

  async _rest(path, { method = 'GET', body, prefer, retried = false } = {}) {
    const headers = { ...this._headers };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: withTimeout(),
    });

    // An access token lasts an hour. A phone in a pocket between cookie stops
    // sails past that, and the scheduled refresh does not fire while the tab is
    // suspended, so the first request after waking is a 401. Refresh once and
    // retry rather than surfacing it as a failed save.
    if (res.status === 401 && !retried) {
      try {
        await this._refresh();
        this._scheduleRefresh();
        return this._rest(path, { method, body, prefer, retried: true });
      } catch { /* fall through to the normal error path */ }
    }

    if (!res.ok) {
      const text = await res.text();
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text).message ?? msg; } catch { /* keep raw */ }
      throw new Error(msg || `Request failed (${res.status}).`);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  get userId() { return this.session?.user?.id ?? null; }

  async _fetchOwnTaster() {
    if (!this.userId) return null;
    const rows = await this._rest(`tasters?id=eq.${this.userId}&select=*`);
    return rows?.[0] ?? null;
  }

  async _loadParties() {
    try {
      const rows = await this._rest('party_members?select=party_id,taster_id');
      this._partyIds = [...new Set(rows.map((r) => r.party_id))];
      this._partyMemberIds = [...new Set(rows.map((r) => r.taster_id))];
    } catch {
      this._partyIds = [];
      this._partyMemberIds = [];
    }
  }

  /* --------------------------------------------------------------- email --
   * An anonymous identity lives in one browser's storage, and iOS clears that
   * after about a week without a visit. Linking an email upgrades the SAME
   * auth.uid() in place rather than creating a second account, so scores
   * already written stay yours and become reachable from another device.
   */

  get email() { return this.session?.user?.email || null; }
  get isAnonymous() { return this.session?.user?.is_anonymous !== false; }

  _consumeAuthRedirect() {
    const raw = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    if (!raw.includes('access_token=')) return null;
    const q = new URLSearchParams(raw);
    const access_token = q.get('access_token');
    if (!access_token) return null;

    const expires_in = Number(q.get('expires_in') || 3600);
    const session = {
      access_token,
      refresh_token: q.get('refresh_token'),
      expires_in,
      expires_at: Math.floor(Date.now() / 1000) + expires_in,
      user: parseJwtUser(access_token),
    };
    try { localStorage.setItem(KEYS.session, JSON.stringify(session)); } catch { /* ignore */ }
    // Strip the tokens out of the address bar so they are not left in history
    // or pasted into a shared route link.
    history.replaceState(null, '', location.pathname + location.search);
    return session;
  }

  async _auth(path, { method = 'POST', body, authed = false } = {}) {
    const headers = { apikey: this.anonKey, 'Content-Type': 'application/json' };
    if (authed) headers.Authorization = `Bearer ${this.session?.access_token}`;
    const res = await fetch(`${this.url}/auth/v1/${path}`, {
      method, headers, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text.slice(0, 200);
      try { const j = JSON.parse(text); msg = j.msg ?? j.message ?? j.error_description ?? msg; }
      catch { /* keep raw */ }
      throw new Error(msg);
    }
    return res.json().catch(() => null);
  }

  /** Attach an email to the current identity. Sends a confirmation link. */
  async linkEmail(email) {
    await this._auth('user', { method: 'PUT', authed: true, body: { email: String(email).trim() } });
    return true;
  }

  /** Sign back in as an identity that already carries this email. */
  async sendMagicLink(email) {
    await this._auth('otp', {
      body: {
        email: String(email).trim(),
        // Never create a new user here. An unknown address means a typo, and
        // silently minting a second empty account is worse than an error.
        create_user: false,
        options: { email_redirect_to: location.origin + location.pathname },
      },
    });
    return true;
  }

  async getTaster() { return this._taster; }

  /*
   * Everyone who has entered a name, whether or not they have scored anything.
   *
   * Typing your name should put you on the board straight away rather than
   * leaving you invisible until your first cookie. Reads are public — see the
   * security note at the top of db/schema.sql, which says so plainly — so this
   * needs no party and no permission.
   */
  async listTasters() {
    try {
      return (await this._rest('tasters?select=id,display_name,created_at&order=created_at')) ?? [];
    } catch (err) {
      if (isNetworkError(err)) return [];
      throw err;
    }
  }

  /* ------------------------------------------------- two people, one phone --
   * The device-only adapter has kept a list of tasters since the beginning,
   * because without one the second person to type their name would inherit the
   * first person's scores. The cloud adapter shipped without it, and the live
   * site runs on the cloud adapter, so on the deployed site the feature was
   * dead code.
   *
   * It cannot work the same way here. tasters.id is a foreign key to
   * auth.users, so one signed-in user is exactly one taster, by construction,
   * and no amount of client code changes that. What the browser CAN hold is
   * more than one session. So a second taster is a second anonymous sign-in,
   * and switching is swapping which session is active. Both join the same
   * party, so the two of them still land on one leaderboard.
   *
   * The consequence worth knowing: each profile is a separate auth identity,
   * so attaching an email upgrades only the profile that is active when you do
   * it. That is the honest behaviour rather than a bug — the alternative would
   * be silently merging two people's scores under one login.
   */

  _readRoster() {
    try {
      const rows = JSON.parse(localStorage.getItem(KEYS.roster) || '[]');
      return Array.isArray(rows) ? rows : [];
    } catch { return []; }
  }

  _writeRoster(rows) {
    try { localStorage.setItem(KEYS.roster, JSON.stringify(rows)); } catch { /* full */ }
  }

  /** Fold the live session back into the roster so a switch never loses it. */
  _rememberCurrent() {
    if (!this.session || !this.userId) return;
    const rows = this._readRoster().filter((r) => r.id !== this.userId);
    rows.push({
      id: this.userId,
      display_name: this._taster?.display_name ?? 'Unnamed',
      session: this.session,
    });
    this._writeRoster(rows);
  }

  async listProfiles() {
    this._rememberCurrent();
    const roster = this._readRoster();
    // Never show a profile with no name yet; it is an artefact of a half
    // finished sign-in, not a person.
    return roster
      .filter((r) => r.display_name && r.display_name !== 'Unnamed')
      .map((r) => ({
        id: r.id,
        display_name: r.display_name,
        party_code: this.partyCode,
      }));
  }

  async addProfile(displayName, partyCode) {
    const nameError = validateName(displayName);
    if (nameError) throw new Error(nameError);
    if (!navigator.onLine) {
      throw new Error('Adding a second taster needs a connection, because it creates a new account. Try again when you have signal.');
    }

    // Park the person who is currently scoring before minting anyone new.
    this._rememberCurrent();
    const previous = this.session;

    try {
      await this._signInAnonymously();
      this._taster = null;
      this._partyIds = [];
      this._partyMemberIds = [];
      await this.signIn(displayName, partyCode ?? this.partyCode ?? null);
    } catch (err) {
      // A half-created profile would strand the first person, so put the
      // session that was working back exactly as it was.
      this.session = previous;
      this._persist();
      this._taster = await this._fetchOwnTaster().catch(() => null);
      await this._loadParties();
      throw err;
    }

    this._rememberCurrent();
    this._scheduleRefresh();
    return this._taster;
  }

  async switchProfile(id) {
    if (id === this.userId) return this._taster;

    this._rememberCurrent();
    const target = this._readRoster().find((r) => r.id === id);
    if (!target) throw new Error('That taster is not on this device any more.');

    const previous = this.session;
    this.session = target.session;

    // A parked session has usually gone stale, since the whole point is that it
    // sat unused while the other person scored.
    if (this.session?.expires_at && this.session.expires_at * 1000 < Date.now() + 60_000) {
      try {
        await this._refresh();
      } catch {
        this.session = previous;
        this._persist();
        throw new Error(`${target.display_name}'s sign-in has expired on this device. They will need to start again, or open the invite link on their own phone.`);
      }
    }

    this._persist();
    this._scheduleRefresh();
    this._taster = await this._fetchOwnTaster();
    await this._loadParties();
    // Anything they wrote while offline could not go out under the other
    // person's token; now it can.
    this.flushOutbox();
    return this._taster;
  }

  async signIn(displayName, partyCode) {
    const nameError = validateName(displayName);
    if (nameError) throw new Error(nameError);
    const codeError = validatePartyCode(partyCode);
    if (codeError) throw new Error(codeError);

    const write = () => this._rest('tasters', {
      method: 'POST',
      body: { id: this.userId, display_name: String(displayName).trim() },
      prefer: 'resolution=merge-duplicates,return=representation',
    });

    let saved;
    try {
      saved = await write();
    } catch (err) {
      // tasters.id is a foreign key to auth.users, and a JWT outlives the user
      // it names: PostgREST checks the signature, not whether the account still
      // exists. So after the leaderboard is reset (db/reset-test-data.sql) every
      // phone is holding a token for a deleted account, and the only symptom is
      // that saving your name fails with a foreign key error nobody can act on.
      // Sign in again and write it under the new identity instead.
      if (/tasters_id_fkey|foreign key/i.test(err.message)) {
        await this._signInAnonymously();
        this._scheduleRefresh();
        saved = await write();
      } else throw err;
    }
    this._taster = Array.isArray(saved) ? saved[0] : saved;

    if (partyCode) await this.joinParty(partyCode);
    else await this._loadParties();

    return this._taster;
  }

  /* Codes are hashed and compared server side inside one audited function, so
     no code ever travels back out of the database and none can be enumerated
     from the client. */
  async joinParty(code) {
    const res = await fetch(`${this.url}/rest/v1/rpc/join_party`, {
      method: 'POST',
      headers: this._headers,
      body: JSON.stringify({ p_code: String(code).trim().toLowerCase() }),
    });
    if (!res.ok) {
      const text = await res.text();
      let msg = text.slice(0, 200);
      try { msg = JSON.parse(text).message ?? msg; } catch { /* keep raw */ }
      throw new Error(msg);
    }
    try { localStorage.setItem(KEYS.party, String(code).trim().toLowerCase()); } catch { /* ignore */ }
    await this._loadParties();
    return true;
  }

  get inParty() { return this._partyIds.length > 0; }
  get partyCode() {
    try { return localStorage.getItem(KEYS.party) || null; } catch { return null; }
  }
  get partySize() { return this._partyMemberIds.length; }

  /* Membership was loaded once at boot. If your date joins after your session
     started, which is the normal order, their scores never appeared until you
     fully reloaded. Cheap to re-check, so re-check. */
  async refreshParties() {
    if (!this._taster || !navigator.onLine) return;
    await this._loadParties();
  }

  async leaveParty() {
    for (const id of [...this._partyIds]) {
      await fetch(`${this.url}/rest/v1/rpc/leave_party`, {
        method: 'POST', headers: this._headers, body: JSON.stringify({ p_party: id }),
      }).catch(() => {});
    }
    try { localStorage.removeItem(KEYS.party); } catch { /* ignore */ }
    await this._loadParties();
    return true;
  }

  async saveRating(input) {
    if (!this._taster) throw new Error('Add your name before scoring.');
    const errors = validateRating(input);
    if (errors.length) throw new Error(errors[0]);

    const type = input.itemType === 'other' ? 'other' : 'cookie';
    const scores = {};
    for (const f of FACTORS[type]) scores[f] = Number(input.scores[f]);

    const body = {
      taster_id: this.userId,
      item_key: itemKey(input.stopId, input.itemId),
      ...scores,
      price_paid: input.pricePaid === '' || input.pricePaid == null ? null : Number(input.pricePaid),
      notes: input.notes ? String(input.notes).slice(0, 500) : null,
      visited_on: input.visitedOn ?? new Date().toISOString().slice(0, 10),
      rubric_version: RUBRIC_VERSION,
    };

    try {
      const saved = await this._rest('rating_events', { method: 'POST', body, prefer: 'return=representation' });
      this.flushOutbox();
      return Array.isArray(saved) ? saved[0] : saved;
    } catch (err) {
      // Only queue what failed for network reasons. A constraint violation is
      // a real rejection and the user needs to see it now, not in an hour.
      if (isNetworkError(err)) {
        this._queue(body);
        return {
          ...body, id: `pending-${Date.now()}`, pending: true,
          taster_name: this._taster?.display_name ?? 'You',
          stop_id: input.stopId, item_id: input.itemId, item_type: type,
          total_score: totalScore(scores, type), recipe_score: recipeScore(scores, type),
          created_at: new Date().toISOString(),
        };
      }
      throw err;
    }
  }

  _scopeQuery(scope) {
    if (scope === 'mine') return `&taster_id=eq.${this.userId}`;
    if (scope === 'party') {
      const ids = this._partyMemberIds.length ? this._partyMemberIds : [this.userId];
      return `&taster_id=in.(${ids.join(',')})`;
    }
    return '';
  }

  async listRatings({ scope = 'all' } = {}) {
    let rows = [];
    try {
      rows = (await this._rest(`rating_feed?select=*${this._scopeQuery(scope)}`)) ?? [];
    } catch (err) {
      // A dead spot must not blank the results screen.
      if (isNetworkError(err)) rows = [];
      else throw err;
    }
    // Anything still queued is real work the user did; show it rather than
    // pretending it does not exist until the network returns.
    const queued = this._readOutbox().map((row) => ({
      ...row, id: `pending-${row.taster_id}:${row.item_key}`, pending: true,
      taster_name: row._taster_name ?? this._taster?.display_name ?? 'You',
      stop_id: row.item_key.split(':')[0],
      item_id: row.item_key.split(':').slice(1).join(':'),
      item_type: row.chocolate == null ? 'other' : 'cookie',
      created_at: row._queued_at,
    }));
    return rows.concat(queued);
  }

  async listHistory({ scope = 'all' } = {}) {
    try {
      // Bounded: this is re-fetched on every poll and only ever drives a
      // running-average line, so the whole history is never needed.
      return (await this._rest(
        `rating_history?select=*&order=created_at.asc&limit=500${this._scopeQuery(scope)}`)) ?? [];
    } catch (err) {
      if (isNetworkError(err)) return [];
      throw err;
    }
  }

  async exportAll() {
    // rating_feed carries the factor columns; rating_history does not. Exporting
    // from history would produce a file that looks complete and contains no
    // actual scores.
    const current = await this.listRatings({ scope: 'mine' });
    const history = await this.listHistory({ scope: 'mine' });
    return {
      exported: new Date().toISOString(),
      rubricVersion: RUBRIC_VERSION,
      profiles: this._taster ? [this._taster] : [],
      events: current,
      history,
    };
  }

  async importAll() {
    throw new Error('Importing is only available on device-only storage.');
  }
}

/* ----------------------------------------------------------------- choose */

export async function createStore() {
  let config = null;
  try {
    const res = await fetch('config/supabase.json', { cache: 'no-store' });
    if (res.ok) config = await res.json();
  } catch { /* no config shipped, which is the normal case */ }

  const configured =
    config?.url && config?.anonKey &&
    !String(config.url).includes('YOUR-PROJECT') &&
    !String(config.anonKey).includes('YOUR-ANON-KEY');

  if (configured) {
    try {
      return await new SupabaseAdapter(config).init();
    } catch (err) {
      const offline = isNetworkError(err);
      if (offline) {
        // Do NOT fall back to the device here. The service worker serves the
        // cached config offline, so this branch is reached on any offline
        // reload; falling back would start writing to a separate local store
        // that the Postgres copy can never merge with, silently forking the
        // user's data in two. Stay on the cloud adapter with no session: reads
        // come back empty, writes queue, and everything reconciles on flush.
        console.warn('Offline at boot; staying on the cloud adapter and queueing writes.', err);
        const stub = new SupabaseAdapter(config);
        try { stub.session = JSON.parse(localStorage.getItem(KEYS.session) || 'null'); }
        catch { stub.session = null; }
        stub._taster = null;
        stub.degraded = 'Offline. Scores you add now are saved on this device and sent when you are back.';
        stub.flushOutbox();
        window.addEventListener('online', () => stub.flushOutbox());
        return stub;
      }
      console.error('Cloud storage misconfigured, falling back to this device.', err);
      const local = await new LocalAdapter().init();
      local.degraded = /captcha/i.test(err.message)
        ? 'The database rejected sign-in because CAPTCHA is enabled for anonymous sign-ins. This client cannot send a CAPTCHA token, so turn it off in Authentication, Attack Protection.'
        : err.message;
      return local;
    }
  }
  return new LocalAdapter().init();
}

/* iOS clears script-writable storage after about a week of not visiting a
   site. Asking for persistent storage does not always work, but when it does
   it is the difference between keeping a tour's scores and losing them. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist) {
      if (await navigator.storage.persisted()) return true;
      return await navigator.storage.persist();
    }
  } catch { /* not supported */ }
  return false;
}
