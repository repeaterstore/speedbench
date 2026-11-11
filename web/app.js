import { SpeedTest } from './engine.js';
import { Gauge } from './gauge.js';

const gauge = new Gauge(document.getElementById('dial'));
const fmt2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
// While a transfer runs, the big number follows the gauge's eased value every
// animation frame, so the decimals tick continuously like Ookla's readout.
let liveReadout = false;
gauge.onFrame = (v) => { if (liveReadout) document.getElementById('value').textContent = fmt2(v); };

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(d));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

for (const id of ['streams', 'warmup', 'duration', 'device']) {
  const saved = store.get(`lst.${id}`);
  if (saved != null) $(id).value = saved;
  $(id).addEventListener('change', () => store.set(`lst.${id}`, $(id).value));
}
// Ookla-style trimming is the default; only an explicit opt-out turns it off.
$('trim').checked = store.get('lst.trim') !== '0';

// A made-up, editable name so each device is recognisable in shared results.
const ADJ = ['Swift', 'Brave', 'Lucky', 'Mellow', 'Zippy', 'Cosmic', 'Sunny', 'Quiet', 'Nimble', 'Bold', 'Clever', 'Fuzzy', 'Jolly', 'Rapid', 'Velvet', 'Amber'];
const NOUN = ['Otter', 'Falcon', 'Badger', 'Comet', 'Panda', 'Heron', 'Lynx', 'Maple', 'Pebble', 'Orca', 'Fox', 'Koala', 'Sparrow', 'Bison', 'Gecko', 'Puffin'];
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
if (!$('device').value.trim()) {
  $('device').value = `${pickOne(ADJ)} ${pickOne(NOUN)}`;
  store.set('lst.device', $('device').value);
}
$('device').addEventListener('input', () => store.set('lst.device', $('device').value));
$('device').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
$('device').addEventListener('blur', () => {
  if (!$('device').value.trim()) { $('device').value = `${pickOne(ADJ)} ${pickOne(NOUN)}`; store.set('lst.device', $('device').value); }
});
$('trim').addEventListener('change', () => store.set('lst.trim', $('trim').checked ? '1' : '0'));

let config = { dataPorts: [] };
fetch('/api/config').then((r) => r.json()).then((c) => (config = c)).catch(() => {});

let test = null;
let lastResult = null;
const series = { download: [], upload: [] };

function headline(s) {
  if (!s) return null;
  return $('trim').checked ? s.trimmed : s.mean;
}

function renderResult(r) {
  $('down').textContent = fmt(headline(r.download));
  $('up').textContent = fmt(headline(r.upload));
  $('ping').textContent = r.idle ? `${fmt(r.idle.median)} ms` : '—';
  $('pingSub').textContent = r.idle ? `jitter ${fmt(r.idle.jitter)} ms` : '';
  $('loaded').textContent = r.downloadLoaded || r.uploadLoaded ? `${fmt(r.downloadLoaded?.median)} / ${fmt(r.uploadLoaded?.median)}` : '—';
  $('loadedSub').textContent = 'ms during ↓ / ↑';
}
$('trim').addEventListener('change', () => lastResult && renderResult(lastResult));

// Gaussian-weighted smoothing (display only; results are not affected).
function smooth(values, sigma = 3) {
  const k = Math.ceil(sigma * 3);
  const w = Array.from({ length: 2 * k + 1 }, (_, i) => Math.exp(-((i - k) ** 2) / (2 * sigma * sigma)));
  return values.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = -k; j <= k; j++) {
      const v = values[i + j];
      if (v === undefined) continue;
      sum += v * w[j + k]; n += w[j + k];
    }
    return sum / n;
  });
}

// Cubic curve through every point (Catmull-Rom), clamped so it never overshoots below zero.
function curve(pts, floorY) {
  const path = new Path2D();
  path.moveTo(...pts[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1y = Math.min(floorY, p1[1] + (p2[1] - p0[1]) / 6);
    const c2y = Math.min(floorY, p2[1] - (p3[1] - p1[1]) / 6);
    path.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, c1y, p2[0] - (p3[0] - p1[0]) / 6, c2y, p2[0], p2[1]);
  }
  return path;
}

function drawChart() {
  const c = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = 120;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const all = [...series.download, ...series.upload];
  const max = Math.max(1, ...all) * 1.1;
  const css = getComputedStyle(document.documentElement);
  const n = Math.max(series.download.length, series.upload.length, 2);
  for (const [key, color] of [['download', '--down'], ['upload', '--up']]) {
    const s = smooth(series[key]);
    if (s.length < 2) continue;
    const c = css.getPropertyValue(color).trim();
    const pts = s.map((v, i) => [8 + (i / (n - 1)) * (w - 16), h - 8 - (v / max) * (h - 16)]);
    const path = curve(pts, h - 8);
    const area = new Path2D(path);
    area.lineTo(pts[pts.length - 1][0], h);
    area.lineTo(pts[0][0], h);
    area.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, c + '55');
    grad.addColorStop(1, c + '00');
    ctx.fillStyle = grad;
    ctx.fill(area);
    ctx.strokeStyle = c;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.stroke(path);
  }
  ctx.fillStyle = css.getPropertyValue('--muted').trim();
  ctx.font = '11px system-ui';
  ctx.fillText(`${fmt(max / 1.1, 0)} Mbps`, 8, 14);
}

const phaseLabel = { ping: 'Latency', download: 'Download', upload: 'Upload', done: 'Done' };
let lastLiveSample = 0;
function onUpdate(u) {
  if (u.phase === 'partial') { renderResult(u.result); return; }
  if (u.phase === 'ping') {
    $('phase').textContent = 'Latency';
    if (u.progress != null) $('bar').style.width = `${(u.progress * 100).toFixed(1)}%`;
    if (u.latency != null) { $('value').textContent = fmt(u.latency); document.querySelector('.big .unit').textContent = 'ms'; }
    return;
  }
  if (u.phase === 'done') return;
  if (gauge.mode !== u.phase) gauge.setMode(u.phase);
  gauge.set(u.mbps);
  document.querySelector('.big .unit').textContent = 'Mbps';
  $('phase').textContent = `${phaseLabel[u.phase]}${u.warmup ? ' · warming up' : ''}${u.fromServer ? ' · measured at server' : ''}`;
  liveReadout = true;
  $('bar').style.width = `${(u.progress * 100).toFixed(1)}%`;
  const t = performance.now();
  if (t - lastLiveSample > 250) {
    series[u.phase].push(u.mbps);
    lastLiveSample = t;
    drawChart();
  }
}

async function start() {
  if (test) { test.cancel(); return; }
  series.download = []; series.upload = [];
  for (const id of ['down', 'up', 'ping', 'loaded']) { $(id).textContent = '—'; const s = $(`${id}Sub`); if (s) s.textContent = ''; }
  gauge.reset();
  gauge.setMode('download');
  $('start').textContent = 'Stop';
  $('start').classList.add('stop');
  let wake;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  test = new SpeedTest({
    streams: +$('streams').value || 8,
    warmupMs: (+$('warmup').value || 0) * 1000,
    durationMs: (+$('duration').value || 15) * 1000,
    dataPorts: config.dataPorts || [],
    onUpdate,
  });
  try {
    const r = await test.run();
    lastResult = r;
    renderResult(r);
    $('phase').textContent = 'Done';
    liveReadout = false;
    $('value').textContent = fmt2(headline(r.download));
    series.download = r.downloadSlices; series.upload = r.uploadSlices; drawChart();
    await fetch('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...r, device: $('device').value || undefined, trimmedHeadline: $('trim').checked }),
    });
    loadHistory();
  } catch (e) {
    $('phase').textContent = e.message === 'cancelled' ? 'Stopped' : `Error: ${e.message}`;
  } finally {
    test = null;
    $('start').textContent = 'Start';
    $('start').classList.remove('stop');
    $('bar').style.width = '0';
    liveReadout = false;
    gauge.set(0);
    wake?.release?.().catch(() => {});
  }
}
$('start').addEventListener('click', start);

function shortUA(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return (ua.match(/Android[^;]*;\s*([^;)]+)/) || [])[1]?.trim() || 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Device';
}

async function loadHistory() {
  try {
    const list = await (await fetch('/api/results')).json();
    $('history').replaceChildren(...list.slice(0, 20).map((r) => {
      const li = document.createElement('li');
      const t = new Date(r.time);
      const pick = (s) => (r.trimmedHeadline ? s?.trimmed : s?.mean);
      li.innerHTML = `<span>${r.device ? escape(r.device) : shortUA(r.userAgent)} <span class="who">${escape(r.clientIp || '')} · ${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></span>
        <span class="speeds">↓ ${fmt(pick(r.download))} ↑ ${fmt(pick(r.upload))} · ${fmt(r.idle?.median)} ms</span>`;
      return li;
    }));
  } catch {}
}
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function pollServer() {
  try {
    const s = await (await fetch('/api/live')).json();
    $('server').textContent = `Server: ${s.activeTests} active · ↓ ${fmt(s.downMbps)} ↑ ${fmt(s.upMbps)} Mbps`;
  } catch {
    $('server').textContent = 'Server: unreachable';
  }
}
setInterval(pollServer, 1000);
pollServer();
loadHistory();
setInterval(() => !test && loadHistory(), 10000);
drawChart();
