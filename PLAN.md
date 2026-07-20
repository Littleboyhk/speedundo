# SpeedUndo — internet speed meter

A browser-based internet speed test in the spirit of Speedtest by Ookla: press one
button, watch a live gauge, read four numbers. No accounts, no build step, no
dependencies.

**Name.** *SpeedUndo* — it takes the guesswork out of a slow line: run the test
and see the connection plainly. Short, typable, and unambiguous.

**Subject & audience.** The subject is the line itself — the wire between you and
the internet. The audience is anyone who suspects their connection is slow. The
page has exactly one job: run a test and make the result legible in three seconds.

**Aesthetic thesis: precision instrument, not marketing site.** The design language
is the network operations bench — phosphor traces, RX/TX indicator LEDs, mono
readouts on dark glass. Dark-first (a meter is read in the dark), with a clean
"lab bench" light theme. One aesthetic risk, spent in one place: the gauge needle
leaves a decaying **phosphor afterglow trail**, and the live throughput graph is
drawn as an oscilloscope trace. Everything around that signature stays quiet.

---

## 1 · Color system (validated)

Color is assigned by job, not by taste. Three metric hues follow networking
convention — **cyan = RX (download), violet = TX (upload), amber = latency** — and
each hue belongs to its metric everywhere it appears (tile, gauge, trace, history
bar). Text never wears a series color; values are always ink.

Both palettes were run through the dataviz six-check validator against their real
surfaces. **All checks pass** in both modes: lightness band, chroma floor,
CVD separation (worst adjacent pair ΔE 43.9 dark / 49.4 light — target is ≥ 12),
and ≥ 3:1 contrast vs. surface.

### Dark theme (default) — "night bench"

| Token          | Hex                       | Role |
|----------------|---------------------------|------|
| `--page`       | `#060A12`                 | page plane, blue-black (never pure black) |
| `--surface`    | `#0D1420`                 | cards, gauge bezel, chart surface |
| `--surface-2`  | `#121C2C`                 | raised: drawer, tooltip, chips |
| `--ink`        | `#EDF3FC`                 | primary text, hero numerals |
| `--ink-2`      | `#97A6BD`                 | secondary text |
| `--muted`      | `#5D6C84`                 | eyebrows, axis labels |
| `--hairline`   | `rgba(148,178,224,0.12)`  | borders, dividers |
| `--grid`       | `rgba(148,178,224,0.07)`  | scope gridlines |
| `--rx`         | `#1FA5BC`                 | download — cyan |
| `--tx`         | `#7D5BE6`                 | upload — violet |
| `--lat`        | `#BE861A`                 | ping & jitter — amber |
| `--rx-glow`    | `#46D8EF`                 | glow/gradient ends only, never identity |
| `--tx-glow`    | `#A78BFA`                 | 〃 |
| `--lat-glow`   | `#F0B429`                 | 〃 |
| `--good`       | `#0CA30C`                 | status only, with icon+label |
| `--critical`   | `#D03B3B`                 | errors, with icon+label |

### Light theme — "lab bench"

| Token          | Hex                       |
|----------------|---------------------------|
| `--page`       | `#EEF1F6` |
| `--surface`    | `#F7F8FA` |
| `--surface-2`  | `#FFFFFF` |
| `--ink`        | `#101828` |
| `--ink-2`      | `#46536B` |
| `--muted`      | `#7A8699` |
| `--hairline`   | `rgba(16,24,40,0.12)` |
| `--grid`       | `rgba(16,24,40,0.06)` |
| `--rx`         | `#008FB3` |
| `--tx`         | `#6D28D9` |
| `--lat`        | `#A36000` |
| `--good`       | `#006300` |
| `--critical`   | `#D03B3B` |

Theme rules: dark is the default; first visit honors `prefers-color-scheme`; the
toggle stamps `data-theme` on `<html>` and persists to `localStorage`. Canvases
read tokens from computed style so they re-skin on toggle. Glow variants are
decorative only (gradient ends, shadow blur) — identity is always carried by the
validated base hue plus a text label, never color alone.

## 2 · Typography

Three faces, three jobs — chosen for the instrument-panel register:

| Role | Face | Used for |
|------|------|----------|
| Display | **Space Grotesk** (600/700) | brand mark, gauge numeral, tile values |
| Data / utility | **IBM Plex Mono** (400/500) | eyebrows, units, meta readouts, axis ticks, history rows |
| Body | system-ui stack | buttons, helper copy, errors |

Scale: gauge numeral `clamp(56px, 12vw, 92px)`; tile values 28–32px; eyebrows
11px mono, letterspaced +0.08em, uppercase. Tabular numerals (`tabular-nums`) on
the live gauge numeral and history columns so digits don't jitter. Fonts load
from Google Fonts with full system fallbacks — the app works offline on fallbacks.

## 3 · Layout

```
┌────────────────────────────────────────────────────────┐
│ ▚ SpeedUndo                         [history] [theme]  │  topbar, hairline below
│                                                        │
│                    ╭─────────────╮                     │
│                 ╱   ·  ·  ·  ·    ╲                    │  gauge hero — 270° arc,
│                │      ( GO )       │                   │  GO ring idle → live
│                 ╲   184.2 Mbps    ╱                    │  numeral while running
│                    ╰─────────────╯                     │
│                 ● DOWNLOAD · phase chip                │
│                                                        │
│  ┌─ PING ────┐ ┌─ JITTER ──┐ ┌─ DOWN ───┐ ┌─ UP ────┐  │  stat tiles, LED tick
│  │ 24 ms     │ │ 1.8 ms    │ │ 184 Mbps │ │ 42 Mbps │  │  per metric hue
│  └───────────┘ └───────────┘ └──────────┘ └─────────┘  │
│                                                        │
│  RX ─ DOWNLOAD   TX ─ UPLOAD                 [table]   │  legend row
│  ~~~/\~~~~/\_____ scope trace ______/\/~~~~~~~~        │  live area chart,
│  0s        5s        10s        15s        20s         │  crosshair tooltip
│                                                        │
│  IP 61.3.136.44 · AS9829 · VIA MAA · LOADED RTT 96 ms  │  mono meta chips
│  server: [Cloudflare edge ▾]                           │
└────────────────────────────────────────────────────────┘
   history drawer (right, over backdrop): past runs,
   RX/TX mini bars + values, copy / clear
```

Mobile (≤ 720px): single column — gauge, tiles in a 2×2 grid, trace, chips wrap.
Drawer becomes full-width sheet.

## 4 · Signature element

**Phosphor persistence.** While the test runs, the gauge needle leaves a trail of
its recent positions that decays like a CRT phosphor, and the same treatment
draws the scope trace (bright leading edge, dimming history). It encodes something
true — where the throughput just was, i.e. its variance — not just decoration.
Disabled under `prefers-reduced-motion` (needle jumps, no trail, trace still
draws statically).

## 5 · Measurement methodology

Backend: **Cloudflare's public speed-test edge** (`speed.cloudflare.com`) —
verified CORS-open (`Access-Control-Allow-Origin: *`, `timing-allow-origin: *`).
`__down?bytes=N` serves N bytes; `__up` accepts POSTs; client IP/ASN/city/colo
arrive as `cf-meta-*` response headers on a 0-byte request. A bundled
zero-dependency Node server exposes the same contract (`/down`, `/up`) for
LAN/localhost testing, selectable in the footer.

| Phase | Method | Reported |
|-------|--------|----------|
| Ping | 10 sequential 0-byte GETs, `performance.now()` around each | median → **ping**; mean absolute successive difference → **jitter** |
| Download | 1 MB warm-up, then 5 parallel streams of 25 MB reads for ~10 s; bytes counted via `ReadableStream` reader into a shared counter, sampled every 100 ms | throughput over the window minus the first 1.5 s ramp; peak kept for details |
| Loaded latency | 0-byte pings every 750 ms *during* the download phase | median → **loaded RTT** (bufferbloat indicator, shown in meta row) |
| Upload | 4 parallel XHR POSTs of 8 MB random blobs for ~8 s, bytes via `upload.onprogress` | same trimmed-window computation |

Mbps = bytes × 8 / seconds / 10⁶ (decimal, as ISPs advertise). The gauge scale is
piecewise-linear over stops 0 · 1 · 5 · 10 · 20 · 50 · 100 · 250 · 500 · 1000, so
both a 8 Mbps DSL line and a gigabit line read meaningfully. Aborts are clean
(AbortController + xhr.abort); a failed phase degrades gracefully (partial
results kept, error state names the phase and offers retry).

## 6 · Architecture

```
speedundo/
  index.html          shell, semantic landmarks, aria-live status
  css/styles.css      tokens (both themes), layout, components
  js/
    main.js           state machine + DOM orchestration
    engine.js         measurement engine (ping/down/up/meta, events)
    gauge.js          canvas gauge: scale, needle, afterglow
    trace.js          canvas scope chart: RX/TX series, crosshair tooltip
    history.js        localStorage results + drawer rendering
    theme.js          theme boot + toggle + canvas re-skin event
    format.js         number/unit/time formatting helpers
  server.js           zero-dep static host + /down + /up (LAN test target)
  README.md           run instructions
```

No framework, no bundler: ES modules served statically. `node server.js` → 
http://localhost:8787.

## 7 · Quality floor

- Results history in `localStorage` with copy-to-clipboard summary.
- Keyboard: everything reachable; Esc closes the drawer; visible focus rings.
- `aria-live` announces phase changes and the final result; canvases are
  `aria-hidden` with the real values always present as DOM text.
- `prefers-reduced-motion` respected (no trail, no eased needle, no pulse).
- A results **details table** (per-phase avg/peak/bytes/streams) backs the chart
  with text — no data locked in pixels.
- Legend + direct RX/TX labels on the trace; text never colored by series.
- Responsive to 360px; hit targets ≥ 44px.

---

## 8 · Phase 2 — network intel (shipped)

Six additions on top of the core meter, keeping the zero-dependency rule:

| Feature | Design |
|---------|--------|
| **Auto ISP + city** | `ipwho.is` (CORS-open) → ISP, ASN, city, region, pincode. Cached per session; shown as a headline under the gauge; attached to results. Degrades silently. |
| **Packet loss** | Primary: two local RTCPeerConnections forced through a public TURN relay, unreliable datachannel, 400 sequenced packets → loss = missing seqs. Fallback when UDP is blocked: complete a 4 MB transfer post-download, 0-byte probe reuses the socket, read Cloudflare `cfL4` server-timing `sent`/`retrans` counters (min 200 segments). Fifth stat tile, amber (latency-family hue). |
| **Leaderboard** | `data/results.json` flat store (capped 20 000, no IPs). Median down/up/ping per ISP per city/pincode, 30-day window, ranked bars + health chips. "You" row highlighted. |
| **Outage signal** | Recent 2 h median vs 30-day baseline per ISP+city. Thresholds: −15 % warning · −40 % serious · −70 % critical. Status = icon + label + color (never color alone). Banner when it's the visitor's ISP. |
| **Time-of-day** | 24 hourly buckets of median download, bar chart on canvas re-skinned via tokens on theme change; trough direct-labeled "slowest". Falls back to city-wide when the visitor's ISP has < 12 reports. |
| **API + badge** | Open JSON: `/api/leaderboard · outage · patterns · stats · submit`. `/api/badge.svg` renders a shields-style live badge, value section tinted by health. Embed tab generates Markdown/HTML snippets. |

UI: tabbed **Network intel** panel (leaderboard / time of day / embed & API)
that loads at page-open from the detected city — community data is visible
before the first run. Real-internet results auto-submit; LAN results don't.
Demo seed (3 cities × 4 ISPs × 30 days, evening sag, one degraded ISP) makes
every panel render on first boot; top-up on later boots keeps seed stores
"recent" without ever touching real data.

---

## 9 · Share a result (shipped)

On completion, **Share result** opens a focus-trapped modal (`inert` on the
rest of the page, Esc to close — same pattern as the history drawer):

- **Result card** — `js/share.js` `drawCard()` paints the run onto a 1200×630
  canvas (social OG-image aspect): hero download in `--rx`, upload in `--tx`,
  ping/jitter/loss row in `--lat`, ISP + city, timestamp, and a mini-gauge
  echoing the app needle. Reads theme tokens, so it re-skins on `themechange`.
- **Caption** — editable textarea pre-filled from `defaultCaption()` (speeds,
  ISP/city, `#speedtest`).
- **Networks** — X · Reddit · Threads · Facebook, official Simple Icons brand
  glyphs (CC0), each opening that network's web share intent with the caption.
  Intents can't carry an image, so picking a network first copies the card PNG
  to the clipboard; the note explains the paste step and degrades to
  "Download image" when clipboard write is blocked.
- **Direct** — Download image (PNG), Copy image, and the native share sheet
  (`navigator.share` with the file) where supported.

Hue-per-metric holds on the card (download cyan, upload violet, latency amber),
so a shared image reads as the same system as the app.
