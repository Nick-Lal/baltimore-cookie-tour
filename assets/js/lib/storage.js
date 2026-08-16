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

  /** Newest event per person per item. */
  async listRatings({ scope = 'all' } = {}) {
    const latest = new Map();
    for (const e of this._scoped(scope)) {
      const k = `${e.taster_id}|${e.item_key}`;
      const prev = latest.get(k);
      if (!prev || e.created_at > prev.created_at) latest.set(k, e);
    }
    return [...latest.values()];
  }

  async listHistory({ scope = 'all' } = {}) {
    return this._scoped(scope).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
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
    for (const e of payload.events) {
      if (e?.id && !seen.has(e.id)) { this._events.push(e); seen.add(e.id); added++; }
    }
    for (const p of payload.profiles ?? []) {
      if (p?.id && !this._profiles.some((x) => x.id === p.id)) this._profiles.push(p);
    }
    this._write(KEYS.events, this._events);
    this._write(KEYS.profiles, this._profiles);
    return added;
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
    try { this.session = JSON.parse(localStorage.getItem(KEYS.session) || 'null'); }
    catch { this.session = null; }

    if (this.session?.expires_at && this.session.expires_at * 1000 < Date.now() + 60_000) {
      await this._refresh().catch(() => { this.session = null; });
    }
    if (!this.session) await this._signInAnonymously();
    this._scheduleRefresh();

    this._taster = await this._fetchOwnTaster();
    if (this._taster) await this._loadParties();
    return this;
  }

  _persist() {
    try { localStorage.setItem(KEYS.session, JSON.stringify(this.session)); } catch { /* ignore */ }
  }

  async _signInAnonymously() {
    const res = await fetch(`${this.url}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: this.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
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

  async _rest(path, { method = 'GET', body, prefer } = {}) {
    const headers = { ...this._headers };
    if (prefer) headers.Prefer = prefer;
    const res = await fetch(`${this.url}/rest/v1/${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
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

  async getTaster() { return this._taster; }
  async listProfiles() { return this._taster ? [this._taster] : []; }

  async signIn(displayName, partyCode) {
    const nameError = validateName(displayName);
    if (nameError) throw new Error(nameError);
    const codeError = validatePartyCode(partyCode);
    if (codeError) throw new Error(codeError);

    const saved = await this._rest('tasters', {
      method: 'POST',
      body: { id: this.userId, display_name: String(displayName).trim() },
      prefer: 'resolution=merge-duplicates,return=representation',
    });
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
    await this._loadParties();
    return true;
  }

  get inParty() { return this._partyIds.length > 0; }

  async saveRating(input) {
    if (!this._taster) throw new Error('Add your name before scoring.');
    const errors = validateRating(input);
    if (errors.length) throw new Error(errors[0]);

    const type = input.itemType === 'other' ? 'other' : 'cookie';
    const scores = {};
    for (const f of FACTORS[type]) scores[f] = Number(input.scores[f]);

    const saved = await this._rest('rating_events', {
      method: 'POST',
      body: {
        taster_id: this.userId,
        item_key: itemKey(input.stopId, input.itemId),
        ...scores,
        price_paid: input.pricePaid === '' || input.pricePaid == null ? null : Number(input.pricePaid),
        notes: input.notes ? String(input.notes).slice(0, 500) : null,
        visited_on: input.visitedOn ?? new Date().toISOString().slice(0, 10),
        rubric_version: RUBRIC_VERSION,
      },
      prefer: 'return=representation',
    });
    return Array.isArray(saved) ? saved[0] : saved;
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
    return (await this._rest(`rating_feed?select=*${this._scopeQuery(scope)}`)) ?? [];
  }

  async listHistory({ scope = 'all' } = {}) {
    return (await this._rest(
      `rating_history?select=*&order=created_at.asc${this._scopeQuery(scope)}`)) ?? [];
  }

  async exportAll() {
    return {
      exported: new Date().toISOString(),
      rubricVersion: RUBRIC_VERSION,
      profiles: this._taster ? [this._taster] : [],
      events: await this.listHistory({ scope: 'mine' }),
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
      console.warn('Cloud storage unavailable, falling back to this device.', err);
      const local = await new LocalAdapter().init();
      local.degraded = err.message;
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
