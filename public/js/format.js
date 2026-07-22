// Number/date formatting shared by tiles, gauge, trace, and history.
// Speed and date/time formatting honor the user's global settings; the raw
// measurement values stay in Mbps/ms internally and are only converted here
// for display.

import { getSetting } from './settings.js';

const SPEED_LABEL = { mbps: 'Mbps', kbps: 'Kbps' };

function speedUnit() {
  return getSetting('speed') === 'kbps' ? 'kbps' : 'mbps';
}

export function speedUnitLabel() {
  return SPEED_LABEL[speedUnit()];
}

// Format a throughput value (always given in Mbps internally) in the unit the
// user picked. Used everywhere a speed number is shown next to a unit label.
export function fmtMbps(v) {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  const val = speedUnit() === 'kbps' ? v * 1000 : v;
  if (val < 10) return val.toFixed(2);
  if (val < 100) return val.toFixed(1);
  return String(Math.round(val));
}

// Always-Mbps formatter for the decorative instrument scales (gauge dial and
// oscilloscope trace) so their fixed axis/tooltip stay internally consistent
// regardless of the chosen display unit.
export function fmtMbpsFixed(v) {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  if (v < 10) return v.toFixed(2);
  if (v < 100) return v.toFixed(1);
  return String(Math.round(v));
}

export function distanceUnitLabel() {
  return getSetting('distance') === 'km' ? 'km' : 'mi';
}

// Format a distance given canonically in kilometres into the chosen unit.
export function fmtDistance(km) {
  if (km == null || !Number.isFinite(km) || km < 0) return '—';
  const v = getSetting('distance') === 'km' ? km : km * 0.621371;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

export function fmtMs(v) {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  if (v < 10) return v.toFixed(1);
  return String(Math.round(v));
}

export function fmtPct(v) {
  if (v == null || !Number.isFinite(v) || v < 0) return '—';
  if (v === 0) return '0';
  if (v < 10) return v.toFixed(1);
  return String(Math.round(v));
}

export function fmtBytes(b) {
  if (b == null || !Number.isFinite(b) || b < 0) return '—';
  const units = ['B', 'kB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
  return `${i > 0 && b < 10 ? b.toFixed(1) : Math.round(b)} ${units[i]}`;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Date in the user's chosen order/separators.
export function fmtDate(ts) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  switch (getSetting('date')) {
    case 'DMY': return `${dd}/${mm}/${yyyy}`;
    case 'YMD': return `${yyyy}-${mm}-${dd}`;
    case 'MDY':
    default: return `${mm}/${dd}/${yyyy}`;
  }
}

// Time in 12- or 24-hour form per settings.
export function fmtTime(ts) {
  const d = new Date(ts);
  const h = d.getHours();
  const min = pad2(d.getMinutes());
  if (getSetting('time') === '24h') return `${pad2(h)}:${min}`;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${h12}:${min} ${ap}`;
}

export function fmtDateTime(ts) {
  return `${fmtDate(ts)} ${fmtTime(ts)}`;
}

export function fmtStamp(ts) {
  return `${fmtDate(ts)} · ${fmtTime(ts)}`;
}

export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function meanAbsDiff(values) {
  if (values.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < values.length; i++) sum += Math.abs(values[i] - values[i - 1]);
  return sum / (values.length - 1);
}
