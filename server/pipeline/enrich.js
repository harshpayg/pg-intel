import * as cheerio from 'cheerio';
import { q, J, nowIso } from '../db.js';
import { fetchText } from '../util/http.js';
import { domainOf, normName, clip, fmtUsdM } from '../util/text.js';
import * as llm from './llm.js';
import { log } from '../bus.js';
import { researchPeople } from './people.js';

const PROVIDERS = [
  ['Stripe', /js\.stripe\.com|checkout\.stripe\.com|buy\.stripe\.com|stripe\.com\/v3/i],
  ['Razorpay', /checkout\.razorpay\.com|razorpay\.com\/(payment|pl)|rzp\.io|razorpay-checkout/i],
  ['PayPal', /paypal\.com\/sdk|paypalobjects\.com|paypal\.me\/|www\.paypal\.com\/(cgi-bin|checkoutnow|donate)/i],
  ['Cashfree', /sdk\.cashfree\.com|cashfree\.com\/(checkout|pg)|payments\.cashfree/i],
  ['PayU', /secure\.payu\.in|payumoney\.com|payu\.in\/pay/i],
  ['CCAvenue', /ccavenue\.com/i],
  ['Instamojo', /instamojo\.com/i],
  ['Paddle', /cdn\.paddle\.com|paddle\.js|checkout\.paddle\.com/i],
  ['Lemon Squeezy', /lemonsqueezy\.com/i],
  ['Chargebee', /js\.chargebee\.com|chargebee\.com\/checkout/i],
  ['PayGlocal', /payglocal/i],
];
const PLATFORMS = [
  ['Shopify', /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i],
  ['WooCommerce', /woocommerce/i],
  ['Magento', /Magento_|mage\/cookies|static\/version\d+\/frontend/i],
  ['Wix', /wixstatic\.com|wix\.com/i],
  ['Webflow', /webflow\.(com|io)/i],
];
const PARKED = /domain (is )?for sale|buy this domain|parked free|sedoparking|hugedomains|dan\.com|godaddy\.com\/domainsearch|this domain may be for sale/i;

function analyse(html, url) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const title = $('title').first().text().trim() || $('meta[property="og:site_name"]').attr('content') || '';
  const desc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  const providers = PROVIDERS.filter(([, re]) => re.test(html)).map(([n]) => n);
  const platform = PLATFORMS.find(([, re]) => re.test(html))?.[0] || null;
  const currencies = [];
  if (/(US\$|\$\s?\d|\bUSD\b)/.test(text)) currencies.push('USD');
  if (/(€\s?\d|\bEUR\b)/.test(text)) currencies.push('EUR');
  if (/(£\s?\d|\bGBP\b)/.test(text)) currencies.push('GBP');
  if (/\bAED\b/.test(text)) currencies.push('AED');
  if (/(₹\s?\d|\bINR\b|Rs\.?\s?\d)/.test(text)) currencies.push('INR');
  const switcher = /currency[-_ ]?(switcher|selector|picker|converter)|select (your )?currency|data-currency|localization-form/i.test(html);
  const shipsIntl = /ships? (worldwide|internationally|globally|to \d+\+? countries)|international shipping|worldwide shipping|we ship (to|across) (the )?(world|globe|\d+)|global shipping/i.test(text);
  const hreflangs = [...new Set($('link[hreflang]').map((_, el) => $(el).attr('hreflang')).get())].slice(0, 20);
  const social = {};
  $('a[href]').each((_, el) => {
    const h = $(el).attr('href') || '';
    if (!social.linkedin && /linkedin\.com\/company\//i.test(h)) social.linkedin = h.split('?')[0];
    if (!social.twitter && /(twitter|x)\.com\/[A-Za-z0-9_]+\/?$/i.test(h)) social.twitter = h;
    if (!social.instagram && /instagram\.com\/[A-Za-z0-9_.]+\/?$/i.test(h)) social.instagram = h;
  });
  // Role inboxes only (sales@, hello@...). No personal emails are stored.
  const emails = [...new Set((html.match(/\b(sales|hello|contact|info|support|partnerships|business|team)@[a-z0-9.-]+\.[a-z]{2,}\b/gi) || []).map((e) => e.toLowerCase()))].slice(0, 3);
  const pricingLink = $('a[href]').map((_, el) => $(el).attr('href')).get().find((h) => /\/pricing\b|\/plans\b/i.test(h || ''));
  return { title: clip(title, 120), description: clip(desc, 300), providers, platform, currencies, switcher, shipsIntl, hreflangs, social, emails, pricingLink: pricingLink ? new URL(pricingLink, url).toString() : null, textSample: text.slice(0, 4000) };
}

function nameMatches(name, a) {
  const n = normName(name);
  if (!n) return false;
  const hay = normName(`${a.title} ${a.description}`) + normName(a.textSample.slice(0, 1500));
  return hay.includes(n) || (n.length > 6 && hay.includes(n.slice(0, Math.ceil(n.length * 0.75))));
}

async function tryUrl(url) {
  try {
    const { text, finalUrl } = await fetchText(url, { timeoutMs: 9000, maxBytes: 2_500_000, accept: 'text/html' });
    if (PARKED.test(text.slice(0, 20000))) return null;
    return { html: text, url: finalUrl };
  } catch {
    return null;
  }
}

async function findWebsite(company) {
  if (company.website) {
    const r = await tryUrl(/^https?:/.test(company.website) ? company.website : `https://${company.website}`);
    if (r) return r;
  }
  const slug = company.name.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  const slugCore = normName(company.name);
  const cands = [...new Set([`${slug}.com`, `${slug}.in`, `${slug}.ai`, `${slug}.io`, `${slugCore}.com`, `get${slug}.com`, `${slug}.co`, `${slug}.co.in`])];
  for (const d of cands.slice(0, 6)) {
    const r = await tryUrl(`https://${d}`);
    if (!r) continue;
    const a = analyse(r.html, r.url);
    if (nameMatches(company.name, a)) return r;
  }
  return null;
}

const PITCH = {
  SaaS: 'Collect USD/EUR subscriptions through local collection accounts and international cards with higher success rates, auto-generated FIRA for each payment, and fast INR settlement.',
  AI: 'Bill global customers in their currency (cards plus local USD/EUR/GBP accounts) with automated FIRA and quick INR settlement, without setting up a foreign entity.',
  'IT Services': 'Replace SWIFT wires and PayPal fees on foreign client invoices with local USD/GBP/EUR collection accounts, payment links and automatic FIRA for export-of-services compliance.',
  Agency: 'Let overseas clients pay invoices via local transfer or card, cut wire and PayPal fees, and get FIRA automatically for GST/LUT filings.',
  Freelancer: 'Get paid by foreign clients through local accounts and payment links instead of PayPal, with FIRA issued automatically.',
  D2C: 'Accept international cards on the storefront (Shopify/Woo plugins) with better approval rates and multi-currency checkout as the brand ships abroad.',
  Marketplace: 'Enable international buyers with multi-currency checkout and high-approval card acceptance, settled to INR with compliance handled.',
  Exporter: 'Collect from overseas buyers via local accounts and cards, with eBRC/EDPMS reconciliation handled and faster INR realisation than bank wires.',
  Manufacturing: 'Collect export receivables via local foreign-currency accounts and cards, with eBRC reconciliation and faster INR realisation.',
  Edtech: 'Collect fees from international students in their own currency (cards plus local transfers) with compliant INR settlement.',
  Travel: 'Accept foreign cards from inbound travellers at high success rates with multi-currency pricing and fast INR settlement.',
  Gaming: 'Monetise global players with high-approval international card acceptance and multi-currency pricing.',
  Media: 'Collect from global subscribers, sponsors and platforms in USD/EUR with FIRA and fast INR settlement.',
};

export function heuristicPitch(company, events) {
  const markets = J(company.markets, []).filter((m) => m !== 'Global');
  const f = events.find((e) => e.type === 'funding');
  const exp = events.find((e) => e.type === 'expansion' || e.type === 'export');
  const enr = J(company.enrichment, null);
  let opener;
  if (f) opener = `Congrats on the ${f.stage || 'new'} round${f.amount_usd_m ? ` (${fmtUsdM(f.amount_usd_m)})` : ''}. As ${company.name} scales${markets.length ? ` in ${markets.slice(0, 2).join(' and ')}` : ' internationally'}, getting paid from abroad usually gets harder, not easier.`;
  else if (exp) opener = `Saw the ${markets.length ? markets.slice(0, 2).join('/') + ' ' : ''}expansion news. That is usually when foreign collections and FIRA paperwork start to hurt.`;
  else opener = `${company.name} looks like it serves customers outside India. We help Indian businesses get paid from abroad faster and cheaper.`;
  const stackNote = enr?.providers?.length ? ` Currently on ${enr.providers.join(', ')}.` : '';
  return `${opener} ${PITCH[company.sector] || PITCH.SaaS}${stackNote}`;
}

async function llmPitch(company, events, enr) {
  const facts = {
    company: company.name, sector: company.sector, description: company.description, markets: J(company.markets, []),
    events: events.slice(0, 5).map((e) => ({ type: e.type, title: e.title, stage: e.stage, amount: e.amount_text, signals: J(e.signals, []) })),
    website: enr ? { title: enr.title, description: enr.description, providers: enr.providers, platform: enr.platform, currencies: enr.currencies, shipsIntl: enr.shipsIntl } : null,
  };
  const out = await llm.json(
    'You write crisp B2B sales angles for PayGlocal (RBI-licensed cross-border payment aggregator for Indian businesses: international cards with high success, local USD/EUR/GBP collection accounts, automated FIRA/eBRC, fast INR settlement, Shopify/Woo plugins). Ground every claim in the given facts. No hype, no em-dashes.',
    `Facts:\n${JSON.stringify(facts, null, 1)}\n\nReturn JSON: {"pitch": "2-3 sentence outreach angle referencing the trigger event and the specific PayGlocal product that fits", "sells_intl": "yes|likely|unknown|no"}`,
    { type: 'OBJECT', properties: { pitch: { type: 'STRING' }, sells_intl: { type: 'STRING', enum: ['yes', 'likely', 'unknown', 'no'] } }, required: ['pitch', 'sells_intl'] },
    { temperature: 0.4, maxTokens: 600 },
  );
  return out;
}

export async function enrichCompany(id) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', id);
  if (!c) return null;
  const events = q.all('SELECT * FROM events WHERE company_id = ? ORDER BY occurred_at DESC', id);
  let enr = { checkedAt: nowIso(), found: false };
  let site = null;
  try {
    site = await findWebsite(c);
    if (site) {
      const a = analyse(site.html, site.url);
      enr = { ...enr, found: true, url: site.url, domain: domainOf(site.url), ...a };
      if (a.pricingLink && domainOf(a.pricingLink) === enr.domain) {
        const p = await tryUrl(a.pricingLink);
        if (p) {
          const pa = analyse(p.html, p.url);
          enr.providers = [...new Set([...enr.providers, ...pa.providers])];
          enr.currencies = [...new Set([...enr.currencies, ...pa.currencies])];
          enr.switcher = enr.switcher || pa.switcher;
        }
      }
      delete enr.textSample;
    }
  } catch (e) {
    enr.error = e.message;
  }

  // Decision makers, team size and open roles (article + about/team pages + job boards).
  try {
    const people = await researchPeople(id, { siteHtml: site?.html, siteUrl: site?.url });
    if (people?.openRoles) enr.openRoles = people.openRoles;
  } catch (e) {
    log('error', `People research for ${c.name}: ${e.message}`);
  }

  let pitch = null;
  let sellsIntl = null;
  if (llm.available()) {
    try {
      const r = await llmPitch({ ...c, enrichment: JSON.stringify(enr) }, events, enr.found ? enr : null);
      pitch = r.pitch;
      if (r.sells_intl && r.sells_intl !== 'unknown') sellsIntl = r.sells_intl;
    } catch { /* fall back below */ }
  }
  if (!pitch) pitch = heuristicPitch({ ...c, enrichment: JSON.stringify(enr) }, events);

  const domain = enr.domain && !q.get('SELECT id FROM companies WHERE domain = ? AND id != ?', enr.domain, id) ? enr.domain : c.domain;
  q.run(`UPDATE companies SET enrichment = ?, enriched_at = ?, pitch = ?, website = COALESCE(?, website), domain = ?,
    sells_intl = CASE WHEN ? IS NOT NULL AND sells_intl IN ('unknown','likely') THEN ? ELSE sells_intl END,
    description = COALESCE(description, ?), updated_at = ? WHERE id = ?`,
    JSON.stringify(enr), nowIso(), pitch, enr.found ? enr.url : null, domain, sellsIntl, sellsIntl, enr.description || null, nowIso(), id);
  log('enrich', `${c.name}: ${enr.found ? `${enr.domain} · ${[enr.platform, ...(enr.providers || [])].filter(Boolean).join(', ') || 'no checkout'}${enr.currencies?.length ? ` · ${enr.currencies.join('/')}` : ''}` : 'website not found'}`);
  return enr;
}
