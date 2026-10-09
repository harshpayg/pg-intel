import { q, J, getSetting, setSetting } from '../db.js';
import { classifyIntel, classifyReddit, isNearDup } from './intel.js';
import { clip } from '../util/text.js';
import { log } from '../bus.js';

// Insert an intel row unless it repeats a story from the last week; repeats bump `coverage` instead.
// Returns true when a new row was written.
export function saveIntel(intel, item, source, rawId) {
  const title = intel.title || item.title;
  if (q.get('SELECT 1 FROM intel WHERE url = ? OR title = ?', item.url, title)) return false;
  const topic = intel.topic || intel.meta?.topic || null;
  if (intel.category !== 'voice') {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const recent = q.all(`SELECT id, title, meta FROM intel WHERE category = ? AND COALESCE(published_at, created_at) > ?`, intel.category, since);
    const dup = recent.find((r) => isNearDup(title, r.title, topic && J(r.meta, {}).topic === topic));
    if (dup) { q.run('UPDATE intel SET coverage = coverage + 1 WHERE id = ?', dup.id); return false; }
  }
  const meta = { ...(intel.meta || {}), ...(topic ? { topic } : {}) };
  q.run('INSERT INTO intel(raw_item_id, source_id, category, title, summary, so_what, importance, url, published_at, meta, score) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    rawId, source.id, intel.category, title, intel.summary || clip(item.summary || '', 400), intel.so_what,
    Math.max(1, Math.min(3, intel.importance || 2)), item.url, item.published_at, JSON.stringify(meta), intel.score ?? null);
  return true;
}

// One-off: re-judge everything already stored with the current classifiers. Bump RULES_VERSION when they change.
const RULES_VERSION = 3;
export function rebuildIntel() {
  if (getSetting('intelRulesVersion', 1) >= RULES_VERSION) return;
  const kept = new Map(q.all(`SELECT url, status FROM intel WHERE status != 'new'`).map((r) => [r.url, r.status]));
  const rows = q.all(`SELECT r.*, s.category scat, s.params sparams FROM raw_items r JOIN sources s ON s.id = r.source_id
    WHERE s.category IN ('intel','voice') AND r.status IN ('done','filtered') ORDER BY COALESCE(r.published_at, r.fetched_at) ASC`);
  q.run('DELETE FROM intel');
  let n = 0;
  for (const r of rows) {
    const source = { id: r.source_id, category: r.scat, params: J(r.sparams, {}) };
    const item = { ...r, meta: J(r.meta, {}) };
    const cls = r.scat === 'voice' ? classifyReddit(item, source) : classifyIntel(item, source);
    if (cls && saveIntel({ ...cls, title: item.title }, item, source, r.id)) {
      n++;
      if (kept.has(item.url)) q.run('UPDATE intel SET status = ? WHERE url = ?', kept.get(item.url), item.url);
    }
  }
  setSetting('intelRulesVersion', RULES_VERSION);
  log('boot', `Rebuilt intel with new rules: kept ${n} of ${rows.length} stored items`);
}
