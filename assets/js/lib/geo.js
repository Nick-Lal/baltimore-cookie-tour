/* Geometry helpers: distance, polyline decoding, route ordering. */

const R_EARTH_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in kilometres. */
export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Decode a Google/Valhalla encoded polyline.
 * Valhalla uses precision 6; Google and OSRM use 5. Pass the right one.
 */
export function decodePolyline(str, precision = 6) {
  const factor = 10 ** precision;
  const coords = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < str.length) {
    let result = 1;
    let shift = 0;
    let b;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

/**
 * Order stops to shorten the tour: nearest neighbour from a fixed start,
 * then 2-opt until no swap improves it. At thirteen stops this runs in well
 * under a millisecond and lands on the optimal order or within a hair of it.
 * The caller passes a cost function backed by the committed street-network
 * matrix, so the ordering is done on real walking distances rather than on
 * how the crow flies. Straight-line distance is the fallback when no cost
 * function is supplied.
 */
export function optimiseOrder(stops, { fixStart = true, cost = null } = {}) {
  if (stops.length < 3) return stops.slice();

  const n = stops.length;
  const measure = cost ?? ((a, b) => haversineKm(a, b));
  const d = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 0 : measure(stops[i], stops[j])))
  );

  // nearest neighbour
  const unvisited = new Set(stops.map((_, i) => i));
  let current = 0;
  const tour = [current];
  unvisited.delete(current);
  while (unvisited.size) {
    let best = -1;
    let bestD = Infinity;
    for (const j of unvisited) {
      if (d[current][j] < bestD) {
        bestD = d[current][j];
        best = j;
      }
    }
    tour.push(best);
    unvisited.delete(best);
    current = best;
  }

  // 2-opt. An open path, so the last node has no return edge to consider.
  const lo = fixStart ? 1 : 0;
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 100) {
    improved = false;
    for (let i = lo; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = tour[i - 1];
        const b = tour[i];
        const c = tour[k];
        const e = k + 1 < n ? tour[k + 1] : null;
        const before = d[a][b] + (e !== null ? d[c][e] : 0);
        const after = d[a][c] + (e !== null ? d[b][e] : 0);
        if (after < before - 1e-9) {
          let x = i;
          let y = k;
          while (x < y) {
            const t = tour[x];
            tour[x] = tour[y];
            tour[y] = t;
            x++;
            y--;
          }
          improved = true;
        }
      }
    }
  }
  return tour.map((i) => stops[i]);
}

/** Bounding box for a set of points, padded slightly. */
export function boundsOf(points, pad = 0.004) {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return [
    [Math.min(...lats) - pad, Math.min(...lngs) - pad],
    [Math.max(...lats) + pad, Math.max(...lngs) + pad],
  ];
}

export function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}

export function formatMins(mins) {
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h} hr ${rem} min` : `${h} hr`;
}
