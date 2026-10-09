import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// On Railway, an attached volume is exposed as RAILWAY_VOLUME_MOUNT_PATH; keep the DB there so it survives deploys.
const DB_PATH = process.env.DB_PATH
  || (process.env.RAILWAY_VOLUME_MOUNT_PATH && path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'leadintel.db'))
  || path.resolve('data/leadintel.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                -- rss | gnews | reddit | hn | yc
  category TEXT NOT NULL DEFAULT 'leads', -- leads | intel | voice
  params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  cadence_min INTEGER NOT NULL DEFAULT 60,
  min_cadence INTEGER NOT NULL DEFAULT 20,
  max_cadence INTEGER NOT NULL DEFAULT 720,
  created_by TEXT NOT NULL DEFAULT 'system', -- system | user | agent
  expires_at TEXT,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT,
  last_error TEXT,
  runs INTEGER NOT NULL DEFAULT 0,
  items_total INTEGER NOT NULL DEFAULT 0,
  passed_total INTEGER NOT NULL DEFAULT 0,
  leads_total INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS raw_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  url_hash TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  status TEXT NOT NULL DEFAULT 'new', -- new | filtered | dup | processing | done | error
  prefilter TEXT,
  meta TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_raw_status ON raw_items(status, id);
CREATE INDEX IF NOT EXISTS idx_raw_fetched ON raw_items(fetched_at);

CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  domain TEXT,
  aliases TEXT NOT NULL DEFAULT '[]',
  sector TEXT,
  city TEXT,
  description TEXT,
  website TEXT,
  logo TEXT,
  size TEXT,
  is_indian INTEGER NOT NULL DEFAULT 1,
  sells_intl TEXT,
  markets TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new', -- new | reviewed | contacted | qualified | dismissed
  feedback INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0,
  breakdown TEXT NOT NULL DEFAULT '[]',
  why TEXT,
  pitch TEXT,
  enrichment TEXT,
  enriched_at TEXT,
  notes TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_event_at TEXT,
  seen_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_comp_norm ON companies(norm_name);
CREATE INDEX IF NOT EXISTS idx_comp_domain ON companies(domain);
CREATE INDEX IF NOT EXISTS idx_comp_score ON companies(score DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  raw_item_id INTEGER,
  source_id TEXT,
  type TEXT NOT NULL, -- funding | expansion | launch | export | hiring | pain | partnership | acquisition | directory | other
  title TEXT NOT NULL,
  summary TEXT,
  url TEXT,
  stage TEXT,
  amount_text TEXT,
  amount_usd_m REAL,
  investors TEXT NOT NULL DEFAULT '[]',
  markets TEXT NOT NULL DEFAULT '[]',
  signals TEXT NOT NULL DEFAULT '[]',
  competitors TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  corroborations INTEGER NOT NULL DEFAULT 1,
  extra_urls TEXT NOT NULL DEFAULT '[]',
  occurred_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_company ON events(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS intel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_item_id INTEGER,
  source_id TEXT,
  category TEXT NOT NULL, -- regulatory | competitor | market | voice
  title TEXT NOT NULL,
  summary TEXT,
  so_what TEXT,
  importance INTEGER NOT NULL DEFAULT 2, -- 1..3
  url TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_intel_created ON intel(created_at);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  fetched INTEGER DEFAULT 0,
  new_items INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS llm_usage (
  day TEXT PRIMARY KEY,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);
`);

// People at a company we might reach out to. Every row records where it came from (DPDP provenance).
db.exec(`
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  norm_name TEXT NOT NULL,
  role TEXT,
  email TEXT,
  email_status TEXT,          -- verified | risky (accept-all domain) | null
  email_source TEXT,          -- apollo | hunter | manual
  email_checked_at TEXT,
  linkedin TEXT,
  source TEXT NOT NULL,       -- article | website | news | yc | apollo | manual
  source_url TEXT,
  evidence TEXT,
  confidence REAL NOT NULL DEFAULT 0.6,
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(company_id, norm_name)
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
`);

// Additive migrations for databases created by earlier versions (e.g. the Railway volume).
function addColumn(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}
addColumn('companies', 'team', 'TEXT');           // { min, max, exact, source, url, evidence, at }
addColumn('companies', 'people_checked_at', 'TEXT');
addColumn('intel', 'meta', 'TEXT');                // classifier tags: topic, or Reddit sub/segment/intent/signals
addColumn('intel', 'score', 'INTEGER');            // Reddit buyer-intent score 0..100
addColumn('intel', 'status', "TEXT NOT NULL DEFAULT 'new'"); // Reddit triage: new | replied | lead | ignored
addColumn('intel', 'coverage', 'INTEGER NOT NULL DEFAULT 1'); // how many outlets ran the same story

export const nowIso = () => new Date().toISOString();

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const J = (s, fb) => {
  if (s == null) return fb;
  try { return JSON.parse(s); } catch { return fb; }
};

export function getSetting(key, fallback) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? J(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}
