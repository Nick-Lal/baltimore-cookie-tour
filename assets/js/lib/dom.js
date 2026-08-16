/*
 * DOM helpers.
 *
 * Everything here sets text through textContent. Display names and tasting
 * notes are written by whoever is using the site and rendered on a public
 * leaderboard, so they must never be interpolated into markup. There is no
 * innerHTML path in this file, which is the point of having the file.
 */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list' && typeof v !== 'object') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

/** Inline SVG icon from a path string. Icons are ours, never user data. */
export function icon(paths, { size = 20, width = 1.8, fill = 'none' } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', fill);
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(width));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;
  for (const d of [].concat(paths)) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

export const ICONS = {
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5l5 5 11-11',
  minus: 'M5 12h14',
  chevronRight: 'M9 5l7 7-7 7',
  chevronLeft: 'M15 5l-7 7 7 7',
  up: 'M12 19V5m0 0-6 6m6-6 6 6',
  down: 'M12 5v14m0 0 6-6m-6 6-6-6',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12',
  walk: 'M13 4.5a1.5 1.5 0 1 0 0-.01M11 21l1.5-6-2.5-2 1-5 3 2 2.5 1M9.5 12.5 8 16m6.5-2 2 7',
  scooter: 'M6 19a2.5 2.5 0 1 0 0-.01M18.5 19a2.5 2.5 0 1 0 0-.01M6 19h9l3-13h2.5',
  car: 'M5 17h14M6.5 17v1.5M17.5 17v1.5M4 13l1.7-4.6A2 2 0 0 1 7.6 7h8.8a2 2 0 0 1 1.9 1.4L20 13v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3Z',
  info: 'M12 16v-5M12 8h.01M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z',
  warn: 'M12 9v4m0 3h.01M10.3 3.9 2.5 17.4A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3.1L13.7 3.9a2 2 0 0 0-3.4 0Z',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z',
  pin: 'M12 21s7-5.6 7-11a7 7 0 1 0-14 0c0 5.4 7 11 7 11Z M12 10.5a1.5 1.5 0 1 0 0-.01',
  wand: 'M4 20 16 8M14 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z',
  star: 'M12 3.5 14.6 9l6 .9-4.3 4.2 1 6-5.3-2.8L6.7 20l1-6L3.4 9.9 9.4 9 12 3.5Z',
};

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function frag(children) {
  const f = document.createDocumentFragment();
  for (const c of [].concat(children)) if (c) f.append(c);
  return f;
}

let toastTimer = null;
export function toast(message) {
  const node = document.getElementById('toast');
  if (!node) return;
  node.textContent = message;
  node.classList.add('is-shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('is-shown'), 2600);
}

/** Slide a segmented control's indicator under the selected button. */
export function syncSegmented(root) {
  const thumb = root.querySelector('.segmented__thumb');
  const active = root.querySelector('[aria-selected="true"]');
  if (!thumb || !active) return;
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.transform = `translateX(${active.offsetLeft - 2}px)`;
}

export function wireSegmented(root, onChange) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('button[role="tab"], button[data-filter], button[data-scope]');
    if (!btn || !root.contains(btn)) return;
    root.querySelectorAll('button').forEach((b) =>
      b.setAttribute('aria-selected', String(b === btn)));
    syncSegmented(root);
    onChange(btn.dataset);
  });
  requestAnimationFrame(() => syncSegmented(root));
  window.addEventListener('resize', () => syncSegmented(root));
}

export const money = (n) =>
  n == null ? '—' : `$${Number(n).toFixed(2)}`;

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function prettyTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h < 12 || h === 24 ? 'am' : 'pm';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`;
}
