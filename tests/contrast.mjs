/*
 * Contrast check across every theme.
 *
 *   node tests/contrast.mjs
 *
 * Ten themes is ten chances to ship an unreadable one. This parses themes.css
 * and checks the pairs that actually carry text, against WCAG 2.2 AA: 4.5:1
 * for body-sized text, 3:1 for large text and for the boundaries of
 * interactive controls.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'assets', 'css', 'themes.css'), 'utf8');

function parseThemes(text) {
  const themes = {};
  const blockRe = /\[data-theme="([^"]+)"\]\s*\{([^}]*)\}/g;
  let m;
  while ((m = blockRe.exec(text))) {
    const vars = {};
    for (const line of m[2].split(';')) {
      const kv = /--([\w-]+)\s*:\s*(.+)/.exec(line.trim());
      if (kv) vars[kv[1]] = kv[2].trim();
    }
    themes[m[1]] = vars;
  }
  return themes;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/* fg token, bg token, minimum, what it is used for */
const PAIRS = [
  ['label', 'bg', 4.5, 'body text on the page'],
  ['label', 'bg-elevated', 4.5, 'body text on cards'],
  ['label-2', 'bg', 4.5, 'secondary text on the page'],
  ['label-2', 'bg-elevated', 4.5, 'secondary text on cards'],
  ['label-3', 'bg', 4.5, 'captions and footnotes'],
  ['label-3', 'bg-elevated', 4.5, 'captions on cards'],
  ['tint', 'bg', 4.5, 'links and accent text'],
  ['tint', 'bg-elevated', 4.5, 'links on cards'],
  ['tint-ink', 'tint', 4.5, 'text inside filled buttons'],
  ['label-4', 'bg-elevated', 3.0, 'the sheet grip and chevrons'],
  ['separator-opaque', 'bg', 1.2, 'hairline separators'],
];

const themes = parseThemes(css);
const names = Object.keys(themes);
const failures = [];
let checks = 0;

for (const name of names) {
  const vars = themes[name];
  for (const [fgKey, bgKey, min, purpose] of PAIRS) {
    const fg = hexToRgb(vars[fgKey] ?? '');
    const bg = hexToRgb(vars[bgKey] ?? '');
    if (!fg || !bg) continue; // non-hex tokens such as rgba fills are skipped
    checks++;
    const r = ratio(fg, bg);
    if (r < min) {
      failures.push(
        `${name.padEnd(16)} --${fgKey} on --${bgKey}  ${r.toFixed(2)}:1 (needs ${min}:1)  — ${purpose}`
      );
    }
  }
}

console.log(`\n${names.length} themes, ${checks} contrast checks, ${failures.length} below target\n`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (!failures.length) console.log('  All themes meet WCAG AA on every text pair.\n');
process.exit(failures.length ? 1 : 0);
