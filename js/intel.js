// Community "network intel" layer: talks to the server's /api/* endpoints and
// renders the crowdsourced leaderboard, the outage/degradation banner, the
// time-of-day patterns chart, and the embeddable badge. Every fetch degrades to
// null when the API is unreachable (e.g. the page isn't served by server.js),
// and the caller simply hides the panel.

import { readTokens } from './theme.js';
import { fmtMbps, fmtMs, speedUnitLabel } from './format.js';

const STATUS = {
  good: { icon: '✓', label: 'Healthy', cls: 'good' },
  warning: { icon: '▲', label: 'Slower than usual', cls: 'warning' },
  serious: { icon: '▲', label: 'Degraded', cls: 'serious' },
  critical: { icon: '✕', label: 'Possible outage', cls: 'critical' },
  unknown: { icon: '·', label: 'No recent data', cls: 'unknown' },
};

async function getJson(url, opts) {
  try {
    const res = await fetch(url, { cache: 'no-store', ...opts });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
}

export function submitResult(result) {
  const g = result.geo || {};
  const body = {
    isp: g.isp, asn: g.asn,
    city: g.city, region: g.region, country: g.country, postal: g.postal,
    down: result.down, up: result.up,
    ping: result.ping, jitter: result.jitter, loss: result.loss,
  };
  if (!body.isp || !body.city || body.down == null) return Promise.resolve(null);
  return getJson('/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const fetchLeaderboard = ({ city, postal }) =>
  getJson(`/api/leaderboard?city=${encodeURIComponent(city || '')}&postal=${encodeURIComponent(postal || '')}`);

export const fetchPatterns = ({ isp, city }) =>
  getJson(`/api/patterns?isp=${encodeURIComponent(isp || '')}&city=${encodeURIComponent(city || '')}`);

export const fetchOutage = ({ isp, city }) =>
  getJson(`/api/outage?isp=${encodeURIComponent(isp || '')}&city=${encodeURIComponent(city || '')}`);

// ---- outage banner ----------------------------------------------------------

export function renderOutage(el, data, geo) {
  if (!data || data.status === 'unknown' || data.status === 'good') {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  const s = STATUS[data.status] || STATUS.unknown;
  el.className = `outage outage-${s.cls}`;
  el.textContent = '';
  const icon = document.createElement('span');
  icon.className = 'outage-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = s.icon;
  const text = document.createElement('span');
  const where = [geo?.isp, geo?.city].filter(Boolean).join(' in ') || 'This network';
  text.innerHTML = `<strong>${escapeHtml(where)}</strong> is running ${Math.abs(data.deltaPct)}% `
    + `below its 30-day median (${fmtMbps(data.recent)} vs ${fmtMbps(data.baseline)} ${speedUnitLabel()} down) — `
    + `${s.label.toLowerCase()} from ${data.recentSamples} recent report${data.recentSamples === 1 ? '' : 's'}.`;
  el.append(icon, text);
  el.hidden = false;
}

// ---- leaderboard ------------------------------------------------------------

export function renderLeaderboard(el, data, highlightIsp) {
  el.textContent = '';
  if (!data || !data.isps.length) {
    const p = document.createElement('p');
    p.className = 'intel-empty';
    p.textContent = data
      ? 'No reports yet for this city. Run a test to be the first.'
      : 'Leaderboard needs the SpeedUndo server — start it with “node server.js”.';
    el.appendChild(p);
    return;
  }
  const maxDown = Math.max(...data.isps.map((i) => i.down || 0), 1);
  const hl = (highlightIsp || '').toLowerCase();
  data.isps.forEach((isp, i) => {
    const s = STATUS[isp.health?.status] || STATUS.unknown;
    const row = document.createElement('article');
    row.className = 'lb-row';
    if (isp.isp.toLowerCase() === hl) row.classList.add('lb-you');

    const rank = document.createElement('span');
    rank.className = 'lb-rank';
    rank.textContent = String(i + 1);

    const main = document.createElement('div');
    main.className = 'lb-main';
    const name = document.createElement('div');
    name.className = 'lb-name';
    name.innerHTML = `${escapeHtml(isp.isp)}`
      + (isp.isp.toLowerCase() === hl ? ' <span class="lb-youtag">you</span>' : '')
      + (isp.asn ? ` <span class="lb-asn">AS${isp.asn}</span>` : '');
    const barWrap = document.createElement('div');
    barWrap.className = 'lb-bar-wrap';
    const bar = document.createElement('span');
    bar.className = 'lb-bar';
    bar.style.width = `${Math.max(3, ((isp.down || 0) / maxDown) * 100)}%`;
    barWrap.appendChild(bar);
    main.append(name, barWrap);

    const nums = document.createElement('div');
    nums.className = 'lb-nums';
    nums.innerHTML = `<span class="lb-down">${fmtMbps(isp.down)}<i>↓</i></span>`
      + `<span>${fmtMbps(isp.up)}<i>↑</i></span>`
      + `<span>${fmtMs(isp.ping)}<i>ms</i></span>`
      + `<span>${isp.samples}<i>tests</i></span>`;

    const chip = document.createElement('span');
    chip.className = `status-chip status-${s.cls}`;
    chip.innerHTML = `<span aria-hidden="true">${s.icon}</span>${s.label}`;

    row.append(rank, main, nums, chip);
    el.appendChild(row);
  });
}

// ---- time-of-day patterns chart ---------------------------------------------

const P = { top: 14, right: 12, bottom: 22, left: 34 };

export class PatternsChart {
  constructor(canvas, tooltipEl) {
    this.canvas = canvas;
    this.tooltip = tooltipEl;
    this.ctx = canvas.getContext('2d');
    this.tokens = readTokens(canvas);
    this.hours = [];
    this.hover = -1;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    window.addEventListener('themechange', () => { this.tokens = readTokens(this.canvas); this.draw(); });
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerleave', () => { this.hover = -1; this.tooltip.hidden = true; this.draw(); });
    if (document.fonts?.ready) document.fonts.ready.then(() => this.draw());
    this.resize();
  }

  setData(hours) {
    this.hours = hours || [];
    this.draw();
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

  bandX(i) {
    const inner = this.w - P.left - P.right;
    return P.left + (inner * i) / 24;
  }

  onMove(e) {
    if (!this.hours.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const inner = this.w - P.left - P.right;
    const i = Math.floor(((x - P.left) / inner) * 24);
    if (i < 0 || i > 23) { this.hover = -1; this.tooltip.hidden = true; this.draw(); return; }
    this.hover = i;
    this.draw();
    const hr = this.hours[i];
    const label = `${String(i).padStart(2, '0')}:00`;
    this.tooltip.textContent = hr && hr.down != null
      ? `${label} · ${fmtMbps(hr.down)}↓ ${fmtMbps(hr.up)}↑ ${speedUnitLabel()} · ${hr.samples} tests`
      : `${label} · no data`;
    this.tooltip.hidden = false;
    const tw = this.tooltip.offsetWidth;
    this.tooltip.style.left = `${Math.min(Math.max(this.bandX(i) - tw / 2, 4), this.w - tw - 4)}px`;
    this.tooltip.style.top = '2px';
  }

  draw() {
    const { ctx, tokens: t } = this;
    if (!this.w) return;
    ctx.clearRect(0, 0, this.w, this.h);
    const y0 = this.h - P.bottom;
    const vals = this.hours.map((x) => x.down).filter((v) => v != null);
    const maxV = Math.max(...vals, 1);
    const ceil = niceCeil(maxV);

    // gridlines + y labels
    ctx.font = '10px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    for (let g = 0; g <= 2; g++) {
      const v = (ceil * g) / 2;
      const y = y0 - ((y0 - P.top) * g) / 2;
      ctx.beginPath();
      ctx.moveTo(P.left, y);
      ctx.lineTo(this.w - P.right, y);
      ctx.strokeStyle = g === 0 ? t.hairline : t.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'right';
      ctx.fillText(String(Math.round(v)), P.left - 6, y);
    }

    if (!vals.length) {
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'center';
      ctx.fillText('no pattern data yet', this.w / 2, (P.top + y0) / 2);
      return;
    }

    // bars — download median per local hour, single series (rx)
    const inner = this.w - P.left - P.right;
    const bw = (inner / 24) * 0.66;
    for (let i = 0; i < 24; i++) {
      const hr = this.hours[i];
      if (!hr || hr.down == null) continue;
      const x = this.bandX(i) + (inner / 24 - bw) / 2;
      const bh = ((y0 - P.top) * hr.down) / ceil;
      const y = y0 - bh;
      ctx.fillStyle = i === this.hover ? t.rxGlow : t.rx;
      roundRectTop(ctx, x, y, bw, bh, 3);
      ctx.fill();
    }

    // x labels every 6h
    ctx.fillStyle = t.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 24; i += 6) {
      ctx.fillText(`${String(i % 24).padStart(2, '0')}h`, this.bandX(i), y0 + 6);
    }

    // direct-label the worst (lowest non-null) hour — the congestion trough
    let lo = -1;
    for (let i = 0; i < 24; i++) {
      const hr = this.hours[i];
      if (!hr || hr.down == null) continue;
      if (lo < 0 || hr.down < this.hours[lo].down) lo = i;
    }
    if (lo >= 0) {
      const hr = this.hours[lo];
      const x = this.bandX(lo) + inner / 48;
      const y = y0 - ((y0 - P.top) * hr.down) / ceil - 6;
      ctx.fillStyle = t.ink2;
      ctx.font = '9.5px "IBM Plex Mono", ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText('slowest', x, y);
    }
  }
}

// ---- embed / badge ----------------------------------------------------------

export function embedFor({ isp, city }, origin) {
  const q = `city=${encodeURIComponent(city || '')}&isp=${encodeURIComponent(isp || '')}&metric=down`;
  const badge = `${origin}/api/badge.svg?${q}`;
  const stats = `${origin}/api/stats?${q}`;
  return {
    badge, stats,
    html: `<a href="${origin}"><img alt="SpeedUndo speed" src="${badge}"></a>`,
    markdown: `[![SpeedUndo speed](${badge})](${origin})`,
  };
}

// ---- helpers ----------------------------------------------------------------

function niceCeil(v) {
  const steps = [10, 25, 50, 100, 150, 250, 500, 750, 1000, 2500, 5000];
  return steps.find((s) => s >= v * 1.08) || Math.ceil(v * 1.1);
}

function roundRectTop(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
