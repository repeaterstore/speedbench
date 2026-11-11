// SpeedBench dial: a 270° instrument face with engraved ticks that light up as
// the needle passes them. Non-linear scale (like Ookla's) that steps up to a
// larger range when a reading exceeds it.

const NS = 'http://www.w3.org/2000/svg';
const SCALES = [
  [0, 5, 10, 50, 100, 250, 500, 750, 1000],
  [0, 50, 100, 500, 1000, 2500, 5000, 7500, 10000],
  [0, 500, 1000, 5000, 10000, 25000, 50000, 75000, 100000],
];
const START = 135; // degrees clockwise from +x; the dial sweeps 270°
const SWEEP = 270;
const CX = 170, CY = 170, R = 138;
const MINOR = 4; // minor ticks between labelled ticks

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
};
const polar = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};
const arcPath = (r) => {
  const [x0, y0] = polar(START, r);
  const [x1, y1] = polar(START + SWEEP, r);
  return `M ${x0} ${y0} A ${r} ${r} 0 1 1 ${x1} ${y1}`;
};
const label = (v) => (v >= 1000 ? `${v / 1000}G` : String(v));

export class Gauge {
  constructor(container) {
    this.scaleIndex = 0;
    this.value = 0;
    this.target = 0;
    this.mode = 'download';
    const svg = el('svg', { viewBox: '0 0 340 300', class: 'dial-svg', 'aria-hidden': 'true' });
    const defs = el('defs', {}, svg);
    for (const m of ['download', 'upload']) {
      const g = el('linearGradient', { id: `arc-${m}`, gradientUnits: 'userSpaceOnUse', x1: 40, y1: 270, x2: 300, y2: 40 }, defs);
      el('stop', { offset: '0', class: `stop-${m}-lo` }, g);
      el('stop', { offset: '1', class: `stop-${m}-hi` }, g);
      // Needle drawn along +x before rotation: faint at the hub, solid at the tip.
      const n = el('linearGradient', { id: `needle-${m}`, gradientUnits: 'userSpaceOnUse', x1: CX, y1: CY, x2: CX + R, y2: CY }, defs);
      el('stop', { offset: '0', class: `stop-${m}-hi`, 'stop-opacity': '0' }, n);
      el('stop', { offset: '0.55', class: `stop-${m}-hi`, 'stop-opacity': '0.55' }, n);
      el('stop', { offset: '1', class: `stop-${m}-hi` }, n);
    }
    const blur = el('filter', { id: 'soft', x: '-20%', y: '-20%', width: '140%', height: '140%' }, defs);
    el('feGaussianBlur', { stdDeviation: '7' }, blur);

    el('circle', { cx: CX, cy: CY, r: R + 18, class: 'd-bezel' }, svg);
    el('path', { d: arcPath(R), class: 'd-track', pathLength: 1 }, svg);
    this.halo = el('path', { d: arcPath(R), class: 'd-halo', pathLength: 1, filter: 'url(#soft)', 'stroke-dasharray': '0 1' }, svg);
    this.fill = el('path', { d: arcPath(R), class: 'd-fill', pathLength: 1, 'stroke-dasharray': '0 1' }, svg);
    this.head = el('circle', { r: 5, class: 'd-head' }, svg);
    this.ticks = el('g', { class: 'd-ticks' }, svg);
    this.needle = el('g', { class: 'd-needle' }, svg);
    el('path', { d: `M ${CX} ${CY - 6} L ${CX + R - 30} ${CY - 1} Q ${CX + R - 27} ${CY} ${CX + R - 30} ${CY + 1} L ${CX} ${CY + 6} Z`, class: 'd-needle-body' }, this.needle);
    el('circle', { cx: CX, cy: CY, r: 10, class: 'd-hub' }, svg);
    el('circle', { cx: CX, cy: CY, r: 3.5, class: 'd-hub-dot' }, svg);
    container.replaceChildren(svg);
    this.svg = svg;
    this.setMode('download');
    this.drawTicks();
    this.render();
    this.tick = this.tick.bind(this);
  }

  get scale() {
    return SCALES[this.scaleIndex];
  }

  drawTicks() {
    this.ticks.replaceChildren();
    this.tickEls = [];
    const s = this.scale;
    const steps = s.length - 1;
    for (let i = 0; i <= steps * MINOR; i++) {
      const f = i / (steps * MINOR);
      const deg = START + SWEEP * f;
      const major = i % MINOR === 0;
      const [x0, y0] = polar(deg, R - 17);
      const [x1, y1] = polar(deg, R - (major ? 29 : 23));
      const line = el('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'major' : 'minor' }, this.ticks);
      this.tickEls.push([f, line]);
      if (major) {
        const [tx, ty] = polar(deg, R - 46);
        const t = el('text', { x: tx, y: ty + 4.5, 'text-anchor': 'middle' }, this.ticks);
        t.textContent = label(s[i / MINOR]);
        this.tickEls.push([f, t]);
      }
    }
    this.lit = -1;
  }

  fraction(v) {
    const s = this.scale;
    if (v <= 0) return 0;
    for (let i = 1; i < s.length; i++) {
      if (v <= s[i]) return (i - 1 + (v - s[i - 1]) / (s[i] - s[i - 1])) / (s.length - 1);
    }
    return 1;
  }

  setMode(mode) {
    this.mode = mode;
    this.svg.dataset.mode = mode;
    this.fill.setAttribute('stroke', `url(#arc-${mode})`);
    this.halo.setAttribute('stroke', `url(#arc-${mode})`);
    this.needle.firstChild.setAttribute('fill', `url(#needle-${mode})`);
  }

  set(v) {
    this.target = Math.max(0, v || 0);
    while (this.target > this.scale[this.scale.length - 1] && this.scaleIndex < SCALES.length - 1) {
      this.scaleIndex++;
      this.drawTicks();
    }
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  reset() {
    this.scaleIndex = 0;
    this.drawTicks();
    this.set(0);
  }

  tick(ts) {
    const dt = this.last ? Math.min(100, ts - this.last) : 16;
    this.last = ts;
    // Exponential approach: smooth, no overshoot, frame-rate independent.
    this.value += (this.target - this.value) * (1 - Math.exp(-dt / 220));
    if (Math.abs(this.target - this.value) < 0.0005 * Math.max(1, this.target)) this.value = this.target;
    this.render();
    if (this.value !== this.target) this.raf = requestAnimationFrame(this.tick);
    else this.raf = this.last = null;
  }

  render() {
    const f = this.fraction(this.value);
    const dash = `${f} 1`;
    this.fill.setAttribute('stroke-dasharray', dash);
    this.halo.setAttribute('stroke-dasharray', dash);
    const on = f > 0.002;
    this.fill.style.opacity = this.halo.style.opacity = this.head.style.opacity = on ? '' : 0;
    const deg = START + SWEEP * f;
    const [hx, hy] = polar(deg, R);
    this.head.setAttribute('cx', hx);
    this.head.setAttribute('cy', hy);
    this.needle.setAttribute('transform', `rotate(${deg} ${CX} ${CY})`);
    // Light every tick and label the needle has reached.
    const lit = on ? this.tickEls.filter(([tf]) => tf <= f + 1e-6).length : 0;
    if (lit !== this.lit) {
      this.tickEls.forEach(([, e], i) => e.classList.toggle('lit', i < lit));
      this.lit = lit;
    }
    this.onFrame?.(this.value);
  }
}
