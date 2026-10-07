import { XMLParser } from 'fast-xml-parser';
import { fetchText, fetchJson } from '../util/http.js';
import { stripHtml, clip, toIso } from '../util/text.js';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: true, htmlEntities: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x) => (x == null ? '' : typeof x === 'object' ? (x['#text'] ?? '') : String(x));

// Each item: { url, title, summary, published_at, meta? }
// meta.entity lets a structured source skip LLM extraction.
export function parseFeed(body) {
  const doc = xml.parse(body);
  if (doc.rss?.channel) {
    return arr(doc.rss.channel.item).map((it) => ({
      url: txt(it.link) || txt(it.guid),
      title: stripHtml(txt(it.title)),
      summary: clip(stripHtml(txt(it['content:encoded']) || txt(it.description)), 1500),
      published_at: toIso(txt(it.pubDate) || txt(it['dc:date'])),
      meta: { publisher: txt(it.source) || undefined, categories: arr(it.category).map(txt).slice(0, 8) },
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((e) => {
      const link = arr(e.link).find((l) => !l['@rel'] || l['@rel'] === 'alternate') || arr(e.link)[0];
      return {
        url: link?.['@href'] || txt(e.id),
        title: stripHtml(txt(e.title)),
        summary: clip(stripHtml(txt(e.content) || txt(e.summary)), 1500),
        published_at: toIso(txt(e.updated) || txt(e.published)),
        meta: { author: txt(e.author?.name) || undefined },
      };
    });
  }
  if (doc['rdf:RDF']) {
    return arr(doc['rdf:RDF'].item).map((it) => ({
      url: txt(it.link), title: stripHtml(txt(it.title)), summary: clip(stripHtml(txt(it.description)), 1500), published_at: toIso(txt(it['dc:date'])),
    }));
  }
  throw new Error('Not an RSS/Atom feed');
}

let redditToken = null;
async function redditOAuth(p) {
  if (!redditToken || redditToken.exp < Date.now()) {
    const res = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'PayGlocalLeadIntel/1.0',
      },
      body: 'grant_type=client_credentials',
    });
    const j = await res.json();
    if (!j.access_token) throw new Error(`Reddit auth failed: ${j.error || res.status}`);
    redditToken = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  }
  const path = p.search
    ? `${p.sub ? `/r/${p.sub}` : ''}/search?q=${encodeURIComponent(p.search)}&sort=new&t=month&limit=50${p.sub ? '&restrict_sr=1' : ''}`
    : `/r/${p.sub}/new?limit=50`;
  const data = await fetchJson(`https://oauth.reddit.com${path}`, { headers: { authorization: `bearer ${redditToken.token}` } });
  return (data?.data?.children || []).map((c) => c.data).filter((d) => !/^\[(for hire|hiring|meta|mod)\]/i.test(d.title)).map((d) => ({
    url: `https://www.reddit.com${d.permalink}`,
    title: d.title,
    summary: clip(d.selftext || '', 1500),
    published_at: new Date(d.created_utc * 1000).toISOString(),
    meta: { sub: d.subreddit, score: d.score, comments: d.num_comments },
  }));
}

const kinds = {
  async rss(p) {
    const { text } = await fetchText(p.url);
    let items = parseFeed(text);
    if (p.mustMatch) {
      const re = new RegExp(p.mustMatch, 'i');
      items = items.filter((i) => re.test(`${i.title} ${i.summary}`));
    }
    return items;
  },

  async gnews(p) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(p.query)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const { text } = await fetchText(url);
    return parseFeed(text).map((i) => {
      // Titles look like "Headline - Publisher"; descriptions are just a link.
      const m = i.title.match(/^(.*)\s+-\s+([^-]{2,60})$/);
      return { ...i, title: m ? m[1] : i.title, summary: '', meta: { ...i.meta, publisher: m?.[2] || i.meta?.publisher, query: p.query } };
    });
  },

  async reddit(p) {
    // Prefer the official API when a (free) Reddit app is configured: far higher rate limits.
    if (process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET) return redditOAuth(p);
    const url = p.search
      ? `https://www.reddit.com/${p.sub ? `r/${p.sub}/` : ''}search.rss?q=${encodeURIComponent(p.search)}&sort=new&t=month${p.sub ? '&restrict_sr=1' : ''}`
      : `https://www.reddit.com/r/${p.sub}/new/.rss`;
    const { text } = await fetchText(url);
    return parseFeed(text).filter((i) => !/^r\/\w+$/.test(i.title) && !/^\[(for hire|hiring|meta|mod)\]/i.test(i.title)).map((i) => ({ ...i, summary: clip(i.summary.replace(/submitted by .*$/i, '').trim(), 1500), meta: { ...i.meta, sub: p.sub } }));
  },

  async hn(p) {
    const since = Math.floor(Date.now() / 1000) - (p.days || 30) * 86400;
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(p.query)}&tags=${p.tags || 'story'}&numericFilters=created_at_i>${since}&hitsPerPage=50`;
    const data = await fetchJson(url);
    return (data.hits || []).filter((h) => h.title).map((h) => ({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title,
      summary: clip(stripHtml(h.story_text || ''), 1500),
      published_at: toIso(h.created_at),
      meta: { hn: `https://news.ycombinator.com/item?id=${h.objectID}`, points: h.points },
    }));
  },

  async yc(p) {
    const data = await fetchJson('https://yc-oss.github.io/api/companies/all.json', { timeoutMs: 60000, maxBytes: 60_000_000 });
    const minYear = p.minYear || 2022;
    return data
      .filter((c) => (c.regions || []).includes('India') && c.status === 'Active')
      .filter((c) => { const y = parseInt(String(c.batch || '').match(/\d{4}/)?.[0] || '0', 10); return y >= minYear; })
      .map((c) => ({
        url: c.url,
        title: `${c.name} (YC ${c.batch}): ${c.one_liner || ''}`.trim(),
        summary: clip(c.long_description || c.one_liner || '', 1200),
        published_at: c.launched_at ? new Date(c.launched_at * 1000).toISOString() : null,
        meta: {
          entity: {
            name: c.name,
            website: c.website,
            logo: c.small_logo_thumb_url,
            city: (c.all_locations || '').split(',')[0] || null,
            description: c.one_liner,
            industry: [c.industry, c.subindustry, ...(c.tags || [])].filter(Boolean).join(' / '),
            team_size: c.team_size,
            batch: c.batch,
            hiring: !!c.isHiring,
            stage: 'Seed',
            investors: ['Y Combinator'],
          },
        },
      }));
  },
};

export const SOURCE_KINDS = Object.keys(kinds);

export async function fetchSource(source) {
  const fn = kinds[source.kind];
  if (!fn) throw new Error(`Unknown source kind ${source.kind}`);
  const items = await fn(source.params);
  return items.filter((i) => i.url && i.title);
}

// Seed catalogue. Categories: leads (company discovery), intel (market/regulatory), voice (pain signals).
export const SEED_SOURCES = [
  // Indian startup and business news
  { id: 'inc42', name: 'Inc42', kind: 'rss', params: { url: 'https://inc42.com/feed/' }, cadence_min: 30 },
  { id: 'inc42-buzz', name: 'Inc42 Buzz', kind: 'rss', params: { url: 'https://inc42.com/buzz/feed/' }, cadence_min: 30 },
  { id: 'entrackr', name: 'Entrackr', kind: 'rss', params: { url: 'https://entrackr.com/rss' }, cadence_min: 30 },
  { id: 'yourstory', name: 'YourStory', kind: 'rss', params: { url: 'https://yourstory.com/feed' }, cadence_min: 30 },
  { id: 'et-startups', name: 'ET Startups', kind: 'rss', params: { url: 'https://economictimes.indiatimes.com/tech/startups/rssfeeds/78570540.cms' }, cadence_min: 45 },
  { id: 'mint-companies', name: 'Mint Companies', kind: 'rss', params: { url: 'https://www.livemint.com/rss/companies' }, cadence_min: 60 },
  { id: 'bs-companies', name: 'Business Standard Companies', kind: 'rss', params: { url: 'https://www.business-standard.com/rss/companies-101.rss' }, cadence_min: 60 },
  { id: 'moneycontrol', name: 'Moneycontrol Business', kind: 'rss', params: { url: 'https://www.moneycontrol.com/rss/business.xml' }, cadence_min: 60 },
  { id: 'techcrunch-india', name: 'TechCrunch India', kind: 'rss', params: { url: 'https://techcrunch.com/tag/india/feed/' }, cadence_min: 90 },
  { id: 'techinasia', name: 'Tech in Asia (India)', kind: 'rss', params: { url: 'https://www.techinasia.com/feed', mustMatch: 'india|indian|bengaluru|bangalore|mumbai|delhi|gurugram' }, cadence_min: 90 },
  { id: 'businessline-economy', name: 'BusinessLine Economy (exports)', kind: 'rss', params: { url: 'https://www.thehindubusinessline.com/economy/feeder/default.rss' }, cadence_min: 120 },

  // Google News discovery queries (core; the agent adds rotating ones)
  { id: 'gn-funding', name: 'GNews: Indian startup funding', kind: 'gnews', params: { query: 'Indian startup raises funding when:7d' }, cadence_min: 60 },
  { id: 'gn-seed-a', name: 'GNews: Seed / Series A India', kind: 'gnews', params: { query: '"Series A" OR "seed round" OR "pre-Series A" India startup when:7d' }, cadence_min: 60 },
  { id: 'gn-saas-global', name: 'GNews: Indian SaaS going global', kind: 'gnews', params: { query: 'Indian SaaS startup global customers OR "US market" when:30d' }, cadence_min: 180 },
  { id: 'gn-d2c-intl', name: 'GNews: D2C international expansion', kind: 'gnews', params: { query: 'Indian D2C brand international expansion OR "ships globally" OR "US launch" when:30d' }, cadence_min: 180 },
  { id: 'gn-expands', name: 'GNews: expands to US/UAE/UK', kind: 'gnews', params: { query: 'Indian startup expands to US OR UAE OR UK OR Europe when:14d' }, cadence_min: 120 },
  { id: 'gn-exporters', name: 'GNews: exporters new markets', kind: 'gnews', params: { query: 'Indian exporter new markets OR export orders company when:14d' }, cadence_min: 180 },
  { id: 'gn-edtech-travel', name: 'GNews: edtech / travel global', kind: 'gnews', params: { query: 'Indian edtech OR traveltech startup international students OR global expansion when:30d' }, cadence_min: 240 },

  // Builders and global-first startups
  { id: 'yc-india', name: 'Y Combinator India companies', kind: 'yc', params: { minYear: 2023 }, cadence_min: 1440, min_cadence: 720, max_cadence: 2880 },
  { id: 'hn-india', name: 'Hacker News: India builders', kind: 'hn', params: { query: 'India', tags: 'show_hn', days: 45 }, cadence_min: 360 },
  { id: 'hn-bangalore', name: 'Hacker News: Bangalore', kind: 'hn', params: { query: 'Bangalore', days: 45 }, cadence_min: 360 },

  // Voice of market: pain signals
  { id: 'rd-indianstartups', name: 'Reddit r/IndianStartups', kind: 'reddit', category: 'voice', params: { sub: 'IndianStartups' }, cadence_min: 120 },
  { id: 'rd-startupindia', name: 'Reddit r/StartUpIndia', kind: 'reddit', category: 'voice', params: { sub: 'StartUpIndia' }, cadence_min: 120 },
  { id: 'rd-intl-payments', name: 'Reddit: international payments India', kind: 'reddit', category: 'voice', params: { search: '"international payments" india' }, cadence_min: 360 },
  { id: 'rd-stripe-india', name: 'Reddit: Stripe/PayPal India', kind: 'reddit', category: 'voice', params: { search: '(stripe OR paypal OR payoneer) india fees' }, cadence_min: 360 },
  { id: 'rd-fira', name: 'Reddit: FIRA / export invoices', kind: 'reddit', category: 'voice', params: { search: 'FIRA OR FIRC OR "export of services" OR LUT' }, cadence_min: 480 },

  // Market and regulatory intel
  { id: 'rbi-press', name: 'RBI Press Releases', kind: 'rss', category: 'intel', params: { url: 'https://rbi.org.in/pressreleases_rss.xml' }, cadence_min: 120 },
  { id: 'rbi-notifications', name: 'RBI Notifications', kind: 'rss', category: 'intel', params: { url: 'https://rbi.org.in/notifications_rss.xml' }, cadence_min: 120 },
  { id: 'gn-competitors', name: 'GNews: competitor moves', kind: 'gnews', category: 'intel', params: { query: 'Skydo OR Xflow OR Briskpe OR "Razorpay international" OR "Cashfree cross-border" OR "PayPal India" when:14d' }, cadence_min: 240 },
  { id: 'gn-xb-payments', name: 'GNews: cross-border payments India', kind: 'gnews', category: 'intel', params: { query: '"cross-border payments" India OR "payment aggregator cross border" when:14d' }, cadence_min: 240 },
  { id: 'gn-export-policy', name: 'GNews: export policy / DGFT', kind: 'gnews', category: 'intel', params: { query: 'DGFT OR "export policy" OR "foreign trade policy" India when:14d' }, cadence_min: 360 },
  { id: 'gn-payglocal', name: 'GNews: PayGlocal mentions', kind: 'gnews', category: 'intel', params: { query: 'PayGlocal when:60d' }, cadence_min: 720 },
];
