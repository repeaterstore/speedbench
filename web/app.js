import { SpeedTest } from './engine.js';
import { Gauge } from './gauge.js';

const $ = (id) => document.getElementById(id);
const ok = (v) => v != null && Number.isFinite(v);
// One decimal, like the dial readout; whole numbers past 1 Gbps so it fits.
const speed = (v) => (!ok(v) ? '—' : v >= 1000 ? v.toFixed(0) : v.toFixed(1));
const ms = (v) => (!ok(v) ? '—' : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const gauge = new Gauge($('dial'));
// While a transfer runs, the readout follows the needle every frame.
let liveReadout = false;
gauge.onFrame = (v) => { if (liveReadout) $('value').textContent = speed(v); };

// Settings
for (const id of ['streams', 'warmup', 'duration', 'device']) {
  const saved = store.get(`lst.${id}`);
  if (saved != null) $(id).value = saved;
  $(id).addEventListener('change', () => store.set(`lst.${id}`, $(id).value));
}
$('trim').checked = store.get('lst.trim') !== '0';
$('trim').addEventListener('change', () => {
  store.set('lst.trim', $('trim').checked ? '1' : '0');
  if (lastResult) renderResult(lastResult);
});

// A made-up, editable name so each device is recognisable in shared results.
const ADJ = ['Swift', 'Brave', 'Lucky', 'Mellow', 'Zippy', 'Cosmic', 'Sunny', 'Quiet', 'Nimble', 'Bold', 'Clever', 'Fuzzy', 'Jolly', 'Rapid', 'Velvet', 'Amber'];
const NOUN = ['Otter', 'Falcon', 'Badger', 'Comet', 'Panda', 'Heron', 'Lynx', 'Maple', 'Pebble', 'Orca', 'Fox', 'Koala', 'Sparrow', 'Bison', 'Gecko', 'Puffin'];
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const ensureName = () => {
  if (!$('device').value.trim()) {
    $('device').value = `${pickOne(ADJ)} ${pickOne(NOUN)}`;
    store.set('lst.device', $('device').value);
  }
};
ensureName();
$('device').addEventListener('input', () => store.set('lst.device', $('device').value));
$('device').addEventListener('blur', ensureName);
$('device').addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());

let config = { dataPorts: [] };
fetch('/api/config').then((r) => r.json()).then((c) => (config = c)).catch(() => {});

let test = null;
let lastResult = null;
const series = { download: [], upload: [] };

const headline = (s) => (!s ? null : $('trim').checked ? s.trimmed ?? s.mean : s.mean);
const reading = (stage) => document.querySelector(`.reading[data-stage=${stage}]`);

function setStage(stage) {
  document.querySelectorAll('.reading').forEach((r) => r.classList.toggle('active', r.dataset.stage === stage));
}

function fill(id, text, stage) {
  const el = $(id);
  if (el.textContent === text) return;
  el.textContent = text;
  const r = reading(stage);
  r.classList.remove('filled');
  if (text !== '—') { void r.offsetWidth; r.classList.add('filled'); }
}

function renderResult(r) {
  fill('ping', ms(r.idle?.median), 'ping');
  $('pingSub').textContent = r.idle ? `jitter ${ms(r.idle.jitter)}` : ' ';
  fill('down', speed(headline(r.download)), 'download');
  $('downSub').textContent = r.downloadLoaded ? `${ms(r.downloadLoaded.median)} ms loaded` : ' ';
  fill('up', speed(headline(r.upload)), 'upload');
  $('upSub').textContent = r.uploadLoaded ? `${ms(r.uploadLoaded.median)} ms loaded` : ' ';
}

function clearResults() {
  for (const [id, stage] of [['ping', 'ping'], ['down', 'download'], ['up', 'upload']]) {
    $(id).textContent = '—';
    reading(stage).classList.remove('filled');
  }
  for (const id of ['pingSub', 'downSub', 'upSub']) $(id).textContent = ' ';
}

// ---- Throughput chart (display only: smoothed; results are not affected) ----
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
  const w = c.clientWidth, h = c.clientHeight;
  if (!w) return;
  c.width = w * dpr; c.height = h * dpr;
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  const peak = Math.max(0, ...smooth(series.download), ...smooth(series.upload));
  const max = Math.max(1, peak) * 1.15;
  $('chartMax').textContent = peak > 0 ? `peak ${speed(peak)}` : '';
  // Faint guide lines at quarters.
  ctx.strokeStyle = css.getPropertyValue('--line').trim();
  ctx.lineWidth = 1;
  for (let q = 1; q < 4; q++) {
    const y = Math.round((h * q) / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  // Each phase spans the full width, so download and upload are directly comparable.
  for (const [key, color] of [['download', '--down'], ['upload', '--up']]) {
    const s = smooth(series[key]);
    if (s.length < 2) continue;
    const col = css.getPropertyValue(color).trim();
    const n = Math.max(s.length, expectedPoints);
    const pts = s.map((v, i) => [(i / (n - 1)) * w, h - 4 - (v / max) * (h - 12)]);
    const path = curve(pts, h - 4);
    const area = new Path2D(path);
    area.lineTo(pts[pts.length - 1][0], h);
    area.lineTo(pts[0][0], h);
    area.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, col + '40');
    grad.addColorStop(1, col + '00');
    ctx.fillStyle = grad;
    ctx.fill(area);
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.lineJoin = ctx.lineCap = 'round';
    ctx.stroke(path);
  }
}
let expectedPoints = 80;
window.addEventListener('resize', drawChart);

// ---- Live updates ----
const phaseText = { ping: 'Ping', download: 'Download', upload: 'Upload' };
let lastChartPush = 0;

function onUpdate(u) {
  if (u.phase === 'partial') { renderResult(u.result); return; }
  if (u.phase === 'done') return;
  setStage(u.phase);
  $('instrument').dataset.mode = u.phase;
  $('bar').style.transform = `scaleX(${u.progress ?? 0})`;
  if (u.phase === 'ping') {
    $('phase').textContent = 'Ping';
    $('unit').textContent = 'ms';
    if (ok(u.latency)) $('value').textContent = ms(u.latency);
    return;
  }
  if (gauge.mode !== u.phase) gauge.setMode(u.phase);
  $('unit').textContent = 'Mbps';
  $('phase').textContent = u.final ? `${phaseText[u.phase]} result` : u.warmup ? `${phaseText[u.phase]} · warming up` : phaseText[u.phase];
  liveReadout = true;
  gauge.set(u.mbps);
  if (!u.final && ok(u.instant)) {
    const t = performance.now();
    if (t - lastChartPush > 250) {
      series[u.phase].push(u.instant);
      lastChartPush = t;
      drawChart();
    }
  }
}

function setState(state) {
  $('instrument').dataset.state = state;
  $('start').setAttribute('aria-label', state === 'running' ? 'Test running' : 'Start test');
}

async function start() {
  if (test) return;
  series.download = []; series.upload = [];
  clearResults();
  drawChart();
  gauge.reset();
  gauge.setMode('download');
  $('value').textContent = '—';
  setState('running');
  let wake;
  try { wake = await navigator.wakeLock?.request('screen'); } catch {}
  const warmupMs = (+$('warmup').value || 0) * 1000;
  const durationMs = (+$('duration').value || 15) * 1000;
  expectedPoints = Math.round((warmupMs + durationMs) / 250);
  test = new SpeedTest({
    streams: +$('streams').value || 8,
    warmupMs, durationMs,
    mode: $('trim').checked ? 'trimmed' : 'mean',
    dataPorts: config.dataPorts || [],
    onUpdate,
  });
  try {
    const r = await test.run();
    lastResult = r;
    renderResult(r);
    series.download = r.downloadSlices; series.upload = r.uploadSlices;
    drawChart();
    await fetch('/api/results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...r, device: $('device').value || undefined, trimmedHeadline: $('trim').checked }),
    }).catch(() => {});
    loadHistory();
    await new Promise((res) => setTimeout(res, 1400)); // let the dial rest on the final value
  } catch (e) {
    $('phase').textContent = e.message === 'cancelled' ? 'Stopped' : `Error: ${e.message}`;
  } finally {
    test = null;
    setStage(null);
    liveReadout = false;
    gauge.set(0);
    $('bar').style.transform = 'scaleX(0)';
    setState('idle');
    wake?.release?.().catch(() => {});
  }
}
$('start').addEventListener('click', start);
$('stop').addEventListener('click', () => test?.cancel());

// ---- Shared results ----
function shortUA(ua = '') {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Device';
}
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function loadHistory() {
  try {
    const list = await (await fetch('/api/results')).json();
    if (!list.length) return;
    const me = $('device').value;
    $('history').replaceChildren(...list.slice(0, 20).map((r) => {
      const tr = document.createElement('tr');
      if (r.device && r.device === me) tr.className = 'mine';
      const t = new Date(r.time);
      const pick = (s) => (!s ? null : r.trimmedHeadline ? s.trimmed ?? s.mean : s.mean);
      const name = r.device || shortUA(r.userAgent);
      tr.innerHTML = `<td>${escape(name)}<span class="who">${t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${escape(r.clientIp || '')}</span></td>
        <td class="n">${ms(r.idle?.median)}</td><td class="n down">${speed(pick(r.download))}</td><td class="n up">${speed(pick(r.upload))}</td>`;
      return tr;
    }));
  } catch {}
}

async function pollServer() {
  try {
    const s = await (await fetch('/api/live')).json();
    const busy = s.activeTests > 0;
    $('srvDot').className = `dot ${busy ? 'busy' : 'ok'}`;
    $('server').textContent = busy
      ? `${s.activeTests} testing · ↓${speed(s.downMbps)} ↑${speed(s.upMbps)}`
      : 'Server ready';
  } catch {
    $('srvDot').className = 'dot';
    $('server').textContent = 'Server unreachable';
  }
}
setInterval(pollServer, 1000);
pollServer();
loadHistory();
setInterval(() => !test && loadHistory(), 10000);
drawChart();
