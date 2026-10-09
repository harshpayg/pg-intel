// Traction insights from DataForSEO: where a company's web traffic comes from, whether it is growing,
// what it ranks for and what runs on its site. One lookup costs a few cents, so results are cached.
import { q, J, nowIso } from '../db.js';
import { bus, log } from '../bus.js';

const BASE = () => (process.env.DATAFORSEO_BASE || 'https://api.dataforseo.com').replace(/\/$/, '');
const CACHE_DAYS = 7;
const DAILY_CAP = () => Number(process.env.DATAFORSEO_DAILY_CAP) || 100;
export const configured = () => Boolean(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

q.run(`CREATE TABLE IF NOT EXISTS traction (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  data TEXT,
  error TEXT,
  cost REAL NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL
)`);

// Google location codes for countries are 2000 + ISO 3166 numeric. The UI turns alpha-2 into a country name.
const ISO = {
  4: 'AF', 8: 'AL', 12: 'DZ', 32: 'AR', 36: 'AU', 40: 'AT', 48: 'BH', 50: 'BD', 56: 'BE', 76: 'BR', 100: 'BG', 124: 'CA', 144: 'LK', 152: 'CL',
  156: 'CN', 158: 'TW', 170: 'CO', 191: 'HR', 196: 'CY', 203: 'CZ', 208: 'DK', 218: 'EC', 233: 'EE', 246: 'FI', 250: 'FR', 276: 'DE', 288: 'GH',
  300: 'GR', 344: 'HK', 348: 'HU', 352: 'IS', 356: 'IN', 360: 'ID', 372: 'IE', 376: 'IL', 380: 'IT', 392: 'JP', 398: 'KZ', 400: 'JO', 404: 'KE',
  410: 'KR', 414: 'KW', 422: 'LB', 440: 'LT', 428: 'LV', 442: 'LU', 458: 'MY', 462: 'MV', 480: 'MU', 484: 'MX', 504: 'MA', 524: 'NP', 528: 'NL',
  554: 'NZ', 566: 'NG', 578: 'NO', 512: 'OM', 586: 'PK', 604: 'PE', 608: 'PH', 616: 'PL', 620: 'PT', 634: 'QA', 642: 'RO', 643: 'RU', 682: 'SA',
  688: 'RS', 702: 'SG', 703: 'SK', 704: 'VN', 705: 'SI', 710: 'ZA', 724: 'ES', 752: 'SE', 756: 'CH', 764: 'TH', 784: 'AE', 788: 'TN', 792: 'TR',
  800: 'UG', 804: 'UA', 818: 'EG', 826: 'GB', 834: 'TZ', 840: 'US', 858: 'UY', 862: 'VE', 894: 'ZM',
};
const countryOf = (code) => ISO[Number(code) - 2000] || null;
const REGION = new Intl.DisplayNames(['en'], { type: 'region' });
const nameOf = (cc) => { try { return REGION.of(cc); } catch { return cc; } };

// Payment and commerce tech worth calling out for PayGlocal's pitch.
const PAYMENT_TECH = /stripe|paypal|razorpay|cashfree|payu|ccavenue|braintree|adyen|checkout\.com|square|klarna|afterpay|paddle|chargebee|recurly|shopify payments|apple pay|google pay|amazon pay|instamojo|juspay|easebuzz|phonepe|paytm|2checkout|worldpay|payoneer|wise/i;
const COMMERCE_TECH = /shopify|woocommerce|magento|bigcommerce|wix|squarespace|prestashop|opencart|salesforce commerce/i;

function auth() {
  return `Basic ${Buffer.from(`${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`).toString('base64')}`;
}

class ApiError extends Error {}

async function call(path, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method: 'POST', signal: ctl.signal,
      headers: { authorization: auth(), 'content-type': 'application/json' },
      body: JSON.stringify([body]),
    });
    const j = await res.json().catch(() => null);
    if (!j) throw new ApiError(`DataForSEO returned HTTP ${res.status}`);
    // 20000 = ok. Account-level problems (unverified, no funds, bad login) come back here.
    if (j.status_code !== 20000) throw new ApiError(`DataForSEO: ${j.status_message || j.status_code}`);
    const task = j.tasks?.[0];
    // 40102 "No Search Results" is a normal empty answer, not a failure.
    if (task && task.status_code !== 20000 && task.status_code !== 40102) throw new ApiError(`DataForSEO: ${task.status_message || task.status_code}`);
    return { result: task?.result?.[0] || null, cost: Number(j.cost) || 0 };
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError('DataForSEO timed out');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

function summariseOverview(result) {
  const byCountry = new Map();
  let total = 0, paid = 0, keywords = 0, isNew = 0, isLost = 0, paidCountries = 0;
  for (const it of result?.items || []) {
    const cc = countryOf(it.location_code);
    const o = it.metrics?.organic || {};
    const p = it.metrics?.paid || {};
    const etv = num(o.etv);
    total += etv; paid += num(p.etv); keywords += num(o.count); isNew += num(o.is_new); isLost += num(o.is_lost);
    if (num(p.count) > 0) paidCountries++;
    if (!cc) continue;
    const row = byCountry.get(cc) || { cc, location_code: it.location_code, language_code: it.language_code, etv: 0, keywords: 0, langEtv: -1 };
    row.etv += etv; row.keywords += num(o.count);
    // Remember the main language in each country for follow-up calls.
    if (etv > row.langEtv) { row.langEtv = etv; row.language_code = it.language_code; }
    byCountry.set(cc, row);
  }
  const countries = [...byCountry.values()].sort((a, b) => b.etv - a.etv).map(({ langEtv, ...r }) => ({ ...r, share: total ? r.etv / total : 0 }));
  const india = countries.find((c) => c.cc === 'IN');
  return { total, paid, keywords, isNew, isLost, paidCountries, countries, intlShare: total ? 1 - (india?.etv || 0) / total : null };
}

function summariseHistory(result) {
  return (result?.items || [])
    .map((it) => ({ y: it.year, m: it.month, etv: num(it.metrics?.organic?.etv), keywords: num(it.metrics?.organic?.count) }))
    .sort((a, b) => a.y - b.y || a.m - b.m)
    .slice(-12);
}

function summariseKeywords(result) {
  return (result?.items || []).slice(0, 10).map((it) => {
    const s = it.ranked_serp_element?.serp_item || {};
    return {
      keyword: it.keyword_data?.keyword,
      volume: num(it.keyword_data?.keyword_info?.search_volume),
      position: s.rank_group ?? s.rank_absolute ?? null,
      etv: num(s.etv),
      url: s.url || null,
      intent: it.keyword_data?.search_intent_info?.main_intent || null,
    };
  }).filter((k) => k.keyword);
}

function summariseTech(result) {
  const groups = result?.technologies || {};
  const all = [];
  for (const [group, cats] of Object.entries(groups)) {
    for (const [cat, names] of Object.entries(cats || {})) {
      for (const name of [].concat(names || [])) all.push({ group, cat, name: String(name) });
    }
  }
  return {
    payments: [...new Set(all.filter((t) => PAYMENT_TECH.test(t.name) || /payment/i.test(t.cat)).map((t) => t.name))],
    commerce: [...new Set(all.filter((t) => COMMERCE_TECH.test(t.name) || /ecommerce/i.test(t.cat)).map((t) => t.name))],
    other: [...new Set(all.map((t) => t.name))].filter((n) => !PAYMENT_TECH.test(n) && !COMMERCE_TECH.test(n)).slice(0, 14),
    country: result?.country_iso_code || null,
    language: result?.content_language_code || result?.language_code || null,
    title: result?.title || null,
  };
}

// Plain-language takeaways for sales, written from the numbers rather than guessed.
function insights(d, companyName) {
  const out = [];
  const o = d.overview;
  if (o.intlShare != null && o.total >= 50) {
    const top = o.countries.find((c) => c.cc !== 'IN');
    if (o.intlShare >= 0.5) out.push({ tone: 'good', text: `${Math.round(o.intlShare * 100)}% of search traffic comes from outside India${top ? `, led by ${nameOf(top.cc)}` : ''}: ${companyName} is already selling to a foreign audience.` });
    else if (o.intlShare >= 0.15) out.push({ tone: 'good', text: `${Math.round(o.intlShare * 100)}% of search traffic is international${top ? ` (top: ${nameOf(top.cc)})` : ''}: an early foreign audience worth converting.` });
    else out.push({ tone: 'neutral', text: `Search traffic is mostly from India (${Math.round((1 - o.intlShare) * 100)}%): lead with expansion plans, not current foreign volume.` });
  }
  const h = d.history;
  if (h.length >= 4) {
    const last = h.at(-1).etv, base = h[Math.max(0, h.length - 4)].etv;
    if (base > 20) {
      const g = (last - base) / base;
      if (g >= 0.2) out.push({ tone: 'good', text: `Traffic in ${d.market?.cc ? nameOf(d.market.cc) : 'its top market'} grew ${Math.round(g * 100)}% over the last 3 months: momentum to reference in outreach.` });
      else if (g <= -0.2) out.push({ tone: 'warn', text: `Traffic in ${d.market?.cc ? nameOf(d.market.cc) : 'its top market'} fell ${Math.round(-g * 100)}% over the last 3 months.` });
    }
  }
  if (o.paidCountries > 0) out.push({ tone: 'good', text: `Buying Google Ads in ${o.paidCountries} market${o.paidCountries > 1 ? 's' : ''}: actively spending to acquire customers.` });
  if (d.tech?.payments?.length) out.push({ tone: 'neutral', text: `Payment stack on site: ${d.tech.payments.join(', ')}. Compare fees, FX spread and FIRA handling against PayGlocal.` });
  else if (d.tech?.commerce?.length) out.push({ tone: 'neutral', text: `Runs on ${d.tech.commerce.join(', ')} with no payment provider detected: a PayGlocal plugin conversation.` });
  if (!out.length) out.push({ tone: 'neutral', text: 'Too little search data to judge traction; rely on news signals for this lead.' });
  return out;
}

const progress = (id, step, state) => bus.emit('traction', { id, step, state });

export function cachedTraction(companyId) {
  const row = q.get('SELECT * FROM traction WHERE company_id = ?', companyId);
  if (!row) return null;
  return { domain: row.domain, data: J(row.data, null), error: row.error, cost: row.cost, fetchedAt: row.fetched_at, stale: Date.now() - new Date(row.fetched_at).getTime() > CACHE_DAYS * 86400000 };
}

export function usageToday() {
  const day = new Date().toISOString().slice(0, 10);
  const r = q.get(`SELECT COUNT(*) n, COALESCE(SUM(cost), 0) cost FROM traction WHERE fetched_at >= ?`, `${day}T00:00:00`);
  return { lookups: r.n, cost: r.cost, cap: DAILY_CAP() };
}

const running = new Map();

export function fetchTraction(companyId, { refresh = false } = {}) {
  if (running.has(companyId)) return running.get(companyId);
  const p = run(companyId, refresh).finally(() => running.delete(companyId));
  running.set(companyId, p);
  return p;
}

async function run(companyId, refresh) {
  const c = q.get('SELECT id, name, domain FROM companies WHERE id = ?', companyId);
  if (!c) throw new ApiError('Lead not found');
  if (!c.domain) throw new ApiError('No website on file for this lead. Run "Research now" first.');
  if (!configured()) throw new ApiError('DataForSEO is not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.');
  const cached = cachedTraction(companyId);
  if (cached?.data && !cached.stale && !refresh) return cached;
  const use = usageToday();
  if (use.lookups >= use.cap) throw new ApiError(`Daily DataForSEO limit reached (${use.cap} lookups). Raise DATAFORSEO_DAILY_CAP to allow more.`);

  const target = c.domain.replace(/^www\./, '');
  let cost = 0;
  const step = async (name, fn) => {
    progress(companyId, name, 'start');
    try { const r = await fn(); progress(companyId, name, 'done'); return r; }
    catch (e) { progress(companyId, name, 'error'); throw e; }
  };

  try {
    // 1. Traffic in every country in one call; this also tells us which market to drill into.
    const ov = await step('countries', () => call('/v3/dataforseo_labs/google/domain_rank_overview/live', { target, limit: 200 }));
    cost += ov.cost;
    const overview = summariseOverview(ov.result);
    const market = overview.countries[0] || { cc: 'IN', location_code: 2356, language_code: 'en' };
    const from = new Date(); from.setMonth(from.getMonth() - 12);

    // 2-4 in parallel; a failed side call leaves its section empty instead of failing the whole lookup.
    const soft = (name, fn) => step(name, fn).then((r) => { cost += r.cost; return r.result; }).catch((e) => { log('error', `Traction ${name} for ${target}: ${e.message}`); return null; });
    const [hist, kw, tech] = await Promise.all([
      soft('trend', () => call('/v3/dataforseo_labs/google/historical_rank_overview/live', { target, location_code: market.location_code, language_code: market.language_code, date_from: from.toISOString().slice(0, 10) })),
      soft('keywords', () => call('/v3/dataforseo_labs/google/ranked_keywords/live', { target, location_code: market.location_code, language_code: market.language_code, limit: 10, order_by: ['ranked_serp_element.serp_item.etv,desc'] })),
      soft('tech', () => call('/v3/domain_analytics/technologies/domain_technologies/live', { target })),
    ]);

    const data = { target, market: { cc: market.cc, language: market.language_code }, overview, history: summariseHistory(hist), keywords: summariseKeywords(kw), tech: tech ? summariseTech(tech) : null };
    data.insights = insights(data, c.name);
    q.run(`INSERT INTO traction(company_id, domain, data, error, cost, fetched_at) VALUES(?,?,?,NULL,?,?)
      ON CONFLICT(company_id) DO UPDATE SET domain = excluded.domain, data = excluded.data, error = NULL, cost = excluded.cost, fetched_at = excluded.fetched_at`,
    companyId, target, JSON.stringify(data), cost, nowIso());
    log('enrich', `Traction for ${c.name} (${target}): ${Math.round(overview.total)} est. visits/mo, cost $${cost.toFixed(3)}`);
    return cachedTraction(companyId);
  } catch (e) {
    log('error', `Traction for ${target}: ${e.message}`);
    throw e;
  }
}

export { ApiError };
