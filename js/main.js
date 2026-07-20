// UI orchestration: state machine over the engine's events.
// States: idle → running(meta|ping|download|upload) → done | error.

import { SERVERS, SpeedTest } from './engine.js';
import { Gauge } from './gauge.js';
import { Trace } from './trace.js';
import { initTheme, toggleTheme, currentTheme } from './theme.js';
import {
  loadHistory, saveResult, clearHistory, deleteEntry, renderHistory,
} from './history.js';
import {
  fmtMbps, fmtMs, fmtBytes, fmtPct, fmtDateTime, speedUnitLabel,
} from './format.js';
import { getSettings, getSetting, setSetting } from './settings.js';
import { detectIsp } from './geo.js';
import {
  submitResult, fetchLeaderboard, fetchPatterns, fetchOutage,
  renderLeaderboard, renderOutage, PatternsChart, embedFor,
} from './intel.js';
import {
  defaultCaption, drawCard, copyCardToClipboard, downloadCard,
  nativeShare, renderNetworkButtons,
} from './share.js';

const $ = (id) => document.getElementById(id);

const els = {
  themeBtn: $('themeBtn'), historyBtn: $('historyBtn'),
  gaugeCanvas: $('gauge'), goBtn: $('goBtn'),
  reading: $('gaugeReading'), liveValue: $('liveValue'), liveUnit: $('liveUnit'),
  phaseChip: $('phaseChip'), phaseLed: $('phaseLed'), phaseText: $('phaseText'),
  stopBtn: $('stopBtn'), againBtn: $('againBtn'), copyBtn: $('copyBtn'),
  shareBtn: $('shareBtn'), shareModal: $('shareModal'), shareBackdrop: $('shareBackdrop'),
  shareClose: $('shareClose'), shareCard: $('shareCard'), shareCaption: $('shareCaption'),
  shareNets: $('shareNets'), shareDownload: $('shareDownload'),
  shareCopyImg: $('shareCopyImg'), shareNative: $('shareNative'), shareNote: $('shareNote'),
  errorBanner: $('errorBanner'), errorText: $('errorText'), retryBtn: $('retryBtn'),
  pingVal: $('pingVal'), jitterVal: $('jitterVal'), lossVal: $('lossVal'),
  downVal: $('downVal'), upVal: $('upVal'),
  ispLine: $('ispLine'), ispName: $('ispName'), ispWhere: $('ispWhere'),
  outage: $('outage'),
  intel: $('intel'), intelScope: $('intelScope'), leaderboard: $('leaderboard'),
  patterns: $('patterns'), patternsTip: $('patternsTip'), patternsScope: $('patternsScope'),
  badgeImg: $('badgeImg'), embedMd: $('embedMd'), embedHtml: $('embedHtml'),
  statsLink: $('statsLink'),
  traceCanvas: $('trace'), traceTooltip: $('traceTooltip'),
  details: $('details'), detailsBody: $('detailsBody'),
  metaChips: $('metaChips'), serverSelect: $('serverSelect'),
  drawer: $('drawer'), drawerClose: $('drawerClose'),
  historyList: $('historyList'), clearBtn: $('clearBtn'),
  backdrop: $('backdrop'), srStatus: $('srStatus'),
  settingsBtn: $('settingsBtn'), settingsModal: $('settingsModal'),
  settingsBackdrop: $('settingsBackdrop'), settingsClose: $('settingsClose'),
  dateFormat: $('dateFormat'), settingsServerName: $('settingsServerName'),
  settingsServerSelect: $('settingsServerSelect'), settingsChangeServer: $('settingsChangeServer'),
};

const PHASE_LABEL = {
  meta: 'CONNECTING', ping: 'LATENCY',
  download: 'DOWNLOAD', upload: 'UPLOAD',
  loss: 'PACKET LOSS', done: 'COMPLETE',
};
const PHASE_KIND = { ping: 'ping', download: 'down', upload: 'up', loss: 'ping' };

let state = 'idle';
let engine = null;
let lastResult = null;
let lastDownT = 0;
let upOffset = 0;

initTheme();
const gauge = new Gauge(els.gaugeCanvas);
const trace = new Trace(els.traceCanvas, els.traceTooltip);

// ---- helpers ---------------------------------------------------------------

function announce(text) {
  els.srStatus.textContent = text;
}

function setPhaseChip(label, kind) {
  els.phaseText.textContent = label;
  els.phaseLed.dataset.kind = kind || 'idle';
  els.phaseChip.hidden = false;
}

function setReading(valueText, unitText) {
  els.liveValue.textContent = valueText;
  els.liveUnit.textContent = unitText;
}

function setState(next) {
  state = next;
  document.body.dataset.state = next;
  els.goBtn.hidden = next !== 'idle';
  els.reading.hidden = next === 'idle';
  els.stopBtn.hidden = next !== 'running';
  els.againBtn.hidden = !(next === 'done' || next === 'error');
  els.copyBtn.hidden = next !== 'done';
  els.shareBtn.hidden = next !== 'done';
  els.errorBanner.hidden = next !== 'error';
  els.phaseChip.hidden = next === 'idle';
  els.serverSelect.disabled = next === 'running';
  els.settingsServerSelect.disabled = next === 'running';
}

function selectedServer() {
  return SERVERS.find((s) => s.id === getSetting('server')) || SERVERS[0];
}

function renderMetaChips(meta, loadedRtt) {
  els.metaChips.textContent = '';
  const chips = [];
  if (meta?.ip) chips.push(`IP ${meta.ip}`);
  if (meta?.asn) chips.push(`AS${meta.asn}`);
  if (meta?.city) chips.push(meta.city + (meta.country ? `, ${meta.country}` : ''));
  if (meta?.colo) chips.push(`VIA ${meta.colo}`);
  if (loadedRtt != null) chips.push(`LOADED RTT ${fmtMs(loadedRtt)} ms`);
  for (const text of chips) {
    const li = document.createElement('li');
    li.textContent = text;
    els.metaChips.appendChild(li);
  }
}

function fillDetails(r) {
  const u = speedUnitLabel();
  const rows = [
    ['Download avg', `${fmtMbps(r.down)} ${u}`],
    ['Download peak', `${fmtMbps(r.downPeak)} ${u}`],
    ['Data received', `${fmtBytes(r.downBytes)} in ${r.downDur.toFixed(1)} s · 5 streams`],
    ['Upload avg', `${fmtMbps(r.up)} ${u}`],
    ['Upload peak', `${fmtMbps(r.upPeak)} ${u}`],
    ['Data sent', `${fmtBytes(r.upBytes)} in ${r.upDur.toFixed(1)} s · 4 streams`],
    ['Ping (median)', `${fmtMs(r.ping)} ms`],
    ['Jitter', `${fmtMs(r.jitter)} ms`],
    ['Loaded RTT', r.loadedRtt != null ? `${fmtMs(r.loadedRtt)} ms` : '—'],
    ['Packet loss', r.loss != null
      ? `${fmtPct(r.loss)} % (${r.lossMethod === 'tcp'
        ? `TCP retransmits, ${r.lossSent} segments under load`
        : `UDP, ${r.lossReceived}/${r.lossSent} via TURN relay`})`
      : (r.server === 'local' ? 'not measured for LAN tests' : 'unavailable (no relay reachable)')],
  ];
  els.detailsBody.textContent = '';
  for (const [k, v] of rows) {
    const tr = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = k;
    const td = document.createElement('td');
    td.textContent = v;
    tr.append(th, td);
    els.detailsBody.appendChild(tr);
  }
  els.details.hidden = false;
}

function resetTiles() {
  for (const el of [els.pingVal, els.jitterVal, els.lossVal, els.downVal, els.upVal]) {
    el.textContent = '—';
  }
}

// ---- test run ---------------------------------------------------------------

function start() {
  if (state === 'running') return;
  const server = selectedServer();
  lastDownT = 0;
  upOffset = 0;
  resetTiles();
  trace.reset();
  els.details.hidden = true;
  setState('running');
  setPhaseChip(PHASE_LABEL.meta, 'idle');
  setReading('···', '');
  gauge.setKind('ping');
  gauge.start();
  announce('Test started. Connecting to the test server.');

  engine = new SpeedTest(server, {
    phase(name) {
      const kind = PHASE_KIND[name] || 'idle';
      if (name !== 'done') setPhaseChip(PHASE_LABEL[name], kind);
      if (name === 'ping') {
        gauge.setKind('ping');
        setReading('···', 'ms');
        announce('Measuring latency.');
      } else if (name === 'download') {
        gauge.setKind('down');
        gauge.setValue(0);
        setReading('0', speedUnitLabel());
        announce('Measuring download speed.');
      } else if (name === 'upload') {
        upOffset = lastDownT + 1;
        gauge.setKind('up');
        gauge.setValue(0);
        setReading('0', speedUnitLabel());
        announce('Measuring upload speed.');
      } else if (name === 'loss') {
        gauge.setKind('ping');
        setReading('···', '% loss');
        announce('Measuring packet loss over a relay.');
      }
    },
    isp(g) {
      showIspLine(g);
    },
    loss(l) {
      els.lossVal.textContent = l ? fmtPct(l.lossPct) : '—';
    },
    meta(m) {
      renderMetaChips(m, null);
    },
    ping(ms, i, n) {
      setReading(fmtMs(ms), 'ms');
      els.pingVal.textContent = fmtMs(ms);
    },
    sample(kind, t, v) {
      if (kind === 'down') {
        lastDownT = t;
        trace.addSample('down', t, v);
      } else {
        trace.addSample('up', upOffset + t, v);
      }
    },
    live(kind, mbps) {
      gauge.setValue(mbps);
      setReading(fmtMbps(mbps), speedUnitLabel());
      (kind === 'down' ? els.downVal : els.upVal).textContent = fmtMbps(mbps);
    },
    done(result) {
      lastResult = result;
      els.pingVal.textContent = fmtMs(result.ping);
      els.jitterVal.textContent = fmtMs(result.jitter);
      els.lossVal.textContent = result.loss != null ? fmtPct(result.loss) : '—';
      els.downVal.textContent = fmtMbps(result.down);
      els.upVal.textContent = fmtMbps(result.up);
      gauge.setKind('done');
      gauge.setValue(result.down);
      gauge.stop();
      trace.finish();
      // Whole dial winds down to rest — needle, arc, and the center numeral.
      // The result stays in the tiles, details, and history.
      gauge.park((v) => setReading(v === 0 ? '0' : fmtMbps(v), speedUnitLabel()));
      setPhaseChip(PHASE_LABEL.done, 'down');
      renderMetaChips(result.meta, result.loadedRtt);
      fillDetails(result);
      renderHistory(els.historyList, saveResult(result), onDeleteEntry);
      setState('done');
      // Community layer: share (only real-internet tests carry real ISP truth)
      // then refresh the leaderboard/outage/patterns for this connection.
      if (result.server === 'cloudflare' && result.geo) {
        submitResult(result).finally(() => loadIntel(result.geo));
      } else if (result.geo || currentGeo) {
        loadIntel(result.geo || currentGeo);
      }
      const unitWord = getSetting('speed') === 'kbps' ? 'kilobits per second' : 'megabits per second';
      announce(
        `Test complete. Download ${fmtMbps(result.down)} ${unitWord}, `
        + `upload ${fmtMbps(result.up)} ${unitWord}, `
        + `ping ${fmtMs(result.ping)} milliseconds`
        + (result.loss != null ? `, packet loss ${fmtPct(result.loss)} percent.` : '.'),
      );
    },
    error(err, phase) {
      gauge.stop();
      gauge.park();
      trace.finish();
      setState('error');
      setPhaseChip('ERROR', 'idle');
      setReading('—', '');
      els.errorText.textContent = phase
        ? `The ${phase} phase failed: ${err.message} Check your connection and try again.`
        : `The test failed: ${err.message}`;
      announce(els.errorText.textContent);
    },
    aborted() {
      gauge.setKind('idle');
      gauge.stop();
      trace.finish();
      setState('idle');
      setReading('—', '');
      announce('Test stopped.');
    },
  });
  engine.run();
}

// ---- network intel ----------------------------------------------------------

let currentGeo = null;
let lastIntel = null; // { lb, pat, out, g, patScope } — cached so unit changes re-render without refetch
const patternsChart = new PatternsChart(els.patterns, els.patternsTip);

function showIspLine(g) {
  currentGeo = g;
  if (!g || (!g.isp && !g.city)) { els.ispLine.hidden = true; return; }
  els.ispName.textContent = g.isp || 'Unknown ISP';
  els.ispWhere.textContent = [g.city, g.region, g.postal].filter(Boolean).join(' · ');
  els.ispLine.hidden = false;
}

// Re-render the community panel from cached data (used on settings change so a
// unit switch updates the numbers without hitting the network again).
function renderIntelFromCache() {
  if (!lastIntel) return;
  const {
    lb, pat, out, g, patScope,
  } = lastIntel;
  renderOutage(els.outage, out, g);
  renderLeaderboard(els.leaderboard, lb, g.isp);
  els.intelScope.textContent = lb
    ? `${g.city} · last ${lb.scope.windowDays} days · ${lb.scope.samples} community reports`
    : '';
  if (pat) {
    patternsChart.setData(pat.hours);
    els.patternsScope.textContent = pat.scope.samples
      ? `${patScope} · ${g.city} · ${pat.scope.samples} reports`
      : `${g.city} · no reports yet`;
  }
}

async function loadIntel(g) {
  if (!g?.city) { els.intel.hidden = true; return; }
  let [lb, pat, out] = await Promise.all([
    fetchLeaderboard({ city: g.city }),
    fetchPatterns({ isp: g.isp, city: g.city }),
    g.isp ? fetchOutage({ isp: g.isp, city: g.city }) : Promise.resolve(null),
  ]);
  let patScope = g.isp || 'All ISPs';
  if (pat && g.isp && pat.scope.samples < 12) {
    // An ISP with almost no reports makes an empty chart — widen to city-wide.
    const cityWide = await fetchPatterns({ city: g.city });
    if (cityWide && cityWide.scope.samples > pat.scope.samples) {
      pat = cityWide;
      patScope = 'All ISPs';
    }
  }
  lastIntel = {
    lb, pat, out, g, patScope,
  };
  renderIntelFromCache();
  const embed = embedFor(g, location.origin);
  els.badgeImg.src = embed.badge;
  els.embedMd.value = embed.markdown;
  els.embedHtml.value = embed.html;
  els.statsLink.href = embed.stats;
  els.intel.hidden = false;
}

// Tabs
for (const tab of document.querySelectorAll('.intel-tab')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll('.intel-tab')) {
      t.setAttribute('aria-selected', t === tab ? 'true' : 'false');
    }
    for (const view of document.querySelectorAll('.intel-view')) {
      view.hidden = view.dataset.panel !== tab.dataset.tab;
    }
    if (tab.dataset.tab === 'patterns') patternsChart.resize();
  });
}
for (const input of [els.embedMd, els.embedHtml]) {
  input.addEventListener('focus', () => input.select());
}

// Detect ISP/city at load so the community intel shows before the first run.
detectIsp().then((g) => {
  showIspLine(g);
  if (g) loadIntel(g);
}).catch(() => {});

// ---- wiring -----------------------------------------------------------------

els.goBtn.addEventListener('click', start);
els.againBtn.addEventListener('click', start);
els.retryBtn.addEventListener('click', start);
els.stopBtn.addEventListener('click', () => engine?.abort());

els.themeBtn.addEventListener('click', () => {
  const next = toggleTheme();
  els.themeBtn.setAttribute('aria-label', `Switch to ${next === 'dark' ? 'light' : 'dark'} theme`);
});
els.themeBtn.setAttribute(
  'aria-label',
  `Switch to ${currentTheme() === 'dark' ? 'light' : 'dark'} theme`,
);

els.copyBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  const r = lastResult;
  const when = fmtDateTime(r.ts);
  const u = speedUnitLabel();
  const text = `SpeedUndo speed test — down ${fmtMbps(r.down)} ${u} · up ${fmtMbps(r.up)} ${u}`
    + ` · ping ${fmtMs(r.ping)} ms · jitter ${fmtMs(r.jitter)} ms`
    + (r.meta?.colo ? ` · via ${r.meta.colo}` : '') + ` · ${when}`;
  try {
    await navigator.clipboard.writeText(text);
    els.copyBtn.textContent = 'Copied';
    setTimeout(() => { els.copyBtn.textContent = 'Copy result'; }, 1600);
  } catch (_) {
    announce('Copy failed. Clipboard access was blocked.');
  }
});

// Server selection — settings is the single source of truth; the footer picker
// and the Settings dialog both read/write it and stay in sync via settingschange.
function populateServerSelect(sel) {
  for (const s of SERVERS) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    sel.appendChild(opt);
  }
}
populateServerSelect(els.serverSelect);
populateServerSelect(els.settingsServerSelect);

// One-time migration from the pre-settings standalone key.
try {
  const legacy = localStorage.getItem('speedundo.server');
  if (legacy && SERVERS.some((s) => s.id === legacy)) setSetting('server', legacy);
  localStorage.removeItem('speedundo.server');
} catch (_) { /* ignore */ }

function currentServerId() {
  const id = getSetting('server');
  return SERVERS.some((s) => s.id === id) ? id : SERVERS[0].id;
}
function applyServerToUI() {
  const id = currentServerId();
  els.serverSelect.value = id;
  els.settingsServerSelect.value = id;
  els.settingsServerName.textContent = (SERVERS.find((s) => s.id === id) || SERVERS[0]).label;
}

els.serverSelect.addEventListener('change', () => setSetting('server', els.serverSelect.value));
els.settingsServerSelect.addEventListener('change', () => setSetting('server', els.settingsServerSelect.value));
els.settingsChangeServer.addEventListener('click', () => {
  const revealing = els.settingsServerSelect.hidden;
  els.settingsServerSelect.hidden = !revealing;
  els.settingsChangeServer.textContent = revealing ? 'Done' : 'Change Server';
  if (revealing) els.settingsServerSelect.focus();
});

// History drawer
let lastFocus = null;
const inertTargets = () => document.querySelectorAll('.topbar, .app');
function openDrawer() {
  lastFocus = document.activeElement;
  els.drawer.hidden = false;
  els.backdrop.hidden = false;
  for (const el of inertTargets()) el.inert = true;
  requestAnimationFrame(() => {
    els.drawer.classList.add('open');
    els.backdrop.classList.add('open');
  });
  els.drawerClose.focus();
}
function closeDrawer() {
  els.drawer.classList.remove('open');
  els.backdrop.classList.remove('open');
  for (const el of inertTargets()) el.inert = false;
  setTimeout(() => {
    els.drawer.hidden = true;
    els.backdrop.hidden = true;
  }, 240);
  if (lastFocus) lastFocus.focus();
}
els.historyBtn.addEventListener('click', openDrawer);
els.drawerClose.addEventListener('click', closeDrawer);
els.backdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.drawer.hidden) closeDrawer();
});
els.clearBtn.addEventListener('click', () => {
  clearHistory();
  renderHistory(els.historyList, [], onDeleteEntry);
});
function onDeleteEntry(ts) {
  renderHistory(els.historyList, deleteEntry(ts), onDeleteEntry);
}
renderHistory(els.historyList, loadHistory(), onDeleteEntry);

// Share modal
let shareLastFocus = null;
function openShare() {
  if (!lastResult) return;
  shareLastFocus = document.activeElement;
  drawCard(els.shareCard, lastResult);
  els.shareCaption.value = defaultCaption(lastResult);
  els.shareModal.hidden = false;
  els.shareBackdrop.hidden = false;
  for (const el of inertTargets()) el.inert = true;
  requestAnimationFrame(() => {
    els.shareModal.classList.add('open');
    els.shareBackdrop.classList.add('open');
  });
  els.shareNative.hidden = !navigator.share;
  els.shareClose.focus();
}
function closeShare() {
  els.shareModal.classList.remove('open');
  els.shareBackdrop.classList.remove('open');
  for (const el of inertTargets()) el.inert = false;
  setTimeout(() => {
    els.shareModal.hidden = true;
    els.shareBackdrop.hidden = true;
  }, 240);
  if (shareLastFocus) shareLastFocus.focus();
}
const flashBtn = (btn, msg, orig) => {
  btn.textContent = msg;
  setTimeout(() => { btn.textContent = orig; }, 1800);
};
renderNetworkButtons(
  els.shareNets,
  () => els.shareCaption.value,
  async () => {
    // Intent URLs can't carry the image — put it on the clipboard first.
    const ok = await copyCardToClipboard(els.shareCard);
    els.shareNote.textContent = ok
      ? 'Image copied to your clipboard — paste it into the post beside the caption.'
      : 'Clipboard unavailable — use "Download image" and attach it to the post.';
  },
);
els.shareBtn.addEventListener('click', openShare);
els.shareClose.addEventListener('click', closeShare);
els.shareBackdrop.addEventListener('click', closeShare);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.shareModal.hidden) closeShare();
});
els.shareDownload.addEventListener('click', () => {
  if (lastResult) downloadCard(els.shareCard, lastResult);
});
els.shareCopyImg.addEventListener('click', async () => {
  const ok = await copyCardToClipboard(els.shareCard);
  flashBtn(els.shareCopyImg, ok ? 'Copied ✓' : 'Copy failed', 'Copy image');
});
els.shareNative.addEventListener('click', () => {
  if (lastResult) nativeShare(els.shareCard, lastResult, els.shareCaption.value);
});
window.addEventListener('themechange', () => {
  if (!els.shareModal.hidden && lastResult) drawCard(els.shareCard, lastResult);
});

// ---- settings ---------------------------------------------------------------

// Reflect the stored settings onto the dialog controls.
function syncSettingsControls() {
  const s = getSettings();
  for (const seg of document.querySelectorAll('.seg[data-setting]')) {
    const key = seg.dataset.setting;
    for (const opt of seg.querySelectorAll('.seg-opt')) {
      opt.setAttribute('aria-pressed', String(opt.dataset.value === s[key]));
    }
  }
  els.dateFormat.value = s.date;
  applyServerToUI();
}

// Push the active speed-unit label into every static label + the live readout.
function applySpeedUnitLabels() {
  const label = speedUnitLabel();
  for (const el of document.querySelectorAll('.js-speed-unit')) el.textContent = label;
  if (els.liveUnit.textContent === 'Mbps' || els.liveUnit.textContent === 'Kbps') {
    els.liveUnit.textContent = label;
  }
}

// Re-render everything that shows a speed/date so a settings change is instant.
function refreshDisplaysForSettings() {
  applySpeedUnitLabels();
  if (lastResult) {
    els.downVal.textContent = fmtMbps(lastResult.down);
    els.upVal.textContent = fmtMbps(lastResult.up);
    els.pingVal.textContent = fmtMs(lastResult.ping);
    els.jitterVal.textContent = fmtMs(lastResult.jitter);
    els.lossVal.textContent = lastResult.loss != null ? fmtPct(lastResult.loss) : '—';
    if (!els.details.hidden) fillDetails(lastResult);
  }
  renderHistory(els.historyList, loadHistory(), onDeleteEntry);
  renderIntelFromCache();
  if (!els.shareModal.hidden && lastResult) drawCard(els.shareCard, lastResult);
}

let settingsLastFocus = null;
function openSettings() {
  settingsLastFocus = document.activeElement;
  syncSettingsControls();
  els.settingsServerSelect.hidden = true;
  els.settingsChangeServer.textContent = 'Change Server';
  els.settingsModal.hidden = false;
  els.settingsBackdrop.hidden = false;
  for (const el of inertTargets()) el.inert = true;
  requestAnimationFrame(() => {
    els.settingsModal.classList.add('open');
    els.settingsBackdrop.classList.add('open');
  });
  els.settingsClose.focus();
}
function closeSettings() {
  els.settingsModal.classList.remove('open');
  els.settingsBackdrop.classList.remove('open');
  for (const el of inertTargets()) el.inert = false;
  setTimeout(() => {
    els.settingsModal.hidden = true;
    els.settingsBackdrop.hidden = true;
  }, 240);
  if (settingsLastFocus) settingsLastFocus.focus();
}
els.settingsBtn.addEventListener('click', openSettings);
els.settingsClose.addEventListener('click', closeSettings);
els.settingsBackdrop.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.settingsModal.hidden) closeSettings();
});

for (const seg of document.querySelectorAll('.seg[data-setting]')) {
  seg.addEventListener('click', (e) => {
    const opt = e.target.closest('.seg-opt');
    if (opt) setSetting(seg.dataset.setting, opt.dataset.value);
  });
}
els.dateFormat.addEventListener('change', () => setSetting('date', els.dateFormat.value));

window.addEventListener('settingschange', () => {
  syncSettingsControls();
  refreshDisplaysForSettings();
});

// Initial paint
setState('idle');
setReading('—', '');
syncSettingsControls();
applySpeedUnitLabels();
