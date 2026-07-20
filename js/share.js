// Share-a-result: renders the finished test onto a 1200×630 canvas card
// (social OG-image aspect), and posts to X / Reddit / Threads / Facebook via
// their web share intents. Web intents can't attach an image, so the card is
// also copied to the clipboard (or downloadable) to paste into the post.

import {
  fmtMbps, fmtMs, fmtPct, speedUnitLabel, fmtDateTime,
} from './format.js';
import { readTokens } from './theme.js';

// Official brand glyphs (Simple Icons, CC0), 24×24 viewBox path data.
const NETWORKS = [
  {
    id: 'x', name: 'X',
    intent: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`,
    path: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z',
  },
  {
    id: 'reddit', name: 'Reddit',
    intent: (text) => `https://www.reddit.com/submit?title=${encodeURIComponent(text)}&type=TEXT`,
    path: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z',
  },
  {
    id: 'threads', name: 'Threads',
    intent: (text) => `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`,
    path: 'M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z',
  },
  {
    id: 'facebook', name: 'Facebook',
    // sharer needs a URL; quote carries the caption alongside it.
    intent: (text) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(location.origin)}&quote=${encodeURIComponent(text)}`,
    path: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
  },
];

export function defaultCaption(result) {
  const geo = result.geo || {};
  const unit = speedUnitLabel();
  const bits = [
    `⚡ ${fmtMbps(result.down)} ${unit} down · ${fmtMbps(result.up)} ${unit} up`,
    `${fmtMs(result.ping)} ms ping`,
  ];
  if (result.loss != null) bits.push(`${fmtPct(result.loss)}% loss`);
  const where = [geo.isp, geo.city].filter(Boolean).join(', ');
  return `My internet right now: ${bits.join(' · ')}`
    + (where ? ` — on ${where}` : '')
    + `\nMeasured with SpeedUndo #speedtest`;
}

/* ---- helpers ----------------------------------------------------------------- */

function hexA(hex, a) {
  const h = String(hex || '').replace('#', '');
  if (!/^[0-9a-f]{3,8}$/i.test(h)) return `rgba(31,165,188,${a})`;
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ---- card renderer ---------------------------------------------------------- */

const CARD_W = 1200;
const CARD_H = 630;

export function drawCard(canvas, result, tokens) {
  const t = tokens || readTokens(canvas);
  const ctx = canvas.getContext('2d');
  const geo = result.geo || {};
  canvas.width = CARD_W;
  canvas.height = CARD_H;

  // Surface + vignette
  ctx.fillStyle = t.surface || '#0D1420';
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  const vg = ctx.createRadialGradient(CARD_W / 2, -120, 80, CARD_W / 2, -120, 900);
  vg.addColorStop(0, hexA(t.rx, 0.10));
  vg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Hairline frame
  ctx.strokeStyle = t.hairline;
  ctx.lineWidth = 2;
  roundRect(ctx, 14, 14, CARD_W - 28, CARD_H - 28, 18);
  ctx.stroke();

  // Brand
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = t.ink;
  ctx.font = '600 44px "Space Grotesk", system-ui, sans-serif';
  const brandText = 'SpeedUndo';
  ctx.fillText(brandText, 64, 104);
  const brandW = ctx.measureText(brandText).width;
  ctx.fillStyle = t.muted;
  ctx.font = '400 22px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillText('internet speed meter', 64 + brandW + 22, 104);

  // Timestamp — top right
  ctx.textAlign = 'right';
  ctx.fillText(fmtDateTime(result.ts), CARD_W - 64, 104);
  ctx.textAlign = 'left';

  // Hero number: download
  ctx.fillStyle = t.rx;
  ctx.font = '600 170px "Space Grotesk", system-ui, sans-serif';
  const downTxt = fmtMbps(result.down);
  ctx.fillText(downTxt, 60, 320);
  const dw = ctx.measureText(downTxt).width;
  ctx.fillStyle = t.muted;
  ctx.font = '400 34px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillText(`${speedUnitLabel()} ↓ download`, 60 + dw + 26, 318);

  // Upload — second line
  ctx.fillStyle = t.tx;
  ctx.font = '600 84px "Space Grotesk", system-ui, sans-serif';
  const upTxt = fmtMbps(result.up);
  ctx.fillText(upTxt, 64, 428);
  const uw = ctx.measureText(upTxt).width;
  ctx.fillStyle = t.muted;
  ctx.font = '400 30px "IBM Plex Mono", ui-monospace, monospace';
  ctx.fillText(`${speedUnitLabel()} ↑ upload`, 64 + uw + 22, 426);

  // Metric row: ping / jitter / loss
  const row = [
    { label: 'PING', value: `${fmtMs(result.ping)} ms`, color: t.lat },
    { label: 'JITTER', value: `${fmtMs(result.jitter)} ms`, color: t.lat },
    ...(result.loss != null
      ? [{ label: 'LOSS', value: `${fmtPct(result.loss)} %`, color: t.lat }]
      : []),
  ];
  let x = 64;
  const rowY = 528;
  for (const m of row) {
    ctx.fillStyle = m.color;
    ctx.fillRect(x, rowY - 24, 10, 10);
    ctx.fillStyle = t.muted;
    ctx.font = '500 20px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillText(m.label, x + 20, rowY - 15);
    ctx.fillStyle = t.ink;
    ctx.font = '600 40px "Space Grotesk", system-ui, sans-serif';
    ctx.fillText(m.value, x, rowY + 28);
    x += Math.max(ctx.measureText(m.value).width, 150) + 66;
  }

  // ISP + city — bottom line
  const where = [geo.isp, [geo.city, geo.postal].filter(Boolean).join(' ')]
    .filter(Boolean).join('  ·  ');
  if (where) {
    ctx.fillStyle = t.ink2;
    ctx.font = '400 26px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillText(where, 64, 588);
  }

  // Gauge motif — right side
  drawMiniGauge(ctx, CARD_W - 210, 400, 130, result, t);
}

function drawMiniGauge(ctx, cx, cy, r, result, t) {
  const start = (135 * Math.PI) / 180;
  const sweep = (270 * Math.PI) / 180;
  // fraction on the same piecewise scale as the app gauge (approx: log-ish)
  const stops = [0, 1, 5, 10, 20, 50, 100, 250, 500, 1000];
  const v = Math.min(result.down || 0, 1000);
  let i = 0;
  while (i < stops.length - 1 && v > stops[i + 1]) i++;
  const frac = v <= 0 ? 0
    : (i + (v - stops[i]) / (stops[i + 1] - stops[i])) / (stops.length - 1);

  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, start + sweep);
  ctx.strokeStyle = t.hairline;
  ctx.lineWidth = 16;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, r, start, start + sweep * frac);
  const grad = ctx.createLinearGradient(cx - r, cy, cx + r, cy);
  grad.addColorStop(0, t.rx);
  grad.addColorStop(1, t.rxGlow || t.rx);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 16;
  ctx.stroke();

  // needle: center pivot, tip short of the arc (mirrors the app needle)
  const a = start + sweep * frac;
  const tip = r - 34;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * tip, cy + Math.sin(a) * tip);
  ctx.strokeStyle = t.ink;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + Math.cos(a) * tip, cy + Math.sin(a) * tip, 6, 0, Math.PI * 2);
  ctx.fillStyle = t.rxGlow || t.rx;
  ctx.fill();
}

/* ---- share actions ----------------------------------------------------------- */

export function cardBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

export async function copyCardToClipboard(canvas) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') return false;
  try {
    const blob = await cardBlob(canvas);
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch (_) {
    return false;
  }
}

export function downloadCard(canvas, result) {
  const a = document.createElement('a');
  const when = new Date(result.ts).toISOString().slice(0, 16).replace(/[:T]/g, '-');
  a.download = `speedundo-speedtest-${when}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

export async function nativeShare(canvas, result, caption) {
  if (!navigator.share) return false;
  try {
    const blob = await cardBlob(canvas);
    const file = blob && new File([blob], 'speedundo-speedtest.png', { type: 'image/png' });
    if (file && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: caption });
    } else {
      await navigator.share({ text: caption });
    }
    return true;
  } catch (_) {
    return false; // user dismissed or unsupported payload
  }
}

export function renderNetworkButtons(container, getCaption, beforeOpen) {
  container.textContent = '';
  for (const net of NETWORKS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `share-net share-net-${net.id}`;
    btn.setAttribute('aria-label', `Post to ${net.name}`);
    btn.innerHTML =
      `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${net.path}"/></svg>`
      + `<span>${net.name}</span>`;
    btn.addEventListener('click', async () => {
      await beforeOpen?.(net);
      window.open(net.intent(getCaption()), '_blank', 'noopener,width=640,height=640');
    });
    container.appendChild(btn);
  }
}
