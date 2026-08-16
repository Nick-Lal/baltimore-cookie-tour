/* Theme library: catalogue, persistence, and the picker UI. */

export const THEMES = [
  { id: 'bake-sale', name: 'Bake Sale', scheme: 'light',
    note: 'Cream, chocolate and butter. A bakery counter on a Saturday morning.',
    swatch: ['#fbf6ee', '#b4541f', '#2e2019'] },
  { id: 'charm-city', name: 'Charm City', scheme: 'light',
    note: 'The Baltimore flag. Black and gold, square corners, heraldic.',
    swatch: ['#fdfbf3', '#8a6a00', '#14120c'] },
  { id: 'midnight-batch', name: 'Midnight Batch', scheme: 'dark',
    note: 'For the 2am stop. Near black with a warm amber tint.',
    swatch: ['#12100e', '#ffb340', '#f7f1e8'] },
  { id: 'formstone', name: 'Formstone', scheme: 'light',
    note: 'Rowhouse grey, marble step white, a brick red accent.',
    swatch: ['#f2f1ee', '#9c3b2e', '#24262a'] },
  { id: 'old-bay', name: 'Old Bay', scheme: 'light',
    note: 'Paprika and crab blue on brown paper. Maryland, obviously.',
    swatch: ['#fdf4e3', '#1f5f8b', '#33240f'] },
  { id: 'sourdough', name: 'Sourdough', scheme: 'light',
    note: 'Flour, crust and Maldon salt. Soft corners, serif headings.',
    swatch: ['#f7f5f0', '#627565', '#2b2a26'] },
  { id: 'neon-diner', name: 'Neon Diner', scheme: 'dark',
    note: 'Deep teal and hot pink. Rounded, loud, unmistakably a date.',
    swatch: ['#0d1f22', '#ff518f', '#f4f7f2'] },
  { id: 'marble-counter', name: 'Marble Counter', scheme: 'light',
    note: 'Editorial minimal. Square corners, no shadows, one green.',
    swatch: ['#ffffff', '#1a7f5a', '#111111'] },
  { id: 'dark-chocolate', name: 'Dark Chocolate', scheme: 'dark',
    note: 'Cocoa browns under cream text, with gold. Quiet and rich.',
    swatch: ['#1a1210', '#d9a441', '#f2e8dd'] },
  { id: 'harbor-fog', name: 'Harbor Fog', scheme: 'light',
    note: 'Cool blue grey, low contrast chrome. Easy on a bright screen.',
    swatch: ['#eef2f4', '#3f6d8f', '#1e2a31'] },
];

const KEY = 'cookietour.theme';
const DEFAULT_LIGHT = 'bake-sale';
const DEFAULT_DARK = 'midnight-batch';

export function currentTheme() {
  return document.documentElement.dataset.theme || DEFAULT_LIGHT;
}

export function applyTheme(id, { persist = true } = {}) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0];
  document.documentElement.dataset.theme = theme.id;
  if (persist) {
    try { localStorage.setItem(KEY, theme.id); } catch { /* private mode */ }
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.content = getComputedStyle(document.documentElement)
      .getPropertyValue('--bg').trim() || theme.swatch[0];
  }
  document.dispatchEvent(new CustomEvent('themechange', { detail: theme }));
  return theme;
}

/** Run before first paint to avoid a flash of the wrong theme. */
export function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
  if (saved && THEMES.some((t) => t.id === saved)) return applyTheme(saved, { persist: false });
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return applyTheme(prefersDark ? DEFAULT_DARK : DEFAULT_LIGHT, { persist: false });
}

/** Build the theme picker grid into a container element. */
export function renderThemePicker(container) {
  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'theme-grid';
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-label', 'Site theme');

  for (const theme of THEMES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-card';
    btn.dataset.theme = theme.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(theme.id === currentTheme()));
    btn.innerHTML = `
      <span class="theme-card__swatches" aria-hidden="true">
        ${theme.swatch.map((c) => `<span style="background:${c}"></span>`).join('')}
      </span>
      <span class="theme-card__body">
        <span class="theme-card__name">${theme.name}</span>
        <span class="theme-card__note footnote">${theme.note}</span>
      </span>
      <span class="theme-card__check" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.4"
             stroke-linecap="round" stroke-linejoin="round"><path d="M4 10.5l4 4 8-9"/></svg>
      </span>`;
    btn.tabIndex = theme.id === currentTheme() ? 0 : -1;
    btn.addEventListener('click', () => select(theme.id));
    grid.appendChild(btn);
  }

  function select(id, focus = false) {
    applyTheme(id);
    for (const card of grid.querySelectorAll('.theme-card')) {
      const on = card.dataset.theme === id;
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = on ? 0 : -1;
      if (on && focus) card.focus();
    }
  }

  /* One tab stop for the whole group, arrows to move between options, which is
     what a radiogroup is supposed to do. Ten sequential tab stops is not. */
  grid.addEventListener('keydown', (e) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const ids = THEMES.map((t) => t.id);
    const at = ids.indexOf(currentTheme());
    let next;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (at + 1) % ids.length;
    else next = (at - 1 + ids.length) % ids.length;
    select(ids[next], true);
  });

  container.appendChild(grid);
  return grid;
}
