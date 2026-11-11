// Animated SVG speedometer. Non-linear scale (like Ookla's) so both slow and
// fast links use most of the dial; it steps up to a bigger scale when exceeded.

const NS = 'http://www.w3.org/2000/svg';
const SCALES = [
  [0, 5, 10, 50, 100, 250, 500, 750, 1000],
  [0, 50, 100, 500, 1000, 2500, 5000, 7500, 10000],
  [0, 500, 1000, 5000, 10000, 25000, 50000, 75000, 100000],
];
const START = 135; // degrees, clockwise from +x; dial sweeps 270°
const SWEEP = 270;
const CX = 160, CY = 160, R = 128;

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
    const svg = el('svg', { viewBox: '0 0 320 290', class: 'gauge-svg', role: 'img', 'aria-label': 'Speedometer' });
    const defs = el('defs', {}, svg);
    for (const [id, a, b] of [['g-download', '--down', '--down2'], ['g-upload', '--up', '--up2']]) {
      const g = el('linearGradient', { id, x1: '0', y1: '1', x2: '1', y2: '0' }, defs);
      el('stop', { offset: '0', style: `stop-color: var(${a})` }, g);
      el('stop', { offset: '1', style: `stop-color: var(${b})` }, g);
    }
    const glow = el('filter', { id: 'glow', x: '-30%', y: '-30%', width: '160%', height: '160%' }, defs);
    el('feGaussianBlur', { stdDeviation: '6', result: 'b' }, glow);
    const merge = el('feMerge', {}, glow);
    el('feMergeNode', { in: 'b' }, merge);
    el('feMergeNode', { in: 'SourceGraphic' }, merge);

    el('path', { d: arcPath(R), class: 'g-track', pathLength: 1 }, svg);
    this.fill = el('path', { d: arcPath(R), class: 'g-fill', pathLength: 1, filter: 'url(#glow)', 'stroke-dasharray': '0 1' }, svg);
    this.ticks = el('g', { class: 'g-ticks' }, svg);
    this.needle = el('g', { class: 'g-needle' }, svg);
    el('path', { d: `M ${CX - 4} ${CY} L ${CX + R - 22} ${CY - 1.2} L ${CX + R - 22} ${CY + 1.2} Z`, class: 'g-needle-body' }, this.needle);
    el('circle', { cx: CX, cy: CY, r: 12, class: 'g-hub' }, svg);
    el('circle', { cx: CX, cy: CY, r: 4, class: 'g-hub-dot' }, svg);
    container.replaceChildren(svg);
    this.svg = svg;
    this.drawTicks();
    this.render();
    this.tick = this.tick.bind(this);
  }

  get scale() {
    return SCALES[this.scaleIndex];
  }

  drawTicks() {
    this.ticks.replaceChildren();
    const s = this.scale;
    s.forEach((v, i) => {
      const deg = START + (SWEEP * i) / (s.length - 1);
      const [x0, y0] = polar(deg, R - 16);
      const [x1, y1] = polar(deg, R - 24);
      el('line', { x1: x0, y1: y0, x2: x1, y2: y1 }, this.ticks);
      const [tx, ty] = polar(deg, R - 40);
      const t = el('text', { x: tx, y: ty + 4, 'text-anchor': 'middle' }, this.ticks);
      t.textContent = label(v);
    });
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
    // Critically damped approach: smooth, no overshoot, frame-rate independent.
    this.value += (this.target - this.value) * (1 - Math.exp(-dt / 140));
    if (Math.abs(this.target - this.value) < 0.001 * Math.max(1, this.target)) this.value = this.target;
    this.render();
    if (this.value !== this.target) this.raf = requestAnimationFrame(this.tick);
    else this.raf = this.last = null;
  }

  render() {
    const f = this.fraction(this.value);
    this.fill.setAttribute('stroke-dasharray', `${f} 1`);
    this.fill.style.opacity = f > 0.002 ? 1 : 0;
    this.fill.setAttribute('stroke', `url(#g-${this.mode})`);
    this.needle.setAttribute('transform', `rotate(${START + SWEEP * f} ${CX} ${CY})`);
  }
}
