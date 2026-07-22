// Scope-style live throughput chart. Two series on one shared timeline:
// RX (download) then TX (upload). Crosshair + tooltip on hover; the DOM legend
// and the details table carry the same information as text.

import { readTokens, reducedMotion } from './theme.js';
// The scope is a fixed-Mbps instrument (its Y axis is in Mbps), so its tooltip
// uses the always-Mbps formatter rather than the unit-switching one.
import { fmtMbpsFixed as fmtMbps } from './format.js';

const PAD = { top: 12, right: 34, bottom: 22, left: 40 };
const Y_CEILINGS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

function withAlpha(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export class Trace {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltip = tooltipEl;
    this.ctx = canvas.getContext('2d');
    this.tokens = readTokens(canvas);
    this.series = { down: [], up: [] };
    this.live = false;
    this.cursor = null; // hovered x in seconds

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    window.addEventListener('themechange', () => {
      this.tokens = readTokens(this.canvas);
      this.draw();
    });
    if (document.fonts?.ready) document.fonts.ready.then(() => this.draw());

    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => {
      this.cursor = null;
      this.tooltip.hidden = true;
      this.draw();
    });
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = rect.width;
    this.h = rect.height;
    this.draw();
  }

  reset() {
    this.series = { down: [], up: [] };
    this.live = true;
    this.cursor = null;
    this.tooltip.hidden = true;
    this.draw();
  }

  finish() {
    this.live = false;
    this.draw();
  }

  addSample(kind, x, v) {
    if (!Number.isFinite(x) || !Number.isFinite(v)) return;
    this.series[kind].push({ x, v: Math.max(0, v) });
    this.draw();
  }

  extent() {
    const all = [...this.series.down, ...this.series.up];
    let lastX = 0;
    let maxV = 0;
    for (const p of all) {
      if (p.x > lastX) lastX = p.x;
      if (p.v > maxV) maxV = p.v;
    }
    const xMax = Math.max(20, Math.ceil(lastX + 2));
    const yMax = Y_CEILINGS.find((c) => c >= maxV * 1.05) || Y_CEILINGS[Y_CEILINGS.length - 1];
    return { xMax, yMax, hasData: all.length > 0 };
  }

  sx(x, xMax) { return PAD.left + ((this.w - PAD.left - PAD.right) * x) / xMax; }
  sy(v, yMax) { return this.h - PAD.bottom - ((this.h - PAD.top - PAD.bottom) * v) / yMax; }

  onMove(e) {
    const { xMax, yMax, hasData } = this.extent();
    if (!hasData) return;
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const x = ((px - PAD.left) / (this.w - PAD.left - PAD.right)) * xMax;
    if (x < 0 || x > xMax) { this.cursor = null; this.tooltip.hidden = true; this.draw(); return; }
    this.cursor = x;
    this.draw();

    const nearest = (arr) => {
      let best = null;
      for (const p of arr) {
        if (best === null || Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
      }
      return best && Math.abs(best.x - x) <= 0.75 ? best : null;
    };
    const d = nearest(this.series.down);
    const u = nearest(this.series.up);
    if (!d && !u) { this.tooltip.hidden = true; return; }
    const parts = [`${x.toFixed(1)} s`];
    if (d) parts.push(`RX ${fmtMbps(d.v)} Mbps`);
    if (u) parts.push(`TX ${fmtMbps(u.v)} Mbps`);
    this.tooltip.textContent = parts.join(' · ');
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    const tx = Math.min(Math.max(px - tw / 2, 4), this.w - tw - 4);
    this.tooltip.style.left = `${tx}px`;
    this.tooltip.style.top = `${Math.max(4, this.sy(Math.max(d?.v || 0, u?.v || 0), yMax) - 36)}px`;
  }

  drawSeries(points, base, glow, xMax, yMax) {
    if (points.length < 2) return;
    const { ctx } = this;
    const y0 = this.h - PAD.bottom;

    // area fill
    ctx.beginPath();
    ctx.moveTo(this.sx(points[0].x, xMax), y0);
    for (const p of points) ctx.lineTo(this.sx(p.x, xMax), this.sy(p.v, yMax));
    ctx.lineTo(this.sx(points[points.length - 1].x, xMax), y0);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, PAD.top, 0, y0);
    grad.addColorStop(0, withAlpha(base, 0.24));
    grad.addColorStop(1, withAlpha(base, 0));
    ctx.fillStyle = grad;
    ctx.fill();

    // line
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const px = this.sx(points[i].x, xMax);
      const py = this.sy(points[i].v, yMax);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = base;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // leading dot (bright while live)
    const last = points[points.length - 1];
    ctx.beginPath();
    ctx.arc(this.sx(last.x, xMax), this.sy(last.v, yMax), 3, 0, Math.PI * 2);
    ctx.fillStyle = this.live ? glow : base;
    if (this.live && !reducedMotion()) {
      ctx.shadowColor = glow;
      ctx.shadowBlur = 8;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  labelSeries(points, name, base, xMax, yMax) {
    if (points.length < 2) return;
    const last = points[points.length - 1];
    const px = this.sx(last.x, xMax);
    const py = this.sy(last.v, yMax);
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(px + 10, py, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = base;
    ctx.fill();
    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.tokens.ink2;
    ctx.fillText(name, px + 16, py);
  }

  draw() {
    const { ctx, tokens: t } = this;
    if (!this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);
    const { xMax, yMax, hasData } = this.extent();
    const y0 = this.h - PAD.bottom;

    // grid
    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 4; i++) {
      const v = (yMax * i) / 4;
      const y = this.sy(v, yMax);
      ctx.beginPath();
      ctx.moveTo(PAD.left, y);
      ctx.lineTo(this.w - PAD.right, y);
      ctx.strokeStyle = i === 0 ? t.hairline : t.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      if (i === 2 || i === 4) {
        ctx.fillStyle = t.muted;
        ctx.textAlign = 'right';
        ctx.fillText(v % 1 === 0 ? String(v) : v.toFixed(1), PAD.left - 6, y);
      }
    }
    // x ticks every 5 s
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= xMax; s += 5) {
      const x = this.sx(s, xMax);
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + 4);
      ctx.strokeStyle = t.hairline;
      ctx.stroke();
      ctx.fillStyle = t.muted;
      ctx.fillText(`${s}s`, x, y0 + 7);
    }

    if (!hasData) {
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('run a test to draw the trace', this.w / 2, (PAD.top + y0) / 2);
      return;
    }

    this.drawSeries(this.series.down, t.rx, t.rxGlow, xMax, yMax);
    this.drawSeries(this.series.up, t.tx, t.txGlow, xMax, yMax);
    this.labelSeries(this.series.down, 'RX', t.rx, xMax, yMax);
    this.labelSeries(this.series.up, 'TX', t.tx, xMax, yMax);

    // crosshair
    if (this.cursor != null) {
      const x = this.sx(this.cursor, xMax);
      ctx.beginPath();
      ctx.moveTo(x, PAD.top);
      ctx.lineTo(x, y0);
      ctx.strokeStyle = t.hairline;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}
