import crypto from 'node:crypto';

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: '-', mdash: '-', hellip: '...', '#039': "'", '#8217': "'", '#8216': "'", '#8220': '"', '#8221': '"', '#8211': '-', '#8212': '-', '#038': '&', '#8377': '₹' };

export function decodeEntities(s = '') {
  return String(s)
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (ENTITIES[k] != null) return ENTITIES[k];
      if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
      if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10));
      return m;
    });
}

export function stripHtml(s = '') {
  return decodeEntities(String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Strip tracking params and fragments so the same article dedups.
export function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_src|mc_|igshid|oc$)/i.test(k)) url.searchParams.delete(k);
    }
    url.hostname = url.hostname.replace(/^www\./, '');
    return url.toString().replace(/\/$/, '');
  } catch {
    return u;
  }
}

const SUFFIXES = /\b(private limited|pvt\.? ltd\.?|pvt|ltd\.?|limited|llp|inc\.?|corp\.?|corporation|co\.|company|technologies|technology|tech|labs?|solutions|software|systems|ventures|india|global|group|holdings|the)\b/gi;

export function normName(name = '') {
  return String(name)
    .toLowerCase()
    .replace(/\.(com|in|ai|io|co|app|tech)\b/g, '')
    .replace(/['’]s\b/g, '')
    .replace(SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function domainOf(u) {
  if (!u) return null;
  try {
    const h = new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
    return h.includes('.') ? h : null;
  } catch {
    return null;
  }
}

// Jaro-Winkler similarity for fuzzy name matching.
export function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const md = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - md); j < Math.min(b.length, i + md + 1); j++) {
      if (!bm[j] && a[i] === b[j]) { am[i] = bm[j] = true; m++; break; }
    }
  }
  if (!m) return 0;
  let t = 0;
  for (let i = 0, k = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let p = 0;
  while (p < 4 && a[p] === b[p]) p++;
  return jaro + p * 0.1 * (1 - jaro);
}

const STOP = new Set('a an the and or of to in on for with by from at as is are was were be its it this that new india indian startup startups raises raised funding'.split(' '));
export function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9₹$ ]+/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
}

export function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export const INR_PER_USD = 85;

// "$12 Mn", "Rs 40 Cr", "₹150 crore", "USD 3.5 million", "$1.2B" -> USD millions
export function parseAmountUsdM(text = '') {
  const s = String(text).replace(/,/g, '');
  const m = s.match(/(US\$|USD|\$|₹|INR|Rs\.?)\s?(\d+(?:\.\d+)?)\s?(mn|million|m\b|cr\b|crore|crores|bn|billion|b\b|lakh|lakhs|k\b|thousand)?/i)
    || s.match(/(\d+(?:\.\d+)?)\s?(mn|million|cr|crore|crores|bn|billion|lakh|lakhs)\s?(dollars|usd|rupees|inr)?/i);
  if (!m) return null;
  let cur, num, unit;
  if (/^\d/.test(m[1])) {
    num = parseFloat(m[1]); unit = (m[2] || '').toLowerCase(); cur = /cr|lakh|rupee|inr/i.test(m[2] + (m[3] || '')) ? 'INR' : 'USD';
  } else {
    cur = /₹|INR|Rs/i.test(m[1]) ? 'INR' : 'USD'; num = parseFloat(m[2]); unit = (m[3] || '').toLowerCase();
  }
  if (!Number.isFinite(num)) return null;
  let value; // in native currency units
  if (/^(mn|million|m)$/.test(unit)) value = num * 1e6;
  else if (/^(bn|billion|b)$/.test(unit)) value = num * 1e9;
  else if (/^cr/.test(unit)) value = num * 1e7;
  else if (/^lakh/.test(unit)) value = num * 1e5;
  else if (/^(k|thousand)$/.test(unit)) value = num * 1e3;
  else value = num;
  const usd = cur === 'INR' ? value / INR_PER_USD : value;
  const m_ = usd / 1e6;
  return m_ > 0.005 && m_ < 20000 ? Math.round(m_ * 100) / 100 : null;
}

export function fmtUsdM(m) {
  if (m == null) return null;
  if (m >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  if (m >= 1) return `$${m.toFixed(m >= 10 ? 0 : 1)}M`;
  return `$${Math.round(m * 1000)}K`;
}

export function toIso(d) {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}

export const daysAgo = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86_400_000 : Infinity);
