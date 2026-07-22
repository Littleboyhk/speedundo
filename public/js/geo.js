// ISP + location detection. Primary source: ipwho.is (CORS-open, no key —
// verified); fallback: ipapi.co for networks/regions where the primary is
// blocked or down. Each attempt is time-boxed so a filtered endpoint can
// never stall the test — the app degrades to cf-meta only.
// Cached for the session so repeat tests don't re-query.

let cached;

const PROVIDERS = [
  {
    url: 'https://ipwho.is/',
    map: (j) => (j.success === false ? null : {
      ip: j.ip || null,
      isp: j.connection?.isp || j.connection?.org || null,
      asn: j.connection?.asn || null,
      city: j.city || null,
      region: j.region || null,
      country: j.country_code || null,
      postal: j.postal || null,
    }),
  },
  {
    url: 'https://ipwhois.app/json/',
    map: (j) => (j.success === false ? null : {
      ip: j.ip || null,
      isp: j.isp || j.org || null,
      asn: j.asn ? Number(String(j.asn).replace(/^AS/i, '')) || null : null,
      city: j.city || null,
      region: j.region || null,
      country: j.country_code || null,
      postal: null, // not provided by this source
    }),
  },
];

const ATTEMPT_TIMEOUT_MS = 6000;

export async function detectIsp({ signal } = {}) {
  if (cached !== undefined) return cached;
  for (const p of PROVIDERS) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const res = await fetch(p.url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = p.map(await res.json());
      if (geo && (geo.isp || geo.city)) {
        cached = geo;
        return cached;
      }
    } catch (err) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      // fall through to the next provider
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  cached = null; // offline or all providers blocked — degrade to cf-meta only
  return cached;
}
