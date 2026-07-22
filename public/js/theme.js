// Theme boot + toggle. The <head> inline script stamps data-theme before first
// paint; this module owns changes after that. Canvases listen for 'themechange'
// to re-read tokens.

const KEY = 'speedundo.theme';
const THEME_COLOR = { dark: '#060A12', light: '#EEF1F6' };

function apply(theme) {
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[theme] || THEME_COLOR.dark);
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
}

export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function initTheme() {
  // The inline head script already stamped the attribute; just sync theme-color
  // and let listeners know the starting state.
  apply(currentTheme());
}

export function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem(KEY, next); } catch (_) { /* private mode */ }
  apply(next);
  return next;
}

// Read the app's design tokens off any element (canvases re-skin with these).
export function readTokens(el) {
  const cs = getComputedStyle(el);
  const t = (name) => cs.getPropertyValue(name).trim();
  return {
    ink: t('--ink'),
    ink2: t('--ink-2'),
    muted: t('--muted'),
    hairline: t('--hairline'),
    grid: t('--grid'),
    surface: t('--surface'),
    surface2: t('--surface-2'),
    rx: t('--rx'),
    tx: t('--tx'),
    lat: t('--lat'),
    rxGlow: t('--rx-glow'),
    txGlow: t('--tx-glow'),
    latGlow: t('--lat-glow'),
  };
}

export const reducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
