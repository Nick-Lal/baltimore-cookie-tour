/* Setup: identity, party, storage, themes and data export. */

import { el, icon, ICONS, clear, toast } from '../lib/dom.js';
import { state, emit } from '../lib/state.js';
import { renderThemePicker, currentTheme } from '../themes.js';
import { requestPersistence } from '../lib/storage.js';
import { refresh as refreshResults } from './results.js';

function statusCard() {
  const store = state.store;
  const cloud = store.mode === 'cloud';

  const lines = cloud
    ? [
        'Scores go to a hosted Postgres database and sync between phones.',
        'Row level security means nobody can edit or delete a score you wrote, and scores are append-only, so nothing you record is ever overwritten.',
      ]
    : [
        'Scores are saved on this device only. Nothing leaves your phone, and nothing syncs to anyone else’s.',
        'That is fine for one person on one phone. For two people comparing scores, connect the shared database.',
      ];

  return el('div', {}, [
    el('div', { class: 'row', style: { gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' } }, [
      el('span', { class: `badge__dot ${cloud ? 'dot-open' : 'dot-unk'}` }),
      el('span', { class: 'headline', text: cloud ? 'Synced database' : 'This device only' }),
    ]),
    ...lines.map((t) => el('p', { class: 'footnote secondary', style: { marginBottom: 'var(--sp-2)' }, text: t })),
    store.degraded
      ? el('div', { class: 'notice notice--warn', style: { marginTop: 'var(--sp-3)' } }, [
          icon(ICONS.warn, { size: 18 }),
          el('span', { text: `The database was configured but did not answer, so scores are staying on this device. ${store.degraded}` }),
        ])
      : null,
    !cloud
      ? el('p', { class: 'footnote', style: { marginTop: 'var(--sp-3)' } },
          el('a', { href: 'docs/supabase-setup.md', text: 'How to connect the shared database' }))
      : null,
  ]);
}

function profileSwitcher() {
  const store = state.store;
  if (store.mode !== 'local' || !store.listProfiles) return null;

  return (async () => {
    const profiles = await store.listProfiles();
    if (profiles.length < 2) return null;
    return el('div', { class: 'card', style: { marginTop: 'var(--sp-3)' } },
      profiles.map((p) => el('button', {
        class: 'list__row list__row--button', type: 'button',
        onclick: async () => {
          await store.switchProfile(p.id);
          state.taster = await store.getTaster();
          emit('taster');
          await refreshResults();
          render();
          toast(`Now scoring as ${p.display_name}.`);
        },
      }, [
        el('span', { class: 'list__body' }, [
          el('span', { class: 'list__title', text: p.display_name }),
          el('span', { class: 'list__sub', text: p.party_code ? `Party ${p.party_code}` : 'No party' }),
        ]),
        p.id === state.taster?.id
          ? el('span', { style: { color: 'var(--tint)' } }, icon(ICONS.check, { size: 20, width: 2.4 }))
          : null,
      ])));
  })();
}

/* ----------------------------------------------------------------- render */

export function render() {
  const host = document.getElementById('storage-status');
  if (host) { clear(host); host.append(statusCard()); }

  const nameInput = document.getElementById('display-name');
  const codeInput = document.getElementById('party-code');
  if (nameInput && state.taster) nameInput.value = state.taster.display_name ?? '';
  if (codeInput && state.taster?.party_code) codeInput.value = state.taster.party_code;

  const picker = document.getElementById('theme-picker');
  if (picker) renderThemePicker(picker);

  const switcherHost = document.getElementById('profile-switcher');
  if (switcherHost) {
    clear(switcherHost);
    const p = profileSwitcher();
    if (p) p.then((node) => { if (node) switcherHost.append(node); });
  }
}

export function initSettingsView() {
  const form = document.getElementById('identity-form');
  const status = document.getElementById('identity-status');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('display-name').value;
    const code = document.getElementById('party-code').value;
    status.textContent = 'Saving…';
    try {
      state.taster = await state.store.signIn(name, code || null);
      requestPersistence();
      status.textContent = code
        ? `Saved. You are in party "${code.trim().toLowerCase()}".`
        : 'Saved.';
      emit('taster');
      await refreshResults();
      render();
      toast(`Hello, ${state.taster.display_name}.`);
    } catch (err) {
      status.textContent = err.message;
    }
  });

  document.getElementById('export-json')?.addEventListener('click', () => exportData());
  document.getElementById('export-data')?.addEventListener('click', () => exportData());

  document.getElementById('import-json')?.addEventListener('click', () =>
    document.getElementById('import-file').click());

  document.getElementById('import-file')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const added = await state.store.importAll(payload);
      await refreshResults();
      toast(added ? `Restored ${added} scores.` : 'Nothing new in that file.');
    } catch (err) {
      toast(err.message);
    } finally {
      e.target.value = '';
    }
  });
}

async function exportData() {
  try {
    const data = await state.store.exportAll();
    data.theme = currentTheme();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', {
      href: url,
      download: `cookie-tour-${new Date().toISOString().slice(0, 10)}.json`,
    });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Downloaded.');
  } catch (err) {
    toast(err.message);
  }
}
