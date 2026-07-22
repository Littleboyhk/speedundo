// Results history: localStorage persistence + drawer rendering.
// Bars share one scale (max Mbps across every stored run) so runs compare
// honestly; values are always printed beside the bars in ink.

import { fmtMbps, fmtMs, fmtStamp, speedUnitLabel } from './format.js';

const KEY = 'speedundo.history';
const MAX_ENTRIES = 50;

export function loadHistory() {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

export function saveResult(result) {
  const entries = loadHistory();
  entries.unshift({
    ts: result.ts,
    ping: result.ping,
    jitter: result.jitter,
    down: result.down,
    up: result.up,
    loss: result.loss ?? null,
    loadedRtt: result.loadedRtt,
    colo: result.meta?.colo || null,
    isp: result.geo?.isp || null,
    city: result.geo?.city || null,
    region: result.geo?.region || null,
    postal: result.geo?.postal || null,
    server: result.server,
  });
  const trimmed = entries.slice(0, MAX_ENTRIES);
  try { localStorage.setItem(KEY, JSON.stringify(trimmed)); } catch (_) { /* full */ }
  return trimmed;
}

export function clearHistory() {
  try { localStorage.removeItem(KEY); } catch (_) { /* ignore */ }
}

export function deleteEntry(ts) {
  const entries = loadHistory().filter((e) => e.ts !== ts);
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (_) { /* ignore */ }
  return entries;
}

export function renderHistory(listEl, entries, onDelete) {
  listEl.textContent = '';
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No tests yet. Run one and it will be kept here, in this browser.';
    listEl.appendChild(empty);
    return;
  }
  const maxMbps = Math.max(
    1,
    ...entries.map((e) => Math.max(e.down || 0, e.up || 0)),
  );
  for (const e of entries) {
    const row = document.createElement('article');
    row.className = 'history-row';

    const head = document.createElement('div');
    head.className = 'history-head';
    const stamp = document.createElement('span');
    stamp.className = 'history-stamp';
    stamp.textContent = fmtStamp(e.ts) + (e.colo ? ` · via ${e.colo}` : '');
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'history-del';
    del.setAttribute('aria-label', `Delete result from ${fmtStamp(e.ts)}`);
    del.textContent = '✕';
    del.addEventListener('click', () => onDelete(e.ts));
    head.append(stamp, del);
    row.appendChild(head);

    if (e.isp || e.city || e.postal) {
      const net = document.createElement('div');
      net.className = 'history-net';
      const place = [e.city, e.region, e.postal].filter(Boolean).join(' · ');
      net.textContent = [e.isp, place].filter(Boolean).join(' — ');
      row.appendChild(net);
    }

    for (const [kind, label, value] of [
      ['rx', 'RX', e.down],
      ['tx', 'TX', e.up],
    ]) {
      const line = document.createElement('div');
      line.className = 'history-line';
      const tag = document.createElement('span');
      tag.className = 'history-tag';
      tag.textContent = label;
      const barWrap = document.createElement('span');
      barWrap.className = 'history-bar-wrap';
      const bar = document.createElement('span');
      bar.className = `history-bar history-bar-${kind}`;
      bar.style.width = `${Math.max(2, ((value || 0) / maxMbps) * 100)}%`;
      barWrap.appendChild(bar);
      const val = document.createElement('span');
      val.className = 'history-val';
      val.textContent = `${fmtMbps(value)} ${speedUnitLabel()}`;
      line.append(tag, barWrap, val);
      row.appendChild(line);
    }

    const foot = document.createElement('div');
    foot.className = 'history-foot';
    foot.textContent = `ping ${fmtMs(e.ping)} ms · jitter ${fmtMs(e.jitter)} ms`
      + (e.loss != null ? ` · loss ${e.loss}%` : '')
      + (e.loadedRtt != null ? ` · loaded ${fmtMs(e.loadedRtt)} ms` : '');
    row.appendChild(foot);

    listEl.appendChild(row);
  }
}
