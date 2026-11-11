import { summarizeThroughput, summarizeLatency, nextSize, sliceRates } from './analysis.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

let uploadBlob;
function getUploadBlob() {
  if (!uploadBlob) {
    // Random (incompressible) data, filled 64 KiB at a time (getRandomValues limit).
    const buf = new Uint8Array(32 << 20);
    for (let i = 0; i < buf.length; i += 65536) crypto.getRandomValues(buf.subarray(i, i + 65536));
    uploadBlob = new Blob([buf]);
  }
  return uploadBlob;
}

// Round trip for one tiny request. Prefers the browser's Resource Timing
// (request sent -> first byte back), which leaves out JavaScript scheduling
// delays; falls back to wall-clock time around fetch.
async function ping(origin) {
  const url = `${origin}/api/ping?r=${Math.random()}`;
  const t0 = now();
  const r = await fetch(url, { cache: 'no-store' });
  await r.arrayBuffer();
  const wall = now() - t0;
  const entry = performance.getEntriesByName(url).pop();
  if (performance.getEntriesByType('resource').length > 200) performance.clearResourceTimings();
  if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
    return entry.responseStart - entry.requestStart;
  }
  return wall;
}

export class SpeedTest {
  constructor({ streams = 8, warmupMs = 5000, durationMs = 15000, dataPorts = [], onUpdate = () => {} }) {
    Object.assign(this, { streams, warmupMs, durationMs, onUpdate });
    this.sid = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2);
    this.main = location.origin;
    const proto = location.protocol;
    this.origins = dataPorts.length ? dataPorts.map((p) => `${proto}//${location.hostname}:${p}`) : [this.main];
    this.aborted = false;
  }

  originFor(i) {
    return this.origins[i % this.origins.length];
  }

  cancel() {
    this.aborted = true;
    this.controllers?.forEach((c) => c.abort());
  }

  async run() {
    const result = { streams: this.streams, warmupMs: this.warmupMs, durationMs: this.durationMs };
    this.onUpdate({ phase: 'ping' });
    result.idle = await this.idleLatency();
    this.onUpdate({ phase: 'partial', result: { ...result } });
    if (this.aborted) throw new Error('cancelled');
    const down = await this.download();
    result.download = down.summary;
    result.downloadLoaded = down.loaded;
    result.downloadSlices = down.slices;
    this.onUpdate({ phase: 'partial', result: { ...result } });
    if (this.aborted) throw new Error('cancelled');
    const up = await this.upload();
    result.upload = up.summary;
    result.uploadLoaded = up.loaded;
    result.uploadSlices = up.slices;
    this.onUpdate({ phase: 'done' });
    return result;
  }

  async idleLatency() {
    // Discard a few pings: the first opens the connection, and the next ones
    // wake the phone's Wi-Fi from power saving. Pings then go back to back so
    // the radio stays awake and doesn't add its wake-up delay.
    for (let i = 0; i < 4 && !this.aborted; i++) await ping(this.main);
    const ms = [];
    for (let i = 0; i < 20 && !this.aborted; i++) {
      ms.push(await ping(this.main));
      this.onUpdate({ phase: 'ping', latency: summarizeLatency(ms).median, progress: ms.length / 20 });
    }
    const summary = summarizeLatency(ms);
    if (summary) summary.samples = ms.map((v) => Math.round(v * 100) / 100);
    return summary;
  }

  // Pings on the main origin during a load phase; only counted after warm-up.
  async loadedLatency(isRunning, measureFrom) {
    const ms = [];
    while (isRunning() && !this.aborted) {
      try {
        const t0 = now();
        const v = await ping(this.main);
        if (t0 >= measureFrom()) ms.push(v);
      } catch {}
      await sleep(250);
    }
    return summarizeLatency(ms);
  }

  live(samples, phase, startT, fromServer = false) {
    const last = samples[samples.length - 1];
    if (!last) return;
    const window = samples.filter((s) => s.t >= last.t - 1000);
    const first = window[0];
    const mbps = last.t > first.t ? ((last.bytes - first.bytes) * 8) / ((last.t - first.t) * 1000) : 0;
    const elapsed = last.t - startT;
    this.onUpdate({ phase, mbps, progress: Math.min(1, elapsed / (this.warmupMs + this.durationMs)), warmup: elapsed < this.warmupMs, fromServer });
  }

  // Download is counted in the browser as bytes arrive, which is accurate for this direction.
  async download() {
    const startT = now();
    const endT = startT + this.warmupMs + this.durationMs;
    let bytes = 0;
    const samples = [{ t: startT, bytes: 0 }];
    let running = true;
    this.controllers = [];
    const stream = async (i) => {
      let size = 8 << 20;
      while (running && !this.aborted) {
        const ctl = new AbortController();
        this.controllers.push(ctl);
        const t0 = now();
        try {
          const r = await fetch(`${this.originFor(i)}/api/down?sid=${this.sid}&bytes=${size}&r=${Math.random()}`, { cache: 'no-store', signal: ctl.signal });
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
          }
          size = nextSize(size, now() - t0, { max: 256 << 20 });
        } catch {
          if (running && !this.aborted) await sleep(100);
        }
      }
    };
    const workers = Array.from({ length: this.streams }, (_, i) => stream(i));
    const latency = this.loadedLatency(() => running, () => startT + this.warmupMs);
    while (now() < endT && !this.aborted) {
      await sleep(100);
      samples.push({ t: now(), bytes });
      this.live(samples, 'download', startT);
    }
    running = false;
    this.controllers.forEach((c) => c.abort());
    await Promise.allSettled(workers);
    return {
      summary: summarizeThroughput(samples, { startT, warmupMs: this.warmupMs, endT }),
      slices: sliceRates(samples, startT, endT, 250),
      loaded: await latency,
    };
  }

  async progress() {
    const r = await fetch(`${this.main}/api/progress?sid=${this.sid}&r=${Math.random()}`, { cache: 'no-store' });
    const j = await r.json();
    return { t: j.t, bytes: j.upBytes };
  }

  // Upload is counted at the server; t is the server's clock. Bytes that the
  // browser has queued but the server has not received are never counted.
  async upload() {
    const blob = getUploadBlob();
    const first = await this.progress();
    const base = first.bytes;
    const startT = first.t;
    const endT = startT + this.warmupMs + this.durationMs;
    const samples = [{ t: startT, bytes: 0 }];
    let running = true;
    this.controllers = [];
    const clientStart = now();
    const stream = async (i) => {
      let size = 1 << 20;
      while (running && !this.aborted) {
        const ctl = new AbortController();
        this.controllers.push(ctl);
        const t0 = now();
        try {
          const body = size <= blob.size ? blob.slice(0, size) : new Blob(Array(Math.ceil(size / blob.size)).fill(blob)).slice(0, size);
          const r = await fetch(`${this.originFor(i)}/api/up?sid=${this.sid}&r=${Math.random()}`, { method: 'POST', body, cache: 'no-store', signal: ctl.signal });
          await r.arrayBuffer();
          size = nextSize(size, now() - t0, { max: 128 << 20 });
        } catch {
          if (running && !this.aborted) await sleep(100);
        }
      }
    };
    const workers = Array.from({ length: this.streams }, (_, i) => stream(i));
    const latency = this.loadedLatency(() => running, () => clientStart + this.warmupMs);
    while (!this.aborted) {
      await sleep(150);
      let p;
      try {
        p = await this.progress();
      } catch {
        continue;
      }
      samples.push({ t: p.t, bytes: p.bytes - base });
      this.live(samples, 'upload', startT, true);
      if (p.t >= endT) break;
    }
    running = false;
    this.controllers.forEach((c) => c.abort());
    await Promise.allSettled(workers);
    return {
      summary: summarizeThroughput(samples, { startT, warmupMs: this.warmupMs, endT }),
      slices: sliceRates(samples, startT, Math.min(endT, samples[samples.length - 1].t), 250),
      loaded: await latency,
    };
  }
}
