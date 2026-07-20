// Canvas gauge: 270° arc, piecewise-linear scale over Ookla-style stops, thin
// needle, and the signature phosphor afterglow trail while a test is running.
// The numeral in the middle is real DOM text (main.js) — this canvas is
// aria-hidden decoration around it.

import { readTokens, reducedMotion } from './theme.js';

const STOPS = [0, 1, 5, 10, 20, 50, 100, 250, 500, 1000];
const START_DEG = 135;
const SWEEP_DEG = 270;
const TRAIL_LIFE_MS = 650;

const rad = (deg) => (deg * Math.PI) / 180;

function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function speedToFrac(v) {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= STOPS[STOPS.length - 1]) return 1;
  let i = 0;
  while (v > STOPS[i + 1]) i++;
  const lo = STOPS[i];
  const hi = STOPS[i + 1];
  return (i + (v - lo) / (hi - lo)) / (STOPS.length - 1);
}

export class Gauge {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.tokens = readTokens(canvas);
    this.kind = 'idle';        // idle | ping | down | up | done
    this.target = 0;           // Mbps
    this.current = 0;          // eased Mbps
    this.needleFrac = 0;       // needle position — tracks current, parks to 0
    this.parkRaf = null;
    this.parkTimer = null;
    this.trail = [];           // [{frac, at}]
    this.raf = null;
    this.size = 0;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    window.addEventListener('themechange', () => {
      this.tokens = readTokens(this.canvas);
      if (!this.raf) this.draw();
    });
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (!this.raf) this.draw(); });
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const s = Math.max(10, Math.min(rect.width, rect.height));
    this.size = s;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.raf) this.draw();
  }

  cancelPark() {
    if (this.parkRaf) { cancelAnimationFrame(this.parkRaf); this.parkRaf = null; }
    if (this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = null; }
  }

  setKind(kind) {
    this.kind = kind;
    if (kind === 'idle' || kind === 'ping') {
      this.target = 0;
      this.current = 0;
      this.needleFrac = 0;
      this.trail = [];
      this.cancelPark();
    }
    if (!this.raf) this.draw();
  }

  setValue(mbps) {
    this.target = Math.max(0, mbps || 0);
  }

  start() {
    if (this.raf) return;
    this.cancelPark();
    const tick = () => {
      this.current = reducedMotion()
        ? this.target
        : this.current + (this.target - this.current) * 0.14;
      this.needleFrac = speedToFrac(this.current);
      if (!reducedMotion() && (this.kind === 'down' || this.kind === 'up')) {
        this.trail.push({ frac: this.needleFrac, at: performance.now() });
        const cutoff = performance.now() - TRAIL_LIFE_MS;
        while (this.trail.length && this.trail[0].at < cutoff) this.trail.shift();
      }
      this.draw();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.trail = [];
    this.current = this.target;
    this.needleFrac = speedToFrac(this.current);
    this.draw();
  }

  // Wind the whole instrument back to rest — needle home, arc draining, and
  // the live value easing to 0 (reported via onValue so the DOM readout can
  // count down in sync). A real meter reads zero when the run is over; the
  // result lives in the tiles/history, not the dial.
  park(onValue) {
    if (this.parkRaf) cancelAnimationFrame(this.parkRaf);
    if (this.parkTimer) clearTimeout(this.parkTimer);
    const finish = () => {
      if (this.parkRaf) cancelAnimationFrame(this.parkRaf);
      this.parkRaf = null;
      this.parkTimer = null;
      this.needleFrac = 0;
      this.current = 0;
      this.target = 0;
      if (onValue) onValue(0);
      this.draw();
    };
    if (reducedMotion()) {
      finish();
      return;
    }
    const fromFrac = this.needleFrac;
    const fromVal = this.current;
    const t0 = performance.now();
    const dur = 850;
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / dur);
      const ease = 1 - (1 - k) ** 3; // ease-out cubic
      this.needleFrac = fromFrac * (1 - ease);
      this.current = fromVal * (1 - ease);
      this.target = this.current;
      if (onValue) onValue(this.current);
      this.draw();
      this.parkRaf = k < 1 ? requestAnimationFrame(step) : null;
      if (k >= 1 && this.parkTimer) { clearTimeout(this.parkTimer); this.parkTimer = null; }
    };
    this.parkRaf = requestAnimationFrame(step);
    // rAF pauses in hidden tabs — guarantee the dial lands on 0 regardless.
    this.parkTimer = setTimeout(finish, dur + 250);
  }

  accent() {
    const t = this.tokens;
    switch (this.kind) {
      case 'ping': return { base: t.lat, glow: t.latGlow };
      case 'up': return { base: t.tx, glow: t.txGlow };
      case 'down':
      case 'done': return { base: t.rx, glow: t.rxGlow };
      default: return { base: t.muted, glow: t.muted };
    }
  }

  draw() {
    const { ctx, size: s, tokens: t } = this;
    const rect = this.canvas.getBoundingClientRect();
    const r = s / 2 - 30;
    if (!rect.width || !rect.height || r <= 0) return; // not laid out yet
    ctx.clearRect(0, 0, rect.width, rect.height);
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const trackW = 12;
    const a0 = rad(START_DEG);
    const frac = speedToFrac(this.current);
    const aNow = rad(START_DEG + SWEEP_DEG * frac);
    const aNeedle = rad(START_DEG + SWEEP_DEG * this.needleFrac);
    const { base, glow } = this.accent();

    // Track
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, rad(START_DEG + SWEEP_DEG));
    ctx.strokeStyle = t.hairline;
    ctx.lineWidth = trackW;
    ctx.lineCap = 'round';
    ctx.stroke();

    // Afterglow trail — decaying wake behind the live position
    if (this.trail.length > 1) {
      const now = performance.now();
      for (let i = 1; i < this.trail.length; i++) {
        const p0 = this.trail[i - 1];
        const p1 = this.trail[i];
        if (Math.abs(p1.frac - p0.frac) < 1e-5) continue;
        const age = (now - p1.at) / TRAIL_LIFE_MS;
        ctx.beginPath();
        ctx.arc(
          cx, cy, r,
          rad(START_DEG + SWEEP_DEG * Math.min(p0.frac, p1.frac)),
          rad(START_DEG + SWEEP_DEG * Math.max(p0.frac, p1.frac)),
        );
        ctx.strokeStyle = glow;
        ctx.globalAlpha = Math.max(0, (1 - age) * 0.28);
        ctx.lineWidth = trackW + 6;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Progress arc
    if (frac > 0.001 && this.kind !== 'idle') {
      const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
      grad.addColorStop(0, base);
      grad.addColorStop(1, glow);
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, aNow);
      ctx.strokeStyle = grad;
      ctx.lineWidth = trackW;
      ctx.lineCap = 'round';
      ctx.shadowColor = glow;
      ctx.shadowBlur = reducedMotion() ? 0 : 16;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Ticks + labels
    ctx.font = '10.5px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const n = STOPS.length - 1;
    for (let i = 0; i <= n; i++) {
      const a = rad(START_DEG + (SWEEP_DEG * i) / n);
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + cos * (r + 10), cy + sin * (r + 10));
      ctx.lineTo(cx + cos * (r + 16), cy + sin * (r + 16));
      ctx.strokeStyle = t.muted;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = t.muted;
      ctx.fillText(String(STOPS[i]), cx + cos * (r - 26), cy + sin * (r - 26));
      // minor tick at segment midpoint
      if (i < n) {
        const am = rad(START_DEG + (SWEEP_DEG * (i + 0.5)) / n);
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(am) * (r + 10), cy + Math.sin(am) * (r + 10));
        ctx.lineTo(cx + Math.cos(am) * (r + 13), cy + Math.sin(am) * (r + 13));
        ctx.globalAlpha = 0.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // Needle — a tapered blade pivoting at the true center. It fades in away
    // from the hub (the GO button / live numeral sits over the middle, and a
    // solid shaft under the text would be noise), and the tip parks with a
    // small clear gap before the numerals (labels are centered at r - 26).
    const active = this.kind !== 'idle';
    const col = active ? base : t.muted;
    const nCos = Math.cos(aNeedle);
    const nSin = Math.sin(aNeedle);
    const tipR = r - 42;
    const halfW = Math.max(3.5, r * 0.02);
    const tipX = cx + nCos * tipR;
    const tipY = cy + nSin * tipR;
    const perpX = -nSin;
    const perpY = nCos;

    const blade = ctx.createLinearGradient(cx, cy, tipX, tipY);
    blade.addColorStop(0, withAlpha(col, 0));
    blade.addColorStop(0.25, withAlpha(col, 0.55));
    blade.addColorStop(1, col);

    ctx.beginPath();
    ctx.moveTo(cx + perpX * halfW, cy + perpY * halfW);
    ctx.lineTo(tipX + perpX * 0.7, tipY + perpY * 0.7);
    ctx.lineTo(tipX - perpX * 0.7, tipY - perpY * 0.7);
    ctx.lineTo(cx - perpX * halfW, cy - perpY * halfW);
    ctx.closePath();
    ctx.fillStyle = blade;
    if (active && !reducedMotion()) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = 10;
    }
    ctx.fill();
    ctx.shadowBlur = 0;

    // Luminous tip cap — the reading point, floating just off the numerals.
    ctx.beginPath();
    ctx.arc(tipX, tipY, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = active ? glow : t.muted;
    ctx.fill();
  }
}
