/* Route building: order, modes, timing and the itinerary. */

import { el, icon, ICONS, clear, toast, money } from '../lib/dom.js?v=e60178fd';
import { state, subscribe, pickedStops, moveStop, setOrder, togglePick, shareUrl } from '../lib/state.js?v=e60178fd';
import {
  MODES, routeItinerary, itinerarySummary, suggestMode, modeOptionsFor,
  legAdvisory, schedule, matrixKm, SCOOTER_PRICING,
} from '../lib/routing.js?v=e60178fd';
import { optimiseOrder, formatKm, formatMins } from '../lib/geo.js?v=e60178fd';
import { drawRoute, fitToStops, CLUSTER_COLOURS } from './stops.js?v=e60178fd';

let startAt = defaultStart();
let dwellMin = 20;
let partySize = 2;
let building = false;
let restale = false;

function defaultStart() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  if (d.getHours() < 9 || d.getHours() > 15) d.setHours(11);
  else d.setHours(d.getHours() + 1);
  return d;
}

const timeStr = (d) =>
  d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

const inputValue = (d) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/* ------------------------------------------------------------------ build */

export async function rebuildRoute() {
  const stops = pickedStops();
  if (stops.length < 2) {
    state.legs = [];
    drawRoute([]);
    render();
    return;
  }
  // Adding several stops quickly fires several rebuilds. Dropping the later
  // ones would leave the itinerary describing a route the user no longer has,
  // so the last request is queued and run once the current one finishes.
  if (building) { restale = true; return; }
  building = true;
  render();

  try {
    const modes = stops.slice(0, -1).map((s, i) =>
      state.legModes[i] ?? suggestMode(matrixKm(s, stops[i + 1], 'walk')));
    const legs = await routeItinerary(stops, modes);
    // Only publish if the selection has not moved on underneath us.
    if (!restale) {
      state.legs = legs;
      drawRoute(state.legs);
    }
  } catch (err) {
    console.error(err);
    toast('Could not work out the route. Showing estimates.');
  } finally {
    building = false;
    render();
    if (restale) { restale = false; await rebuildRoute(); }
  }
}

/* ------------------------------------------------------------------ parts */

function stopCard(stop, i, total, scheduled) {
  const problem = scheduled?.problem;
  const arrive = scheduled?.arrive;

  return el('div', { class: 'route-stop' }, [
    el('div', { style: { minWidth: 0 } }, [
      el('div', { class: 'row', style: { gap: 'var(--sp-2)' } }, [
        el('span', {
          class: 'stop-row__num',
          style: { background: CLUSTER_COLOURS[stop.cluster] ?? '#666', flexShrink: '0' },
          'aria-hidden': 'true',
        }, String(i + 1)),
        el('div', { style: { minWidth: 0 } }, [
          el('div', { class: 'list__title', text: stop.branch ? `${stop.name}, ${stop.branch}` : stop.name }),
          el('div', { class: 'list__sub' }, [
            arrive ? `Arrive ${timeStr(arrive)}` : stop.signature,
            problem ? el('span', {
              class: 'dot-shut',
              style: { fontWeight: '600' },
              text: problem === 'closed-by-then' ? '  ·  shut by then'
                : problem === 'not-open-yet' ? '  ·  not open yet'
                : '  ·  hours unknown',
            }) : null,
          ]),
        ]),
      ]),
    ]),
    el('div', { class: 'route-stop__ctrls' }, [
      el('button', {
        type: 'button', 'aria-label': `Move ${stop.name} earlier`,
        disabled: i === 0,
        onclick: () => { moveStop(i, i - 1); },
      }, icon(ICONS.up, { size: 18, width: 2 })),
      el('button', {
        type: 'button', 'aria-label': `Move ${stop.name} later`,
        disabled: i === total - 1,
        onclick: () => { moveStop(i, i + 1); },
      }, icon(ICONS.down, { size: 18, width: 2 })),
      el('button', {
        type: 'button', 'aria-label': `Remove ${stop.name}`,
        onclick: () => { togglePick(stop.id); toast(`Removed ${stop.name}`); },
      }, icon(ICONS.trash, { size: 18, width: 2 })),
    ]),
  ]);
}

function legCard(leg, i, stops) {
  const km = leg?.km ?? matrixKm(stops[i], stops[i + 1], 'walk');
  const options = modeOptionsFor(km);
  const advisory = leg ? legAdvisory(km, leg.minutes) : null;

  const optionButtons = options.map((modeId) => {
    const m = MODES[modeId];
    const active = (state.legModes[i] ?? leg?.mode ?? suggestMode(km)) === modeId;
    // Approximate the alternative from the matrix so both options show a time
    // before anything is fetched.
    const altKm = matrixKm(stops[i], stops[i + 1], modeId);
    const mins = active && leg
      ? leg.minutes
      : (altKm / m.fallbackKmh) * 60 + m.overheadMin;

    return el('button', {
      class: 'mode-opt', type: 'button', 'aria-pressed': String(active),
      onclick: () => {
        state.legModes[i] = modeId;
        rebuildRoute();
      },
    }, [
      el('span', { class: 'row', style: { gap: '5px' } }, [
        icon(ICONS[m.icon], { size: 15, width: 2 }),
        el('span', { class: 'mode-opt__label', text: m.label }),
      ]),
      el('span', { class: 'mode-opt__time', text: `${formatMins(mins)} · ${formatKm(altKm)}` }),
    ]);
  });

  return el('div', { class: 'leg' }, [
    el('div', { class: 'leg__rail' }, [
      el('div', { class: `leg__line${leg?.estimated ? ' leg__line--dashed' : ''}` }),
    ]),
    el('div', { class: 'leg__card' }, [
      el('div', { class: 'leg__summary footnote secondary' }, [
        leg
          ? `${formatMins(leg.minutes)} ${MODES[leg.mode].verb}, ${formatKm(leg.km)}`
          : 'Working it out…',
        leg?.estimated ? el('span', { class: 'badge', text: 'estimate' }) : null,
      ]),
      el('div', { class: 'mode-options' }, optionButtons),
      advisory ? el('p', { class: 'footnote secondary', style: { marginTop: 'var(--sp-2)' }, text: advisory }) : null,
    ]),
  ]);
}

function summaryCard(sum) {
  const cells = [
    [String(sum.stops), sum.stops === 1 ? 'stop' : 'stops'],
    [formatKm(sum.km), 'on the ground'],
    [formatMins(sum.totalMin), 'door to door'],
    [money(sum.totalCost), `for ${sum.partySize}`],
  ];
  return el('div', { class: 'card' }, [
    el('div', { class: 'summary-grid' }, cells.map(([v, l]) =>
      el('div', { class: 'summary-cell' }, [
        el('div', { class: 'summary-cell__val', text: v }),
        el('div', { class: 'summary-cell__lab', text: l }),
      ]))),
    el('div', {
      class: 'footnote secondary',
      style: { padding: '0 var(--sp-4) var(--sp-4)' },
      text: `${formatMins(sum.travelMin)} travelling, ${formatMins(sum.dwellMin)} in the shops ` +
            `at ${dwellMin} minutes each. Cookies about ${money(sum.cookieCost)}, ` +
            `scooters about ${money(sum.scooterCost)}.`,
    }),
  ]);
}

function controlsCard() {
  return el('div', { class: 'card card__pad stack', style: { '--gap': 'var(--sp-4)' } }, [
    el('div', { class: 'row row--between', style: { gap: 'var(--sp-4)' } }, [
      el('div', { style: { flex: '1' } }, [
        el('label', { class: 'form-label', for: 'start-time', text: 'Start at' }),
        el('input', {
          class: 'field', id: 'start-time', type: 'time', value: inputValue(startAt),
          onchange: (e) => {
            const [h, m] = e.target.value.split(':').map(Number);
            if (Number.isFinite(h)) { startAt.setHours(h, m || 0, 0, 0); render(); }
          },
        }),
      ]),
      el('div', { style: { flex: '1' } }, [
        el('label', { class: 'form-label', for: 'dwell', text: 'Minutes per stop' }),
        el('input', {
          class: 'field', id: 'dwell', type: 'number', min: '5', max: '90', step: '5',
          value: String(dwellMin),
          onchange: (e) => {
            const v = Number(e.target.value);
            if (v >= 5 && v <= 90) { dwellMin = v; render(); }
          },
        }),
      ]),
    ]),
    el('div', { class: 'row', style: { gap: 'var(--sp-2)' } }, [
      el('button', {
        class: 'btn btn--tinted', type: 'button', style: { flex: '1' },
        onclick: () => {
          const stops = pickedStops();
          if (stops.length < 3) { toast('Add at least three stops first.'); return; }
          const ordered = optimiseOrder(stops, { cost: (a, b) => matrixKm(a, b, 'walk') });
          setOrder(ordered.map((s) => s.id));
          toast('Reordered to cut the walking.');
        },
      }, [icon(ICONS.wand, { size: 18 }), 'Sort for me']),
      el('button', {
        class: 'btn btn--grey', type: 'button',
        onclick: async () => {
          const url = shareUrl();
          try {
            if (navigator.share) await navigator.share({ title: 'Our cookie route', url });
            else { await navigator.clipboard.writeText(url); toast('Link copied.'); }
          } catch { /* the user changed their mind, which is fine */ }
        },
      }, 'Share'),
    ]),
  ]);
}

/* ----------------------------------------------------------------- render */

export function render() {
  const host = document.getElementById('route-body');
  const sub = document.getElementById('route-sub');
  const count = document.getElementById('route-count');
  if (!host) return;
  clear(host);

  const stops = pickedStops();

  if (count) {
    count.hidden = stops.length === 0;
    count.textContent = String(stops.length);
  }

  if (!stops.length) {
    sub.textContent = 'Nothing picked yet.';
    host.append(el('div', { class: 'empty' }, [
      el('h3', { class: 'headline', text: 'No stops yet' }),
      el('p', { class: 'callout', text: 'Go to Stops and add a few. Two or more and I will work out how to get between them on foot and by scooter.' }),
      el('button', {
        class: 'btn btn--filled', type: 'button', style: { marginTop: 'var(--sp-5)' },
        onclick: () => document.querySelector('[data-view="map"]').click(),
      }, 'Pick some stops'),
    ]));
    return;
  }

  sub.textContent = stops.length === 1
    ? 'One stop. Add another and I will route between them.'
    : `${stops.length} stops, in this order.`;

  const scheduled = schedule(stops, state.legs, startAt, { minutesPerStop: dwellMin });
  const problems = scheduled.filter((s) => s.problem === 'closed-by-then' || s.problem === 'not-open-yet');

  host.append(el('div', { class: 'pad', style: { marginBottom: 'var(--sp-4)' } }, controlsCard()));

  if (state.legs.length) {
    host.append(el('div', { class: 'pad', style: { marginBottom: 'var(--sp-4)' } },
      summaryCard(itinerarySummary(state.legs, stops, { minutesPerStop: dwellMin, partySize }))));
  }

  if (problems.length) {
    host.append(el('div', { class: 'pad', style: { marginBottom: 'var(--sp-4)' } },
      el('div', { class: 'notice notice--warn' }, [
        icon(ICONS.warn, { size: 18 }),
        el('span', {}, [
          problems.length === 1
            ? `${problems[0].stop.name} is a problem at this start time: `
            : `${problems.length} stops are a problem at this start time: `,
          problems.map((p) =>
            `${p.stop.name} ${p.problem === 'closed-by-then' ? 'will have shut' : 'is not open yet'}`
          ).join(', '),
          '. Try a different start time or reorder.',
        ]),
      ])));
  }

  const list = el('div', { class: 'pad' });
  stops.forEach((stop, i) => {
    list.append(stopCard(stop, i, stops.length, scheduled[i]));
    if (i < stops.length - 1) list.append(legCard(state.legs[i], i, stops));
  });
  host.append(list);

  const anyEstimated = state.legs.some((l) => l.estimated);
  host.append(el('div', { class: 'pad', style: { marginTop: 'var(--sp-4)', paddingBottom: 'var(--sp-10)' } },
    el('div', { class: 'notice' }, [
      icon(ICONS.info, { size: 18 }),
      el('span', {
        text: anyEstimated
          ? 'Some legs are straight-line estimates because the routing service did not answer. Distances shown as estimates will be longer in reality.'
          : `Walking and cycling times come from OpenStreetMap road data. Scooter times are the ` +
            `cycling route plus ${MODES.scooter.overheadMin} minutes to find and unlock one, and ` +
            `cost about $${SCOOTER_PRICING.unlock.toFixed(2)} to unlock plus ` +
            `$${SCOOTER_PRICING.perMinute.toFixed(2)} a minute, each.`,
      }),
    ])));
}

/* ------------------------------------------------------------------ setup */

export function initRouteView() {
  document.getElementById('share-route')?.addEventListener('click', async () => {
    const url = shareUrl();
    try {
      if (navigator.share) await navigator.share({ title: 'Our cookie route', url });
      else { await navigator.clipboard.writeText(url); toast('Link copied.'); }
    } catch { /* dismissed */ }
  });

  subscribe((reason) => {
    if (reason === 'picked') {
      rebuildRoute();
      const stops = pickedStops();
      if (stops.length) fitToStops(stops);
    }
  });
}
