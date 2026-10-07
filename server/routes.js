import express from 'express';
import { q, J, nowIso, getSetting, setSetting } from './db.js';
import { getConfig, saveConfig, resetConfig, DEFAULT_CONFIG } from './config.js';
import { computeScore, rescore, rescoreAll } from './pipeline/score.js';
import { enrichCompany } from './pipeline/enrich.js';
import { fetchSource, SOURCE_KINDS } from './sources/index.js';
import { runSource, runAllNow, runningSources, ingest } from './scheduler.js';
import { agentCycle, lookalike } from './agent.js';
import { stats as procStats, queueDepth } from './pipeline/processor.js';
import * as llm from './pipeline/llm.js';
import { bus, recentActivity, log } from './bus.js';
import { sha1, fmtUsdM } from './util/text.js';
import { hostCooldowns } from './util/http.js';

export const api = express.Router();
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));
const dayAgoIso = (d = 1) => new Date(Date.now() - d * 86400000).toISOString();

// ---------- shaping ----------
function eventView(e) {
  return {
    id: e.id, type: e.type, title: e.title, summary: e.summary, url: e.url, stage: e.stage, amount: e.amount_text || fmtUsdM(e.amount_usd_m),
    amountUsdM: e.amount_usd_m, investors: J(e.investors, []), markets: J(e.markets, []), signals: J(e.signals, []), competitors: J(e.competitors, []),
    corroborations: e.corroborations, extraUrls: J(e.extra_urls, []), occurredAt: e.occurred_at, createdAt: e.created_at, source: e.source_name || e.source_id,
  };
}

function companyView(c, events, checkpoint) {
  const ev = events || q.all(`SELECT e.*, s.name source_name FROM events e LEFT JOIN sources s ON s.id = e.source_id WHERE company_id = ? ORDER BY occurred_at DESC`, c.id);
  const funding = ev.find((e) => e.type === 'funding') || ev.find((e) => e.type === 'directory');
  const signals = [...new Set(ev.flatMap((e) => J(e.signals, [])))].slice(0, 6);
  const enr = J(c.enrichment, null);
  return {
    id: c.id, name: c.name, sector: c.sector, city: c.city, description: c.description, website: c.website, domain: c.domain, logo: c.logo,
    size: c.size, sellsIntl: c.sells_intl, markets: J(c.markets, []), status: c.status, feedback: c.feedback, score: c.score,
    breakdown: J(c.breakdown, []), why: c.why, pitch: c.pitch, notes: c.notes, confidence: c.confidence,
    firstSeenAt: c.first_seen_at, lastEventAt: c.last_event_at, enrichedAt: c.enriched_at,
    enrichment: enr ? { found: enr.found, url: enr.url, title: enr.title, providers: enr.providers, platform: enr.platform, currencies: enr.currencies, shipsIntl: enr.shipsIntl, switcher: enr.switcher, social: enr.social, emails: enr.emails, locales: enr.hreflangs?.length || 0 } : null,
    funding: funding ? { stage: funding.stage, amount: funding.amount_text || fmtUsdM(funding.amount_usd_m), date: funding.occurred_at, investors: J(funding.investors, []), type: funding.type } : null,
    signals,
    latest: ev[0] ? { type: ev[0].type, title: ev[0].title, url: ev[0].url, source: ev[0].source_name || ev[0].source_id, at: ev[0].occurred_at } : null,
    sources: [...new Set(ev.map((e) => e.source_name || e.source_id))],
    eventCount: ev.length,
    corroborations: ev.reduce((s, e) => s + (e.corroborations || 1), 0),
    badge: checkpoint ? (c.first_seen_at > checkpoint ? 'new' : c.last_event_at > checkpoint ? 'updated' : null) : null,
  };
}

function eventsFor(ids) {
  if (!ids.length) return new Map();
  const rows = q.all(`SELECT e.*, s.name source_name FROM events e LEFT JOIN sources s ON s.id = e.source_id WHERE company_id IN (${ids.map(() => '?').join(',')}) ORDER BY occurred_at DESC`, ...ids);
  const m = new Map();
  for (const r of rows) { if (!m.has(r.company_id)) m.set(r.company_id, []); m.get(r.company_id).push(r); }
  return m;
}

// ---------- stats ----------
api.get('/stats', wrap((req, res) => {
  const cfg = getConfig();
  const one = (sql, ...p) => q.get(sql, ...p).n;
  res.json({
    companies: one(`SELECT COUNT(*) n FROM companies WHERE status != 'dismissed'`),
    highIntent: one(`SELECT COUNT(*) n FROM companies WHERE score >= ? AND status != 'dismissed'`, cfg.threshold),
    newToday: one('SELECT COUNT(*) n FROM companies WHERE first_seen_at > ?', dayAgoIso()),
    events24h: one('SELECT COUNT(*) n FROM events WHERE created_at > ?', dayAgoIso()),
    fundingSignals: one(`SELECT COUNT(DISTINCT company_id) n FROM events WHERE type = 'funding' AND occurred_at > ?`, dayAgoIso(30)),
    intlSignals: one(`SELECT COUNT(*) n FROM companies WHERE sells_intl IN ('yes','likely') AND status != 'dismissed'`),
    intel24h: one('SELECT COUNT(*) n FROM intel WHERE created_at > ?', dayAgoIso()),
    items24h: one('SELECT COUNT(*) n FROM raw_items WHERE fetched_at > ?', dayAgoIso()),
    itemsTotal: one('SELECT COUNT(*) n FROM raw_items'),
    passedTotal: one(`SELECT COUNT(*) n FROM raw_items WHERE status IN ('done','processing')`),
    filteredTotal: one(`SELECT COUNT(*) n FROM raw_items WHERE status IN ('filtered','dup')`),
    sourcesActive: one('SELECT COUNT(*) n FROM sources WHERE enabled = 1'),
    sourcesError: one(`SELECT COUNT(*) n FROM sources WHERE enabled = 1 AND last_status = 'error'`),
    agentQueries: one(`SELECT COUNT(*) n FROM sources WHERE created_by = 'agent' AND enabled = 1`),
    queue: queueDepth(),
    running: runningSources(),
    sectors: q.all(`SELECT sector, COUNT(*) n, ROUND(AVG(score)) avg FROM companies WHERE status != 'dismissed' GROUP BY sector ORDER BY n DESC`),
    llm: llm.usage(),
    pipeline: procStats,
    threshold: cfg.threshold,
    cooldowns: hostCooldowns(),
    briefCheckpoint: getSetting('brief_checkpoint', null),
  });
}));

// ---------- brief (fresh since last ack) ----------
api.get('/brief', wrap((req, res) => {
  const cfg = getConfig();
  const checkpoint = getSetting('brief_checkpoint', '1970-01-01T00:00:00.000Z');
  const cands = q.all(`SELECT * FROM companies WHERE status != 'dismissed' AND last_event_at > ? AND score >= 20 ORDER BY score DESC LIMIT 400`, checkpoint);
  const N = cfg.brief.size;
  const exploitN = Math.ceil(N * (1 - cfg.brief.explorationShare));
  const picks = cands.slice(0, exploitN).map((c) => ({ c, explore: false }));
  // Exploration: best leads from sectors not yet represented, so the brief never collapses onto one segment.
  const rest = cands.slice(exploitN);
  const seen = new Set(picks.map((p) => p.c.sector));
  while (picks.length < N && rest.length) {
    let idx = rest.findIndex((c) => !seen.has(c.sector));
    if (idx < 0) idx = 0;
    const [c] = rest.splice(idx, 1);
    seen.add(c.sector);
    picks.push({ c, explore: true });
  }
  const evs = eventsFor(picks.map((p) => p.c.id));
  const intel = q.all('SELECT * FROM intel WHERE created_at > ? ORDER BY importance DESC, published_at DESC LIMIT 8', checkpoint);
  res.json({
    checkpoint,
    totalNew: cands.filter((c) => c.first_seen_at > checkpoint).length,
    totalUpdated: cands.filter((c) => c.first_seen_at <= checkpoint).length,
    leads: picks.map(({ c, explore }) => ({ ...companyView(c, evs.get(c.id) || [], checkpoint), explore })),
    intel,
  });
}));

api.post('/brief/ack', wrap((req, res) => {
  const prev = getSetting('brief_checkpoint', null);
  setSetting('brief_prev_checkpoint', prev);
  setSetting('brief_checkpoint', nowIso());
  res.json({ ok: true });
}));

api.post('/brief/undo', wrap((req, res) => {
  setSetting('brief_checkpoint', getSetting('brief_prev_checkpoint', null) || '1970-01-01T00:00:00.000Z');
  res.json({ ok: true });
}));

// ---------- leads ----------
function leadQuery(qs) {
  const where = [];
  const p = [];
  if (qs.status && qs.status !== 'all') { where.push('c.status = ?'); p.push(qs.status); } else if (qs.status !== 'all') where.push(`c.status != 'dismissed'`);
  if (qs.q) { where.push('(c.name LIKE ? OR c.description LIKE ? OR c.why LIKE ? OR c.city LIKE ?)'); const l = `%${qs.q}%`; p.push(l, l, l, l); }
  if (qs.sector) { where.push('c.sector = ?'); p.push(qs.sector); }
  if (qs.minScore) { where.push('c.score >= ?'); p.push(Number(qs.minScore)); }
  if (qs.stage) { where.push('EXISTS (SELECT 1 FROM events e WHERE e.company_id = c.id AND e.stage = ?)'); p.push(qs.stage); }
  if (qs.source) { where.push('EXISTS (SELECT 1 FROM events e WHERE e.company_id = c.id AND e.source_id = ?)'); p.push(qs.source); }
  if (qs.type) { where.push('EXISTS (SELECT 1 FROM events e WHERE e.company_id = c.id AND e.type = ?)'); p.push(qs.type); }
  if (qs.intl === '1') where.push(`(c.sells_intl IN ('yes','likely') OR c.markets != '[]')`);
  if (qs.days) { where.push('c.last_event_at > ?'); p.push(dayAgoIso(Number(qs.days))); }
  if (qs.hideEnterprise === '1') where.push(`c.size != 'enterprise'`);
  const order = { recent: 'c.last_event_at DESC', new: 'c.first_seen_at DESC', name: 'c.name COLLATE NOCASE' }[qs.sort] || 'c.score DESC, c.last_event_at DESC';
  return { sql: `FROM companies c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, p, order };
}

api.get('/leads', wrap((req, res) => {
  const { sql, p, order } = leadQuery(req.query);
  const limit = Math.min(200, Number(req.query.limit) || 50);
  const offset = Number(req.query.offset) || 0;
  const total = q.get(`SELECT COUNT(*) n ${sql}`, ...p).n;
  const rows = q.all(`SELECT c.* ${sql} ORDER BY ${order} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const evs = eventsFor(rows.map((r) => r.id));
  const checkpoint = getSetting('brief_checkpoint', null);
  res.json({ total, leads: rows.map((c) => companyView(c, evs.get(c.id) || [], checkpoint)) });
}));

api.get('/leads.csv', wrap((req, res) => {
  const { sql, p, order } = leadQuery(req.query);
  const rows = q.all(`SELECT c.* ${sql} ORDER BY ${order} LIMIT 5000`, ...p);
  const evs = eventsFor(rows.map((r) => r.id));
  const cols = ['name', 'score', 'sector', 'city', 'website', 'status', 'stage', 'amount', 'funding_date', 'markets', 'signals', 'payment_stack', 'why', 'pitch', 'source_url'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  for (const c of rows) {
    const v = companyView(c, evs.get(c.id) || []);
    lines.push([v.name, v.score, v.sector, v.city, v.website, v.status, v.funding?.stage, v.funding?.amount, v.funding?.date?.slice(0, 10), v.markets.join('; '), v.signals.join('; '), v.enrichment?.providers?.join('; '), v.why, v.pitch, v.latest?.url].map(esc).join(','));
  }
  res.setHeader('content-type', 'text/csv; charset=utf-8');
  res.setHeader('content-disposition', `attachment; filename="payglocal-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
}));

api.get('/leads/:id', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const events = q.all(`SELECT e.*, s.name source_name FROM events e LEFT JOIN sources s ON s.id = e.source_id WHERE company_id = ? ORDER BY occurred_at DESC`, c.id);
  if (!c.seen_at) q.run('UPDATE companies SET seen_at = ? WHERE id = ?', nowIso(), c.id);
  res.json({ ...companyView(c, events), events: events.map(eventView) });
}));

api.patch('/leads/:id', wrap((req, res) => {
  const c = q.get('SELECT * FROM companies WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  const { status, notes, feedback } = req.body || {};
  if (status && ['new', 'reviewed', 'contacted', 'qualified', 'dismissed'].includes(status)) q.run('UPDATE companies SET status = ?, updated_at = ? WHERE id = ?', status, nowIso(), c.id);
  if (typeof notes === 'string') q.run('UPDATE companies SET notes = ?, updated_at = ? WHERE id = ?', notes.slice(0, 5000), nowIso(), c.id);
  if ([-1, 0, 1].includes(feedback) && feedback !== c.feedback) {
    q.run('UPDATE companies SET feedback = ?, updated_at = ? WHERE id = ?', feedback, nowIso(), c.id);
    learnFromFeedback(c, c.feedback, feedback);
    if (feedback === -1 && c.status !== 'dismissed') q.run(`UPDATE companies SET status = 'dismissed' WHERE id = ?`, c.id);
  }
  rescore(c.id);
  res.json({ ok: true });
}));

// Bounded learning: feedback nudges sector weight (±25% max) and source quality counters.
function learnFromFeedback(c, prev, next) {
  const learned = getSetting('learned', { sector: {} });
  learned.sector ||= {};
  const delta = (next - prev) * 0.04;
  learned.sector[c.sector] = Math.max(-0.25, Math.min(0.25, (learned.sector[c.sector] || 0) + delta));
  setSetting('learned', learned);
  const srcs = q.all('SELECT DISTINCT source_id FROM events WHERE company_id = ?', c.id).map((r) => r.source_id);
  for (const s of srcs) {
    if (prev === 1) q.run('UPDATE sources SET approved = MAX(0, approved - 1) WHERE id = ?', s);
    if (prev === -1) q.run('UPDATE sources SET rejected = MAX(0, rejected - 1) WHERE id = ?', s);
    if (next === 1) q.run('UPDATE sources SET approved = approved + 1 WHERE id = ?', s);
    if (next === -1) q.run('UPDATE sources SET rejected = rejected + 1 WHERE id = ?', s);
  }
  log('learn', `Feedback ${next > 0 ? '👍' : next < 0 ? '👎' : 'cleared'} on ${c.name}: ${c.sector} weight adj now ${Math.round(learned.sector[c.sector] * 100)}%`);
}

api.post('/leads/:id/enrich', wrap(async (req, res) => {
  const enr = await enrichCompany(Number(req.params.id));
  rescore(Number(req.params.id));
  res.json({ ok: true, enrichment: enr });
}));

api.post('/leads/:id/lookalike', wrap((req, res) => {
  const ids = lookalike(Number(req.params.id));
  res.json({ ok: true, sources: ids });
}));

// ---------- intel ----------
api.get('/intel', wrap((req, res) => {
  const cat = req.query.category;
  const rows = cat
    ? q.all('SELECT i.*, s.name source_name FROM intel i LEFT JOIN sources s ON s.id = i.source_id WHERE i.category = ? ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT 150', cat)
    : q.all('SELECT i.*, s.name source_name FROM intel i LEFT JOIN sources s ON s.id = i.source_id ORDER BY COALESCE(i.published_at, i.created_at) DESC LIMIT 150');
  const counts = q.all('SELECT category, COUNT(*) n FROM intel GROUP BY category');
  res.json({ items: rows, counts });
}));

// ---------- sources ----------
api.get('/sources', wrap((req, res) => {
  const rows = q.all(`SELECT * FROM sources ORDER BY enabled DESC, created_by = 'agent', category, name`);
  const running = new Set(runningSources());
  res.json(rows.map((s) => ({ ...s, params: J(s.params, {}), running: running.has(s.id), quality: s.approved + s.rejected ? Math.round((s.approved / (s.approved + s.rejected)) * 100) : null })));
}));

function sourceFromBody(b) {
  const kind = b.kind;
  if (!SOURCE_KINDS.includes(kind)) throw new Error(`kind must be one of ${SOURCE_KINDS.join(', ')}`);
  const category = ['leads', 'intel', 'voice'].includes(b.category) ? b.category : kind === 'reddit' ? 'voice' : 'leads';
  let params, name;
  if (kind === 'rss') { if (!/^https?:\/\//.test(b.url || '')) throw new Error('A valid feed URL is required'); params = { url: b.url }; name = b.name || new URL(b.url).hostname; }
  else if (kind === 'gnews') { if (!b.query) throw new Error('query is required'); params = { query: b.query }; name = b.name || `GNews: ${b.query}`; }
  else if (kind === 'reddit') { if (!b.sub && !b.search) throw new Error('sub or search is required'); params = { sub: b.sub || undefined, search: b.search || undefined }; name = b.name || (b.sub ? `Reddit r/${b.sub}` : `Reddit: ${b.search}`); }
  else if (kind === 'hn') { if (!b.query) throw new Error('query is required'); params = { query: b.query, days: 45 }; name = b.name || `HN: ${b.query}`; }
  else throw new Error('This kind cannot be added manually');
  return { id: `user-${sha1(kind + JSON.stringify(params)).slice(0, 10)}`, name, kind, category, params };
}

api.post('/sources/test', wrap(async (req, res) => {
  const s = sourceFromBody(req.body || {});
  const items = await fetchSource(s);
  res.json({ ok: true, count: items.length, sample: items.slice(0, 5).map((i) => ({ title: i.title, date: i.published_at })) });
}));

api.post('/sources', wrap(async (req, res) => {
  const s = sourceFromBody(req.body || {});
  if (q.get('SELECT 1 FROM sources WHERE id = ?', s.id)) throw new Error('This source already exists');
  const items = await fetchSource(s); // validates before saving
  q.run('INSERT INTO sources(id, name, kind, category, params, cadence_min, created_by) VALUES(?,?,?,?,?,?,?)', s.id, s.name, s.kind, s.category, JSON.stringify(s.params), Number(req.body.cadence_min) || 120, 'user');
  const fresh = ingest({ ...s }, items);
  q.run('UPDATE sources SET last_run_at = ?, next_run_at = ?, last_status = ?, runs = 1, items_total = ? WHERE id = ?', nowIso(), new Date(Date.now() + 120 * 60000).toISOString(), 'ok', fresh, s.id);
  log('source', `Added ${s.name}: ${items.length} items, ${fresh} new`);
  res.json({ ok: true, id: s.id, fetched: items.length, fresh });
}));

api.patch('/sources/:id', wrap((req, res) => {
  const s = q.get('SELECT * FROM sources WHERE id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') q.run('UPDATE sources SET enabled = ?, next_run_at = CASE WHEN ? THEN NULL ELSE next_run_at END, expires_at = CASE WHEN ? AND created_by = \'agent\' THEN NULL ELSE expires_at END WHERE id = ?', b.enabled ? 1 : 0, b.enabled ? 1 : 0, b.enabled ? 1 : 0, s.id);
  if (b.cadence_min) q.run('UPDATE sources SET cadence_min = ? WHERE id = ?', Math.max(5, Number(b.cadence_min)), s.id);
  if (b.category && ['leads', 'intel', 'voice'].includes(b.category)) q.run('UPDATE sources SET category = ? WHERE id = ?', b.category, s.id);
  res.json({ ok: true });
}));

api.delete('/sources/:id', wrap((req, res) => {
  const s = q.get('SELECT * FROM sources WHERE id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Not found' });
  if (s.created_by === 'system') q.run('UPDATE sources SET enabled = 0 WHERE id = ?', s.id);
  else q.run('DELETE FROM sources WHERE id = ?', s.id);
  res.json({ ok: true });
}));

api.post('/sources/:id/run', wrap(async (req, res) => {
  res.json(await runSource(req.params.id, { manual: true }));
}));

api.post('/scan', wrap((req, res) => {
  runAllNow();
  log('scan', 'Manual scan of all enabled sources triggered');
  res.json({ ok: true });
}));

api.post('/agent/run', wrap(async (req, res) => {
  const ids = await agentCycle({ force: true });
  res.json({ ok: true, added: ids || [] });
}));

// ---------- config ----------
api.get('/config', wrap((req, res) => res.json({ config: getConfig(), defaults: DEFAULT_CONFIG, learned: getSetting('learned', {}) })));

api.put('/config', wrap((req, res) => {
  const next = req.body?.config;
  if (!next || typeof next !== 'object') throw new Error('config object required');
  for (const k of ['weights', 'sectors', 'keywords']) if (next[k] && typeof next[k] !== 'object') throw new Error(`${k} must be an object`);
  const cfg = saveConfig(next);
  const n = rescoreAll();
  log('config', `Config saved; rescored ${n} companies`);
  res.json({ ok: true, config: cfg });
}));

api.post('/config/reset', wrap((req, res) => {
  const cfg = resetConfig();
  rescoreAll();
  res.json({ ok: true, config: cfg });
}));

// Live preview: how would the current top leads score under a draft config?
api.post('/config/preview', wrap((req, res) => {
  const draft = req.body?.config;
  if (!draft) throw new Error('config required');
  const rows = q.all(`SELECT * FROM companies WHERE status != 'dismissed' ORDER BY score DESC LIMIT 40`);
  const evs = eventsFor(rows.map((r) => r.id));
  const out = rows.map((c) => {
    const { score } = computeScore(c, evs.get(c.id) || [], draft);
    return { id: c.id, name: c.name, sector: c.sector, before: c.score, after: score };
  }).sort((a, b) => b.after - a.after);
  res.json({ preview: out.slice(0, 15), movedIntoHigh: out.filter((o) => o.after >= draft.threshold && o.before < draft.threshold).length, movedOutOfHigh: out.filter((o) => o.after < draft.threshold && o.before >= draft.threshold).length });
}));

// ---------- activity + live stream ----------
api.get('/activity', wrap((req, res) => res.json(recentActivity(Number(req.query.n) || 120))));

api.get('/runs', wrap((req, res) => res.json(q.all('SELECT r.*, s.name FROM runs r LEFT JOIN sources s ON s.id = r.source_id ORDER BY r.id DESC LIMIT 100'))));

api.get('/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const send = (event) => (data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  const handlers = { activity: send('activity'), lead: send('lead'), intel: send('intel'), source: send('source'), stats: send('stats') };
  for (const [k, h] of Object.entries(handlers)) bus.on(k, h);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    for (const [k, h] of Object.entries(handlers)) bus.off(k, h);
  });
});

// Unauthenticated (platform healthcheck), so expose nothing sensitive.
api.get('/health', (req, res) => { q.get('SELECT 1'); res.json({ ok: true, time: nowIso() }); });
