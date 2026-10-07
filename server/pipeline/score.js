import { q, J, nowIso, getSetting } from '../db.js';
import { getConfig } from '../config.js';
import { daysAgo, fmtUsdM } from '../util/text.js';
import { isEnterpriseName } from './extract.js';

const CB_COMPETITORS = /skydo|xflow|payoneer|paypal|stripe|wise|airwallex|briskpe|paddle|lemonsqueezy/i;
const DOMESTIC_PSPS = /razorpay|cashfree|payu|ccavenue|instamojo|easebuzz|phonepe/i;

const STAGE_LATE = /series [d-z]|pre-ipo|ipo/i;

// Transparent, config-driven score. Each component: 0..1 signal x weight.
export function computeScore(company, events, cfg = getConfig(), learned = getSetting('learned', {})) {
  const W = cfg.weights;
  const P = cfg.penalties;
  const parts = [];
  const add = (key, label, frac, detail) => {
    const pts = Math.round((W[key] || 0) * Math.max(0, Math.min(1, frac)));
    parts.push({ key, label, points: pts, max: W[key] || 0, detail });
  };
  const enr = J(company.enrichment, null);
  const markets = J(company.markets, []);
  // Drop the company's own name so "ReFit Global" does not count as a "global" signal.
  const nameRe = new RegExp(company.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  const allText = [company.description, ...events.map((e) => `${e.title} ${e.summary || ''} ${J(e.signals, []).join(' ')}`)].join(' ').replace(nameRe, ' ');

  // Funding: best (most recent, relevant) funding event.
  const fundings = events.filter((e) => e.type === 'funding' || e.type === 'directory');
  let fBest = 0, fDetail = 'No funding signal yet';
  for (const e of fundings) {
    const age = Math.max(0, daysAgo(e.occurred_at));
    const recency = Math.pow(0.5, age / cfg.recencyHalfLifeDays);
    const stageF = !e.stage ? 0.6 : cfg.preferredStages.includes(e.stage) ? 1 : cfg.okStages.includes(e.stage) ? 0.6 : STAGE_LATE.test(e.stage) ? 0.3 : 0.5;
    const a = e.amount_usd_m;
    const amtF = a == null ? 0.75 : a < cfg.fundingSweetSpotUsdM.min ? 0.7 : a > cfg.fundingSweetSpotUsdM.max ? 0.55 : 1;
    const typeF = e.type === 'directory' ? 0.7 : 1;
    const f = recency * stageF * amtF * typeF;
    if (f > fBest) {
      fBest = f;
      fDetail = `${e.stage || 'Round'}${a ? ` · ${fmtUsdM(a)}` : ''} · ${Math.round(age)}d ago`;
    }
  }
  add('funding', 'Funding', fBest, fDetail);

  // International intent.
  const intlBase = { yes: 0.7, likely: 0.45, unknown: 0.1, no: 0 }[company.sells_intl] ?? 0.1;
  const concrete = markets.filter((m) => m !== 'Global');
  const kw = cfg.keywords.positive.filter((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(allText));
  let intl = intlBase + Math.min(0.3, concrete.length * 0.1) + Math.min(0.2, kw.length * 0.05);
  const siteBits = [];
  if (enr?.currencies?.some((c) => c !== 'INR')) { intl += 0.15; siteBits.push(`prices in ${enr.currencies.filter((c) => c !== 'INR').join('/')}`); }
  if (enr?.shipsIntl) { intl += 0.15; siteBits.push('ships internationally'); }
  if (enr?.hreflangs?.length > 1) { intl += 0.05; siteBits.push(`${enr.hreflangs.length} locales`); }
  const intlDetail = [
    company.sells_intl === 'yes' ? 'sells abroad' : company.sells_intl === 'likely' ? 'model implies foreign buyers' : null,
    concrete.length ? `markets: ${concrete.slice(0, 4).join(', ')}` : null,
    kw.length ? `keywords: ${kw.slice(0, 3).join(', ')}` : null,
    ...siteBits,
  ].filter(Boolean).join(' · ') || 'No international signal yet';
  add('international', 'International intent', intl, intlDetail);

  // Sector fit (with learned adjustment from feedback).
  const sw = (cfg.sectors[company.sector] ?? cfg.sectors.Other ?? 0.4) + (learned.sector?.[company.sector] || 0);
  add('sector', 'Sector fit', sw, `${company.sector || 'Other'}${learned.sector?.[company.sector] ? ` (feedback ${learned.sector[company.sector] > 0 ? '+' : ''}${Math.round(learned.sector[company.sector] * 100)}%)` : ''}`);

  // Payment stack.
  const providers = enr?.providers || [];
  const mentioned = [...new Set(events.flatMap((e) => J(e.competitors, [])))];
  let pay = 0, payDetail = 'Not checked yet';
  if (providers.some((p) => /payglocal/i.test(p))) { pay = 0; payDetail = 'PayGlocal already on site (existing customer?)'; }
  else if (providers.length || mentioned.length) {
    const all = [...providers, ...mentioned];
    const cb = all.filter((p) => CB_COMPETITORS.test(p));
    const dom = all.filter((p) => DOMESTIC_PSPS.test(p));
    if (cfg.competitorMode === 'deprioritize') {
      pay = cb.length ? 0 : dom.length ? 0.6 : 0.5;
      payDetail = cb.length ? `Uses ${cb.join(', ')} (deprioritized)` : `Uses ${dom.join(', ') || 'unknown'}`;
    } else {
      pay = cb.length ? 1 : dom.length ? (intl > 0.4 ? 0.7 : 0.4) : 0.4;
      payDetail = cb.length ? `Collects abroad via ${cb.join(', ')}: switch opportunity` : dom.length ? `Domestic PSP only (${dom.join(', ')}): cross-border gap` : 'No checkout detected';
    }
  } else if (enr) {
    pay = intl > 0.4 ? 0.35 : 0.15;
    payDetail = 'No checkout on site (invoice/wire likely)';
  }
  add('paymentStack', 'Payment stack', pay, payDetail);

  // Pain.
  const pains = events.filter((e) => e.type === 'pain');
  add('pain', 'Payment pain', pains.length ? 1 : 0, pains.length ? (pains[0].summary || 'Mentioned payment friction').slice(0, 120) : 'None observed');

  // Momentum.
  const mom = events.filter((e) => ['expansion', 'launch', 'export', 'hiring', 'partnership', 'acquisition'].includes(e.type) && daysAgo(e.occurred_at) < 60);
  add('momentum', 'Momentum', mom.length / 2, mom.length ? mom.slice(0, 2).map((e) => e.type).join(', ') + ' in last 60d' : 'No recent expansion/launch');

  // Corroboration.
  const corr = events.reduce((s, e) => s + (e.corroborations || 1), 0);
  add('corroboration', 'Corroboration', (corr - 1) / 3, `${corr} source${corr > 1 ? 's' : ''}`);

  // Novelty.
  const age = daysAgo(company.first_seen_at);
  add('novelty', 'Novelty', age < 3 ? 1 : Math.max(0, 1 - (age - 3) / 14), age < 1 ? 'Discovered today' : `First seen ${Math.round(age)}d ago`);

  // Soft penalties.
  if (company.size === 'enterprise') parts.push({ key: 'enterprise', label: 'Large enterprise', points: P.enterprise, max: 0, detail: 'Large groups rarely switch PSPs' });
  else if (isEnterpriseName(company.name, cfg)) parts.push({ key: 'enterprise', label: 'Large enterprise', points: P.enterprise, max: 0, detail: 'On enterprise watch list' });
  if (!company.is_indian) parts.push({ key: 'notIndian', label: 'Not an Indian entity', points: P.notIndian, max: 0, detail: 'Outside PA-CB export ICP' });
  const neg = cfg.keywords.negative.filter((k) => new RegExp(`\\b${k}\\b`, 'i').test(allText));
  if (neg.length) parts.push({ key: 'negativeKeyword', label: 'Negative news', points: P.negativeKeyword, max: 0, detail: neg.join(', ') });
  if (fundings.some((e) => STAGE_LATE.test(e.stage || ''))) parts.push({ key: 'lateStage', label: 'Late stage', points: P.lateStage, max: 0, detail: 'Series D+ / pre-IPO' });

  let total = parts.reduce((s, p) => s + p.points, 0);
  const conf = Math.max(0.5, Math.min(1, company.confidence || 0.5));
  total = Math.round(Math.max(0, Math.min(100, total * (0.75 + 0.25 * conf))));
  return { score: total, breakdown: parts, why: explain(company, events, parts, markets) };
}

function explain(company, events, parts, markets) {
  const f = events.find((e) => e.type === 'funding') || events.find((e) => e.type === 'directory');
  const exp = events.find((e) => e.type === 'expansion' || e.type === 'export' || e.type === 'launch');
  const concrete = markets.filter((m) => m !== 'Global');
  const trigger = [];
  if (f?.type === 'funding') trigger.push(`raised ${f.stage ? `a ${f.stage} round` : 'fresh capital'}${f.amount_usd_m ? ` of ${fmtUsdM(f.amount_usd_m)}` : ''}${f.occurred_at ? ` ${Math.max(0, Math.round(daysAgo(f.occurred_at)))}d ago` : ''}`);
  else if (f?.type === 'directory') trigger.push('is a Y Combinator-backed company');
  if (exp) trigger.push(`${exp.type === 'launch' ? 'launched' : 'is expanding'}${concrete.length ? ` into ${concrete.slice(0, 3).join(', ')}` : ' internationally'}`);
  if (events.some((e) => e.type === 'pain')) trigger.push('has publicly described payment friction');
  const s1 = `${company.name} ${trigger.length ? trigger.join(' and ') : 'shows cross-border potential'}.`;

  const fit = [];
  if (!exp && company.sells_intl === 'yes') fit.push(`already sells abroad${concrete.length ? ` (${concrete.slice(0, 3).join(', ')})` : ''}`);
  else if (!exp && company.sells_intl === 'likely') fit.push(`${company.sector} model usually bills foreign customers`);
  const enr = J(company.enrichment, null);
  const fx = enr?.currencies?.filter((c) => c !== 'INR') || [];
  if (fx.length) fit.push(`site prices in ${fx.join('/')}`);
  if (enr?.shipsIntl) fit.push('ships internationally');
  const pay = parts.find((p) => p.key === 'paymentStack' && p.points > 0);
  if (pay && /switch|gap/.test(pay.detail)) fit.push(pay.detail.replace(/^./, (c) => c.toLowerCase()));
  else if (enr?.platform) fit.push(`runs on ${enr.platform}`);
  return fit.length ? `${s1} Fit: ${fit.join('; ')}.` : s1;
}

export function rescore(companyId) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  const events = q.all('SELECT * FROM events WHERE company_id = ? ORDER BY occurred_at DESC', companyId);
  const { score, breakdown, why } = computeScore(c, events);
  q.run('UPDATE companies SET score = ?, breakdown = ?, why = ?, updated_at = ? WHERE id = ?', score, JSON.stringify(breakdown), why, nowIso(), companyId);
  return score;
}

export function rescoreAll() {
  const ids = q.all('SELECT id FROM companies').map((r) => r.id);
  for (const id of ids) rescore(id);
  return ids.length;
}
