import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeThroughput, trimmedMean, summarizeLatency, nextSize, bytesAt } from '../web/analysis.js';

// 100 Mbps (12.5 MB/s) for 0-5 s, then 50 Mbps (6.25 MB/s) for 5-10 s, sampled every 100 ms.
const samples = [];
for (let t = 0; t <= 10000; t += 100) {
  const bytes = t <= 5000 ? 12500 * t : 12500 * 5000 + 6250 * (t - 5000);
  samples.push({ t, bytes });
}

test('warm-up is excluded from the plain average', () => {
  const s = summarizeThroughput(samples, { startT: 0, warmupMs: 5000, endT: 10000 });
  assert.ok(Math.abs(s.mean - 50) < 1e-9);
  const all = summarizeThroughput(samples, { startT: 0, warmupMs: 0, endT: 10000 });
  assert.ok(Math.abs(all.mean - 75) < 1e-9);
});

test('trimmed mean drops slowest 30% and fastest 10% of slices', () => {
  // 1 s slices: five at 100, five at 50. Drop 3 lowest and 1 highest -> 50,50,100,100,100,100.
  const s = summarizeThroughput(samples, { startT: 0, warmupMs: 0, endT: 10000, sliceMs: 1000 });
  assert.ok(Math.abs(s.trimmed - 500 / 6) < 1e-9);
  assert.equal(s.median, 75);
});

test('trimmedMean on explicit values', () => {
  assert.equal(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), (4 + 5 + 6 + 7 + 8 + 9) / 6);
});

test('bytesAt interpolates between samples', () => {
  assert.equal(bytesAt([{ t: 0, bytes: 0 }, { t: 100, bytes: 1000 }], 25), 250);
});

test('latency median and jitter', () => {
  assert.deepEqual(summarizeLatency([10, 14, 12, 20]), { median: 13, jitter: (4 + 2 + 8) / 3, count: 4 });
});

test('request size adapts toward the target, at most 2x per step', () => {
  assert.equal(nextSize(1 << 20, 250), 2 << 20);
  assert.equal(nextSize(4 << 20, 2000), 2 << 20);
  assert.equal(nextSize(1 << 20, 0), 1 << 20);
});

import { liveEstimate } from '../web/analysis.js';

// Steady 100 Mbps (12500 bytes/ms) for 20 s, except a stall from 10.0 to 10.5 s.
const steady = [];
let b = 0;
for (let t = 0; t <= 20000; t += 50) {
  if (t > 0 && !(t > 10000 && t <= 10500)) b += 12500 * 50;
  steady.push({ t, bytes: b });
}

test('live estimate ends exactly at the final result', () => {
  const final = summarizeThroughput(steady, { startT: 0, warmupMs: 5000, endT: 20000 });
  assert.equal(liveEstimate(steady, { startT: 0, warmupMs: 5000, now: 20000, mode: 'trimmed' }), final.trimmed);
  assert.equal(liveEstimate(steady, { startT: 0, warmupMs: 5000, now: 20000, mode: 'mean' }), final.mean);
});

test('live estimate does not follow a momentary stall', () => {
  // Right after the stall, a 1 s instantaneous window would read 50 Mbps.
  const v = liveEstimate(steady, { startT: 0, warmupMs: 5000, now: 10500, mode: 'trimmed' });
  assert.ok(v > 99, `estimate ${v}`);
});

test('live estimate is empty for the first instant, then climbs during warm-up', () => {
  assert.equal(liveEstimate(steady, { startT: 0, warmupMs: 5000, now: 600 }), null);
  assert.ok(Math.abs(liveEstimate(steady, { startT: 0, warmupMs: 5000, now: 2000 }) - 100) < 1e-9);
});
