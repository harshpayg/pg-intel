// Polite HTTP: per-host pacing, cooldown on 429/503, timeouts, size cap.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 PayGlocalLeadIntel/1.0';

const HOST_GAP_MS = {
  'www.reddit.com': 70000, // anonymous RSS tolerates roughly one request a minute
  'reddit.com': 70000,
  'oauth.reddit.com': 1000,
  'news.google.com': 2500,
  'hn.algolia.com': 1000,
  default: 1200,
};

const hostState = new Map(); // host -> { nextAt, cooldownUntil, chain }

function stateFor(host) {
  if (!hostState.has(host)) hostState.set(host, { nextAt: 0, cooldownUntil: 0, chain: Promise.resolve() });
  return hostState.get(host);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

export function hostCooldowns() {
  const now = Date.now();
  return [...hostState.entries()].filter(([, s]) => s.cooldownUntil > now).map(([h, s]) => ({ host: h, until: new Date(s.cooldownUntil).toISOString() }));
}

export async function fetchText(url, { timeoutMs = 20000, maxBytes = 6_000_000, headers = {}, accept } = {}) {
  const host = new URL(url).host;
  const st = stateFor(host);
  const gap = HOST_GAP_MS[host] ?? HOST_GAP_MS.default;

  // Serialize requests per host so pacing holds under concurrency.
  const turn = st.chain.then(async () => {
    const now = Date.now();
    if (st.cooldownUntil > now) throw new HttpError(429, `${url} (host cooling down)`);
    if (st.nextAt > now) await sleep(st.nextAt - now);
    st.nextAt = Date.now() + gap;
  });
  st.chain = turn.catch(() => {});
  await turn;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: accept || 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.9, */*;q=0.8',
        'accept-language': 'en-IN,en;q=0.9',
        ...headers,
      },
    });
    if (res.status === 429 || res.status === 503) {
      st.cooldownUntil = Date.now() + (host.includes('reddit') ? 15 : 5) * 60_000;
      throw new HttpError(res.status, url);
    }
    if (!res.ok) throw new HttpError(res.status, url);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { ctrl.abort(); break; }
      chunks.push(value);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, opts = {}) {
  const { text } = await fetchText(url, { ...opts, accept: 'application/json' });
  return JSON.parse(text);
}
