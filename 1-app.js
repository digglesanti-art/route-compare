'use strict';

const GEOCODER = 'https://nominatim.openstreetmap.org';
const TEAL = '#73a89a';
const GRAYS = ['#b9b3b1', '#968f8d', '#7d7674'];

function decodePolyline(str, precision = 6) {
  let index = 0, lat = 0, lon = 0;
  const coords = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let result = 0, shift = 0, byte;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 0; shift = 0;
    do { byte = str.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index < str.length);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

function withTimeout(p, ms, what) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(what + ' timed out')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function geocode(q) {
  const r = await fetch(`${GEOCODER}/search?q=${encodeURIComponent(q)}&format=json&limit=1`);
  if (!r.ok) throw new Error('The address lookup failed');
  const rows = await r.json();
  if (!rows.length) throw new Error(`No place found for "${q}"`);
  return { lat: +rows[0].lat, lon: +rows[0].lon, label: q };
}

async function suggest(q) {
  const r = await fetch(`${GEOCODER}/search?q=${encodeURIComponent(q)}&format=json&limit=5`);
  if (!r.ok) return [];
  const rows = await r.json();
  return rows.map(row => {
    const full = String(row.display_name);
    const parts = full.split(',');
    return { lat: +row.lat, lon: +row.lon, main: parts[0], rest: parts.slice(1).join(',').trim(), full };
  });
}

const PROVIDERS = [
  {
    id: 'osrm', name: 'OSRM',
    run: async (o, d) => {
      const j = await getJson(`https://router.project-osrm.org/route/v1/driving/${o.lon},${o.lat};${d.lon},${d.lat}?overview=full&geometries=geojson&steps=true`);
      if (j.code !== 'Ok' || !j.routes || !j.routes.length) throw new Error('no route');
      const r = j.routes[0];
      const turns = (r.legs || []).reduce((n, leg) => n + ((leg.steps || []).filter(s => !['depart', 'arrive'].includes(s.maneuver && s.maneuver.type)).length), 0);
      return { provider: 'OSRM', seconds: r.duration, meters: r.distance, turns, coords: r.geometry.coordinates.map(c => [c[1], c[0]]) };
    },
  },
  {
    id: 'valhalla', name: 'Valhalla',
    run: async (o, d) => {
      const req = { locations: [{ lat: o.lat, lon: o.lon }, { lat: d.lat, lon: d.lon }], costing: 'auto', units: 'kilometers' };
      const j = await getJson(`https://valhalla1.openstreetmap.de/route?json=${encodeURIComponent(JSON.stringify(req))}`);
      if (!j.trip) throw new Error('no route');
      const coords = (j.trip.legs || []).flatMap(leg => decodePolyline(leg.shape, 6));
      const turns = (j.trip.legs || []).reduce((n, leg) => n + Math.max(0, (leg.maneuvers || []).length - 2), 0);
      const note = j.trip.summary.has_toll ? 'passes tolls' : undefined;
      return { provider: 'Valhalla', seconds: j.trip.summary.time, meters: j.trip.summary.length * 1000, turns, coords, note };
    },
  },
  {
    id: 'brouter', name: 'BRouter',
    run: async (o, d) => {
      const j = await getJson(`https://brouter.de/brouter?lonlats=${o.lon},${o.lat}|${d.lon},${d.lat}&profile=car-fast&format=geojson`);
      const f = j.features && j.features[0];
      if (!f) throw new Error(j.error || 'no route');
      return {
        provider: 'BRouter',
        seconds: +f.properties['total-time'],
        meters: +f.properties['track-length'],
        coords: f.geometry.coordinates.map(c => [c[1], c[0]]),
      };
    },
  },
];

function pickRecommended(routes) {
  if (!routes.length) return null;
  const fastest = Math.min(...routes.map(r => r.seconds));
  const near = routes.filter(r => r.seconds - fastest <= 120);
  const scored = near.slice().sort((a, b) => (a.turns ?? 1e9) - (b.turns ?? 1e9) || a.meters - b.meters || a.seconds - b.seconds);
  return scored[0] || routes[0];
}

function fmtDur(s) {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} hr ${m % 60} min` : `${h} hr`;
}
function fmtKm(m) { return `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const $ = id => document.getElementById(id);
const state = {
  fromText: '', toText: '', fromPlace: null, toPlace: null, gps: null,
  result: null, sortBy: 'quickest',
  drive: null,
};

function setupAutocomplete(input, list, onText, onPick) {
  let timer = null, seq = 0;
  input.addEventListener('input', () => {
    const v = input.value;
    onText(v);
    if (timer) clearTimeout(timer);
    if (v.trim().length < 3) { list.hidden = true; list.innerHTML = ''; return; }
    const my = ++seq;
    timer = setTimeout(async () => {
      let rows = [];
      try { rows = await suggest(v.trim()); } catch { rows = []; }
      if (my !== seq) return;
      if (!rows.length) { list.hidden = true; list.innerHTML = ''; return; }
      list.innerHTML = rows.map((s, i) => `<li><button type="button" role="option" data-i="${i}"><span class="s1">${esc(s.main)}</span>${s.rest ? `<span class="s2">${esc(s.rest)}</span>` : ''}</button></li>`).join('');
      list.hidden = false;
      list.querySelectorAll('button').forEach(btn => {
        btn.addEventListener('pointerdown', e => {
          e.preventDefault();
          const s = rows[+btn.dataset.i];
          input.value = s.full;
          onText(s.full);
          onPick({ lat: s.lat, lon: s.lon, label: s.main });
          list.hidden = true;
          list.innerHTML = '';
        });
      });
    }, 400);
  });
  document.addEventListener('pointerdown', e => {
    if (!list.hidden && !e.target.closest('.placefield')) { list.hidden = true; }
  });
}

function setError(msg) {
  const el = $('error');
  if (!msg) { el.hidden = true; el.innerHTML = ''; return; }
  el.innerHTML = `<strong>Not this time</strong>${esc(msg)}`;
  el.hidden = false;
}

function sortedRoutes() {
  const routes = state.result ? state.result.routes.slice() : [];
  if (state.sortBy === 'quickest') routes.sort((a, b) => a.seconds - b.seconds);
  else if (state.sortBy === 'shortest') routes.sort((a, b) => a.meters - b.meters);
  else routes.sort((a, b) => (a.turns ?? 1e9) - (b.turns ?? 1e9) || a.seconds - b.seconds);
  return routes;
}

function renderResults() {
  const res = state.result;
  if (!res) return;
  const sorted = sortedRoutes();
  const label = { quickest: 'Quickest first', easiest: 'Easiest first (fewest turns)', shortest: 'Shortest first' }[state.sortBy];
  $('results-title').textContent = `${label} - ${res.origin.label} to ${res.dest.label}`;
  const rec = res.routes.find(r => r.recommended);
  $('recommendation').textContent = rec ? `Take ${rec.provider}: ${fmtDur(rec.seconds)}, ${fmtKm(rec.meters)}${rec.turns != null ? `, ${rec.turns} turns` : ''}.` : '';
  $('rows').innerHTML = sorted.map(r => `<li>
    <span class="num">${r.rank}.</span>
    <span class="name">${esc(r.provider)}${r.recommended ? ' - recommended' : ''}</span>
    <span class="detail">${[fmtKm(r.meters), r.turns != null ? r.turns + ' turns' : null, r.note, r !== sorted[0] && state.sortBy === 'quickest' ? `+${fmtDur(r.seconds - sorted[0].seconds)} slower` : null].filter(Boolean).join(' · ')}</span>
    <span class="val${r.recommended ? ' known' : ''}">${fmtDur(r.seconds)}</span>
  </li>`).join('');
  document.querySelectorAll('.sortrow .chip[data-sort]').forEach(c => c.classList.toggle('active', c.dataset.sort === state.sortBy));
  $('failures').hidden = !res.failures.length;
  if (res.failures.length) $('failures').textContent = 'Not every engine answered: ' + res.failures.map(f => `${f.provider} (${f.reason})`).join(', ') + '. The ranking uses the engines that did.';
  renderMap(res);
  const d = res.dest, o = res.origin;
  $('dl-waze').href = `https://waze.com/ul?ll=${d.lat}%2C${d.lon}&navigate=yes`;
  $('dl-apple').href = `https://maps.apple.com/?saddr=${o.lat}%2C${o.lon}&daddr=${d.lat}%2C${d.lon}&dirflg=d`;
  $('dl-google').href = `https://www.google.com/maps/dir/?api=1&origin=${o.lat}%2C${o.lon}&destination=${d.lat}%2C${d.lon}&travelmode=driving`;
  $('results').hidden = false;
}

function renderMap(res) {
  const routes = res.routes;
  const all = routes.flatMap(r => r.coords).concat([[res.origin.lat, res.origin.lon]], [[res.dest.lat, res.dest.lon]]);
  if (all.length < 2) { $('routemap').innerHTML = ''; return; }
  const lats = all.map(c => c[0]), lons = all.map(c => c[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const latSpan = Math.max(maxLat - minLat, 1e-5);
  const lonSpan = Math.max(maxLon - minLon, 1e-5) * Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  const W = 360;
  const H = Math.round(Math.min(280, Math.max(150, W * latSpan / lonSpan)));
  const pad = 16;
  const sx = (W - 2 * pad) / Math.max(maxLon - minLon, 1e-9);
  const sy = (H - 2 * pad) / Math.max(maxLat - minLat, 1e-9);
  const s = Math.min(sx, sy);
  const px = lon => pad + (lon - minLon) * s + (W - 2 * pad - (maxLon - minLon) * s) / 2;
  const py = lat => H - pad - (lat - minLat) * s - (H - 2 * pad - (maxLat - minLat) * s) / 2;
  const path = coords => coords.map((c, i) => `${i ? 'L' : 'M'}${px(c[1]).toFixed(1)},${py(c[0]).toFixed(1)}`).join(' ');
  const rec = routes.find(r => r.recommended) || routes[0];
  const others = routes.filter(r => r !== rec);
  const legend = [rec, ...others].map((r, i) => `<span class="key"><span class="swatch" style="background:${i === 0 ? TEAL : GRAYS[(i - 1) % GRAYS.length]}"></span>${esc(r.provider)} · ${fmtDur(r.seconds)}</span>`).join('');
  $('routemap').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Route shapes from each engine">
    ${others.map((r, i) => r.coords.length > 1 ? `<path d="${path(r.coords)}" fill="none" stroke="${GRAYS[i % GRAYS.length]}" stroke-width="2" stroke-linecap="round"/>` : '').join('')}
    ${rec && rec.coords.length > 1 ? `<path d="${path(rec.coords)}" fill="none" stroke="${TEAL}" stroke-width="3.5" stroke-linecap="round"/>` : ''}
    <circle cx="${px(res.origin.lon)}" cy="${py(res.origin.lat)}" r="5" fill="#251f21"/>
    <circle cx="${px(res.dest.lon)}" cy="${py(res.dest.lat)}" r="6" fill="${TEAL}" stroke="#fff" stroke-width="2"/>
  </svg><div class="maplegend">${legend}</div>`;
}

async function compare() {
  setError('');
  $('compare').disabled = true;
  $('compare').textContent = 'Asking every engine…';
  try {
    if (!state.toText.trim()) throw new Error('Type a destination first.');
    const dest = state.toPlace || await withTimeout(geocode(state.toText.trim()), 12000, 'Address lookup');
    let origin;
    if (state.gps && (state.fromText === 'My location (GPS)' || state.fromText === state.gps.label)) origin = state.gps;
    else if (state.fromPlace) origin = state.fromPlace;
    else {
      if (!state.fromText.trim()) throw new Error('Type a start point, or tap "Use my location".');
      origin = await withTimeout(geocode(state.fromText.trim()), 12000, 'Address lookup');
    }
    const settled = await Promise.allSettled(PROVIDERS.map(p => withTimeout(p.run(origin, dest), 15000, p.name)));
    const routes = [], failures = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') routes.push({ ...s.value, rank: 0, recommended: false });
      else failures.push({ provider: PROVIDERS[i].name, reason: s.reason instanceof Error ? s.reason.message : 'failed' });
    });
    if (!routes.length) throw new Error('None of the engines answered. Try again in a moment.');
    routes.sort((a, b) => a.seconds - b.seconds);
    routes.forEach((r, i) => { r.rank = i + 1; });
    const rec = pickRecommended(routes);
    if (rec) rec.recommended = true;
    endDrive();
    state.result = { origin, dest, routes, failures };
    state.sortBy = 'quickest';
    renderResults();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    setError(e instanceof Error ? e.message : 'Something went wrong.');
  } finally {
    $('compare').disabled = false;
    $('compare').textContent = 'Compare routes';
  }
}

function useMyLocation() {
  setError('');
  const btn = $('locate');
  btn.disabled = true;
  btn.textContent = 'Locating…';
  const done = () => { btn.disabled = false; btn.textContent = 'Use my location'; };
  const byIp = async () => {
    try {
      const r = await fetch('https://ipapi.co/json/');
      if (!r.ok) throw new Error('no ip location');
      const j = await r.json();
      if (typeof j.latitude !== 'number') throw new Error('no ip location');
      const label = `Near ${j.city || 'you'} (approximate)`;
      state.gps = { lat: j.latitude, lon: j.longitude, label };
      $('from').value = label;
      state.fromText = label;
      state.fromPlace = null;
    } catch {
      setError('Location is not available right now - type your start point instead; suggestions appear after a few letters.');
    } finally { done(); }
  };
  if (!navigator.geolocation) { void byIp(); return; }
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.gps = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'My location' };
      $('from').value = 'My location (GPS)';
      state.fromText = 'My location (GPS)';
      state.fromPlace = null;
      done();
    },
    () => { void byIp(); },
    { timeout: 8000 },
  );
}

/* ---------- drive mode ---------- */

function speak(text) {
  try {
    if (!state.drive || !state.drive.voice || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch { /* no audio */ }
}

function renderDrive() {
  const dr = state.drive;
  if (!dr) return;
  $('drive-rows').innerHTML = dr.etas.map(r => `<li>
    <span class="num">${r.rank}.</span>
    <span class="name">${esc(r.provider)}${r.provider === dr.current.provider ? ' - your route' : ''}</span>
    <span class="detail">${fmtKm(r.meters)}</span>
    <span class="val${r.provider === dr.current.provider ? ' known' : ''}">${fmtDur(r.seconds)}</span>
  </li>`).join('');
  $('drive-status').textContent = `GPS: ${dr.gpsState}${dr.lastCheck ? ' · last check ' + dr.lastCheck : ''} · rechecks every 2 minutes. Screen stays awake while this page is open.`;
  $('al-voice').classList.toggle('active', dr.voice);
  $('al-text').classList.toggle('active', !dr.voice);
  const a = $('drive-alert');
  if (dr.alert) {
    const urls = switchUrls(dr.alert.route, dr.dest);
    a.innerHTML = `<strong>${esc(dr.alert.route.provider)} is ${fmtDur(dr.alert.saving)} faster now</strong>
      A better route came up. One tap switches your navigation app - the phone does not let a web page jump apps by itself.
      <div class="btnrow">
        <button class="btn primary" type="button" id="sw-google">Switch in Google Maps</button>
        <button class="btn secondary" type="button" id="sw-waze">Switch in Waze</button>
        <button class="btn ghost" type="button" id="sw-keep">Keep my route</button>
      </div>`;
    a.hidden = false;
    $('sw-google').addEventListener('click', () => { dr.current = dr.alert.route; dr.dismissed = ''; dr.alert = null; window.open(urls.google, '_blank'); renderDrive(); });
    $('sw-waze').addEventListener('click', () => { dr.current = dr.alert.route; dr.dismissed = ''; dr.alert = null; window.open(urls.waze, '_blank'); renderDrive(); });
    $('sw-keep').addEventListener('click', () => { dr.dismissed = dr.alert.route.provider; dr.alert = null; renderDrive(); });
  } else {
    a.hidden = true;
    a.innerHTML = '';
  }
}

function switchUrls(route, dest) {
  const mid = route.coords[Math.floor(route.coords.length / 2)];
  return {
    google: `https://www.google.com/maps/dir/?api=1&destination=${dest.lat}%2C${dest.lon}${mid ? `&waypoints=${mid[0]}%2C${mid[1]}` : ''}&travelmode=driving`,
    waze: `https://waze.com/ul?ll=${dest.lat}%2C${dest.lon}&navigate=yes`,
    apple: `https://maps.apple.com/?daddr=${dest.lat}%2C${dest.lon}&dirflg=d`,
  };
}

async function driveCheck() {
  const dr = state.drive;
  if (!dr) return;
  const pos = dr.pos;
  if (!pos) { dr.gpsState = 'waiting for GPS'; renderDrive(); return; }
  dr.gpsState = 'live';
  renderDrive();
  const settled = await Promise.allSettled(PROVIDERS.map(p => withTimeout(p.run(pos, dr.dest), 15000, p.name)));
  if (!state.drive) return;
  const fresh = [];
  settled.forEach(s => { if (s.status === 'fulfilled') fresh.push({ ...s.value, rank: 0, recommended: false }); });
  if (!fresh.length) { dr.lastCheck = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' - engines unreachable'; renderDrive(); return; }
  fresh.sort((a, b) => a.seconds - b.seconds);
  fresh.forEach((r, i) => { r.rank = i + 1; });
  const winner = fresh[0];
  winner.recommended = true;
  dr.etas = fresh;
  dr.lastCheck = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cur = fresh.find(r => r.provider === dr.current.provider);
  const curSeconds = cur ? cur.seconds : dr.current.seconds;
  const saving = curSeconds - winner.seconds;
  if (winner.provider !== dr.current.provider && saving >= 180 && dr.dismissed !== winner.provider) {
    dr.alert = { route: winner, saving };
    speak(`${winner.provider} is now ${fmtDur(saving)} faster. Tap switch to take the better route.`);
  }
  renderDrive();
}

function startDrive() {
  const res = state.result;
  if (!res) return;
  const rec = res.routes.find(r => r.recommended) || res.routes[0];
  state.drive = {
    dest: res.dest, current: rec, etas: res.routes.slice(), voice: true,
    alert: null, dismissed: '', gpsState: 'starting', lastCheck: '', pos: null,
    watch: null, timer: null, wake: null,
  };
  try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { if (state.drive) state.drive.wake = w; }).catch(() => {}); } catch { /* unsupported */ }
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => {
      if (!state.drive) return;
      state.drive.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
      void driveCheck();
    }, () => { if (state.drive) { state.drive.gpsState = 'GPS denied'; renderDrive(); } }, { timeout: 10000 });
    state.drive.watch = navigator.geolocation.watchPosition(p => {
      if (state.drive) state.drive.pos = { lat: p.coords.latitude, lon: p.coords.longitude };
    }, () => {}, { enableHighAccuracy: true });
  } else state.drive.gpsState = 'no GPS in this browser';
  state.drive.timer = setInterval(() => { void driveCheck(); }, 120000);
  $('drive-intro').hidden = true;
  $('drive').hidden = false;
  renderDrive();
  $('drive').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function endDrive() {
  const dr = state.drive;
  if (!dr) return;
  if (dr.watch != null && navigator.geolocation) navigator.geolocation.clearWatch(dr.watch);
  if (dr.timer != null) clearInterval(dr.timer);
  try { if (dr.wake) dr.wake.release(); } catch { /* ignore */ }
  try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch { /* ignore */ }
  state.drive = null;
  $('drive').hidden = true;
  $('drive-intro').hidden = false;
}

/* ---------- wiring ---------- */

setupAutocomplete($('from'), $('from-suggest'),
  v => { state.fromText = v; if (state.gps && v !== 'My location (GPS)' && !v.startsWith('Near ')) state.gps = null; },
  p => { state.fromPlace = p; });
setupAutocomplete($('to'), $('to-suggest'),
  v => { state.toText = v; },
  p => { state.toPlace = p; });
$('locate').addEventListener('click', useMyLocation);
$('compare').addEventListener('click', () => { void compare(); });
document.querySelectorAll('.chip[data-sort]').forEach(c => c.addEventListener('click', () => { state.sortBy = c.dataset.sort; renderResults(); }));
$('drive-start').addEventListener('click', startDrive);
$('drive-end').addEventListener('click', endDrive);
$('al-voice').addEventListener('click', () => { if (state.drive) { state.drive.voice = true; renderDrive(); } });
$('al-text').addEventListener('click', () => { if (state.drive) { state.drive.voice = false; renderDrive(); } });
