/* Boot: load data, wire the shell, hand off to the views. */

import { initTheme, applyTheme } from './themes.js?v=ad58b25f';
import { toast } from './lib/dom.js?v=ad58b25f';
import { state, emit, subscribe, readHash, restorePicks, readPartyFromHash } from './lib/state.js?v=ad58b25f';
import { createStore } from './lib/storage.js?v=ad58b25f';
import { loadMatrix } from './lib/routing.js?v=ad58b25f';
import { initMap, initStopsView, renderStopList, renderMarkers, hideDetail, fitToStops, renderPicker, initPickerView } from './views/stops.js?v=ad58b25f';
import { initRouteView, rebuildRoute, render as renderRoute } from './views/route.js?v=ad58b25f';
import { initScoreView, render as renderScore } from './views/score.js?v=ad58b25f';
import { initResultsView, refresh as refreshResults } from './views/results.js?v=ad58b25f';
import { initSettingsView, render as renderSettings } from './views/settings.js?v=ad58b25f';

initTheme();

/* ------------------------------------------------------------------- tabs */

function initTabs() {
  const tabs = [...document.querySelectorAll('.tabbar button[data-view]')];
  const views = new Map(tabs.map((t) => [t.dataset.view, document.getElementById(`view-${t.dataset.view}`)]));

  function show(name) {
    state.view = name;
    for (const tab of tabs) {
      const on = tab.dataset.view === name;
      tab.setAttribute('aria-selected', String(on));
      const view = views.get(tab.dataset.view);
      view.hidden = !on;
      view.classList.toggle('is-active', on);
    }
    if (name === 'pick') renderPicker();
    if (name === 'route') renderRoute();
    if (name === 'score') renderScore();
    if (name === 'results') refreshResults();
    if (name === 'settings') renderSettings();
    if (name === 'map') setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
    emit('view');
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => show(tab.dataset.view));
    tab.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(tab);
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        next.click();
      }
    });
  }
  return show;
}

/* --------------------------------------------------- bottom sheet detents */

/*
 * Three heights, dragged by the grip. Pointer Events rather than the HTML5
 * drag API, which does not fire on touch in iOS Safari at all. Release picks
 * the nearest detent with a nudge from how fast you were moving, so a quick
 * flick goes further than a slow drag of the same distance.
 *
 * This is not a modal: the map stays live behind it, so focus is deliberately
 * not trapped. Escape collapses it, and the grip is a real slider you can
 * drive from the keyboard.
 */
function initSheet() {
  const sheet = document.getElementById('stop-sheet');
  const grip = document.getElementById('sheet-grip');
  const scroll = document.getElementById('sheet-scroll');
  if (!sheet || !grip) return;

  const NAMES = ['peek', 'medium', 'full'];
  let index = 1;
  let dragging = false;
  let startY = 0;
  let startPx = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;

  // Measured against the space the sheet can actually occupy: the viewport
  // less the tab bar it sits above. Using the wrong box here is how a sheet
  // ends up taller than the room it has.
  const detents = () => {
    const bar = document.querySelector('.tabbar')?.getBoundingClientRect().height ?? 0;
    const h = Math.max(240, window.innerHeight - bar);
    return [140, Math.round(h * 0.5), Math.round(h)];
  };

  function apply(px, animate = true) {
    sheet.classList.toggle('is-animating', animate);
    sheet.style.setProperty('--detent', `${px}px`);
  }

  function settle(i, animate = true) {
    index = Math.max(0, Math.min(2, i));
    apply(detents()[index], animate);
    sheet.classList.toggle('is-peek', index === 0);
    sheet.dataset.detent = NAMES[index];
    grip.setAttribute('aria-valuenow', String(index));
    grip.setAttribute('aria-valuetext', ['Collapsed', 'Half height', 'Full height'][index]);
  }

  grip.addEventListener('pointerdown', (e) => {
    if (window.matchMedia('(min-width: 900px)').matches) return;
    dragging = true;
    grip.setPointerCapture(e.pointerId);
    startY = lastY = e.clientY;
    lastT = performance.now();
    velocity = 0;
    startPx = detents()[index];
    sheet.classList.remove('is-animating');
  });

  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const dt = now - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = now;
    const px = Math.max(80, Math.min(detents()[2], startPx - (e.clientY - startY)));
    apply(px, false);
  });

  function end(e) {
    if (!dragging) return;
    dragging = false;
    try { grip.releasePointerCapture(e.pointerId); } catch { /* already gone */ }

    const current = startPx - (lastY - startY);
    const stops = detents();
    // A downward flick is positive velocity, and should push toward a lower detent.
    const projected = current - velocity * 180;
    let best = 0;
    let bestGap = Infinity;
    stops.forEach((px, i) => {
      const gap = Math.abs(px - projected);
      if (gap < bestGap) { bestGap = gap; best = i; }
    });
    settle(best);
  }

  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);

  grip.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); settle(index + 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); settle(index - 1); }
    if (e.key === 'Home') { e.preventDefault(); settle(0); }
    if (e.key === 'End') { e.preventDefault(); settle(2); }
  });

  grip.addEventListener('click', () => {
    if (window.matchMedia('(min-width: 900px)').matches) return;
    settle(index === 2 ? 0 : index + 1);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.view !== 'map') return;
    if (state.detailStopId) hideDetail();
    else settle(0);
  });

  scroll?.addEventListener('scroll', () => {
    if (index < 2 && scroll.scrollTop > 4) settle(2);
  });

  window.addEventListener('resize', () => apply(detents()[index], false));
  // Land on the opening detent without animating, so the sheet is simply
  // there on load rather than sliding up in front of the user.
  settle(1, false);
}

/* ------------------------------------------------------- collapsing titles */

function initScrollTitles() {
  for (const [scrollId, barId] of [
    ['sheet-scroll', null],
    ['route-scroll', 'route-navbar'],
    ['score-scroll', 'score-navbar'],
    ['results-scroll', 'results-navbar'],
    ['settings-scroll', 'settings-navbar'],
  ]) {
    if (!barId) continue;
    const scroll = document.getElementById(scrollId);
    const bar = document.getElementById(barId);
    if (!scroll || !bar) continue;
    scroll.addEventListener('scroll', () => {
      bar.classList.toggle('is-scrolled', scroll.scrollTop > 28);
    }, { passive: true });
  }
}

/* -------------------------------------------------- service worker + net */

/*
 * Offline is the normal case on this tour, not the exception: you are outdoors,
 * on cellular, walking between stops. The stop list, rubric, travel matrix and
 * interface are all cached, so only the live routing line and the shared
 * database actually need a signal.
 */
function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  // Escape hatch. If a worker ever ships broken, ?sw=off tears it down instead
  // of leaving people stuck on a bad build with no way to clear it.
  if (new URLSearchParams(location.search).has('sw')) {
    navigator.serviceWorker.getRegistrations().then(async (regs) => {
      for (const r of regs) {
        if (r.active) r.active.postMessage('unregister');
        await r.unregister();
      }
      toast('Offline support switched off. Reloading.');
      setTimeout(() => location.replace(location.pathname), 1200);
    });
    return;
  }

  // boot() is async, so by the time this runs the load event has usually
  // already fired, and a listener added afterwards never runs at all.
  const register = () => navigator.serviceWorker.register('sw.js').catch((err) => {
    console.warn('Service worker did not register:', err.message);
  });
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

function initNetworkStatus() {
  const show = () => {
    document.body.classList.toggle('is-offline', !navigator.onLine);
  };
  window.addEventListener('online', () => {
    show();
    toast('Back online.');
    if (state.view === 'results') refreshResults();
  });
  window.addEventListener('offline', () => {
    show();
    toast('Offline. Stops and your route still work; new scores will not sync.');
  });
  show();
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  const [stopsRes, rubricRes] = await Promise.all([
    fetch('data/stops.json'),
    fetch('data/rubric.json'),
  ]);
  if (!stopsRes.ok || !rubricRes.ok) throw new Error('Could not load the stop data.');

  const stopsData = await stopsRes.json();
  state.stops = stopsData.stops;
  state.clusters = stopsData.clusters;
  state.priceBands = stopsData.priceBands;
  state.rubric = await rubricRes.json();

  await loadMatrix();

  state.store = await createStore();
  state.taster = await state.store.getTaster();
  if (state.taster?.theme) applyTheme(state.taster.theme);

  const show = initTabs();
  initSheet();
  initScrollTitles();
  initServiceWorker();
  initNetworkStatus();

  initMap();
  initStopsView();
  initPickerView();
  initRouteView();
  initScoreView();
  initResultsView();
  initSettingsView();

  renderStopList();
  renderMarkers();
  fitToStops(state.stops);
  renderSettings();

  // A shared link wins over anything stored. Otherwise restore the last route,
  // or seed the waterfront five on a genuinely first visit.
  const shared = readHash();
  if (!shared) restorePicks();

  // An invite link carries the party. Joining is the whole point of opening it,
  // so do it before the first results read rather than making them find a
  // settings screen and type a code.
  const invited = readPartyFromHash();
  let joined = false;
  if (invited && state.store.mode === 'cloud' && state.store.partyCode !== invited) {
    try {
      if (!state.taster) {
        // join_party needs a taster row to attach to; name it once they save.
        await state.store.signIn('Guest', null);
        state.taster = await state.store.getTaster();
      }
      await state.store.joinParty(invited);
      joined = true;
    } catch (err) {
      console.warn('Could not join the party from the link:', err.message);
    }
  }

  // Always announce the selection, shared or restored. Without this the route
  // only ever built after you changed a pick, so a restored route sat on
  // "Working it out" forever.
  emit('picked');
  await rebuildRoute();

  if (shared) show('route');

  // One message, not two: the second toast used to overwrite the first inside
  // its own animation, so whoever opened an invite never learned they had
  // joined anything.
  if (joined && shared) toast('Joined their party and opened the route. Add your name in Setup.');
  else if (joined) toast('Joined the party. Add your name in Setup so they know who you are.');
  else if (shared) toast('Opened a shared route.');

  await refreshResults();

  subscribe(async (reason) => {
    if (reason === 'rated') await refreshResults();
  });

  if (state.store.degraded) {
    toast('Database unreachable. Scores are saving to this device.');
  }
}

boot().catch((err) => {
  console.error(err);
  const main = document.getElementById('main');
  if (main) {
    main.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    const h = document.createElement('h3');
    h.className = 'headline';
    h.textContent = 'Something did not load';
    const p = document.createElement('p');
    p.className = 'callout';
    p.textContent = `${err.message} Reload the page, and if it keeps happening the stop data may be missing.`;
    wrap.append(h, p);
    main.append(wrap);
  }
});
