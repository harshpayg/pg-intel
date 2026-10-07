import { q, J, nowIso, getSetting, setSetting } from './db.js';
import { getConfig } from './config.js';
import { sha1 } from './util/text.js';
import * as llm from './pipeline/llm.js';
import { runSource } from './scheduler.js';
import { log } from './bus.js';

// The agent keeps discovery fresh: rotating/novel queries, pruning dead ones,
// tuning cadence by yield, and "find more like this" on demand.

const SEGMENTS = ['SaaS startup', 'AI startup', 'D2C brand', 'edtech startup', 'travel startup', 'IT services company', 'digital agency',
  'exporter', 'handicrafts exporter', 'textile exporter', 'jewellery exporter', 'gaming studio', 'spices exporter', 'ayurveda brand',
  'fashion brand', 'B2B marketplace', 'healthtech startup', 'deeptech startup', 'SaaS company', 'software company', 'beauty brand', 'furniture exporter'];
const INTENTS = ['raises seed funding', 'raises Series A', 'raises pre-Series A', 'expands to US', 'launches in UAE', 'enters Europe',
  'international expansion', 'global customers', 'export orders', 'opens office in Dubai', 'launches on Amazon US', 'ships worldwide',
  'Singapore expansion', 'UK launch', 'Middle East expansion', 'Australia launch'];

function addAgentQuery(query, name, why) {
  const cfg = getConfig();
  const id = `agent-${sha1(query).slice(0, 10)}`;
  if (q.get('SELECT 1 FROM sources WHERE id = ?', id)) return null;
  const expires = new Date(Date.now() + cfg.agent.queryTtlDays * 86400000).toISOString();
  q.run(`INSERT INTO sources(id, name, kind, category, params, cadence_min, min_cadence, max_cadence, created_by, expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, id, name || `Agent: ${query.replace(/ when:\d+d$/, '')}`, 'gnews', 'leads', JSON.stringify({ query, why }), 240, 120, 1440, 'agent', expires);
  log('agent', `New query "${query}"${why ? ` (${why})` : ''}`);
  return id;
}

function templateQueries(n) {
  const used = new Set(getSetting('agent_used', []));
  const combos = [];
  for (const s of SEGMENTS) for (const i of INTENTS) combos.push(`India ${s} ${i}`);
  const fresh = combos.filter((c) => !used.has(c));
  const pool = fresh.length >= n ? fresh : combos;
  const picks = [];
  while (picks.length < n && pool.length) picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  setSetting('agent_used', [...used, ...picks].slice(-300));
  return picks.map((p) => ({ query: `${p} when:14d`, why: 'rotation' }));
}

async function llmQueries(n) {
  const liked = q.all(`SELECT name, sector, markets, why FROM companies WHERE feedback = 1 OR status IN ('qualified','contacted') ORDER BY updated_at DESC LIMIT 8`);
  const top = q.all(`SELECT name, sector, markets FROM companies WHERE status != 'dismissed' ORDER BY score DESC LIMIT 12`);
  const disliked = q.all('SELECT name, sector FROM companies WHERE feedback = -1 ORDER BY updated_at DESC LIMIT 6');
  const existing = q.all(`SELECT params FROM sources WHERE kind = 'gnews' AND enabled = 1`).map((r) => J(r.params, {}).query);
  const sectorCounts = q.all(`SELECT sector, COUNT(*) n FROM companies GROUP BY sector ORDER BY n`).map((r) => `${r.sector}: ${r.n}`);
  const out = await llm.json(
    'You plan news searches that discover new PayGlocal leads: Indian businesses that sell or will sell to customers abroad (SaaS, AI, IT services, agencies, D2C exporters, goods exporters, edtech, travel, gaming). Each query runs on Google News RSS. Prefer specific, high-yield phrasing that surfaces individual company announcements (funding, expansion, export deals, launches abroad), not market roundups.',
    `Liked by sales: ${JSON.stringify(liked)}\nTop scored: ${JSON.stringify(top)}\nRejected: ${JSON.stringify(disliked)}\nCoverage by sector so far: ${sectorCounts.join(', ')}\nQueries already running: ${JSON.stringify(existing)}\n\nPropose ${n} NEW queries that explore under-covered ICP segments or double down on what sales liked. Use Google News operators (OR, quotes). Append " when:14d". Return {"queries":[{"query":"...","why":"<=8 words"}]}`,
    { type: 'OBJECT', properties: { queries: { type: 'ARRAY', items: { type: 'OBJECT', properties: { query: { type: 'STRING' }, why: { type: 'STRING' } }, required: ['query', 'why'] } } }, required: ['queries'] },
    { temperature: 0.8, maxTokens: 800 },
  );
  return (out.queries || []).slice(0, n).map((x) => ({ query: /when:\d+d/.test(x.query) ? x.query : `${x.query} when:14d`, why: x.why }));
}

function pruneAndTune() {
  const cfg = getConfig();
  // Expired agent queries: extend once if they produced leads, else retire.
  for (const s of q.all(`SELECT * FROM sources WHERE created_by = 'agent' AND enabled = 1 AND expires_at < ?`, nowIso())) {
    const p = J(s.params, {});
    if (s.leads_total > 0 && !p.extended) {
      q.run('UPDATE sources SET expires_at = ?, params = ? WHERE id = ?', new Date(Date.now() + cfg.agent.queryTtlDays * 86400000).toISOString(), JSON.stringify({ ...p, extended: true }), s.id);
      log('agent', `Extended productive query "${p.query}" (${s.leads_total} leads)`);
    } else {
      q.run('UPDATE sources SET enabled = 0 WHERE id = ?', s.id);
      log('agent', `Retired query "${p.query}" (${s.leads_total} leads)`);
    }
  }
  // Cadence by yield: quiet sources slow down, busy ones speed up.
  for (const s of q.all('SELECT * FROM sources WHERE enabled = 1')) {
    const last = q.all(`SELECT new_items FROM runs WHERE source_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 4`, s.id);
    if (last.length < 3) continue;
    const avg = last.reduce((a, r) => a + r.new_items, 0) / last.length;
    let cad = s.cadence_min;
    if (avg === 0) cad = Math.min(s.max_cadence, Math.round(cad * 1.5));
    else if (avg >= 8) cad = Math.max(s.min_cadence, Math.round(cad * 0.75));
    if (cad !== s.cadence_min) q.run('UPDATE sources SET cadence_min = ? WHERE id = ?', cad, s.id);
  }
}

export async function agentCycle({ force = false } = {}) {
  const cfg = getConfig();
  if (!cfg.agent.enabled && !force) return;
  const last = getSetting('agent_last_run', null);
  if (!force && last && Date.now() - new Date(last).getTime() < cfg.agent.intervalMinutes * 60000) return;
  setSetting('agent_last_run', nowIso());
  pruneAndTune();
  let plans = [];
  if (llm.available()) {
    try { plans = await llmQueries(cfg.agent.queriesPerCycle); } catch (e) { log('agent', `LLM planning failed, using rotation: ${e.message}`); }
  }
  if (!plans.length) plans = templateQueries(cfg.agent.queriesPerCycle);
  const ids = plans.map((p) => addAgentQuery(p.query, null, p.why)).filter(Boolean);
  for (const id of ids) runSource(id).catch(() => {});
  return ids;
}

export function lookalike(companyId) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  const markets = J(c.markets, []).filter((m) => m !== 'Global');
  const seg = { SaaS: 'SaaS startup', AI: 'AI startup', D2C: 'D2C brand', Exporter: 'exporter', Edtech: 'edtech startup', Travel: 'travel startup', 'IT Services': 'IT services company', Agency: 'agency', Manufacturing: 'manufacturer', Gaming: 'gaming studio', Marketplace: 'marketplace' }[c.sector] || 'startup';
  const queries = [
    `Indian ${seg} ${markets.length ? `expands ${markets.slice(0, 2).join(' OR ')}` : 'international expansion'} when:30d`,
    `Indian ${seg} raises funding global customers when:30d`,
  ];
  const ids = queries.map((qq) => addAgentQuery(qq, `Lookalike of ${c.name}: ${qq.replace(/ when:\d+d$/, '')}`, `like ${c.name}`)).filter(Boolean);
  for (const id of ids) runSource(id).catch(() => {});
  return ids;
}

export function startAgent() {
  setTimeout(() => agentCycle().catch((e) => log('error', `Agent: ${e.message}`)), 90_000);
  setInterval(() => agentCycle().catch((e) => log('error', `Agent: ${e.message}`)), 5 * 60_000);
}
