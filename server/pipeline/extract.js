import { getConfig } from '../config.js';
import { q } from '../db.js';
import * as llm from './llm.js';
import { parseAmountUsdM, clip, domainOf } from '../util/text.js';

// ---------- shared vocab ----------
export const SECTOR_RULES = [
  ['Edtech', /\b(edtech|education|learning|upskill|test prep|students?|tutor|school|university|coaching)\b/i],
  ['Travel', /\b(travel|tourism|hotels?|hospitality|trips?|visa|flights?|holiday|traveltech)\b/i],
  ['Healthtech', /\b(health|healthtech|medtech|clinic|pharma|diagnostic|hospital|medical|wellness)\b/i],
  ['Fintech', /\b(fintech|lending|nbfc|insurtech|wealth|neobank|credit|loans?|payments? (app|startup|platform)|stock broking|trading app)\b/i],
  ['Gaming', /\b(gaming|game studio|games?|esports)\b/i],
  ['D2C', /\b(d2c|direct-to-consumer|consumer brand|apparel|fashion|beauty|skincare|personal care|jewell?ery|footwear|snacks?|beverages?|home decor|furniture|ethnic wear|ayurved|nutrition|pet food|coffee|tea brand)\b/i],
  ['Exporter', /\b(exporters?|exports? (of|to)|export house|handicrafts?|textiles?|garments?|spices|seafood|carpets?|leather goods|gems?)\b/i],
  ['SaaS', /\b(saas|b2b software|software platform|crm|erp|api|devtools?|developer tools?|cloud|platform for (businesses|enterprises)|enterprise software|workflow|cybersecurity|security platform|observability|analytics platform)\b/i],
  ['Manufacturing', /\b(manufactur\w*|factory|industrial|electronics|semiconductors?|ev|electric vehicles?|drones?|aerospace|defence|robotics|hardware|chemicals?)\b/i],
  ['Logistics', /\b(logistics|shipping|supply chain|freight|warehous\w*|last-mile|cargo)\b/i],
  ['Agency', /\b(agency|marketing services|design studio|creative studio|consultancy|outsourcing|bpo|kpo|staffing)\b/i],
  ['IT Services', /\b(it services|software services|digital transformation|software development|engineering services|gcc|global capability)\b/i],
  ['Marketplace', /\b(marketplace|b2b commerce|quick commerce|e-?commerce|social commerce)\b/i],
  ['AI', /\b(ai|artificial intelligence|genai|gen ai|llms?|machine learning|agents?|agentic)\b/i],
  ['Media', /\b(media|content|creators?|ott|streaming|publishing|podcast)\b/i],
];

export function guessSector(text) {
  for (const [name, re] of SECTOR_RULES) if (re.test(text)) return name;
  return 'Other';
}

const MARKETS = [
  ['US', /\b(us|u\.s\.|usa|united states|america|american|north america|silicon valley|new york|san francisco)\b/i],
  ['UK', /\b(uk|u\.k\.|united kingdom|britain|london)\b/i],
  ['UAE', /\b(uae|dubai|abu dhabi|emirates)\b/i],
  ['Middle East', /\b(middle east|gcc|saudi|ksa|riyadh|qatar|oman|kuwait|bahrain|mena)\b/i],
  ['Europe', /\b(europe|european|eu|germany|france|netherlands|spain|italy|nordics?)\b/i],
  ['Southeast Asia', /\b(southeast asia|sea|singapore|indonesia|malaysia|thailand|vietnam|philippines)\b/i],
  ['Australia', /\b(australia|new zealand|anz)\b/i],
  ['Africa', /\b(africa|nigeria|kenya|south africa|egypt)\b/i],
  ['Canada', /\b(canada|toronto)\b/i],
  ['Japan', /\b(japan|tokyo)\b/i],
  ['Global', /\b(global(ly)?|worldwide|international(ly)?|overseas|abroad|cross-border)\b/i],
];

export function detectMarkets(text) {
  return MARKETS.filter(([, re]) => re.test(text)).map(([m]) => m);
}

const STAGE_RE = /\b(pre-seed|pre seed|angel|seed|pre-series [a-e]|series [a-f]|bridge|debt|pre-ipo|grant)\b/i;
export function normStage(s) {
  if (!s) return null;
  const m = String(s).match(STAGE_RE);
  if (!m) return null;
  const v = m[1].toLowerCase().replace('pre seed', 'pre-seed');
  const fixed = { 'pre-seed': 'Pre-Seed', angel: 'Angel', seed: 'Seed', bridge: 'Bridge', debt: 'Debt', 'pre-ipo': 'Pre-IPO', grant: 'Grant' };
  if (fixed[v]) return fixed[v];
  const ps = v.match(/^pre-series ([a-e])/);
  if (ps) return `Pre-Series ${ps[1].toUpperCase()}`;
  return `Series ${v.slice(-1).toUpperCase()}`;
}

export function isEnterpriseName(name, cfg = getConfig()) {
  const lc = String(name).toLowerCase();
  return cfg.enterpriseNames.some((n) => {
    const e = n.toLowerCase();
    return lc === e || lc.startsWith(`${e} `) || (e.length >= 4 && lc.startsWith(e));
  });
}

// ---------- heuristic (no-LLM) extraction ----------
const FUND_VERBS = 'raises|raised|secures|secured|bags|bagged|lands|nets|mops up|picks up|gets|receives|closes|scoops up|garners|snags|grabs|attracts|announces|in talks to raise|to raise|eyes';
const EXP_VERBS = 'expands|expanding|enters|forays into|launches in|launches operations in|sets up|opens|goes global|takes .* global|debuts in|partners with|acquires|launches';
const DESCRIPTOR = /^.*\b(startup|start-up|brand|platform|company|firm|maker|player|provider|marketplace|unicorn|soonicorn|fintech|edtech|healthtech|agritech|spacetech|deeptech|cleantech|proptech|insurtech|traveltech|saas|d2c|nbfc|lender|based|backed|owned|bound|operator|manufacturer|exporter|venture|app|unit|subsidiary|arm|major|giant|parent|retailer|chain|studio|label)\s+/i;

function cleanHead(head) {
  let h = head.replace(/^(exclusive|funding alert|breaking|report|update|just in|funding)\s*[:|-]\s*/i, '').replace(/^\[[^\]]+\]\s*/, '').trim();
  h = h.split(/[:|]/).pop().trim();
  const stripped = h.replace(DESCRIPTOR, '').trim();
  if (stripped && /^[A-Za-z0-9]/.test(stripped) && /[A-Z0-9]/.test(stripped)) h = stripped;
  h = h.replace(/['’]s$/, '').replace(/^(the|india's|indian)\s+/i, '').replace(/\s+(ipo|group)$/i, '').trim();
  return h;
}

function plausibleName(name, cfg) {
  if (!name || name.length < 2 || name.length > 40) return false;
  if (!/^[A-Za-z0-9]/.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length > 4) return false;
  if (/^[a-z]/.test(name) && !/[A-Z]/.test(name)) return false; // all-lowercase phrase
  if (/\b(startups?|companies|firms|brands|investors|government|centre|india|report|week|this|these|how|why|what|here)\b/i.test(name) && words.length > 1) return false;
  if (/\b(co-?founder|founder|ceo|minister|chairman|md|missile|ministry|mutual fund|govt|government)\b/i.test(name)) return false;
  const lc = name.toLowerCase();
  if (cfg.blocklist.some((b) => b.toLowerCase() === lc)) return false;
  if (cfg.competitors.some((b) => b.toLowerCase() === lc)) return false;
  return true;
}

function heuristicLead(item, source, cfg) {
  const text = `${item.title}. ${item.summary || ''}`;
  let name = null, type = 'other';
  const f = item.title.match(new RegExp(`^(.*?)\\s+(${FUND_VERBS})\\b`, 'i'));
  const e = item.title.match(new RegExp(`^(.*?)\\s+(${EXP_VERBS})\\b`, 'i'));
  // Investor-first headlines: "Chiratae leads $10 Mn round in quantum startup Quanfluence".
  const inv = !f || !/raise|secure|bag|land|net|mop|pick|get|receive|close|scoop|garner|snag|grab|attract/i.test(f[2])
    ? item.title.match(/\b(?:leads?|invests?|backs?|bets on|pumps|puts|co-leads?|participates)\b.*?\b(?:startup|start-up|brand|platform|company|firm|maker|challenger|player|provider)\s+([A-Z][\w.&'’-]*(?:\s+[A-Z][\w.&'’-]*){0,2})/)
    : null;
  const showHn = item.title.match(/^Show HN:\s*(.+?)\s*(?:\s[–—-]\s|:|,|$)/);
  const intlHere = detectMarkets(item.title).length > 0;
  if (f && /raise|secure|bag|land|net|mop|pick|get|receive|close|scoop|garner|snag|grab|attract/i.test(f[2]) && (parseAmountUsdM(item.title) || STAGE_RE.test(text) || /fund|round|invest/i.test(text))) {
    name = cleanHead(f[1]); type = 'funding';
  } else if (inv && /round|invest|back|crore|mn|million|seed|series/i.test(item.title)) {
    name = cleanHead(inv[1]); type = 'funding';
  } else if (e && intlHere && !/acquires|partners/i.test(e[2])) {
    // Without an LLM, only keep non-funding events that point abroad; domestic launches are noise.
    name = cleanHead(e[1]);
    type = /launches$/i.test(e[2]) ? 'launch' : 'expansion';
  } else if (showHn) {
    name = showHn[1].trim(); type = 'launch';
  }
  if (!plausibleName(name, cfg)) return null;

  const amountTxt = type === 'funding' ? raiseAmountText(item.title) || raiseAmountText(item.summary) : null;
  const amount_usd_m = amountTxt ? parseAmountUsdM(amountTxt) : null;
  const investors = [];
  const led = text.match(/led by ([A-Z][^,.;()]+?)(?:,|\.|;| and | with | along| alongside| to |$)/);
  if (led) investors.push(led[1].trim());
  const city = text.match(/\b(Bengaluru|Bangalore|Mumbai|Delhi|Gurugram|Gurgaon|Noida|Pune|Hyderabad|Chennai|Kolkata|Ahmedabad|Jaipur|Surat|Kochi|Chandigarh|Indore|Coimbatore)\b/)?.[1] || null;
  // Strip the company's own name so "ReFit Global" is not read as a global signal.
  const textNoName = text.split(name).join(' ');
  const markets = detectMarkets(textNoName);
  const cfgPos = cfg.keywords.positive.filter((k) => new RegExp(`\\b${escapeRe(k)}\\b`, 'i').test(textNoName));
  const competitors = cfg.competitors.filter((c) => new RegExp(`\\b${escapeRe(c)}\\b`, 'i').test(text));
  const enterprise = isEnterpriseName(name, cfg) || (amount_usd_m || 0) > 150 || /\b(listed|nse|bse|pre-ipo)\b/i.test(text);

  return {
    name,
    website: null,
    is_indian: true,
    city,
    sector: guessSector(text),
    size: enterprise ? 'enterprise' : 'startup',
    description: clip(item.summary || item.title, 220),
    sells_intl: markets.length ? 'likely' : 'unknown',
    markets: markets.filter((m) => m !== 'Global').concat(markets.includes('Global') ? ['Global'] : []),
    payment_pain: null,
    confidence: type === 'funding' ? 0.6 : 0.45,
    event: {
      type,
      title: item.title,
      summary: clip(item.summary || '', 400),
      stage: type === 'funding' ? normStage(text) : null,
      amount_text: amountTxt,
      amount_usd_m,
      investors,
      signals: [...new Set(cfgPos)].slice(0, 6),
      competitors,
    },
  };
}

function heuristicIntel(item, source, route) {
  const text = `${item.title} ${item.summary || ''}`;
  // Without an LLM, only keep community posts that actually talk about getting paid from abroad.
  if (route === 'voice' && !/\b(stripe|paypal|payoneer|wise\.com|skydo|xflow|razorpay|international payments?|receive payments?|foreign clients?|clients abroad|usd|firc|fira|ebrc|lut|export of services|swift|forex|wire transfer|chargebacks?|payment gateway|international cards?)\b/i.test(text)) return null;
  const competitor = /\b(skydo|xflow|briskpe|razorpay|cashfree|paypal|stripe|payoneer|wise|airwallex|payu|juspay)\b/i.test(text);
  const category = route === 'voice' ? 'voice' : source.id.startsWith('rbi') ? 'regulatory' : competitor ? 'competitor' : /\b(rbi|fema|dgft|policy|regulat|circular|guideline|direction)\b/i.test(text) ? 'regulatory' : 'market';
  const hot = /\b(payment aggregator|pa-cb|cross[- ]border|fema|export|import|forex|lrs|edpms|remittance|data localisation|dpdp|kyc)\b/i.test(text);
  const importance = hot ? 3 : category === 'regulatory' ? 1 : 2;
  const soWhat = {
    regulatory: hot ? 'Touches cross-border/PA rules: check impact on PayGlocal flows and merchant onboarding.' : 'Regulatory update; skim for anything touching payments or exports.',
    competitor: 'Competitor movement: watch positioning, pricing and logos to win back.',
    market: 'Market context for cross-border collections and export growth.',
    voice: 'A real business describing payment friction abroad: a direct outreach or content angle.',
  }[category];
  return { category, title: item.title, summary: clip(item.summary || '', 400), so_what: soWhat, importance };
}

// First money amount that is not a valuation ("at Rs 16.7 Cr valuation").
function raiseAmountText(t = '') {
  const re = /(US\$|USD|\$|₹|INR|Rs\.?)\s?[\d.,]+\s?(mn|million|m\b|cr\b|crore|bn|billion|b\b|lakh|k\b)?/gi;
  for (const m of String(t).matchAll(re)) {
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 18);
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    if (/valuation|valued/i.test(after) || /(\bat|valuation of|valued at|revenue of|turnover of|revenue to|worth)\s*(a\s+)?$/i.test(before)) continue;
    return m[0].trim();
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function structuredLead(item, cfg) {
  const e = item.meta.entity;
  const text = `${e.description || ''} ${e.industry || ''} ${item.summary || ''}`;
  const markets = detectMarkets(text);
  const b2b = /b2b|saas|developer|enterprise|api|infrastructure/i.test(e.industry || '');
  return {
    name: e.name,
    website: e.website,
    logo: e.logo,
    is_indian: true,
    city: e.city,
    sector: guessSector(`${e.industry} ${e.description}`),
    size: 'startup',
    description: clip(e.description || item.summary, 220),
    sells_intl: b2b || markets.length ? 'likely' : 'unknown',
    markets: markets.length ? markets : b2b ? ['US', 'Global'] : [],
    payment_pain: null,
    confidence: 0.8,
    event: {
      type: 'directory',
      title: `Backed by Y Combinator (${e.batch})${e.hiring ? ', currently hiring' : ''}`,
      summary: clip(item.summary, 400),
      stage: 'Seed',
      amount_text: '$500K (YC standard deal)',
      amount_usd_m: 0.5,
      investors: ['Y Combinator'],
      signals: ['YC-backed', b2b ? 'sells to global B2B buyers' : null, e.hiring ? 'hiring' : null].filter(Boolean),
      competitors: [],
    },
  };
}

// ---------- LLM extraction ----------
const SECTORS_ENUM = () => Object.keys(getConfig().sectors);

const SCHEMA = () => ({
  type: 'OBJECT',
  properties: {
    results: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          i: { type: 'INTEGER' },
          leads: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                name: { type: 'STRING' },
                website: { type: 'STRING', nullable: true },
                is_indian: { type: 'BOOLEAN' },
                city: { type: 'STRING', nullable: true },
                sector: { type: 'STRING', enum: SECTORS_ENUM() },
                size: { type: 'STRING', enum: ['micro', 'startup', 'sme', 'enterprise', 'unknown'] },
                description: { type: 'STRING' },
                sells_intl: { type: 'STRING', enum: ['yes', 'likely', 'unknown', 'no'] },
                markets: { type: 'ARRAY', items: { type: 'STRING' } },
                payment_pain: { type: 'STRING', nullable: true },
                confidence: { type: 'NUMBER' },
                event: {
                  type: 'OBJECT',
                  properties: {
                    type: { type: 'STRING', enum: ['funding', 'expansion', 'launch', 'export', 'hiring', 'pain', 'partnership', 'acquisition', 'other'] },
                    title: { type: 'STRING' },
                    summary: { type: 'STRING' },
                    stage: { type: 'STRING', nullable: true },
                    amount_text: { type: 'STRING', nullable: true },
                    amount_usd_m: { type: 'NUMBER', nullable: true },
                    investors: { type: 'ARRAY', items: { type: 'STRING' } },
                    signals: { type: 'ARRAY', items: { type: 'STRING' } },
                    competitors: { type: 'ARRAY', items: { type: 'STRING' } },
                  },
                  required: ['type', 'title', 'summary', 'investors', 'signals', 'competitors'],
                },
              },
              required: ['name', 'is_indian', 'sector', 'size', 'description', 'sells_intl', 'markets', 'confidence', 'event'],
            },
          },
          intel: {
            type: 'OBJECT',
            nullable: true,
            properties: {
              category: { type: 'STRING', enum: ['regulatory', 'competitor', 'market', 'voice'] },
              title: { type: 'STRING' },
              summary: { type: 'STRING' },
              so_what: { type: 'STRING' },
              importance: { type: 'INTEGER' },
            },
            required: ['category', 'title', 'summary', 'so_what', 'importance'],
          },
        },
        required: ['i', 'leads'],
      },
    },
  },
  required: ['results'],
});

const SYSTEM = `You are the lead-intelligence analyst for PayGlocal, an RBI-licensed cross-border payment aggregator (PA-CB) in India.
PayGlocal helps Indian businesses get paid from abroad: international card acceptance with high success rates, local collection accounts in USD/EUR/GBP and more, automated FIRA/eBRC for export compliance, fast INR settlement, payment links and invoices, Shopify/WooCommerce plugins.

Ideal customers (ICP): Indian-registered businesses of any size (freelancers to listed SMEs) that earn or could earn money from customers outside India:
SaaS and AI companies selling to US/EU, IT services and agencies with foreign clients, D2C brands shipping worldwide or selling on Amazon Global/Etsy/Shopify, goods exporters (textiles, handicrafts, jewellery, spices, engineering goods), edtech with international students, travel platforms with inbound/outbound foreign customers, gaming studios, creators.

Your job for each news item / post:
1. "leads": extract ONLY real, specifically named operating companies that are the SUBJECT of the item (raising money, expanding, launching, exporting, hiring, complaining about payments). Never extract investors, publishers, government bodies, or companies only mentioned in passing. Skip roundups listing many startups unless one is clearly the focus. Skip if no company is named.
   - is_indian: true only if headquartered or registered in India or Indian-founded with an Indian entity.
   - size: "enterprise" for large listed groups and unicorns at scale; otherwise best guess.
   - sells_intl: "yes" if the item states foreign customers/revenue/markets; "likely" if the business model implies it (B2B SaaS, IT services, exporter); else "unknown"/"no".
   - markets: concrete countries/regions mentioned (e.g. "US", "UAE", "Europe"); include "Global" if stated generally.
   - event.signals: 2-5 short phrases (max 6 words each) explaining why this matters for cross-border payments, quoting facts from the item. No speculation.
   - event.amount_usd_m: amount in USD millions (convert INR at 85/USD; 1 crore = 10,000,000 INR). null if not stated.
   - event.stage: e.g. "Pre-Seed", "Seed", "Pre-Series A", "Series A", "Series B", "Series C", "Debt", "Bridge", or null.
   - payment_pain: a short quote/paraphrase if the item mentions difficulty collecting money from abroad, otherwise null.
   - confidence: 0..1 that this is a real Indian company correctly extracted.
2. "intel": set when the item is useful market/regulatory/competitor knowledge for PayGlocal leadership, or a "voice of customer" post describing payment pain (category "voice"). importance 1 (FYI) to 3 (act now). so_what: one sentence on what PayGlocal should do or know. Otherwise null.
Return one result per input item index "i". Be precise and conservative. Do not invent websites; only include a website if the item states it or it is unambiguous.`;

function feedbackHints() {
  const liked = q.all("SELECT name, sector, why FROM companies WHERE feedback = 1 ORDER BY updated_at DESC LIMIT 5");
  const disliked = q.all("SELECT name, sector, why FROM companies WHERE feedback = -1 ORDER BY updated_at DESC LIMIT 5");
  if (!liked.length && !disliked.length) return '';
  const f = (r) => `- ${r.name} (${r.sector})`;
  return `\nSales feedback so far (calibrate relevance to this):\nLiked:\n${liked.map(f).join('\n') || '- none'}\nRejected:\n${disliked.map(f).join('\n') || '- none'}\n`;
}

async function llmBatch(batch) {
  const lines = batch.map(({ item, source }, i) => [
    `### i=${i}`,
    `source: ${source.name} (${source.category})${item.meta?.publisher ? `, publisher: ${item.meta.publisher}` : ''}`,
    `date: ${item.published_at?.slice(0, 10) || 'unknown'}`,
    `url-domain: ${domainOf(item.url) || ''}`,
    `title: ${item.title}`,
    item.summary ? `text: ${clip(item.summary, 900)}` : '',
  ].filter(Boolean).join('\n'));
  const prompt = `${feedbackHints()}\nItems:\n\n${lines.join('\n\n')}`;
  const out = await llm.json(SYSTEM, prompt, SCHEMA());
  const byIdx = new Map((out.results || []).map((r) => [r.i, r]));
  return batch.map((_, i) => byIdx.get(i) || { i, leads: [], intel: null });
}

// ---------- public ----------
// batch: [{ item, source, route }] -> [{ leads: [], intel: null|{} , via }]
export async function extractBatch(batch) {
  const cfg = getConfig();
  const results = new Array(batch.length);
  const needLlm = [];
  batch.forEach((b, idx) => {
    if (b.route === 'structured') results[idx] = { leads: [structuredLead(b.item, cfg)], intel: null, via: 'structured' };
    else needLlm.push(idx);
  });

  if (needLlm.length && llm.available()) {
    try {
      const out = await llmBatch(needLlm.map((idx) => batch[idx]));
      needLlm.forEach((idx, k) => {
        const r = out[k];
        results[idx] = { leads: (r.leads || []).map(cleanLlmLead), intel: r.intel || null, via: 'llm' };
      });
      return results;
    } catch {
      // fall through to heuristics for this batch
    }
  }

  for (const idx of needLlm) {
    const { item, source, route } = batch[idx];
    if (route === 'intel' || route === 'voice') {
      const lead = route === 'voice' ? null : heuristicLead(item, source, cfg);
      results[idx] = { leads: lead ? [lead] : [], intel: heuristicIntel(item, source, route), via: 'rules' };
    } else {
      const lead = heuristicLead(item, source, cfg);
      results[idx] = { leads: lead ? [lead] : [], intel: null, via: 'rules' };
    }
  }
  return results;
}

function cleanLlmLead(l) {
  return {
    ...l,
    website: l.website && domainOf(l.website) ? l.website : null,
    markets: [...new Set(l.markets || [])],
    confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0.5)),
    event: { ...l.event, stage: normStage(l.event?.stage) || l.event?.stage || null, investors: l.event?.investors || [], signals: l.event?.signals || [], competitors: l.event?.competitors || [] },
  };
}
