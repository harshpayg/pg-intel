import { getSetting, setSetting } from './db.js';

// Everything here is editable from the Config tab. Nothing is a hard exclusion:
// negatives only lower scores, so a strong lead can still surface.
export const DEFAULT_CONFIG = {
  threshold: 55, // "High intent" cut-off
  weights: {
    funding: 24,        // recency x stage fit x ticket size
    international: 26,  // sells abroad / target markets / ICP keywords / site signals
    sector: 12,         // sector fit with PayGlocal ICP
    paymentStack: 10,   // detected checkout stack (switch opportunity)
    pain: 10,           // public complaints about collecting from abroad
    momentum: 8,        // expansion, launches, hiring, partnerships in last 60d
    corroboration: 5,   // multiple independent sources
    novelty: 5,         // freshly discovered
  },
  penalties: {
    enterprise: -18,       // large enterprises rarely switch
    notIndian: -40,        // not an Indian entity
    negativeKeyword: -10,  // layoffs, shutdowns, etc.
    lateStage: -4,         // Series D+ / pre-IPO
  },
  preferredStages: ['Pre-Seed', 'Angel', 'Seed', 'Pre-Series A', 'Series A', 'Pre-Series B', 'Series B'],
  okStages: ['Series C', 'Bridge', 'Debt', 'Grant'],
  fundingSweetSpotUsdM: { min: 0.2, max: 40 },
  recencyHalfLifeDays: 30,
  sectors: {
    'SaaS': 1, 'AI': 0.95, 'IT Services': 0.9, 'D2C': 1, 'Exporter': 1, 'Manufacturing': 0.85,
    'Edtech': 0.85, 'Travel': 0.85, 'Agency': 0.8, 'Freelancer': 0.75, 'Marketplace': 0.75,
    'Gaming': 0.75, 'Media': 0.6, 'Healthtech': 0.6, 'Logistics': 0.6, 'Fintech': 0.3, 'Other': 0.4,
  },
  keywords: {
    positive: ['global', 'international', 'export', 'exports', 'overseas', 'cross-border', 'multi-currency',
      'US market', 'UK market', 'UAE', 'Middle East', 'GCC', 'Europe', 'Southeast Asia', 'Australia', 'Africa',
      'Amazon Global', 'Etsy', 'Shopify', 'international customers', 'global customers', 'worldwide', 'diaspora', 'NRI',
      'USD revenue', 'foreign clients', 'expand abroad', 'D2C exports'],
    negative: ['layoffs', 'shuts down', 'shutdown', 'insolvency', 'bankruptcy', 'fraud', 'raid', 'winds up'],
  },
  competitors: ['Skydo', 'Xflow', 'Razorpay', 'Cashfree', 'PayPal', 'Stripe', 'Payoneer', 'Wise', 'PayU', 'CCAvenue', 'Briskpe', 'Airwallex'],
  competitorMode: 'opportunity', // opportunity: competitor stack boosts (switch play) | deprioritize: lowers score
  enterpriseNames: ['Reliance', 'Tata', 'Infosys', 'Wipro', 'HCL', 'TCS', 'Adani', 'Mahindra', 'Flipkart', 'Paytm',
    'Zomato', 'Swiggy', 'Ola', 'Byju', 'Bharti', 'Airtel', 'Jio', 'HDFC', 'ICICI', 'SBI', 'Axis', 'Kotak', 'Bajaj', 'Birla',
    'Vedanta', 'ITC', 'Hindustan Unilever', 'Larsen', 'L&T', 'Nykaa', 'PhonePe', 'Meesho', 'Zepto', 'Eternal'],
  // Names that look like companies in headlines but are never leads.
  blocklist: ['Inc42', 'YourStory', 'Entrackr', 'TechCrunch', 'Economic Times', 'Moneycontrol', 'Mint', 'Reuters', 'Bloomberg',
    'Peak XV', 'Sequoia', 'Accel', 'Blume', 'Blume Ventures', 'Nexus', 'Elevation', 'Lightspeed', 'Matrix Partners', 'Kalaari',
    'Chiratae', 'Stellaris', '3one4', 'Info Edge', 'Tiger Global', 'SoftBank', 'Y Combinator', 'RBI', 'SEBI', 'DGFT',
    'Government', 'Centre', 'India', 'Startup', 'Startups', 'PayGlocal', 'Google', 'Microsoft', 'Amazon', 'Meta', 'Apple', 'OpenAI'],
  brief: { size: 25, explorationShare: 0.2 },
  llm: {
    batchSize: 8,
    dailyCallCap: 300,
    minIntervalMs: 6500,
  },
  enrichment: { minScore: 40, perCycle: 4 },
  agent: { enabled: true, intervalMinutes: 120, queriesPerCycle: 3, queryTtlDays: 4 },
  maxItemAgeDays: 45,
};

let cache = null;

export function getConfig() {
  if (!cache) cache = deepMerge(structuredClone(DEFAULT_CONFIG), getSetting('config', {}));
  return cache;
}

export function saveConfig(next) {
  setSetting('config', next);
  cache = null;
  return getConfig();
}

export function resetConfig() {
  setSetting('config', {});
  cache = null;
  return getConfig();
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  for (const [k, v] of Object.entries(over)) {
    base[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return base;
}
