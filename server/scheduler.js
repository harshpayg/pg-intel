import { q, J, nowIso } from './db.js';
import { fetchSource } from './sources/index.js';
import { canonicalUrl, sha1, tokens, jaccard, daysAgo } from './util/text.js';
import { getConfig } from './config.js';
import { bus, log } from './bus.js';

const MAX_CONCURRENT = 4;
const running = new Set();
let timer = null;

// Recent titles for near-duplicate detection across outlets (syndicated stories).
const recentTitles = [];
function isNearDup(title) {
  const t = tokens(title);
  if (t.length < 4) return false;
  for (const r of recentTitles) if (jaccard(t, r) >= 0.75) return true;
  recentTitles.push(t);
  if (recentTitles.length > 3000) recentTitles.shift();
  return false;
}

export function warmDedupCache() {
  for (const r of q.all("SELECT title FROM raw_items WHERE fetched_at > ? ORDER BY id DESC LIMIT 3000", new Date(Date.now() - 4 * 86400000).toISOString())) {
    recentTitles.push(tokens(r.title));
  }
}

function hydrate(row) {
  return row && { ...row, params: J(row.params, {}) };
}

export function ingest(source, items) {
  const cfg = getConfig();
  let fresh = 0;
  const ins = 'INSERT OR IGNORE INTO raw_items(source_id, url, url_hash, title, summary, published_at, status, meta) VALUES(?,?,?,?,?,?,?,?)';
  for (const it of items) {
    const url = canonicalUrl(it.url);
    const hash = sha1(url);
    if (q.get('SELECT 1 FROM raw_items WHERE url_hash = ?', hash)) continue;
    const tooOld = !it.meta?.entity && it.published_at && daysAgo(it.published_at) > cfg.maxItemAgeDays;
    const status = tooOld ? 'filtered' : !it.meta?.entity && isNearDup(it.title) ? 'dup' : 'new';
    const r = q.run(ins, source.id, url, hash, it.title.slice(0, 500), it.summary || '', it.published_at || null, status, JSON.stringify(it.meta || {}));
    if (r.changes) fresh += status === 'new' ? 1 : 0;
  }
  return fresh;
}

export async function runSource(id, { manual = false } = {}) {
  if (running.has(id)) return { skipped: true };
  const source = hydrate(q.get('SELECT * FROM sources WHERE id = ?', id));
  if (!source) throw new Error('Unknown source');
  running.add(id);
  const started = nowIso();
  const run = q.run('INSERT INTO runs(source_id, started_at, status) VALUES(?,?,?)', id, started, 'running');
  bus.emit('source', { id, status: 'running' });
  try {
    const items = await fetchSource(source);
    const fresh = ingest(source, items);
    const jitter = 1 + (Math.random() * 0.2 - 0.1);
    const next = new Date(Date.now() + source.cadence_min * 60000 * jitter).toISOString();
    q.run(`UPDATE sources SET last_run_at=?, next_run_at=?, last_status='ok', last_error=NULL, runs=runs+1, items_total=items_total+? WHERE id=?`, nowIso(), next, fresh, id);
    q.run('UPDATE runs SET finished_at=?, status=?, fetched=?, new_items=? WHERE id=?', nowIso(), 'ok', items.length, fresh, run.lastInsertRowid);
    log('fetch', `${source.name}: ${items.length} items, ${fresh} new${manual ? ' (manual)' : ''}`);
    bus.emit('source', { id, status: 'ok', fresh });
    return { fetched: items.length, fresh };
  } catch (e) {
    if (e.status === 429 || e.status === 503) {
      // Rate limited: not a failure, just come back later.
      const later = new Date(Date.now() + (15 + Math.random() * 20) * 60000).toISOString();
      q.run(`UPDATE sources SET next_run_at=?, last_status='deferred', last_error=? WHERE id=?`, later, 'Rate limited by host, retrying later', id);
      q.run('UPDATE runs SET finished_at=?, status=?, error=? WHERE id=?', nowIso(), 'deferred', 'rate limited', run.lastInsertRowid);
      log('fetch', `${source.name}: rate limited, rescheduled`);
      bus.emit('source', { id, status: 'deferred' });
      return { deferred: true, error: 'Rate limited, rescheduled' };
    }
    const retry = new Date(Date.now() + Math.min(source.cadence_min, 30) * 60000).toISOString();
    q.run(`UPDATE sources SET last_run_at=?, next_run_at=?, last_status='error', last_error=?, runs=runs+1 WHERE id=?`, nowIso(), retry, e.message.slice(0, 300), id);
    q.run('UPDATE runs SET finished_at=?, status=?, error=? WHERE id=?', nowIso(), 'error', e.message.slice(0, 300), run.lastInsertRowid);
    log('error', `${source.name}: ${e.message}`);
    bus.emit('source', { id, status: 'error' });
    return { error: e.message };
  } finally {
    running.delete(id);
  }
}

// One source per host at a time, so a slow-paced host (Reddit) never hogs the worker slots.
const busyHosts = new Map(); // sourceId -> host
function hostOf(s) {
  const p = J(s.params, {});
  if (s.kind === 'gnews') return 'news.google.com';
  if (s.kind === 'reddit') return 'reddit';
  if (s.kind === 'hn') return 'hn.algolia.com';
  if (s.kind === 'yc') return 'yc-oss.github.io';
  try { return new URL(p.url).host; } catch { return s.id; }
}

function tick() {
  if (running.size >= MAX_CONCURRENT) return;
  const due = q.all(`SELECT id, kind, params FROM sources WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at IS NOT NULL, next_run_at LIMIT 50`, nowIso());
  const hosts = new Set(busyHosts.values());
  for (const s of due) {
    if (running.size >= MAX_CONCURRENT) break;
    const host = hostOf(s);
    if (running.has(s.id) || hosts.has(host)) continue;
    hosts.add(host);
    busyHosts.set(s.id, host);
    runSource(s.id).catch(() => {}).finally(() => busyHosts.delete(s.id));
  }
}

export function runAllNow() {
  q.run('UPDATE sources SET next_run_at = NULL WHERE enabled = 1');
  tick();
}

export const runningSources = () => [...running];

export function startScheduler() {
  warmDedupCache();
  tick();
  timer = setInterval(tick, 10_000);
}

export function stopScheduler() {
  clearInterval(timer);
}
