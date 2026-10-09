import { q, J, nowIso } from '../db.js';
import { getConfig } from '../config.js';
import { prefilter } from './prefilter.js';
import { saveIntel } from './intel-store.js';
import { extractBatch } from './extract.js';
import { upsertLead } from './resolve.js';
import { rescore } from './score.js';
import { enrichCompany } from './enrich.js';
import { targetPlan, saveTeam } from './people.js';
import { findEmail, providerStatus } from './email-finders.js';
import * as llm from './llm.js';
import { bus, log } from '../bus.js';

const sourceCache = new Map();
function sourceOf(id) {
  if (!sourceCache.has(id)) {
    const s = q.get('SELECT * FROM sources WHERE id = ?', id);
    sourceCache.set(id, s ? { ...s, params: J(s.params, {}) } : { id, name: id, kind: 'rss', category: 'leads', params: {} });
    setTimeout(() => sourceCache.delete(id), 60_000);
  }
  return sourceCache.get(id);
}

let busy = false;
let enriching = false;
export const stats = { processed: 0, passed: 0, leadsNew: 0, eventsNew: 0, intelNew: 0, lastBatchAt: null, via: { llm: 0, rules: 0, structured: 0 } };

async function processBatch() {
  if (busy) return;
  busy = true;
  try {
    const cfg = getConfig();
    // Newest first so the demo always shows today's news quickly.
    const rows = q.all(`SELECT * FROM raw_items WHERE status = 'new' ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT 60`);
    if (!rows.length) return;

    const batch = [];
    for (const r of rows) {
      const source = sourceOf(r.source_id);
      const item = { ...r, meta: J(r.meta, {}) };
      const pf = prefilter(item, source);
      stats.processed++;
      if (!pf.pass) {
        q.run(`UPDATE raw_items SET status='filtered', prefilter=?, note=? WHERE id=?`, JSON.stringify(pf.hits), pf.reason, r.id);
        continue;
      }
      stats.passed++;
      q.run(`UPDATE raw_items SET status='processing', prefilter=? WHERE id=?`, JSON.stringify(pf.hits), r.id);
      q.run('UPDATE sources SET passed_total = passed_total + 1 WHERE id = ?', source.id);
      batch.push({ item, source, route: pf.route, cls: pf.cls, rawId: r.id });
      if (batch.length >= (llm.available() ? cfg.llm.batchSize : 25)) break;
    }
    if (!batch.length) return;

    const results = await extractBatch(batch);
    const touched = new Set();
    batch.forEach((b, i) => {
      const r = results[i] || { leads: [], intel: null, via: 'rules' };
      stats.via[r.via] = (stats.via[r.via] || 0) + 1;
      let leadsHere = 0;
      for (const lead of r.leads || []) {
        if (lead.confidence != null && lead.confidence < 0.3) continue;
        const res = upsertLead(lead, b.item, b.source, b.rawId);
        if (!res) continue;
        touched.add(res.companyId);
        if (res.newCompany) { stats.leadsNew++; leadsHere++; }
        if (res.newEvent) stats.eventsNew++;
        if (res.newCompany || res.newEvent) {
          const c = q.get('SELECT id, name FROM companies WHERE id = ?', res.companyId);
          bus.emit('lead', { id: c.id, name: c.name, kind: res.newCompany ? 'new' : 'update', source: b.source.name });
        }
      }
      if (leadsHere) q.run('UPDATE sources SET leads_total = leads_total + ? WHERE id = ?', leadsHere, b.source.id);
      if (r.intel && saveIntel(r.intel, b.item, b.source, b.rawId)) {
        stats.intelNew++;
        bus.emit('intel', { title: r.intel.title || b.item.title, category: r.intel.category });
      }
      q.run(`UPDATE raw_items SET status='done', note=? WHERE id=?`, `${r.via}: ${(r.leads || []).length} lead(s)${r.intel ? ', intel' : ''}`, b.rawId);
    });
    for (const id of touched) rescore(id);
    stats.lastBatchAt = nowIso();
    const v = results[0]?.via;
    log('process', `Processed ${batch.length} items via ${v}: ${touched.size} companies touched`);
    bus.emit('stats');
  } catch (e) {
    log('error', `Processor: ${e.message}`);
    q.run(`UPDATE raw_items SET status='new' WHERE status='processing'`);
  } finally {
    busy = false;
  }
}

async function enrichLoop() {
  if (enriching) return;
  enriching = true;
  try {
    const cfg = getConfig();
    // people_checked_at IS NULL also picks up companies enriched before people research existed.
    const rows = q.all(`SELECT id FROM companies WHERE (enriched_at IS NULL OR people_checked_at IS NULL) AND status != 'dismissed' AND score >= ? AND size != 'enterprise' ORDER BY score DESC LIMIT ?`, cfg.enrichment.minScore, cfg.enrichment.perCycle);
    for (const { id } of rows) {
      await enrichCompany(id);
      rescore(id);
      await autoFindEmail(id, cfg);
      bus.emit('lead', { id, kind: 'enriched' });
    }
  } catch (e) {
    log('error', `Enrichment: ${e.message}`);
  } finally {
    enriching = false;
  }
}

// Optional: spend a paid lookup on the primary contact of high-intent leads (off by default).
async function autoFindEmail(id, cfg) {
  const min = cfg.contacts?.autoFindEmailMinScore || 0;
  if (!min) return;
  const c = q.get('SELECT * FROM companies WHERE id = ?', id);
  if (!c || c.score < min) return;
  const st = providerStatus();
  if (!st.configured.length || st.used >= st.cap) return;
  const plan = targetPlan(c);
  const primary = plan.primaryId && q.get('SELECT * FROM contacts WHERE id = ?', plan.primaryId);
  if (!primary || primary.email || primary.email_checked_at) return;
  await findEmail(primary.id).catch((e) => log('error', `Email lookup: ${e.message}`));
}

// One-off: YC companies ingested before team sizes were recorded get theirs from the stored item.
function backfillYcTeams() {
  const rows = q.all(`SELECT r.meta, r.url FROM raw_items r WHERE r.source_id = 'yc-india' AND r.meta LIKE '%"team_size"%'`);
  let n = 0;
  for (const r of rows) {
    const e = J(r.meta, {}).entity;
    if (!e?.team_size) continue;
    const c = q.get(`SELECT c.id FROM companies c JOIN events ev ON ev.company_id = c.id WHERE ev.url = ? AND c.team IS NULL LIMIT 1`, r.url);
    if (!c) continue;
    saveTeam(c.id, { min: e.team_size, max: e.team_size, exact: true, source: 'yc', url: r.url, evidence: `Team size listed on Y Combinator (${e.batch})` });
    n++;
  }
  if (n) log('people', `Backfilled team size for ${n} YC companies`);
}

export function startProcessor() {
  backfillYcTeams();
  q.run(`UPDATE raw_items SET status='new' WHERE status='processing'`);
  setInterval(processBatch, 4000);
  setInterval(enrichLoop, 15000);
  setTimeout(processBatch, 1500);
}

export const queueDepth = () => q.get(`SELECT COUNT(*) n FROM raw_items WHERE status IN ('new','processing')`).n;
