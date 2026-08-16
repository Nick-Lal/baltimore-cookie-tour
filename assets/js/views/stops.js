/* Map, stop list and stop detail. */

import { el, icon, ICONS, clear, toast, wireSegmented, DAY_NAMES, prettyTime, money } from '../lib/dom.js?v=327f9624';
import { state, subscribe, emit, stopById, isPicked, togglePick } from '../lib/state.js?v=327f9624';
import { openAt } from '../lib/routing.js?v=327f9624';
import { boundsOf, haversineKm } from '../lib/geo.js?v=327f9624';

export const CLUSTER_COLOURS = {
  hampden: '#E4572E',
  'north-central': '#17858B',
  central: '#7A5FBF',
  'harbor-east': '#2E6FA8',
  'fells-point': '#1B856F',
  east: '#B5701F',
  'federal-hill': '#B33C63',
};

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
};
const ATTRIB =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

let map = null;
let tileLayer = null;
let markers = new Map();
let routeLayer = null;

/* ------------------------------------------------------------------- map */

function isDarkTheme() {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark');
}

export function initMap() {
  map = L.map('map', {
    center: [39.3035, -76.6098],
    zoom: 12,
    zoomControl: false,
    attributionControl: true,
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setTiles();

  document.addEventListener('themechange', () => setTiles());
  return map;
}

function setTiles() {
  const url = isDarkTheme() ? TILES.dark : TILES.light;
  if (tileLayer) {
    if (tileLayer._url === url) return;
    map.removeLayer(tileLayer);
  }
  tileLayer = L.tileLayer(url, { maxZoom: 19, attribution: ATTRIB, detectRetina: true });
  tileLayer.addTo(map);
  if (routeLayer) routeLayer.bringToFront();
}

function pinFor(stop) {
  const pickedAt = state.picked.indexOf(stop.id);
  const colour = CLUSTER_COLOURS[stop.cluster] ?? '#666';
  const label = pickedAt >= 0 ? String(pickedAt + 1) : '';
  const cls = ['pin', pickedAt >= 0 ? 'pin--selected' : ''].filter(Boolean).join(' ');
  const html =
    `<div class="${cls}" style="background:${colour}">${label}</div>`;
  return L.divIcon({ html, className: '', iconSize: [30, 30], iconAnchor: [15, 15] });
}

export function renderMarkers() {
  if (!map) return;
  const visible = filteredStops();
  const visibleIds = new Set(visible.map((s) => s.id));

  for (const [id, m] of markers) {
    if (!visibleIds.has(id)) {
      map.removeLayer(m);
      markers.delete(id);
    }
  }

  for (const stop of visible) {
    let m = markers.get(stop.id);
    if (!m) {
      m = L.marker([stop.lat, stop.lng], {
        icon: pinFor(stop),
        keyboard: true,
        title: stop.branch ? `${stop.name}, ${stop.branch}` : stop.name,
        alt: stop.branch ? `${stop.name}, ${stop.branch}` : stop.name,
      });
      m.on('click', () => showDetail(stop.id));
      m.addTo(map);
      markers.set(stop.id, m);
    } else {
      m.setIcon(pinFor(stop));
    }
  }
}

export function drawRoute(legs) {
  if (!map) return;
  if (routeLayer) { map.removeLayer(routeLayer); routeLayer = null; }
  if (!legs?.length) return;

  const groups = legs.map((leg) =>
    L.polyline(leg.shape, {
      color: getComputedStyle(document.documentElement).getPropertyValue('--tint').trim() || '#b4541f',
      weight: 5,
      opacity: leg.estimated ? 0.45 : 0.85,
      dashArray: leg.estimated ? '2 9' : null,
      lineCap: 'round',
      lineJoin: 'round',
    })
  );
  routeLayer = L.layerGroup(groups).addTo(map);
}

/*
 * Opt-in locate-me. Nothing asks for a location until the button is pressed,
 * and if permission is refused the control simply disappears rather than
 * leaving a dead button or an error on screen.
 */
let meMarker = null;
let meCircle = null;

export function locateMe(button) {
  if (!navigator.geolocation) {
    button?.remove();
    return;
  }
  button?.classList.add('is-busy');
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      button?.classList.remove('is-busy');
      const here = [coords.latitude, coords.longitude];
      if (meMarker) map.removeLayer(meMarker);
      if (meCircle) map.removeLayer(meCircle);

      // Leaflet writes SVG presentation attributes, so resolve the token to a
      // real colour rather than handing it a var() reference.
      const tint = getComputedStyle(document.documentElement)
        .getPropertyValue('--tint').trim() || '#b4541f';
      meCircle = L.circle(here, {
        radius: Math.max(20, coords.accuracy || 40),
        color: tint, weight: 1, fillOpacity: 0.12,
      }).addTo(map);
      meMarker = L.marker(here, {
        icon: L.divIcon({ html: '<div class="pin pin--me"></div>', className: '', iconSize: [18, 18], iconAnchor: [9, 9] }),
        title: 'Roughly where you are',
        alt: 'Roughly where you are',
        keyboard: false,
      }).addTo(map);

      const nearest = state.stops
        .map((s) => ({ s, km: haversineKm({ lat: coords.latitude, lng: coords.longitude }, s) }))
        .sort((a, b) => a.km - b.km)[0];
      map.setView(here, 15, { animate: true });
      if (nearest) {
        const mins = Math.round((nearest.km / 4.8) * 60);
        toast(`Nearest is ${nearest.s.name}, about ${mins} min on foot.`);
      }
    },
    (err) => {
      button?.classList.remove('is-busy');
      toast(err.code === err.PERMISSION_DENIED
        ? 'No location, no problem. Everything else still works.'
        : 'Could not work out where you are.');
      if (err.code === err.PERMISSION_DENIED) button?.remove();
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
  );
}

export function fitToStops(stops) {
  if (!map || !stops.length) return;
  if (stops.length === 1) {
    map.setView([stops[0].lat, stops[0].lng], 16, { animate: true });
  } else {
    map.fitBounds(boundsOf(stops), { padding: [40, 40], maxZoom: 16 });
  }
}

/* ---------------------------------------------------------------- filters */

function filteredStops() {
  const now = new Date();
  switch (state.filter) {
    case 'confirmed': return state.stops.filter((s) => s.confidence === 'confirmed');
    case 'open': return state.stops.filter((s) => openAt(s, now) === 'open');
    case 'picked': return state.stops.filter((s) => isPicked(s.id));
    default: return state.stops;
  }
}

/* ------------------------------------------------------------- stop rows */

function openBadge(stop) {
  const status = openAt(stop, new Date());
  const map = {
    open: ['dot-open', 'Open now'],
    closed: ['dot-shut', 'Closed now'],
    unknown: ['dot-unk', 'Hours unknown'],
  };
  const [cls, label] = map[status];
  return el('span', { class: 'badge' }, [
    el('span', { class: `badge__dot ${cls}` }),
    el('span', { text: label }),
  ]);
}

function confidenceBadge(stop) {
  const label = { confirmed: 'Confirmed', likely: 'Likely', rotating: 'Rotating' }[stop.confidence];
  return el('span', { class: `badge badge--${stop.confidence}`, title: confidenceTitle(stop.confidence) }, label);
}

function confidenceTitle(c) {
  return {
    confirmed: "A named chocolate chip cookie is on the shop's own menu.",
    likely: 'Reviews name a chocolate chip cookie, but the daily list rotates.',
    rotating: 'The bakery changes its list daily. Chocolate chip shows up some days.',
  }[c];
}

function stopRow(stop) {
  const picked = isPicked(stop.id);
  const position = state.picked.indexOf(stop.id);

  const addBtn = el('button', {
    class: 'stop-row__add',
    type: 'button',
    'aria-label': picked ? `Remove ${stop.name} from your route` : `Add ${stop.name} to your route`,
    'aria-pressed': String(picked),
    onclick: (e) => {
      e.stopPropagation();
      togglePick(stop.id);
      toast(picked ? `Removed ${stop.name}` : `Added ${stop.name}`);
    },
  }, icon(picked ? ICONS.check : ICONS.plus, { size: 24, width: 2.2 }));

  return el('div', {
    class: `stop-row${picked ? ' is-picked' : ''}`,
    dataset: { stop: stop.id },
  }, [
    el('span', {
      class: 'stop-row__num',
      style: { background: CLUSTER_COLOURS[stop.cluster] ?? '#666' },
      'aria-hidden': 'true',
    }, picked ? String(position + 1) : ''),
    el('button', {
      class: 'stop-row__body',
      type: 'button',
      style: { textAlign: 'left', minWidth: 0 },
      onclick: () => showDetail(stop.id),
    }, [
      el('div', { class: 'stop-row__name' }, [
        stop.name,
        stop.branch ? el('span', { class: 'stop-row__branch', text: `  ${stop.branch}` }) : null,
      ]),
      el('div', { class: 'stop-row__sig', text: stop.signature }),
      el('div', { class: 'stop-row__meta' }, [confidenceBadge(stop), openBadge(stop)]),
    ]),
    addBtn,
  ]);
}

export function renderStopList() {
  const host = document.getElementById('cluster-list');
  if (!host) return;
  clear(host);

  const visible = filteredStops();
  if (!visible.length) {
    host.append(el('div', { class: 'empty' }, [
      el('h3', { class: 'headline', text: 'Nothing matches that filter' }),
      el('p', { class: 'footnote', text: 'Try "All", or come back during opening hours.' }),
    ]));
    return;
  }

  for (const cluster of state.clusters) {
    const stops = visible.filter((s) => s.cluster === cluster.id);
    if (!stops.length) continue;
    host.append(el('section', { class: 'cluster' }, [
      el('header', { class: 'cluster__head' }, [
        el('div', { class: 'cluster__name', text: cluster.label }),
        el('div', { class: 'cluster__blurb', text: cluster.blurb }),
      ]),
      el('div', { class: 'cluster__stops' }, stops.map(stopRow)),
    ]));
  }
}

/* ------------------------------------------------------------ stop detail */

export function showDetail(stopId) {
  state.detailStopId = stopId;
  const stop = stopById(stopId);
  const list = document.getElementById('stop-list-panel');
  const panel = document.getElementById('stop-detail-panel');
  if (!stop || !panel) return;

  list.hidden = true;
  panel.hidden = false;
  clear(panel);

  const today = new Date().getDay();
  const picked = isPicked(stop.id);

  panel.append(el('div', { class: 'detail' }, [
    el('div', { class: 'detail__top' }, [
      el('button', {
        class: 'detail__back', type: 'button',
        onclick: () => hideDetail(),
      }, [icon(ICONS.chevronLeft, { size: 20, width: 2.2 }), el('span', { text: 'All stops' })]),
      el('h2', { text: stop.name }),
      stop.branch ? el('div', { class: 'detail__branch', text: stop.branch }) : null,
      el('div', { class: 'stop-row__meta', style: { marginTop: 'var(--sp-3)' } },
        [confidenceBadge(stop), openBadge(stop)]),
      el('p', { class: 'detail__blurb', text: stop.blurb }),

      el('dl', { class: 'detail__facts' }, [
        el('div', { class: 'detail__fact' }, [
          el('dt', { text: 'Address' }), el('dd', { text: stop.address }),
        ]),
        stop.phone ? el('div', { class: 'detail__fact' }, [
          el('dt', { text: 'Phone' }),
          el('dd', {}, el('a', { href: `tel:${stop.phone.replace(/[^\d+]/g, '')}`, text: stop.phone })),
        ]) : null,
        el('div', { class: 'detail__fact' }, [
          el('dt', { text: 'Typical price' }),
          el('dd', { text: state.priceBands?.[stop.priceBand] ?? '—' }),
        ]),
        stop.url ? el('div', { class: 'detail__fact' }, [
          el('dt', { text: 'Website' }),
          el('dd', {}, el('a', { href: stop.url, target: '_blank', rel: 'noopener noreferrer', text: 'Open' })),
        ]) : null,
      ]),

      el('div', { class: 'detail__actions' }, [
        el('button', {
          class: `btn ${picked ? 'btn--grey' : 'btn--filled'}`,
          type: 'button',
          onclick: () => { togglePick(stop.id); showDetail(stop.id); },
        }, picked ? 'On your route' : 'Add to route'),
        el('a', {
          class: 'btn btn--tinted',
          href: `https://www.openstreetmap.org/?mlat=${stop.lat}&mlon=${stop.lng}#map=18/${stop.lat}/${stop.lng}`,
          target: '_blank', rel: 'noopener noreferrer',
        }, 'Open in maps'),
      ]),
    ]),

    el('h3', { class: 'section-header', text: 'Opening hours' }),
    el('div', { class: 'pad' }, el('div', { class: 'card card__pad' },
      el('table', { class: 'hours-table' },
        el('tbody', {}, DAY_NAMES.map((day, i) => {
          const h = stop.hours[i];
          return el('tr', { class: i === today ? 'is-today' : '' }, [
            el('td', { text: day }),
            el('td', { text: h ? `${prettyTime(h.open)} to ${prettyTime(h.close)}` : 'Closed' }),
          ]);
        }))
      ))),

    el('h3', { class: 'section-header', text: 'Score something here' }),
    el('div', { class: 'pad' }, el('div', { class: 'card' },
      stop.menu.map((item) => el('button', {
        class: 'menu-item', type: 'button',
        onclick: () => {
          state.scoring = { stopId: stop.id, itemId: item.id };
          emit('scoring');
          document.querySelector('[data-view="score"]').click();
        },
      }, [
        el('span', {}, [
          el('span', { class: 'list__title', text: item.name }),
          item.primary ? el('span', { class: 'badge', style: { marginLeft: '8px' } }, 'The one') : null,
          el('span', { class: 'list__sub', text: item.note }),
        ]),
        el('span', { class: 'menu-item__price', text: money(item.priceUSD) }),
      ]))
    )),

    el('p', { class: 'pad footnote tertiary', style: { margin: 'var(--sp-4) 0 var(--sp-8)' } },
      'Prices are typical counter prices, not quotes. The scoring form asks what you actually paid.'),
  ]));

  document.getElementById('sheet-scroll').scrollTop = 0;
  if (map) map.panTo([stop.lat, stop.lng], { animate: true });
  renderMarkers();
}

export function hideDetail() {
  state.detailStopId = null;
  const list = document.getElementById('stop-list-panel');
  const panel = document.getElementById('stop-detail-panel');
  if (panel) { panel.hidden = true; clear(panel); }
  if (list) list.hidden = false;
}

/* ------------------------------------------------------------------ setup */

export function initStopsView() {
  // Counts come from the data, so editing stops.json can never leave the
  // interface claiming a number that is no longer true.
  const total = state.stops.length;
  const allTab = document.getElementById('filter-all');
  if (allTab) allTab.textContent = `All ${total}`;
  const intro = document.getElementById('stops-intro');
  if (intro) {
    const confirmed = state.stops.filter((s) => s.confidence === 'confirmed').length;
    intro.textContent =
      `${total} places in Baltimore worth arguing about, ${confirmed} of them with a chocolate ` +
      `chip cookie confirmed on the shop's own menu. Tap one to read it, add it to build a route.`;
  }

  const locateBtn = document.getElementById('locate-me');
  locateBtn?.addEventListener('click', () => locateMe(locateBtn));

  wireSegmented(document.getElementById('map-filter'), ({ filter }) => {
    state.filter = filter;
    renderStopList();
    renderMarkers();
    const shown = filteredStops();
    if (shown.length) fitToStops(shown);
  });

  subscribe((reason) => {
    if (reason === 'picked' || reason === 'data') {
      renderStopList();
      renderMarkers();
      if (state.detailStopId) showDetail(state.detailStopId);
    }
  });
}
