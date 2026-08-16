/* Scoring: pick a stop, pick an item, score it against the anchored rubric. */

import { el, icon, ICONS, clear, toast, money } from '../lib/dom.js?v=e60178fd';
import { state, subscribe, emit, stopById } from '../lib/state.js?v=e60178fd';
import { totalScore, recipeScore, requestPersistence } from '../lib/storage.js?v=e60178fd';
import { CLUSTER_COLOURS } from './stops.js?v=e60178fd';

let draft = null;

function rubricFor(itemType) {
  return state.rubric.rubrics[itemType === 'other' ? 'general' : 'cookie'];
}

/** Nearest written anchor at or below the score, so every value says something. */
function anchorText(factor, value) {
  const keys = Object.keys(factor.anchors).map(Number).sort((a, b) => a - b);
  let chosen = keys[0];
  let exact = false;
  for (const k of keys) {
    if (k === value) { chosen = k; exact = true; break; }
    if (k < value) chosen = k;
  }
  const text = factor.anchors[String(chosen)];
  return exact ? text : `Between the written marks. Closest: ${text}`;
}

/* ------------------------------------------------------------ pick screens */

function renderPickStop(host) {
  host.append(el('header', { class: 'hero-title' }, [
    el('h1', { class: 'large-title', text: 'Score a cookie' }),
    el('p', { class: 'callout secondary', text: "Pick where you are. Six factors, written marks for each, so two people's numbers actually mean the same thing." }),
  ]));

  const picked = state.picked.map(stopById).filter(Boolean);
  const rest = state.stops.filter((s) => !state.picked.includes(s.id));

  const section = (title, stops) => stops.length ? [
    el('h2', { class: 'section-header', text: title }),
    el('div', { class: 'pick-grid' }, stops.map((stop) =>
      el('button', {
        class: 'stop-row', type: 'button',
        onclick: () => { state.scoring = { stopId: stop.id, itemId: null }; render(); },
      }, [
        el('span', {
          class: 'stop-row__num', 'aria-hidden': 'true',
          style: { background: CLUSTER_COLOURS[stop.cluster] ?? '#666' },
        }, ''),
        el('span', { style: { minWidth: 0, textAlign: 'left' } }, [
          el('span', { class: 'stop-row__name', style: { display: 'block' } },
            stop.branch ? `${stop.name}, ${stop.branch}` : stop.name),
          el('span', { class: 'stop-row__sig', style: { display: 'block' }, text: stop.signature }),
        ]),
        el('span', { class: 'list__chevron' }, icon(ICONS.chevronRight, { size: 18, width: 2 })),
      ]))),
  ] : [];

  host.append(...section('On your route', picked), ...section('Everywhere else', rest));
}

function renderPickItem(host, stop) {
  host.append(el('div', { class: 'score-head' }, [
    el('h2', { text: stop.branch ? `${stop.name}, ${stop.branch}` : stop.name }),
    el('p', { text: 'What are you eating?' }),
  ]));

  host.append(el('div', { class: 'pad' }, el('div', { class: 'card' },
    stop.menu.map((item) => el('button', {
      class: 'menu-item', type: 'button',
      onclick: () => { state.scoring = { stopId: stop.id, itemId: item.id }; render(); },
    }, [
      el('span', {}, [
        el('span', { class: 'list__title', text: item.name }),
        item.primary ? el('span', { class: 'badge', style: { marginLeft: '8px' } }, 'The one') : null,
        el('span', { class: 'list__sub', text: item.type === 'cookie' ? 'Scored on the cookie rubric' : 'Scored on the general rubric' }),
      ]),
      el('span', { class: 'menu-item__price', text: money(item.priceUSD) }),
    ])))));

  host.append(el('div', { class: 'pad', style: { marginTop: 'var(--sp-4)' } },
    el('button', {
      class: 'btn btn--grey btn--full', type: 'button',
      onclick: () => {
        toast(`Noted: nothing doing at ${stop.name} today.`);
        state.scoring = null;
        render();
      },
    }, 'They had none today')));
}

/* -------------------------------------------------------------- score form */

function renderForm(host, stop, item) {
  const rubric = rubricFor(item.type);
  const factors = rubric.factors;

  if (!draft || draft.key !== `${stop.id}:${item.id}`) {
    const mine = state.ratings.find(
      (r) => r.taster_id === state.taster?.id && r.stop_id === stop.id && r.item_id === item.id);
    draft = {
      key: `${stop.id}:${item.id}`,
      // Unset, not 5. Every factor starting at a valid midpoint meant a tired
      // thumb on cookie four could press Save without judging anything and
      // record a plausible 50.0 that is indistinguishable from real tasting.
      scores: Object.fromEntries(factors.map((f) => [f.id, mine?.[f.id] ?? null])),
      // Blank, not the catalogue price: pre-filling it puts a number the user
      // never checked into the value index.
      pricePaid: mine?.price_paid ?? '',
      notes: mine?.notes ?? '',
      rescoring: Boolean(mine),
    };
  }

  host.append(el('div', { class: 'score-head' }, [
    el('h2', { text: item.name }),
    el('p', { text: `${stop.branch ? `${stop.name}, ${stop.branch}` : stop.name} · ${rubric.label}` }),
  ]));

  if (draft.rescoring) {
    host.append(el('div', { class: 'pad', style: { marginBottom: 'var(--sp-4)' } },
      el('div', { class: 'notice' }, [
        icon(ICONS.info, { size: 18 }),
        el('span', { text: 'You have scored this before. Saving adds a new score rather than replacing the old one, so the history stays intact.' }),
      ])));
  }

  for (const factor of factors) {
    const current = draft.scores[factor.id];
    const valueNode = el('span', {
      class: 'score-row__val',
      text: current == null ? '–' : String(current),
      style: current == null ? { color: 'var(--label-4)' } : {},
    });
    const anchorNode = el('p', {
      class: 'score-row__anchor',
      id: `f-${factor.id}-anchor`,
      text: current == null ? factor.prompt : anchorText(factor, current),
    });

    /* Ten chips rather than a slider. Dragging a 6px track precisely, one
       handed, holding a cookie, is the wrong ask; a chip is a 44pt tap. It
       also lets "not answered yet" be a real state, which a slider cannot
       represent because it always has a value. */
    const chips = el('div', {
      class: 'chips', role: 'radiogroup',
      'aria-label': `${factor.name}, 1 to 10`,
      'aria-describedby': `f-${factor.id}-anchor`,
    });

    for (let v = 1; v <= 10; v++) {
      chips.append(el('button', {
        class: 'chip', type: 'button', role: 'radio',
        'aria-checked': String(current === v),
        'aria-label': `${factor.name} ${v} of 10`,
        onclick: () => {
          draft.scores[factor.id] = v;
          valueNode.textContent = String(v);
          valueNode.style.color = '';
          anchorNode.textContent = anchorText(factor, v);
          chips.querySelectorAll('.chip').forEach((c, i) =>
            c.setAttribute('aria-checked', String(i + 1 === v)));
          updateTotal();
        },
      }, String(v)));
    }

    host.append(el('div', { class: 'card factor-card' }, [
      el('div', { class: 'score-row' }, [
        el('div', { class: 'score-row__head' }, [
          el('span', { class: 'headline', text: factor.name }),
          valueNode,
        ]),
        el('p', { class: 'footnote tertiary', style: { marginTop: '2px' }, text: factor.short }),
        chips,
        anchorNode,
      ]),
    ]));
  }

  host.append(el('div', { class: 'pad stack', style: { '--gap': 'var(--sp-4)', marginTop: 'var(--sp-2)' } }, [
    el('div', {}, [
      el('label', { class: 'form-label', for: 'price-paid', text: 'What did you pay?' }),
      el('input', {
        class: 'field', id: 'price-paid', type: 'number', min: '0', max: '200', step: '0.25',
        inputmode: 'decimal', value: String(draft.pricePaid ?? ''),
        placeholder: item.priceUSD ? `usually ${money(item.priceUSD)}` : 'optional',
        oninput: (e) => { draft.pricePaid = e.target.value; },
      }),
      el('p', { class: 'footnote secondary', style: { marginTop: 'var(--sp-1)' },
        text: 'Kept out of the score. Used only for points per dollar, which is shown separately.' }),
    ]),
    el('div', {}, [
      el('label', { class: 'form-label', for: 'notes', text: 'Notes' }),
      el('textarea', {
        class: 'field', id: 'notes', maxlength: '500', rows: '3',
        placeholder: 'The bit you will forget by the third stop.',
        'aria-describedby': 'notes-help',
        oninput: (e) => { draft.notes = e.target.value; },
      }, draft.notes),
      el('p', { class: 'footnote secondary', id: 'notes-help', style: { marginTop: 'var(--sp-1)' },
        text: 'Shown on the results page next to your name. Anyone who can see the leaderboard can read it.' }),
    ]),
  ]));

  const totalNode = el('div', { class: 'running-total__val' });
  const labelNode = el('div', { class: 'running-total__lab' });

  const saveBtn = el('button', { class: 'btn btn--filled', type: 'button' },
    draft.rescoring ? 'Save new score' : 'Save score');

  function updateTotal() {
    const unanswered = factors.filter((f) => draft.scores[f.id] == null);
    if (unanswered.length) {
      totalNode.textContent = '–';
      totalNode.style.color = 'var(--label-4)';
      labelNode.textContent = unanswered.length === 1
        ? `${unanswered[0].name.toLowerCase()} still to go`
        : `${unanswered.length} factors still to go`;
      saveBtn.disabled = true;
      return;
    }
    const t = totalScore(draft.scores, item.type);
    const r = recipeScore(draft.scores, item.type);
    totalNode.textContent = t.toFixed(1);
    totalNode.style.color = '';
    labelNode.textContent = `out of 100 · recipe score ${r.toFixed(1)}`;
    saveBtn.disabled = false;
  }

  saveBtn.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const saved = await state.store.saveRating({
        stopId: stop.id,
        itemId: item.id,
        itemType: item.type,
        scores: draft.scores,
        pricePaid: draft.pricePaid,
        notes: draft.notes,
      });
      requestPersistence();
      draft = null;
      state.scoring = null;
      toast(saved?.pending
        ? `Saved ${item.name} on this phone. It will sync when you have signal.`
        : `Scored ${item.name}.`);
      emit('rated');
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });

  updateTotal();

  host.append(el('div', { class: 'running-total material' }, [
    el('div', {}, [totalNode, labelNode]),
    saveBtn,
  ]));

  host.append(el('div', { class: 'pad', style: { padding: 'var(--sp-4) var(--margin) var(--sp-10)' } },
    el('p', { class: 'footnote tertiary', text: state.rubric.notes[3] })));
}

/* ----------------------------------------------------------------- render */

export function render() {
  const host = document.getElementById('score-body');
  const back = document.getElementById('score-back');
  if (!host || !state.rubric) return;
  clear(host);

  if (!state.taster) {
    host.append(el('div', { class: 'empty' }, [
      el('h3', { class: 'headline', text: 'Who is tasting?' }),
      el('p', { class: 'callout', text: 'Put a name in first, so your scores stay yours and the two of you can compare afterwards.' }),
      el('button', {
        class: 'btn btn--filled', type: 'button', style: { marginTop: 'var(--sp-5)' },
        onclick: () => document.querySelector('[data-view="settings"]').click(),
      }, 'Add your name'),
    ]));
    back.hidden = true;
    return;
  }

  const stop = state.scoring?.stopId ? stopById(state.scoring.stopId) : null;
  const item = stop && state.scoring?.itemId
    ? stop.menu.find((m) => m.id === state.scoring.itemId)
    : null;

  back.hidden = !stop;
  back.onclick = () => {
    if (item) state.scoring = { stopId: stop.id, itemId: null };
    else state.scoring = null;
    draft = null;
    render();
  };

  if (!stop) renderPickStop(host);
  else if (!item) renderPickItem(host, stop);
  else renderForm(host, stop, item);

  document.getElementById('score-scroll').scrollTop = 0;
}

export function initScoreView() {
  subscribe((reason) => {
    if (reason === 'scoring' || reason === 'rated' || reason === 'taster') {
      if (reason !== 'scoring') draft = null;
      render();
    }
  });
}
