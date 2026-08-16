/* Results: rankings, factor breakdowns, disagreements and movement over time. */

import { el, icon, ICONS, clear, wireSegmented, money } from '../lib/dom.js';
import { state, subscribe, stopById } from '../lib/state.js';
import { FACTORS } from '../lib/storage.js';

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function labelFor(stopId, itemId) {
  const stop = stopById(stopId);
  const item = stop?.menu.find((m) => m.id === itemId);
  return {
    stop: stop ? (stop.branch ? `${stop.name}, ${stop.branch}` : stop.name) : stopId,
    item: item?.name ?? itemId,
    cluster: stop?.cluster,
  };
}

/**
 * Group current scores by menu item and rank them with a shrunk mean. A raw
 * average is useless on small samples: one enthusiastic 9 would outrank ten
 * honest 8.6s. Pulling each item toward the overall mean in proportion to how
 * little data it has makes a top position something you have to earn twice.
 */
function rank(ratings, itemType) {
  const rows = ratings.filter((r) => r.item_type === itemType);
  if (!rows.length) return { items: [], global: 0 };

  const global = mean(rows.map((r) => Number(r.total_score)));
  const prior = state.rubric?.ranking?.priorWeight ?? 3;
  const byItem = new Map();

  for (const r of rows) {
    const key = `${r.stop_id}:${r.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(r);
  }

  const items = [...byItem.entries()].map(([key, list]) => {
    const totals = list.map((r) => Number(r.total_score));
    const raw = mean(totals);
    const n = list.length;
    const prices = list.map((r) => Number(r.price_paid)).filter((p) => p > 0);
    const values = list.map((r) => Number(r.value_index)).filter(Number.isFinite);
    return {
      key,
      stopId: list[0].stop_id,
      itemId: list[0].item_id,
      n,
      raw,
      adjusted: (n * raw + prior * global) / (n + prior),
      recipe: mean(list.map((r) => Number(r.recipe_score)).filter(Number.isFinite)),
      value: values.length ? mean(values) : null,
      price: prices.length ? mean(prices) : null,
      factors: Object.fromEntries(
        FACTORS[itemType].map((f) => [f, mean(list.map((r) => Number(r[f])).filter(Number.isFinite))])),
      ratings: list,
    };
  });

  items.sort((a, b) => b.adjusted - a.adjusted);
  return { items, global };
}

/* ------------------------------------------------------------------ parts */

function factorBars(item, itemType) {
  const rubric = state.rubric.rubrics[itemType === 'cookie' ? 'cookie' : 'general'];
  return el('div', { style: { padding: 'var(--sp-3) var(--sp-4) var(--sp-4)' } },
    rubric.factors.map((f) => {
      const v = item.factors[f.id] ?? 0;
      return el('div', { class: 'factor-bar' }, [
        el('span', { class: 'factor-bar__name', text: f.name }),
        el('span', { class: 'meter' }, el('span', {
          class: 'meter__fill', style: { width: `${(v / 10) * 100}%` },
        })),
        el('span', { class: 'factor-bar__val tabular', text: v.toFixed(1) }),
      ]);
    }));
}

function rankRow(item, i, itemType) {
  const { stop, item: itemName } = labelFor(item.stopId, item.itemId);
  const thin = item.n < (state.rubric?.ranking?.minScoresForBadge ?? 3);

  const details = el('div', { hidden: true });
  const row = el('button', {
    class: 'rank-row', type: 'button', 'aria-expanded': 'false',
    onclick: () => {
      const open = details.hidden;
      details.hidden = !open;
      row.setAttribute('aria-expanded', String(open));
      if (open && !details.childElementCount) {
        details.append(factorBars(item, itemType));
        if (item.ratings.some((r) => r.notes)) {
          details.append(el('div', { style: { padding: '0 var(--sp-4) var(--sp-4)' } },
            item.ratings.filter((r) => r.notes).map((r) =>
              el('p', { class: 'note-quote' }, [
                el('span', { text: r.notes }),
                el('span', { class: 'tertiary', text: `  — ${r.taster_name}` }),
              ]))));
        }
      }
    },
  }, [
    el('span', { class: `rank-row__pos${i === 0 ? ' rank-row__pos--1' : ''}`, text: String(i + 1) }),
    el('span', { style: { minWidth: 0 } }, [
      el('span', { class: 'rank-row__name', style: { display: 'block' }, text: itemName }),
      el('span', { class: 'rank-row__sub', style: { display: 'block' } }, [
        stop,
        `  ·  ${item.n} ${item.n === 1 ? 'score' : 'scores'}`,
        thin ? el('span', { class: 'tertiary', text: '  ·  thin data' }) : null,
        item.value ? `  ·  ${item.value.toFixed(1)}/$` : null,
      ]),
    ]),
    el('span', {}, [
      el('span', { class: 'rank-row__score', style: { display: 'block' }, text: item.adjusted.toFixed(1) }),
      el('span', { class: 'rank-row__raw', style: { display: 'block' }, text: `raw ${item.raw.toFixed(1)}` }),
    ]),
  ]);

  return el('div', {}, [row, details]);
}

/** Where two tasters most disagree about the same thing. */
function disagreements(ratings) {
  const byItem = new Map();
  for (const r of ratings) {
    const key = `${r.stop_id}:${r.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(r);
  }
  const rows = [];
  for (const [key, list] of byItem) {
    if (list.length < 2) continue;
    const totals = list.map((r) => Number(r.total_score));
    const spread = Math.max(...totals) - Math.min(...totals);
    if (spread < 1) continue;
    rows.push({ key, list, spread, stopId: list[0].stop_id, itemId: list[0].item_id });
  }
  rows.sort((a, b) => b.spread - a.spread);
  return rows.slice(0, 6);
}

function disagreementRow(d) {
  const { stop, item } = labelFor(d.stopId, d.itemId);
  const totals = d.list.map((r) => Number(r.total_score));
  const lo = Math.min(...totals, 0);
  const hi = Math.max(...totals, 100);
  const span = Math.max(1, hi - lo);

  return el('div', { class: 'disagree-row' }, [
    el('div', { class: 'row row--between' }, [
      el('span', {}, [
        el('span', { class: 'list__title', style: { display: 'block' }, text: item }),
        el('span', { class: 'list__sub', style: { display: 'block' }, text: stop }),
      ]),
      el('span', { class: 'rank-row__score', text: `${d.spread.toFixed(1)} apart` }),
    ]),
    el('div', { class: 'disagree-bar' }, [
      el('span', { class: 'disagree-bar__track' }),
      ...d.list.map((r, i) => el('span', {
        class: 'disagree-bar__pt',
        style: {
          left: `${((Number(r.total_score) - lo) / span) * 100}%`,
          background: i === 0 ? 'var(--tint)' : 'var(--label-2)',
        },
        title: `${r.taster_name}: ${Number(r.total_score).toFixed(1)}`,
      })),
    ]),
    el('div', { class: 'disagree-bar__scale' }, [
      el('span', { text: '0' }), el('span', { text: '100' }),
    ]),
    el('div', { class: 'footnote tertiary', style: { marginTop: '2px' } },
      d.list.map((r) => `${r.taster_name} ${Number(r.total_score).toFixed(1)}`).join('  ·  ')),
  ]);
}

/** A tiny line of how an item's average moved as scores arrived. */
function sparkline(points) {
  const w = 260;
  const h = 40;
  if (points.length < 2) return null;
  const xs = points.map((_, i) => (i / (points.length - 1)) * w);
  const lo = Math.min(...points) - 2;
  const hi = Math.max(...points) + 2;
  const span = Math.max(1, hi - lo);
  const ys = points.map((p) => h - ((p - lo) / span) * h);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--tint)');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(path);

  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', String(xs.at(-1)));
  dot.setAttribute('cy', String(ys.at(-1)));
  dot.setAttribute('r', '3');
  dot.setAttribute('fill', 'var(--tint)');
  svg.appendChild(dot);
  return svg;
}

function historySection(history) {
  const byItem = new Map();
  for (const e of history) {
    const key = `${e.stop_id}:${e.item_id}`;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(e);
  }

  const rows = [];
  for (const [key, events] of byItem) {
    if (events.length < 2) continue;
    const running = [];
    let sum = 0;
    events.forEach((e, i) => { sum += Number(e.total_score); running.push(sum / (i + 1)); });
    const { stop, item } = labelFor(events[0].stop_id, events[0].item_id);
    const delta = running.at(-1) - running[0];
    rows.push(el('div', { class: 'history-row' }, [
      el('div', { class: 'row row--between' }, [
        el('span', {}, [
          el('span', { class: 'list__title', style: { display: 'block' }, text: item }),
          el('span', { class: 'list__sub', style: { display: 'block' },
            text: `${stop}  ·  ${events.length} scores` }),
        ]),
        el('span', { class: 'rank-row__score', text: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` }),
      ]),
      sparkline(running),
    ]));
  }
  return rows;
}

/* ----------------------------------------------------------------- render */

export function render() {
  const host = document.getElementById('results-body');
  if (!host) return;
  clear(host);

  const ratings = state.ratings;

  if (!ratings.length) {
    host.append(el('div', { class: 'empty' }, [
      el('h3', { class: 'headline', text: 'Nothing scored yet' }),
      el('p', { class: 'callout', text: 'Score a cookie and the rankings turn up here, along with the factor breakdowns and wherever the two of you disagree most.' }),
      el('button', {
        class: 'btn btn--filled', type: 'button', style: { marginTop: 'var(--sp-5)' },
        onclick: () => document.querySelector('[data-view="score"]').click(),
      }, 'Score something'),
    ]));
    return;
  }

  const cookies = rank(ratings, 'cookie');
  const others = rank(ratings, 'other');

  if (cookies.items.length) {
    host.append(el('h2', { class: 'section-header', text: 'Chocolate chip ranking' }));
    host.append(el('div', { class: 'pad' },
      el('div', { class: 'card' }, cookies.items.map((it, i) => rankRow(it, i, 'cookie')))));
    host.append(el('p', { class: 'pad footnote tertiary', style: { marginTop: 'var(--sp-2)' },
      text: `Ranked on a shrunk mean: each average is pulled toward the overall ${cookies.global.toFixed(1)} ` +
            `in proportion to how few scores it has, so one enthusiastic 9 does not take the top spot. ` +
            `Tap a row for the factor breakdown.` }));
  }

  if (others.items.length) {
    host.append(el('h2', { class: 'section-header', text: 'Everything else' }));
    host.append(el('div', { class: 'pad' },
      el('div', { class: 'card' }, others.items.map((it, i) => rankRow(it, i, 'other')))));
    host.append(el('p', { class: 'pad footnote tertiary', style: { marginTop: 'var(--sp-2)' },
      text: 'Scored on the four factor general rubric and kept separate, because a cortado has no business being ranked on salt balance.' }));
  }

  const dis = disagreements(ratings);
  if (dis.length) {
    host.append(el('h2', { class: 'section-header', text: 'Where you disagree' }));
    host.append(el('div', { class: 'pad' },
      el('div', { class: 'card' }, dis.map(disagreementRow))));
    host.append(el('p', { class: 'pad footnote tertiary', style: { marginTop: 'var(--sp-2)' },
      text: 'The interesting arguments are here. Open the same item in the ranking above to see which factor you actually split on.' }));
  }

  const hist = historySection(state.history ?? []);
  if (hist.length) {
    host.append(el('h2', { class: 'section-header', text: 'How averages moved' }));
    host.append(el('div', { class: 'pad' }, el('div', { class: 'card' }, hist)));
    host.append(el('p', { class: 'pad footnote tertiary', style: { marginTop: 'var(--sp-2)' },
      text: 'Running average after each score. Scores are never overwritten, so re-scoring a cookie adds to this line rather than erasing it.' }));
  }

  host.append(el('div', { style: { height: 'var(--sp-12)' } }));
}

export function initResultsView() {
  wireSegmented(document.getElementById('results-filter'), async ({ scope }) => {
    state.resultsScope = scope;
    await refresh();
  });
  subscribe((reason) => { if (reason === 'ratings') render(); });
}

export async function refresh() {
  if (!state.store) return;
  try {
    state.ratings = await state.store.listRatings({ scope: state.resultsScope });
    state.history = await state.store.listHistory({ scope: state.resultsScope });
  } catch (err) {
    console.error(err);
    state.ratings = [];
    state.history = [];
  }
  render();
}
