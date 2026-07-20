# SpeedUndo — Icon & Favicon Setup

> What was done on **2026-07-19** to install the SpeedUndo brand mark as the
> site icon and favicon, which files exist, where they are referenced, and
> how to regenerate or change them.

## 1 · The mark

The icon is the SpeedUndo brand mark already used in the top bar: two rounded
signal bars — **RX cyan** (short) and **TX violet** (tall) — on the dark
instrument surface, inside a rounded app tile.

| Element | Value | Meaning |
|---------|-------|---------|
| Tile background | `#0D1420` | `--surface` of the dark theme |
| Short bar (left) | `#1FA5BC` | `--rx` — download cyan |
| Tall bar (right) | `#7D5BE6` | `--tx` — upload violet |
| Tile corner radius | 14/64 units | app-icon rounding |

The colors are the validated dark-theme metric hues from `PLAN.md`, so the
icon reads as the same system as the app itself.

## 2 · Files created

| File | Size | Purpose |
|------|------|---------|
| `icons/icon.svg` | vector | **Master.** All rasters derive from this. Modern browsers prefer it (crisp at any size). |
| `favicon.ico` (site root) | 16+32+48 multi-size | Legacy/default favicon. Browsers and crawlers request `/favicon.ico` unprompted. |
| `icons/favicon-16.png` | 16×16 | Browser tab, small displays |
| `icons/favicon-32.png` | 32×32 | Browser tab on HiDPI, taskbar |
| `icons/favicon-48.png` | 48×48 | Windows site shortcuts |
| `icons/apple-touch-icon.png` | 180×180 | iOS/iPadOS home-screen icon |
| `icons/icon-192.png` | 192×192 | Android home screen / PWA install |
| `icons/icon-512.png` | 512×512 | PWA splash / app stores / high-res |
| `manifest.webmanifest` (site root) | — | Web app manifest naming the app ("SpeedUndo") and pointing at the 192/512/SVG icons; enables Add-to-Home-Screen with the proper icon and dark theme color |
| `icons/build-icons.js` | script | Regenerates every raster above from the mark geometry. Zero dependencies. |

## 3 · Where they are wired in

**`index.html` head** (replaced the old inline data-URI favicon):

```html
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" type="image/svg+xml" href="/icons/icon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
```

Resolution order in practice: modern browsers pick the **SVG**; older ones
fall back to the sized PNGs or `/favicon.ico`; iOS uses the
**apple-touch-icon**; Android/PWA installs read the **manifest** (192/512).

**`server.js`**: added the `.webmanifest → application/manifest+json` MIME
mapping so the manifest is served with the correct content type. (`.svg`,
`.png`, `.ico` were already mapped.)

## 4 · How to regenerate (after changing the mark)

1. Edit the geometry/colors in `icons/icon.svg` **and** the matching
   `TILE`/`BARS` constants at the top of `icons/build-icons.js`
   (they mirror each other; keep them in sync).
2. Run:

   ```
   node icons/build-icons.js
   ```

   This rewrites all six PNGs and the root `favicon.ico` in one shot.
3. Hard-refresh (Ctrl+F5). Browsers cache favicons aggressively — if the
   old icon lingers, bump the links with a query string (`?v=2`) or clear
   the site data.

The generator is dependency-free: it renders the rounded-rect geometry with
4× supersampling and writes PNG (zlib) and ICO (PNG-compressed entries,
supported everywhere since Windows Vista) containers by hand.

## 5 · Verification done

- `node icons/build-icons.js` ran clean; all 7 artifacts on disk.
- `icons/icon-512.png` visually inspected — rounded dark tile, cyan + violet
  bars, anti-aliased edges, correct colors.
- Site loads with the new head links; `/favicon.ico`, `/icons/*.png`,
  `/icons/icon.svg`, `/manifest.webmanifest` all served 200 by `server.js`.
