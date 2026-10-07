import { q, J, nowIso } from '../db.js';
import { getConfig } from '../config.js';
import { normName, domainOf, jaroWinkler, tokens, jaccard, daysAgo } from '../util/text.js';

const INTL_RANK = { no: 0, unknown: 1, likely: 2, yes: 3 };

function findCompany(name, domain) {
  if (domain) {
    const byDomain = q.get('SELECT * FROM companies WHERE domain = ?', domain);
    if (byDomain) return byDomain;
  }
  const norm = normName(name);
  if (!norm) return null;
  const exact = q.get('SELECT * FROM companies WHERE norm_name = ?', norm);
  if (exact) return exact;
  // Fuzzy: same first two chars, Jaro-Winkler >= 0.94, or alias hit.
  const cands = q.all('SELECT * FROM companies WHERE substr(norm_name, 1, 2) = ? LIMIT 200', norm.slice(0, 2));
  let best = null, bestS = 0;
  for (const c of cands) {
    const s = jaroWinkler(norm, c.norm_name);
    const aliasHit = J(c.aliases, []).some((a) => normName(a) === norm);
    if (aliasHit) return c;
    if (s > bestS) { best = c; bestS = s; }
  }
  return bestS >= 0.94 && norm.length >= 5 ? best : null;
}

export function validLead(lead) {
  const cfg = getConfig();
  const name = (lead.name || '').trim();
  if (name.length < 2 || name.length > 60) return false;
  const lc = name.toLowerCase();
  if (cfg.blocklist.some((b) => b.toLowerCase() === lc)) return false;
  if (cfg.competitors.some((b) => b.toLowerCase() === lc)) return false;
  if (!normName(name)) return false;
  return true;
}

// Returns { companyId, newCompany, newEvent } or null.
export function upsertLead(lead, item, source, rawItemId) {
  if (!validLead(lead)) return null;
  const name = lead.name.trim();
  const domain = domainOf(lead.website);
  let c = findCompany(name, domain);
  let newCompany = false;

  if (!c) {
    const r = q.run(`INSERT INTO companies(name, norm_name, domain, aliases, sector, city, description, website, logo, size, is_indian, sells_intl, markets, confidence)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      name, normName(name), domain, JSON.stringify([name]), lead.sector || 'Other', lead.city || null, lead.description || null,
      lead.website || null, lead.logo || null, lead.size || 'unknown', lead.is_indian === false ? 0 : 1, lead.sells_intl || 'unknown',
      JSON.stringify(lead.markets || []), lead.confidence ?? 0.5);
    c = q.get('SELECT * FROM companies WHERE id = ?', r.lastInsertRowid);
    newCompany = true;
  } else {
    const aliases = [...new Set([...J(c.aliases, []), name])].slice(0, 10);
    const markets = [...new Set([...J(c.markets, []), ...(lead.markets || [])])];
    const sellsIntl = (INTL_RANK[lead.sells_intl] ?? 1) > (INTL_RANK[c.sells_intl] ?? 1) ? lead.sells_intl : c.sells_intl;
    q.run(`UPDATE companies SET aliases=?, markets=?, sells_intl=?, domain=COALESCE(domain, ?), website=COALESCE(website, ?), logo=COALESCE(logo, ?),
      city=COALESCE(city, ?), description=COALESCE(description, ?), sector=CASE WHEN sector IS NULL OR sector='Other' THEN ? ELSE sector END,
      size=CASE WHEN size='unknown' THEN ? ELSE size END, confidence=MAX(confidence, ?), updated_at=? WHERE id=?`,
      JSON.stringify(aliases), JSON.stringify(markets), sellsIntl, domain, lead.website || null, lead.logo || null,
      lead.city || null, lead.description || null, lead.sector || 'Other', lead.size || 'unknown', lead.confidence ?? 0.5, nowIso(), c.id);
  }

  const ev = lead.event || {};
  const evType = ev.type || 'other';
  const occurred = item.published_at || nowIso();

  // Event dedup: the same story from another outlet corroborates instead of duplicating.
  const recent = q.all('SELECT * FROM events WHERE company_id = ? AND type = ? ORDER BY id DESC LIMIT 10', c.id, evType)
    .filter((e) => Math.abs(daysAgo(e.occurred_at) - daysAgo(occurred)) < (evType === 'directory' ? 3650 : 30));
  const evTok = tokens(ev.title || item.title);
  const twin = recent.find((e) => {
    if (evType === 'directory') return true;
    if (evType === 'funding') {
      if (e.stage && ev.stage && e.stage === ev.stage) return true;
      if (e.amount_usd_m && ev.amount_usd_m && Math.abs(e.amount_usd_m - ev.amount_usd_m) / Math.max(e.amount_usd_m, ev.amount_usd_m) < 0.2) return true;
    }
    return jaccard(tokens(e.title), evTok) >= 0.45 || e.url === item.url;
  });

  if (twin) {
    const urls = J(twin.extra_urls, []);
    if (twin.url !== item.url && !urls.includes(item.url)) {
      urls.push(item.url);
      q.run(`UPDATE events SET corroborations = corroborations + 1, extra_urls = ?, confidence = MAX(confidence, ?),
        signals = ?, investors = ?, amount_usd_m = COALESCE(amount_usd_m, ?), amount_text = COALESCE(amount_text, ?), stage = COALESCE(stage, ?) WHERE id = ?`,
        JSON.stringify(urls.slice(-12)), lead.confidence ?? 0.5,
        JSON.stringify([...new Set([...J(twin.signals, []), ...(ev.signals || [])])].slice(0, 8)),
        JSON.stringify([...new Set([...J(twin.investors, []), ...(ev.investors || [])])].slice(0, 8)),
        ev.amount_usd_m ?? null, ev.amount_text ?? null, ev.stage ?? null, twin.id);
    }
    return { companyId: c.id, newCompany, newEvent: false };
  }

  q.run(`INSERT INTO events(company_id, raw_item_id, source_id, type, title, summary, url, stage, amount_text, amount_usd_m, investors, markets, signals, competitors, confidence, occurred_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    c.id, rawItemId, source.id, evType, ev.title || item.title, ev.summary || null, item.url, ev.stage || null, ev.amount_text || null,
    ev.amount_usd_m ?? null, JSON.stringify(ev.investors || []), JSON.stringify(lead.markets || []), JSON.stringify(ev.signals || []),
    JSON.stringify(ev.competitors || []), lead.confidence ?? 0.5, occurred);
  if (lead.payment_pain) {
    q.run(`INSERT INTO events(company_id, raw_item_id, source_id, type, title, summary, url, confidence, occurred_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      c.id, rawItemId, source.id, 'pain', 'Payment friction mentioned', lead.payment_pain, item.url, lead.confidence ?? 0.5, occurred);
  }
  q.run('UPDATE companies SET last_event_at = ? WHERE id = ?', nowIso(), c.id);
  return { companyId: c.id, newCompany, newEvent: true };
}
