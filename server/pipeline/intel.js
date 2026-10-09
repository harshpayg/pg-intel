// Deterministic classifiers for market intel and Reddit buyer intent.
// Both run with or without an LLM: they are the relevance gate and supply the "so what".
import { getConfig } from '../config.js';

const has = (re, t) => re.test(t);
const textOf = (item) => `${item.title} ${item.summary || ''}`;

// ---------- market intel ----------
const INDIA = /\b(india|indian|rbi|reserve bank|npci|upi|dgft|sebi|gift (city|ifsc)|ifsca|rupee|inr|bengaluru|mumbai|delhi|piyush goyal|sitharaman|malhotra)\b|\brupees\b|₹/i;

// Stories that mention the right words but never change anything for PayGlocal.
const INTEL_NOISE = [
  /\b(high court|supreme court|\bhc\b|cestat|tribunal|writ petition|quashed|upholds?|dismisses appeals?)\b/i,
  /\b(cbi|raid|custodial|arrest(ed)?|death|probe|fir into)\b/i,
  /\b(ironman|marathon|felicitat|award ceremony)\b/i,
  /\b(excise|alcohol|liquor|sugar|trq|rice export ban|minimum import price|anti-dumping|safeguard duty|scrap|psias?|gold dore)\b/i,
  /\b(denied entity|sebi warns|imposes (monetary )?penalty|penalty on|discloses .* order)\b/i,
  /\b(section 35 ?a|co-?operative bank|banking regulation act|amalgamation|cancels (the )?(certificate|licence))\b/i,
  /\b(foreign exchange turnover data|money market operations|treasury bills?|auction|weekly statistical|reference rate|ways and means|state government securities)\b/i,
  /\b(crypto(currenc(y|ies))?|bitcoin|stablecoins? (ban|caution))\b/i,
  /\b(shareholding|listings?|ipo)\b/i,
];

const UPI_ABROAD = 'zimbabwe|uae|uk|france|singapore|nepal|bhutan|sri lanka|mauritius|namibia|peru|trinidad|qatar|oman|cyprus';

// Topic -> what PayGlocal should do about it. First match wins, so most specific first.
const TOPICS = [
  { id: 'policy-statement', cat: 'regulatory', imp: 3, re: /statement on developmental and regulatory policies|monetary policy statement/i,
    so: 'RBI policy statement: scan the full list for payment, forex and PA measures before the next merchant conversation.' },
  { id: 'pa-rules', cat: 'regulatory', imp: 3, re: /payment aggregators?|\bpa-?cb\b|\bpa-?o\b|payment system operators?|master direction.{0,40}payment/i,
    so: 'Direct change to PA/PA-CB rules: check licence obligations, merchant onboarding and settlement flows.' },
  { id: 'export-realisation', cat: 'regulatory', imp: 3, re: /\bfema\b|export (proceeds|realis|realiz)|\bedpms\b|\be-?brc\b|\bfir[ac]s?\b|purpose codes?|inward remittance|softex/i,
    so: 'Changes how exporters prove receipts (FEMA, eBRC, FIRA): a direct hook for automated FIRA/eBRC in outreach.' },
  { id: 'freelancer-inflows', cat: 'regulatory', imp: 3, re: /(freelancers?|creators?|individuals?|professionals?).{0,60}(overseas|foreign|abroad|international)|(overseas|foreign) clients?/i,
    so: 'Clarity for freelancers and creators paid from abroad: publish an explainer and use it as an outreach opener for this segment.' },
  { id: 'remittance', cat: 'regulatory', imp: 2, re: /\blrs\b|outward remittance|form a2|remittance (limit|rules|norms)/i,
    so: 'Remittance rule change: mostly AD-bank side; confirm whether it touches PA-CB refunds or outward flows.' },
  { id: 'kyc-data', cat: 'regulatory', imp: 2, re: /\b(kyc|ckyc|video kyc|aml|anti-money laundering|dpdp|data localisation|data protection)\b/i,
    so: 'Compliance obligation shift (KYC/AML/DPDP): flag to compliance and check merchant onboarding steps.' },
  { id: 'export-incentives', cat: 'regulatory', imp: 2, re: /\b(rodtep|rosctl|duty drawback|interest equali[sz]ation|export promotion mission|niryat|trade finance|export credit|ecgc|insurance cover for .* exports?)\b/i,
    so: 'Export incentive or trade-finance change: exporters re-plan cash flow, a good moment to pitch faster INR settlement.' },
  { id: 'trade-corridor', cat: 'market', imp: 2, re: /\b(fta|free trade agreement|trade deal|trade pact|cepa|tariffs?|new markets|leverage ftas?)\b/i,
    so: 'Trade corridor shift: tells sales which export markets will grow; re-weight target segments and geographies.' },
  { id: 'upi-global', cat: 'market', imp: 1, re: new RegExp(`\\b(upi|npci|rupay)\\b.{0,100}\\b(international|global|cross[- ]border|abroad|overseas|countr(y|ies)|${UPI_ABROAD})\\b|\\b(${UPI_ABROAD})\\b.{0,60}\\b(upi|npci|rupay)\\b|npci international|\\bnipl\\b`, 'i'),
    so: 'UPI and Indian rails going abroad: watch for inbound UPI collection PayGlocal could offer for NRI and tourist payers.' },
  { id: 'cards', cat: 'market', imp: 2, re: /\b(tokeni[sz]ation|card networks?|visa|mastercard|amex|apple pay|google pay|mdr|3-?d ?secure|additional factor of authentication|afa)\b/i,
    so: 'Card acceptance change: check the effect on international card approval rates and checkout flows.' },
  { id: 'gift-city', cat: 'market', imp: 2, re: /\b(gift city|gift ifsc|ifsca)\b/i,
    so: 'GIFT City development: relevant to PayGlocal\'s IFSC PSP plans and to merchants routing global revenue.' },
  { id: 'export-data', cat: 'market', imp: 1, re: /\bexports?\b.{0,40}\b(rise|rises|grow|growth|jump|surge|fall|decline|could add|target|data|billion|record)\b/i,
    so: 'Export trend data: use for market sizing and as a talking point in exporter outreach.' },
  { id: 'xb-payments', cat: 'market', imp: 1, re: /cross[- ]border (payments?|collections?|remittances?|commerce|transfers?|platform)|instant payments|swift/i,
    so: 'Cross-border payments landscape: note new rails or partners that could change pricing or speed for Indian exporters.' },
];

const competitorRe = () => {
  const names = getConfig().competitors.filter((c) => !/payglocal/i.test(c));
  return new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
};

function competitorSoWhat(name, title) {
  if (/\b(launch|introduc|rolls? out|unveil|adds?|links?|enables?)\w*/i.test(title)) return `${name} shipped something new: compare with PayGlocal's offer and brief sales on how to position against it.`;
  if (/\b(raises?|funding|valuation|acqui)\w*/i.test(title)) return `${name} has fresh capital or an acquisition: expect pricing pressure and aggressive outreach to exporters.`;
  if (/\b(licen[cs]e|approval|authori[sz]ation)\b/i.test(title)) return `${name} licence change: check whether it opens a flow PayGlocal currently wins on.`;
  if (/\b(fees?|pricing|charges?)\b/i.test(title)) return `${name} pricing move: update the comparison sheet sales uses.`;
  return `${name} in the news: watch positioning and flag affected merchants to sales.`;
}

// Returns null (drop) or { category, importance, so_what, topic, reason }.
export function classifyIntel(item, source) {
  const t = textOf(item);
  const title = item.title || '';
  if (/\bpayglocal\b/i.test(title)) {
    if (/shareholding|valuation & |tracxn|zaubacorp/i.test(title)) return null;
    return { category: 'payglocal', importance: 2, topic: 'payglocal', so_what: 'PayGlocal in the news: share with sales and marketing and reuse in outreach.' };
  }
  const noise = INTEL_NOISE.find((re) => re.test(title) || (source.id.startsWith('rbi') && re.test(t)));
  if (noise && !/statement on developmental/i.test(title)) return null;
  // Import-only policy (no export or payments angle) does not affect PayGlocal merchants.
  if (/\bimports?\b/i.test(title) && !/\bexport|payment|remittance|forex/i.test(t)) return null;

  const comp = title.match(competitorRe());
  if (comp && /\b(pay|payment|cross|launch|fees?|raise|licen|merchant|india|global|international|wallet|checkout|qr)/i.test(title)) {
    const name = getConfig().competitors.find((c) => c.toLowerCase() === comp[1].toLowerCase()) || comp[1];
    return { category: 'competitor', importance: 2, topic: 'competitor', so_what: competitorSoWhat(name, title) };
  }

  const isRbi = source.id.startsWith('rbi');
  if (!isRbi && !INDIA.test(t)) return null; // global payments news without an India angle
  // Title only: RBI summaries are boilerplate that mentions everything, and GNews items have no summary.
  const topic = TOPICS.find((x) => x.re.test(title));
  if (!topic) return null;
  return { category: topic.cat, importance: topic.imp, topic: topic.id, so_what: topic.so };
}

// ---------- Reddit buyer intent ----------
// Follows the Reddit plan (reddit_plan.md): score each post for intent, India business, a concrete payment problem
// and revenue from abroad. A subreddit is only a source; the post has to qualify on its own.

// India-first subs: posts there need no explicit India mention.
const INDIA_SUBS = /^(indianstartups|startupindia|freelanceindia|freelance_india|ecommerceindia|indiatax|indiabusiness|indianentrepreneur|developersindia|indiainvestments|indiaspeaks|personalfinanceindia|legaladviceindia|caindia|india|bangalore|mumbai|delhi|hyderabad|pune|chennai|ahmedabad|kerala|kolkata)$/i;
const R_INDIA = /\b(india|indian|inr|rupees?|gst|lut|rbi|fema|nri|pvt\.? ?ltd|llp|proprietorship|bengaluru|bangalore|mumbai|delhi|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|surat|noida|gurgaon|gurugram)\b|₹|\b(crore|lakh)s?\b/i;

// Selling or getting paid from abroad (the side PayGlocal serves).
const R_RECEIVE = /\b(receiv\w*|collect\w*|get(ting)? paid|accept\w*|payouts?|withdraw\w*|settle\w*|inward|invoic\w*|bill(ing)? (my |our )?clients?|charge (my |our )?(customers?|clients?)|clients? (pay|in the|from|abroad|overseas)|foreign (clients?|customers?|buyers?)|international (clients?|customers?|buyers?|sales|orders?)|overseas (clients?|customers?|buyers?)|us clients?|uk clients?|export\w*)\b/i;
const R_BUSINESS = /\b(freelanc\w*|client(s)?|saas|startup|founder|co-?founder|my (business|company|agency|store|shop|brand|app|product)|our (business|company|agency|store|shop|brand|app|product|customers)|agency|consult\w*|subscription|customers?|merchant|seller|shopify|etsy|woocommerce|amazon global|exporter|export house|manufacturer|services? business|b2b|llp|pvt\.? ?ltd|proprietor)\b/i;
const R_PROVIDERS = /\b(stripe|paypal|payoneer|wise|skydo|xflow|briskpe|razorpay|cashfree|payu|dodo ?payments|paddle|lemon ?squeezy|airwallex|whop|gumroad|instamojo|ccavenue)\b/gi;

// Spending or buying from abroad, jobs, marketplaces: not a PayGlocal merchant.
const R_CONSUMER = /\b(send money (to|home)|money to (family|parents)|credit card|debit card|forex card|forex markup|zero[- ]forex|lounge|cashback|rewards card|pay(ing)? (on|for) international (websites?|sites?)|international (shopping|websites?|sites?)|application fee|tuition|visa (fee|application)|study abroad|trip|travel(l)?ing (to|from)|holiday|flight|hotel|amazon\.com order|temu|shein|aliexpress|steam|netflix|spotify|chatgpt (plus|subscription)|apple id|google play (balance|gift))\b/i;
// Payments must be the subject of the post, not a word in passing. Includes the plan's search terms.
const R_PAY_CORE = /\b(stripe|paypal|payoneer|wise|skydo|xflow|briskpe|razorpay|cashfree|payu|dodo ?payments|paddle|lemon ?squeezy|airwallex|whop|merchant of record|payment (gateway|provider|platform|processor|aggregator)s?|receiv\w* (international |foreign )?(payments?|money|funds|usd|dollars)|get(ting)? paid|payouts?|collect\w* payments?|accept\w* (international )?(payments?|cards)|international (payments?|cards?|transactions?|transfers?|clients?|customers?)|foreign (remittance|payments?|clients?|currency|buyers?)|payments? from (the )?(usa?|uk|abroad)|cross[- ]border payments?|inward remittance|fir[ac]s?|e-?brc|edpms|export of services|swift|wire transfers?|forex|fx (rate|fee|markup)|usd|paid in (usd|dollars))\b/gi;
const R_TITLE_PROMO = /\b(feedback (wanted|needed|on)|roast my|validate|would (a|an|this) .{0,60} help|is this a (real )?problem|co-?founder|sponsor|selected (among|for)|i (built|made|created|launched)|we (built|launched)|introducing|beta test|hiring|job)\b/i;
const R_OFFTOPIC = /^\s*\[(wts|wtb|selling|buying|us|eu|uk|for hire|hiring)\]|\b(resume|ats|interview|job (offer|hunt|search)|hiring|for hire|salary|appraisal|lut (for|to|on) (photo|video|footage)|color grad\w*|colour grad\w*|s-?log|davinci|premiere pro|lightroom|fpga|lut6|instagram|tiktok account|giveaway)\b/i;

// The plan's scoring signals.
const R_PROBLEM = /\b(declin\w*|fail(ed|ing|s)?|delay\w*|settlement|conversion|fx|exchange rate|fees?|charges?|on hold|chargebacks?|refunds?|frozen|rejected|blocked|limited|deduct\w*|lost|losing)\b/i;
const R_REVENUE_ABROAD = /\b(clients? (in|from) (the )?(us|usa|uk|europe|eu|canada|australia|uae)|(us|uk|eu|foreign|international|overseas|global) (clients?|customers?|buyers?|users?)|customers (abroad|overseas)|revenue|mrr|arr|orders? from|paying (customers|users)|sales (abroad|overseas))\b/i;
const R_UNHAPPY = /\b(high fees|too (expensive|high|much)|expensive|rip-?off|worst|terrible|horrible|hate|frustrat\w*|annoy\w*|nightmare|froze|frozen|on hold|limited|rejected|declined|banned|lost|losing|slow|delay\w*|stuck|unhappy|fed up|sucks|issues?|problems?)\b/i;
const R_URGENT = /\b(urgent\w*|asap|immediately|this week|next week|this month|launching|about to launch|going live|go live|deadline|stuck|help!)\b/i;
// Categories the handbook routes to extra review: flag, never pitch before compliance looks at it.
const R_RESTRICTED = /\b(gambling|betting|casino|fantasy (sports|league)|crypto\w*|bitcoin|nft|forex trading|binary options|adult|onlyfans|escort|vape|tobacco|cbd|cannabis|kratom|prescription|online pharmacy|firearms?|weapons?|mlm|network marketing|chit fund|loan app|lottery|matka)\b/i;

const DISCLOSE = 'If you mention PayGlocal, say you work there.';
const R_INTENTS = [
  { id: 'switching', label: 'Seeking a provider', re: /\b(looking for (a |an )?(payment|provider|gateway|platform|solution|way|alternative)|is (it |\w+ )?safe|should i use|good option|merchant of record|\bmor\b|do (i|we) need|which|best|recommend\w*|suggest\w*|alternatives?|vs\.?|versus|compare|comparison|switch(ing)? (from|to)|instead of|options? for|what (do|are) (you|people) us(e|ing)|anyone (use|used|using|tried))\b/i,
    angle: `Compare the options honestly for their flow (PayPal, Wise, Payoneer, a licensed PA-CB) on fees, FX spread, FIRA and settlement time. ${DISCLOSE}` },
  { id: 'blocked', label: 'Account blocked / rejected', re: /\b(frozen|freez\w*|on hold|account (was |got |is |has been )?(limited|closed|restricted)|blocked|banned|suspended|rejected|declined|invite[- ]only|not available in india|not supported in india)\b/i,
    angle: `Explain why gateways hold or refuse Indian accounts (KYC, purpose codes, chargebacks, invite-only) and what a licensed PA-CB needs instead. ${DISCLOSE}` },
  { id: 'compliance', label: 'FIRA / GST / RBI question', re: /\b(fir[ac]s?|e-?brc|softex|export of services|lut|gst (on|for) (export|foreign|international)|zero[- ]rated|purpose code|inward remittance|fema|rbi (rules?|guidelines?)|edf|edpms|tds|form 10f|trc)\b/i,
    angle: `Answer the compliance question accurately (FIRA/eBRC, LUT, export of services) before anything else. A PA-CB issues FIRA per payment, which is worth noting. ${DISCLOSE}` },
  { id: 'fees', label: 'Fees and FX loss', re: /\b(fees?|charges?|commission|markup|spread|conversion (rate|fee)|exchange rate|lost|losing|deduct\w*|hidden cost|expensive|swift|wire (fee|transfer)|intermediary bank|\d+(\.\d+)? ?%)\b/i,
    angle: `Break down where the money goes (gateway fee, FX spread, SWIFT and intermediary charges) with real numbers; local USD/GBP/EUR collection is the usual fix. ${DISCLOSE}` },
  { id: 'setup', label: 'Setting up collections', re: /\b(how (do|can|should) (i|we)|how to|set ?up|start accepting|integrate|onboard\w*|first international|payment gateway for|accept international (cards|payments))\b/i,
    angle: `Give a short setup checklist for their case (entity, current account, gateway or PA-CB, FIRA, LUT). ${DISCLOSE}` },
];
const PROVIDER_NAMES = { paypal: 'PayPal', payoneer: 'Payoneer', wise: 'Wise', stripe: 'Stripe', skydo: 'Skydo', xflow: 'Xflow', briskpe: 'Briskpe', razorpay: 'Razorpay', cashfree: 'Cashfree', payu: 'PayU', 'dodo payments': 'Dodo Payments', 'dodopayments': 'Dodo Payments', paddle: 'Paddle', 'lemon squeezy': 'Lemon Squeezy', lemonsqueezy: 'Lemon Squeezy', airwallex: 'Airwallex', whop: 'Whop', gumroad: 'Gumroad', instamojo: 'Instamojo', ccavenue: 'CCAvenue' };
export const providerName = (p) => PROVIDER_NAMES[p] || p;
const PROVIDER_COMPLAINT = { id: 'provider-complaint', label: 'Unhappy with current provider' };

// The plan's four groups, each with its product fit.
const SEGMENTS = [
  { id: 'saas', label: 'SaaS & digital', fit: 'IPG + recurring', re: /\b(saas|subscription|software|app store|api|ai (product|startup|tool)|b2b software|mrr|arr|indie ?hacker|digital (product|service)s?|online course|course creator)\b/i },
  { id: 'ecommerce', label: 'E-commerce & D2C', fit: 'IPG', re: /\b(shopify|woocommerce|bigcommerce|etsy|d2c|brand|online store|e-?commerce|checkout|dropship\w*|print on demand|amazon (global|fba|seller))\b/i },
  { id: 'goods', label: 'Goods exporters', fit: 'MCA', re: /\b(exporter|export house|shipment|importer|letter of credit|\blc\b|iec|ad code|fob|cif|handicraft|textile|garment|jewell?ery|spices|rice|manufactur\w*|containers?)\b/i },
  { id: 'services', label: 'Freelancers & service exporters', fit: 'MCA', re: /\b(freelanc\w*|upwork|fiverr|contractor|agency|consult\w*|it services|software services|outsourc\w*|designer|developer|writer|editor|translator|virtual assistant|creator|clients?)\b/i },
];
const R_FIT_IPG = /\b(cards?|checkout|declin\w*|payment gateway|gateway|subscription|recurring|website|store|shopify|woocommerce|payment links?)\b/i;
const R_FIT_MCA = /\b(invoic\w*|bank transfer|wire|swift|usd account|receive usd|remittance|ach|sepa|fir[ac]|payoneer|wise|upwork)\b/i;

export const REDDIT_BANDS = [
  { id: 'high', label: 'High priority', min: 80, action: 'Act first: reply if the subreddit rules allow, tailored to the actual problem.' },
  { id: 'research', label: 'Research', min: 50, action: 'Qualify first: business, payment flow, current provider and countries.' },
  { id: 'monitor', label: 'Monitor', min: 0, action: 'Keep for trend analysis; do not force a sales conversation.' },
];
export const bandOf = (score) => REDDIT_BANDS.find((b) => score >= b.min);

// Returns null (drop) or a scored post (0..100, bands 80+ / 50-79 / below 50).
export function classifyReddit(item, source) {
  const title = item.title || '';
  const t = textOf(item);
  const sub = String(item.meta?.sub || source.params?.sub || '');
  if (R_OFFTOPIC.test(title) || R_OFFTOPIC.test(t.slice(0, 400)) || R_TITLE_PROMO.test(title)) return null;
  // Spending abroad (cards, shopping, fees for study or travel) is the opposite of PayGlocal's flow.
  if (R_CONSUMER.test(title)) return null;

  const india = INDIA_SUBS.test(sub) || R_INDIA.test(t);
  if (!india) return null;
  const coreTitle = new RegExp(R_PAY_CORE.source, 'i').test(title);
  const coreHits = (t.match(R_PAY_CORE) || []).length;
  // Comments are short: one solid payments mention is enough there.
  if (!coreTitle && coreHits < (item.meta?.comment ? 1 : 2)) return null;

  // Judge intent on the title and the sentences that talk about payments, not the whole post.
  const focus = [title, ...t.split(/(?<=[.?!])\s+|\n+/).filter((x) => new RegExp(R_PAY_CORE.source, 'i').test(x))].join(' ');
  const receive = R_RECEIVE.test(focus) && !/\b(don['’]?t|do not|no) need to (receive|transfer)/i.test(t);
  // PayGlocal is cross-border only: domestic payments chatter (incorporation, UPI at the shop) is out.
  const crossBorder = receive || /\b(international|abroad|foreign|overseas|cross[- ]border|global(ly)?|usd|eur|gbp|dollars?|swift|us (clients?|customers?)|north america|europe|uk)\b/i.test(focus);
  if (!crossBorder) return null;
  const business = R_BUSINESS.test(t);
  if (!receive && !business) return null;
  if (R_CONSUMER.test(focus) && !receive) return null;

  const providers = [...new Set((t.match(R_PROVIDERS) || []).map((p) => p.toLowerCase().replace(/\s+/g, ' ')))];
  const intents = R_INTENTS.filter((x) => x.re.test(focus));
  const ids = new Set(intents.map((x) => x.id));
  const unhappy = providers.length > 0 && R_UNHAPPY.test(focus);

  // The plan's 100-point model.
  const parts = [
    [ids.has('switching'), 25, 'seeking a provider or alternative'],
    // Someone in India receiving money from abroad is a service exporter even without saying "business".
    [business || receive, 20, 'India-based business or exporter'],
    [ids.has('blocked') || ids.has('fees') || ids.has('compliance') || R_PROBLEM.test(focus), 20, 'Specific payment or FX problem'],
    [receive || R_REVENUE_ABROAD.test(t), 15, 'Customers or revenue abroad'],
    [unhappy, 10, unhappy ? `Unhappy with ${providers.slice(0, 2).map(providerName).join(', ')}` : 'Unhappy with current provider'],
    [R_URGENT.test(t), 10, 'Urgent or launching soon'],
  ];
  let score = parts.reduce((n, [on, pts]) => n + (on ? pts : 0), 0);
  const ageDays = item.published_at ? (Date.now() - new Date(item.published_at).getTime()) / 86400000 : 0;
  if (ageDays > 21) score -= 10; // stale threads rarely convert
  score = Math.max(0, Math.min(100, score));

  const restricted = (t.match(R_RESTRICTED) || [])[0] || null;
  const band = bandOf(score);
  const main = intents[0] || { id: 'discussion', label: 'Discussing payments', angle: `Add a specific, useful answer on getting paid from abroad; no link unless someone asks. ${DISCLOSE}` };
  const segment = SEGMENTS.find((s) => s.re.test(focus)) || SEGMENTS.find((s) => s.re.test(t)) || { id: 'other', label: 'Other business', fit: null };
  const ipg = R_FIT_IPG.test(focus), mca = R_FIT_MCA.test(focus);
  const fit = ipg && mca ? 'MCA + IPG' : ipg ? 'IPG' : mca ? 'MCA' : segment.fit;
  const angle = restricted
    ? `Restricted category (${restricted}): do not pitch; route to compliance before any outreach.`
    : `${main.angle} ${band.id === 'monitor' ? band.action : ''}`.trim();
  return {
    category: 'voice',
    importance: band.id === 'high' ? 3 : band.id === 'research' ? 2 : 1,
    score,
    so_what: angle,
    meta: {
      sub, comment: !!item.meta?.comment, segment: segment.id, segmentLabel: segment.label, fit,
      intent: main.id, intentLabel: main.label,
      intents: [...intents.map((x) => x.id), ...(unhappy ? [PROVIDER_COMPLAINT.id] : [])],
      providers, unhappy, restricted, band: band.id,
      signals: parts.filter(([on]) => on).map(([, , label]) => label),
      parts: parts.map(([on, pts, label]) => ({ label, pts, on: !!on })),
      comments: Number(item.meta?.comments) || null,
    },
  };
}

export const REDDIT_SEGMENTS = SEGMENTS.map(({ id, label, fit }) => ({ id, label, fit }));
export const REDDIT_INTENTS = [...R_INTENTS.map(({ id, label }) => ({ id, label })), PROVIDER_COMPLAINT];

// ---------- near-duplicate titles ----------
// The same story arrives from 5+ publishers ("Zimbabwe eyes India's UPI ..."). Generic words do not count as overlap.
const STOP = new Set(('the a an of to in on for and or with by from at as is are be its it this that rbi india indian says said new over into after amid via '
  + 'payment payments cross border global export exports dgft extends launches launch bank banks system systems more how why what').split(' '));
export function titleTokens(s) {
  return new Set(String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)));
}
export function isNearDup(a, b, sameTopic) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return false;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size) >= 0.6 || n >= 4 || (sameTopic && n >= 2);
}
