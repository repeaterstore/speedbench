// Pure measurement math, shared by the browser client and the node tests.
// Samples are cumulative byte counts: [{ t: ms, bytes: n }], t ascending.

export function bytesAt(samples, t) {
  if (!samples.length) return 0;
  if (t <= samples[0].t) return samples[0].bytes;
  for (let i = 1; i < samples.length; i++) {
    const b = samples[i];
    if (t <= b.t) {
      const a = samples[i - 1];
      if (b.t === a.t) return b.bytes;
      return a.bytes + ((b.bytes - a.bytes) * (t - a.t)) / (b.t - a.t);
    }
  }
  return samples[samples.length - 1].bytes;
}

const mbps = (bytes, ms) => (ms > 0 ? (bytes * 8) / (ms * 1000) : 0);

/** Rates (Mbps) for consecutive slices of sliceMs between from and to. */
export function sliceRates(samples, from, to, sliceMs) {
  const out = [];
  for (let s = from; s + sliceMs <= to + 1e-9; s += sliceMs) {
    out.push(mbps(bytesAt(samples, s + sliceMs) - bytesAt(samples, s), sliceMs));
  }
  return out;
}

export function median(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Mean after dropping the slowest `low` and fastest `high` fractions (Ookla's old 30%/10%). */
export function trimmedMean(values, low = 0.3, high = 0.1) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const kept = v.slice(Math.floor(v.length * low), v.length - Math.floor(v.length * high));
  if (!kept.length) return null;
  return kept.reduce((a, b) => a + b, 0) / kept.length;
}

/**
 * Throughput for one direction.
 * mean: all bytes in the measured window / window length (the headline).
 * trimmed, median: over sliceMs slices of the measured window.
 */
export function summarizeThroughput(samples, { startT, warmupMs, endT, sliceMs = 250, trimLow = 0.3, trimHigh = 0.1 }) {
  const from = startT + warmupMs;
  const to = endT ?? (samples.length ? samples[samples.length - 1].t : from);
  if (!samples.length || to <= from) return null;
  const slices = sliceRates(samples, from, to, sliceMs);
  return {
    mean: mbps(bytesAt(samples, to) - bytesAt(samples, from), to - from),
    trimmed: trimmedMean(slices, trimLow, trimHigh),
    median: median(slices),
    measuredMs: to - from,
    measuredBytes: bytesAt(samples, to) - bytesAt(samples, from),
  };
}

/** Median latency and jitter (mean absolute difference between consecutive samples). */
export function summarizeLatency(ms) {
  if (!ms.length) return null;
  let jitter = 0;
  for (let i = 1; i < ms.length; i++) jitter += Math.abs(ms[i] - ms[i - 1]);
  return { median: median(ms), jitter: ms.length > 1 ? jitter / (ms.length - 1) : 0, count: ms.length };
}

/** Next request size: aim for targetMs per request, changing by at most 2x. */
export function nextSize(current, elapsedMs, { targetMs = 1000, min = 256 << 10, max = 64 << 20 } = {}) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return current;
  const ratio = Math.max(0.5, Math.min(2, targetMs / elapsedMs));
  return Math.max(min, Math.min(max, Math.round(current * ratio)));
}
