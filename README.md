# SpeedUndo — internet speed meter

A browser speed test in the spirit of Speedtest by Ookla: one button, a live
gauge, five numbers (download, upload, ping, jitter, packet loss) plus a
loaded-latency (bufferbloat) readout — and a crowdsourced "network intel"
layer: ISP leaderboard for your city, outage detection, time-of-day speed
patterns, and an embeddable live badge. No accounts, no build step, no
dependencies.

See [PLAN.md](PLAN.md) for the full design plan: color system, themes,
typography, layout, and measurement methodology.

## Run

```
node server.js
```

Then open http://localhost:8787.

`PORT=9000 node server.js` for a custom port.

## How it measures

- **Test target** — by default, Cloudflare's public speed-test edge
  (`speed.cloudflare.com`), so results reflect your real internet connection.
  The bundled server also exposes the same contract (`/down`, `/up`) — pick
  "This machine (LAN)" in the footer to measure loopback/LAN throughput
  instead.
- **Ping / jitter** — 10 sequential 0-byte requests; median and mean absolute
  successive difference (first sample discarded — it carries TLS setup).
  Dropped probes are retried (up to 14 attempts, 5 s timeout each) so lossy
  networks still produce a figure.
- **Download** — 5 parallel 25 MB streams for 15 s, bytes counted via
  `ReadableStream`, first 1.5 s (TCP ramp) excluded from the figure.
- **Upload** — 4 parallel XHR posts of 8 MB random blobs for 15 s, bytes via
  `upload.onprogress`, same trimmed window.
- **Resilience** — streams survive transient errors (brief backoff, then
  retry while the window is open) and each phase runs under a watchdog
  deadline, so a stalled socket or a mid-test network hiccup degrades the
  sample instead of hanging or failing the test.
- **Loaded RTT** — pings fired *during* the download phase; a large gap vs.
  idle ping indicates bufferbloat.
- **Packet loss** — two methods, best available wins:
  1. *WebRTC/UDP*: two local `RTCPeerConnection`s forced through a public TURN
     relay (`iceTransportPolicy: 'relay'`), an unreliable/unordered datachannel
     (`maxRetransmits: 0`), 400 sequenced 120-byte packets; loss = missing
     sequence numbers after a settle window.
  2. *TCP fallback* (UDP/TURN blocked): after the download phase, a 4 MB
     transfer is run to completion and a 0-byte probe reuses its socket —
     Cloudflare's `cfL4` server-timing header exposes that connection's
     cumulative `sent`/`retrans` TCP counters. Loss = retransmit rate under
     load (min 200 segments, deduped by connection id).
- **ISP + city detection** — `ipwho.is` (CORS-open) supplies ISP name, ASN,
  city, region, and pincode, with `ipwhois.app` as a fallback where the
  primary is blocked; each attempt is time-boxed (6 s). Shown under the gauge
  and attached to results. Falls back gracefully (features hide) when both
  are unreachable.

Mbps are decimal (bytes × 8 / 10⁶), matching how ISPs advertise.

## Network intel (crowdsourced)

Results from real-internet tests are submitted (no IPs stored — ISP, ASN,
city, pincode, and the five numbers only) to the bundled server, which
aggregates:

- **City leaderboard** — ISPs ranked by median download over the last 30 days,
  with per-ISP health chips.
- **Outage / degradation signal** — recent (2 h) download median vs the 30-day
  baseline per ISP+city; −15 % ⇒ *Slower than usual*, −40 % ⇒ *Degraded*,
  −70 % ⇒ *Possible outage*. Shown as a banner when it's **your** ISP.
- **Time-of-day patterns** — median download per local hour over 30 days;
  evening congestion shows up as a sagging band of bars.

The store ships with 30 days of demo seed data (three Indian cities, four
ISPs, evening congestion, one degraded ISP) so every panel renders on first
boot. Delete `data/results.json` to start clean; real submissions mix in
immediately and the demo top-up never touches non-seed stores.

## Share a result

When a test completes, **Share result** opens a card: the finished run drawn
onto a 1200×630 canvas (social OG-image aspect) — hero download, upload,
ping/jitter/loss, ISP + city, and a mini-gauge, re-skinned to the active
theme. An editable caption is pre-filled. Post buttons for **X, Reddit,
Threads, and Facebook** (official brand icons) open each network's web share
intent with the caption. Web intents can't attach an image, so picking a
network also copies the card to the clipboard to paste into the post;
**Download image** and **Copy image** are available directly, and on supporting
devices the native share sheet (**More…**) attaches the PNG itself.

## Public API & badge

All JSON, all open (`Access-Control-Allow-Origin: *`):

| Endpoint | Returns |
|----------|---------|
| `GET /api/leaderboard?city=&postal=&windowDays=` | ranked ISPs + health for a city or pincode |
| `GET /api/outage?isp=&city=` | health status, deltaPct, recent/baseline medians |
| `GET /api/patterns?isp=&city=` | 24 hourly buckets of median down/up/ping |
| `GET /api/stats?city=&isp=` | compact medians + health (`api: "speedundo/1"`) |
| `GET /api/badge.svg?city=&isp=&metric=` | live shields-style SVG badge, health-colored |
| `POST /api/submit` | store one result (validated, 10 KB cap, no PII) |

Embed snippets (Markdown + HTML) for the badge are generated in the app under
**Network intel → Embed & API**.

## Files

| Path | Role |
|------|------|
| `index.html` | shell, landmarks, aria-live status |
| `css/styles.css` | design tokens (dark + light), layout, components |
| `js/engine.js` | measurement engine (all network + math) |
| `js/rtc.js` | WebRTC/TURN packet-loss measurement |
| `js/geo.js` | ISP + city detection (ipwho.is, cached) |
| `js/intel.js` | community API client + leaderboard/outage/patterns/badge UI |
| `js/share.js` | result-card canvas renderer + social share intents |
| `js/gauge.js` | canvas gauge with phosphor afterglow |
| `js/trace.js` | scope-style live throughput chart |
| `js/history.js` | localStorage results + drawer rendering |
| `js/theme.js` | theme boot/toggle, token reader for canvases |
| `js/main.js` | state machine + DOM orchestration |
| `server.js` | zero-dep static host, local test target, community store + API |
| `favicon.ico` · `icons/` · `manifest.webmanifest` | brand icon set — see [ICONS.md](ICONS.md) |
