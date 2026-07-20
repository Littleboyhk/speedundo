// Measurement engine. Phases: meta → ping → download → upload → loss → done.
// Emits UI-agnostic events; owns all network activity and the math.
//
// Throughput method: N parallel streams against the test target for a fixed
// 15 s window, bytes counted continuously, sampled every 100 ms. The reported
// figure is total bytes over the window with the TCP ramp (first 1.5 s)
// excluded. Mbps are decimal (bytes × 8 / 1e6), matching how ISPs advertise.
//
// Resilience (the test must complete on real-world networks everywhere):
// dropped ping probes are retried, streams survive transient errors with a
// short backoff, and every phase runs under a watchdog signal so a hung
// socket can never wedge the test.

import { median, meanAbsDiff } from './format.js';
import { detectIsp } from './geo.js';
import { measurePacketLoss } from './rtc.js';

export const SERVERS = [
  {
    id: 'cloudflare',
    label: 'Cloudflare edge',
    down: (bytes) => `https://speed.cloudflare.com/__down?bytes=${bytes}`,
    up: 'https://speed.cloudflare.com/__up',
    hasMeta: true,
    internet: true,
  },
  {
    id: 'local',
    label: 'This machine (LAN)',
    down: (bytes) => `/down?bytes=${bytes}`,
    up: '/up',
    hasMeta: false,
    internet: false,
  },
];

const PING_COUNT = 10;
const PING_MAX_ATTEMPTS = 14;   // lossy networks may drop a few probes
const PING_TIMEOUT_MS = 5000;
const DOWN_STREAMS = 5;
const DOWN_WINDOW_MS = 15000;   // ≥15 s steady sampling for a stable figure
const DOWN_REQUEST_BYTES = 25_000_000;
const UP_STREAMS = 4;
const UP_WINDOW_MS = 15000;
const UP_BLOB_BYTES = 8 * 1024 * 1024;
const SAMPLE_MS = 100;
const RAMP_SEC = 1.5;
const LOADED_PING_GAP_MS = 750;
const PHASE_SETTLE_MS = 300;
const STREAM_RETRY_MS = 400;    // backoff after a transient stream error
const PHASE_GRACE_MS = 4000;    // watchdog: reap sockets hung past the window

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomBlob(size) {
  const buf = new Uint8Array(size);
  const step = 65536; // crypto.getRandomValues per-call cap
  for (let o = 0; o < size; o += step) {
    crypto.getRandomValues(buf.subarray(o, Math.min(o + step, size)));
  }
  // text/plain keeps cross-origin POSTs "simple" (no CORS preflight),
  // which the public speed-test endpoints are not guaranteed to answer.
  return new Blob([buf], { type: 'text/plain' });
}

// Cloudflare's cfL4 server-timing exposes the server-side TCP socket counters
// for our own download connections — real packet loss on the saturated path.
// Counters are cumulative per connection (cid); headers arrive before the
// body, so only a LATER request on the same reused socket sees the transfer.
function parseCfL4(header) {
  if (!header || !header.includes('cfL4')) return null;
  const num = (k) => {
    const m = header.match(new RegExp(`[?&]${k}=(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  const cid = header.match(/[?&]cid=([0-9a-f]+)/)?.[1];
  const sent = num('sent');
  if (!cid || sent == null) return null;
  return { cid, sent, retrans: num('retrans') || 0, lost: num('lost') || 0 };
}

const TCP_MIN_SEGMENTS = 200; // below this the loss figure would be noise
const TCP_PROBE_BYTES = 4e6;  // completed transfer that feeds the counters

class PhaseError extends Error {
  constructor(phase, message) {
    super(message);
    this.phase = phase;
  }
}

export class SpeedTest {
  /**
   * @param {object} server  entry from SERVERS
   * @param {object} on      callbacks: phase(name), ping(ms, i, n),
   *   sample(kind, tSec, mbps), live(kind, mbps), meta(obj), done(result),
   *   error(err), aborted()
   */
  constructor(server, on = {}) {
    this.server = server;
    this.on = on;
    this.ctrl = new AbortController();
    this.running = false;
  }

  abort() {
    this.ctrl.abort();
  }

  get signal() {
    return this.ctrl.signal;
  }

  emit(name, ...args) {
    if (typeof this.on[name] === 'function') this.on[name](...args);
  }

  // A child AbortSignal that fires on user abort OR after timeoutMs. Lets a
  // single hung request (common on flaky mobile links) die without taking the
  // whole test down, while user aborts still propagate instantly.
  childSignal(timeoutMs) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    this.signal.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    return {
      signal: ctrl.signal,
      abort: () => ctrl.abort(),
      release: () => {
        if (timer) clearTimeout(timer);
        this.signal.removeEventListener('abort', onAbort);
      },
    };
  }

  async run() {
    if (this.running) return;
    this.running = true;
    const result = {
      ts: Date.now(),
      server: this.server.id,
      ping: null, jitter: null,
      down: null, downPeak: null, downBytes: 0, downDur: 0,
      up: null, upPeak: null, upBytes: 0, upDur: 0,
      loadedRtt: null,
      loss: null, lossSent: 0, lossReceived: 0, lossMethod: null,
      meta: null,
      geo: null, // {isp, asn, city, region, country, postal} from geo.js
    };
    try {
      this.emit('phase', 'meta');
      // ISP/city lookup runs alongside the whole test; awaited before 'done'.
      const geoPromise = detectIsp({ signal: this.signal })
        .then((g) => { if (g) this.emit('isp', g); return g; })
        .catch(() => null);
      result.meta = await this.fetchMeta();
      if (result.meta) this.emit('meta', result.meta);

      this.emit('phase', 'ping');
      const { ping, jitter } = await this.pingPhase();
      result.ping = ping;
      result.jitter = jitter;

      await sleep(PHASE_SETTLE_MS);
      this.emit('phase', 'download');
      const down = await this.throughputPhase('down');
      Object.assign(result, {
        down: down.mbps, downPeak: down.peak,
        downBytes: down.bytes, downDur: down.dur,
        loadedRtt: down.loadedRtt,
      });

      await sleep(PHASE_SETTLE_MS);
      this.emit('phase', 'upload');
      const up = await this.throughputPhase('up');
      Object.assign(result, {
        up: up.mbps, upPeak: up.peak, upBytes: up.bytes, upDur: up.dur,
      });

      // Packet loss — internet targets only (for a LAN test the relay path
      // would say nothing about the line under test). Primary: real UDP loss
      // through a TURN relay. Fallback (UDP blocked / no relay candidates):
      // TCP retransmit counters from Cloudflare's cfL4 server-timing on our
      // own saturated download sockets. Null only when both are unavailable.
      if (this.server.internet) {
        this.emit('phase', 'loss');
        const loss = await measurePacketLoss({ signal: this.signal });
        if (loss) {
          result.loss = Math.round(loss.lossPct * 100) / 100;
          result.lossSent = loss.sent;
          result.lossReceived = loss.received;
          result.lossMethod = 'webrtc';
          this.emit('loss', { ...loss, method: 'webrtc' });
        } else if (down.tcp && down.tcp.sent > 0) {
          const pct = (down.tcp.retrans / down.tcp.sent) * 100;
          result.loss = Math.round(pct * 100) / 100;
          result.lossSent = down.tcp.sent;
          result.lossReceived = down.tcp.sent - down.tcp.retrans;
          result.lossMethod = 'tcp';
          this.emit('loss', {
            lossPct: pct, sent: down.tcp.sent,
            received: result.lossReceived, method: 'tcp',
          });
        } else {
          this.emit('loss', null);
        }
      }

      result.geo = await geoPromise;

      this.emit('phase', 'done');
      this.emit('done', result);
      return result;
    } catch (err) {
      if (this.signal.aborted || err?.name === 'AbortError') {
        this.emit('aborted');
      } else {
        this.emit('error', err, err instanceof PhaseError ? err.phase : null);
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  // ---- meta ---------------------------------------------------------------

  async fetchMeta() {
    try {
      const res = await fetch(this.server.down(0), {
        cache: 'no-store', signal: this.signal,
      });
      const h = res.headers;
      const grab = (...names) => {
        for (const n of names) { const v = h.get(n); if (v) return v; }
        return null;
      };
      const meta = {
        ip: grab('cf-meta-ip'),
        colo: grab('cf-meta-colo', 'colo'),
        city: grab('cf-meta-city', 'city'),
        country: grab('cf-meta-country', 'country'),
        asn: grab('cf-meta-asn', 'asn'),
      };
      return Object.values(meta).some(Boolean) ? meta : null;
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      // Metadata is cosmetic — if even this failed, the ping phase will
      // produce the real, actionable error.
      return null;
    }
  }

  // ---- latency ------------------------------------------------------------

  async pingOnce(timeoutMs) {
    const child = timeoutMs ? this.childSignal(timeoutMs) : null;
    const t0 = performance.now();
    try {
      const res = await fetch(this.server.down(0), {
        cache: 'no-store', signal: child ? child.signal : this.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await res.arrayBuffer();
      return performance.now() - t0;
    } finally {
      child?.release();
    }
  }

  async pingPhase() {
    const samples = [];
    let attempts = 0;
    // Lossy links drop probes; keep going until we have enough clean samples
    // or the attempt budget runs out. Only give up when nothing gets through.
    while (samples.length < PING_COUNT && attempts < PING_MAX_ATTEMPTS) {
      if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      attempts++;
      let ms;
      try {
        ms = await this.pingOnce(PING_TIMEOUT_MS);
      } catch (err) {
        if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        continue;
      }
      samples.push(ms);
      // First sample carries connection + TLS setup; report progress with it
      // but keep it out of the statistics.
      const kept = samples.length > 1 ? samples.slice(1) : samples;
      this.emit('ping', median(kept), samples.length, PING_COUNT);
    }
    const kept = samples.length > 1 ? samples.slice(1) : samples;
    if (!kept.length) {
      throw new PhaseError('ping', 'The test server did not respond.');
    }
    return { ping: median(kept), jitter: meanAbsDiff(kept) };
  }

  // ---- throughput (shared by download & upload) ----------------------------

  async throughputPhase(kind) {
    const isDown = kind === 'down';
    const windowMs = isDown ? DOWN_WINDOW_MS : UP_WINDOW_MS;
    const streams = isDown ? DOWN_STREAMS : UP_STREAMS;

    let bytes = 0;
    let lastByteAt = 0; // performance.now() when the most recent bytes were credited
    const counter = { add: (n) => { bytes += n; lastByteAt = performance.now(); } };
    const start = performance.now();
    const deadline = start + windowMs;
    const samples = []; // {t, v, cum} at ~100 ms cadence
    // Watchdog: everything in this phase dies at window + grace, so one
    // stalled socket (frozen mobile link, mid-test network change) can't hang
    // the test forever. User abort propagates through the same signal.
    const phase = this.childSignal(windowMs + PHASE_GRACE_MS);
    const lastErr = { message: null };

    let ema = 0;
    const sampler = setInterval(() => {
      const now = performance.now();
      const t = (now - start) / 1000;
      const prev = samples[samples.length - 1] || { t: 0, cum: 0 };
      const dt = t - prev.t;
      if (dt <= 0) return;
      const v = ((bytes - prev.cum) * 8) / dt / 1e6;
      samples.push({ t, v, cum: bytes });
      ema = ema === 0 ? v : ema + 0.25 * (v - ema);
      this.emit('sample', kind, t, v);
      this.emit('live', kind, ema);
    }, SAMPLE_MS);

    // Loaded-latency probe rides along with the download phase only.
    const loaded = [];
    const loadedProbe = isDown ? (async () => {
      await sleep(1000); // let the streams saturate first
      while (performance.now() < deadline - 400 && !this.signal.aborted) {
        try { loaded.push(await this.pingOnce(PING_TIMEOUT_MS)); } catch (_) { break; }
        await sleep(LOADED_PING_GAP_MS);
      }
    })() : Promise.resolve();

    const workers = [];
    // Per-connection cumulative TCP counters, newest snapshot per cid.
    const tcpMap = isDown ? new Map() : null;
    const recordTcp = tcpMap ? (header) => {
      const t = parseCfL4(header);
      if (t && (!tcpMap.has(t.cid) || t.sent > tcpMap.get(t.cid).sent)) {
        tcpMap.set(t.cid, t);
      }
    } : null;
    for (let i = 0; i < streams; i++) {
      workers.push(isDown
        ? this.downStream(counter, deadline, recordTcp, phase.signal, lastErr)
        : this.upStream(counter, deadline, phase.signal, lastErr));
    }
    await Promise.allSettled(workers);
    clearInterval(sampler);
    await loadedProbe.catch(() => {});
    phase.release();
    if (this.signal.aborted) throw new DOMException('Aborted', 'AbortError');

    const end = performance.now();
    if (bytes === 0) {
      throw new PhaseError(isDown ? 'download' : 'upload',
        lastErr.message || 'No data moved during the test window.');
    }
    // Upload credits bytes only when the server confirms receipt (on response),
    // so the window can close with an in-flight request whose time we must not
    // count against zero bytes. Measure to the last confirmed byte. For
    // download, bytes are counted continuously so lastByteAt ≈ the deadline —
    // no change in behaviour there.
    const dur = ((bytes > 0 ? lastByteAt : end) - start) / 1000;

    // Steady-state figure: bytes moved after the ramp, over that time.
    const rampSec = Math.min(RAMP_SEC, dur * 0.3);
    let rampCum = 0;
    for (const s of samples) { if (s.t <= rampSec) rampCum = s.cum; else break; }
    const mbps = ((bytes - rampCum) * 8) / (dur - rampSec) / 1e6;

    // Peak over a 3-sample moving average (raw 100 ms samples are spiky).
    let peak = 0;
    for (let i = 2; i < samples.length; i++) {
      const avg = (samples[i].v + samples[i - 1].v + samples[i - 2].v) / 3;
      if (avg > peak) peak = avg;
    }

    // TCP view of the download path. The stream sockets die cancelled (their
    // 25 MB bodies rarely complete), so instead: transfer a small payload to
    // COMPLETION, then issue a 0-byte probe — the probe reuses the now-idle
    // socket and its header carries that connection's cumulative counters,
    // including the completed transfer. Dedupe by cid guards double-counting.
    let tcp = null;
    if (recordTcp && !this.signal.aborted) {
      const probe = this.childSignal(8000); // best-effort; never stalls the test
      try {
        const feed = await fetch(this.server.down(TCP_PROBE_BYTES), {
          cache: 'no-store', signal: probe.signal,
        });
        await feed.arrayBuffer(); // must complete so the socket goes idle
        recordTcp(feed.headers.get('server-timing'));
        for (let i = 0; i < 2; i++) {
          const res = await fetch(this.server.down(0), { cache: 'no-store', signal: probe.signal });
          recordTcp(res.headers.get('server-timing'));
        }
      } catch (_) { /* probe is best-effort */ } finally {
        probe.release();
      }
      if (tcpMap.size) {
        const sum = [...tcpMap.values()].reduce(
          (a, s) => ({ sent: a.sent + s.sent, retrans: a.retrans + s.retrans, lost: a.lost + s.lost }),
          { sent: 0, retrans: 0, lost: 0 },
        );
        if (sum.sent >= TCP_MIN_SEGMENTS) tcp = sum;
      }
    }

    return {
      mbps, peak: peak || mbps, bytes, dur, tcp,
      loadedRtt: loaded.length ? median(loaded) : null,
    };
  }

  // A stream survives transient errors: one failed request logs the reason,
  // backs off briefly, and tries again while the window is open — a single
  // hiccup on a flaky link no longer kills a whole stream (or the phase).
  async downStream(counter, deadline, recordTcp, phaseSignal, lastErr) {
    while (performance.now() < deadline && !phaseSignal.aborted) {
      try {
        const res = await fetch(this.server.down(DOWN_REQUEST_BYTES), {
          cache: 'no-store', signal: phaseSignal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        if (recordTcp) recordTcp(res.headers.get('server-timing'));
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            counter.add(value.byteLength);
            if (performance.now() >= deadline) {
              await reader.cancel();
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if (phaseSignal.aborted) return;
        lastErr.message = err?.message || 'Network error.';
        await sleep(STREAM_RETRY_MS);
      }
    }
  }

  upStream(counter, deadline, phaseSignal, lastErr) {
    // One blob is generated lazily and shared across all requests.
    if (!this._blob) this._blob = randomBlob(UP_BLOB_BYTES);
    const url = this.server.up;
    const blob = this._blob;

    // Bytes are credited only when the server RESPONDS — i.e. after it has
    // drained the whole body — so the figure is authoritative and can never run
    // ahead of what the receiver actually got. (The old path counted
    // xhr.upload.onprogress e.loaded, i.e. bytes buffered into the local OS
    // socket, which inflated upload speed on fast links.) A request still in
    // flight when the window closes is aborted and contributes nothing.
    const one = () => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      let deadlineHit = false;
      xhr.open('POST', url, true);
      const onAbort = () => xhr.abort();
      const timer = setTimeout(() => {
        deadlineHit = true;
        xhr.abort();
      }, Math.max(0, deadline - performance.now()));
      xhr.onloadend = () => {
        clearTimeout(timer);
        phaseSignal.removeEventListener('abort', onAbort);
        if (phaseSignal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
        if (deadlineHit) { resolve(); return; } // window closed mid-send — unconfirmed
        if (xhr.status >= 200 && xhr.status < 400) {
          // Prefer the server's own received-byte count; fall back to the blob
          // size (a 2xx means the whole body was received either way).
          let received = blob.size;
          try {
            const j = JSON.parse(xhr.responseText);
            if (j && Number.isFinite(j.received)) received = j.received;
          } catch (_) { /* non-JSON body (e.g. CF __up) → use blob size */ }
          counter.add(received);
          resolve();
        } else {
          reject(new Error(`Upload failed (${xhr.status || 'network error'})`));
        }
      };
      phaseSignal.addEventListener('abort', onAbort, { once: true });
      xhr.send(blob);
    });

    return (async () => {
      while (performance.now() < deadline && !phaseSignal.aborted) {
        try {
          await one();
        } catch (err) {
          if (phaseSignal.aborted) return;
          lastErr.message = err?.message || 'Network error.';
          await sleep(STREAM_RETRY_MS);
        }
      }
    })();
  }
}
