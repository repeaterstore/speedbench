import { SpeedTest } from './engine.js';

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
$('trim').checked = store.get('lst.trim') === '1';
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

function sub(s) {
  if (!s) return '';
  return $('trim').checked ? `avg ${fmt(s.mean)} · median ${fmt(s.median)}` : `trimmed ${fmt(s.trimmed)} · median ${fmt(s.median)}`;
}

function renderResult(r) {
  $('down').textContent = fmt(headline(r.download));
  $('downSub').textContent = sub(r.download);
  $('up').textContent = fmt(headline(r.upload));
  $('upSub').textContent = sub(r.upload);
  $('ping').textContent = r.idle ? `${fmt(r.idle.median)} ms` : '—';
  $('pingSub').textContent = r.idle ? `jitter ${fmt(r.idle.jitter)} ms` : '';
  $('loaded').textContent = r.downloadLoaded || r.uploadLoaded ? `${fmt(r.downloadLoaded?.median, 0)} / ${fmt(r.uploadLoaded?.median, 0)}` : '—';
  $('loadedSub').textContent = 'ms during ↓ / ↑';
}
$('trim').addEventListener('change', () => lastResult && renderResult(lastResult));

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
    const s = series[key];
    if (s.length < 2) continue;
    ctx.strokeStyle = css.getPropertyValue(color).trim();
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.forEach((v, i) => {
      const x = 8 + (i / (n - 1)) * (w - 16);
      const y = h - 8 - (v / max) * (h - 16);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  }
  ctx.fillStyle = css.getPropertyValue('--muted').trim();
  ctx.font = '11px system-ui';
  ctx.fillText(`${fmt(max / 1.1, 0)} Mbps`, 8, 14);
}

const phaseLabel = { ping: 'Latency', download: 'Download', upload: 'Upload', done: 'Done' };
let lastLiveSample = 0;
function onUpdate(u) {
  if (u.phase === 'ping') {
    $('phase').textContent = 'Latency';
    if (u.latency != null) { $('value').textContent = fmt(u.latency); document.querySelector('.big .unit').textContent = 'ms'; }
    return;
  }
  if (u.phase === 'done') return;
  document.querySelector('.big .unit').textContent = 'Mbps';
  $('phase').textContent = `${phaseLabel[u.phase]}${u.warmup ? ' · warming up' : ''}${u.fromServer ? ' · measured at server' : ''}`;
  $('value').textContent = fmt(u.mbps);
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
  for (const id of ['down', 'up', 'ping', 'loaded']) { $(id).textContent = '—'; $(`${id}Sub`).textContent = ''; }
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
    $('value').textContent = fmt(headline(r.download));
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
