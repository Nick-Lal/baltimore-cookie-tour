/* Setup: identity, party, storage, themes and data export. */

import { el, icon, ICONS, clear, toast } from '../lib/dom.js?v=32b96abd';
import { state, emit } from '../lib/state.js?v=32b96abd';
import { renderThemePicker, currentTheme } from '../themes.js?v=32b96abd';
import { requestPersistence } from '../lib/storage.js?v=32b96abd';
import { refresh as refreshResults } from './results.js?v=32b96abd';

function statusCard() {
  const store = state.store;
  const cloud = store.mode === 'cloud';

  const lines = cloud
    ? [
        'Scores go to a hosted Postgres database and sync between phones.',
        'Row level security means nobody can edit or delete a score you wrote, and scores are append-only, so nothing you record is ever overwritten.',
      ]
    : [
        "Scores are saved on this device only. Nothing leaves your phone, and nothing syncs to anyone else's.",
        'Two people can still compare properly by sharing one phone and switching between tasters below. To score from two phones at once, connect the shared database.',
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
          el('a', { href: 'https://github.com/Nick-Lal/baltimore-cookie-tour/blob/master/docs/supabase-setup.md', target: '_blank', rel: 'noopener noreferrer', text: 'How to connect the shared database' }))
      : null,
  ]);
}

/*
 * Two people, one phone.
 *
 * On device-only storage there is no sign-in, so without this the second
 * person to type their name would quietly overwrite the first person's
 * profile and inherit their scores. That would make the whole point of the
 * site, two people comparing numbers, impossible on the shipped default.
 * So the device keeps a list of tasters and you switch between them.
 */
async function profileSwitcher() {
  const store = state.store;
  if (store.mode !== 'local' || !store.listProfiles) return null;

  const profiles = await store.listProfiles();
  const wrap = el('div', { style: { marginTop: 'var(--sp-4)' } });

  if (profiles.length > 1) {
    wrap.append(
      el('h3', { class: 'section-header', style: { padding: '0 0 var(--sp-2)' }, text: 'Who is scoring right now' }),
      el('div', { class: 'card' }, profiles.map((p) => el('button', {
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
          el('span', { class: 'list__sub', text: p.party_code ? `Party ${p.party_code}` : 'No party code' }),
        ]),
        p.id === state.taster?.id
          ? el('span', { style: { color: 'var(--tint)' } }, icon(ICONS.check, { size: 20, width: 2.4 }))
          : null,
      ]))));
  }

  if (state.taster) {
    wrap.append(el('button', {
      class: 'btn btn--tinted btn--full', type: 'button',
      style: { marginTop: 'var(--sp-3)' },
      onclick: () => addTasterFlow(),
    }, 'Add another taster'));
    wrap.append(el('p', {
      class: 'footnote secondary', style: { marginTop: 'var(--sp-2)' },
      text: profiles.length > 1
        ? 'Hand the phone over and switch to the other name before they score.'
        : 'Sharing one phone? Add the other person here so your scores stay separate.',
    }));
  }

  return wrap;
}

async function addTasterFlow() {
  const name = prompt('Name of the other taster');
  if (name == null) return;
  try {
    const code = state.taster?.party_code ?? null;
    state.taster = await state.store.addProfile(name, code);
    emit('taster');
    await refreshResults();
    render();
    toast(`Now scoring as ${state.taster.display_name}.`);
  } catch (err) {
    toast(err.message);
  }
}


/* Supabase's auth errors are written for developers. These are the three that
   a person using the site can actually hit, so say what they mean. */
function explain(msg) {
  const m = String(msg);
  if (/otp_disabled|Signups not allowed/i.test(m)) {
    return 'No scores are saved under that address. Check the spelling, or use ' +
           '"Attach this email" first on the device that has your scores.';
  }
  if (/rate|limit|seconds|too many/i.test(m)) {
    return 'The database only sends a couple of these an hour. Try again shortly.';
  }
  if (/already been registered|already registered|already exists/i.test(m)) {
    return 'That address is already attached to a different set of scores. Use ' +
           '"Send me a link" instead to sign back into those.';
  }
  if (/invalid format|validate email/i.test(m)) return 'That does not look like an email address.';
  return m;
}

/*
 * Keeping your scores.
 *
 * Anonymous identities live in one browser's storage and iOS clears that after
 * roughly a week without a visit. Linking an email upgrades the same identity
 * in place, so nothing already written is orphaned, and the same scores can be
 * reached from a second device.
 */
function durabilityCard() {
  const store = state.store;

  if (store.mode !== 'cloud') {
    return el('div', {}, [
      el('p', { class: 'footnote secondary', text:
        'Scores are on this device only, so the thing that protects them is the ' +
        'download button below. Connect the shared database and you can attach an ' +
        'email instead.' }),
    ]);
  }

  if (store.email) {
    return el('div', {}, [
      el('div', { class: 'row', style: { gap: 'var(--sp-2)', marginBottom: 'var(--sp-2)' } }, [
        el('span', { class: 'badge__dot dot-open' }),
        el('span', { class: 'headline', text: 'Saved to ' + store.email }),
      ]),
      el('p', { class: 'footnote secondary', text:
        'Your scores are tied to this address, not to this browser. Open the site ' +
        'on another phone, use "Send me a sign-in link", and the same scores follow ' +
        'you.' }),
    ]);
  }

  const status = el('p', { class: 'footnote', style: { marginTop: 'var(--sp-2)' }, role: 'status' });
  const input = el('input', {
    class: 'field', id: 'link-email', type: 'email', autocomplete: 'email',
    placeholder: 'you@example.com', inputmode: 'email',
  });

  const run = async (fn, working, done) => {
    const val = input.value.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) {
      status.textContent = 'That does not look like an email address.';
      return;
    }
    status.textContent = working;
    try {
      await fn(val);
      status.textContent = done;
    } catch (err) {
      status.textContent = explain(err.message);
    }
  };

  return el('div', {}, [
    el('p', { class: 'footnote secondary', style: { marginBottom: 'var(--sp-3)' }, text:
      'Right now your scores are tied to this browser. iPhones clear website ' +
      'storage after about a week of not visiting, and clearing it loses the ' +
      'thread back to what you wrote. Attaching an email keeps the same identity ' +
      'and the same scores, and lets you pick them up on another phone.' }),
    el('label', { class: 'form-label', for: 'link-email', text: 'Email' }),
    input,
    el('div', { class: 'row', style: { gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' } }, [
      el('button', {
        class: 'btn btn--filled', type: 'button', style: { flex: '1' },
        onclick: () => run((v) => store.linkEmail(v),
          'Sending…',
          'Check your email and open the link. Your scores stay exactly where they are.'),
      }, 'Attach this email'),
      el('button', {
        class: 'btn btn--grey', type: 'button',
        onclick: () => run((v) => store.sendMagicLink(v),
          'Sending…',
          'Sign-in link sent. Open it on this device to pick up those scores.'),
      }, 'Send me a link'),
    ]),
    status,
  ]);
}

/* ----------------------------------------------------------------- render */

export function render() {
  const host = document.getElementById('storage-status');
  if (host) { clear(host); host.append(statusCard()); }

  const nameInput = document.getElementById('display-name');
  const codeInput = document.getElementById('party-code');
  if (nameInput && state.taster) nameInput.value = state.taster.display_name ?? '';
  if (codeInput && state.taster?.party_code) codeInput.value = state.taster.party_code;

  const durability = document.getElementById('identity-durability');
  if (durability) { clear(durability); durability.append(durabilityCard()); }

  const picker = document.getElementById('theme-picker');
  if (picker) renderThemePicker(picker);

  const switcherHost = document.getElementById('profile-switcher');
  if (switcherHost) {
    clear(switcherHost);
    profileSwitcher().then((node) => {
      if (node && switcherHost.isConnected) switcherHost.append(node);
    });
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
