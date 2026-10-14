// Sprouts (https://ml.sprouts.ai/utility): company snapshot, a person's LinkedIn by name, and email reveal.
// Credits matter, so every call is on click, as small as the API allows, cached, and counted against a cap.
// Until Sprouts confirms its billing rules we assume every answered request costs a credit.
import { q, J, nowIso } from '../db.js';
import { log } from '../bus.js';
import { saveContacts, saveTeam, targetPlan, contactsOf } from './people.js';
import { getConfig } from '../config.js';

const BASE = () => (process.env.SPROUTS_BASE || 'https://ml.sprouts.ai/utility').replace(/\/$/, '');
const SNAPSHOT_DAYS = 30;        // company data changes slowly
const NOT_FOUND_DAYS = 30;       // "Sprouts has nothing for this domain / person" is remembered this long
const SEARCH_CAP = () => Number(process.env.SPROUTS_DAILY_SEARCH_CAP) || 25;
export const configured = () => Boolean(process.env.SPROUTS_API_SECRET && process.env.SPROUTS_LOGIN_EMAIL && process.env.SPROUTS_CUSTOMER_ID);

q.run(`CREATE TABLE IF NOT EXISTS sprouts_company (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  found INTEGER NOT NULL,
  data TEXT,          -- normalised fields shown in the UI
  raw TEXT,           -- the record as returned, so field mapping can be fixed later without paying again
  fetched_at TEXT NOT NULL
)`);
// Ledger of every request, the basis for caps and the usage line in the UI.
q.run(`CREATE TABLE IF NOT EXISTS sprouts_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,       -- account | contact | enrich
  company_id INTEGER,
  contact_id INTEGER,
  records INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  at TEXT NOT NULL
)`);
const cols = q.all('PRAGMA table_info(contacts)').map((c) => c.name);
if (!cols.includes('sprouts_checked_at')) q.run('ALTER TABLE contacts ADD COLUMN sprouts_checked_at TEXT');

export class SproutsError extends Error {}

const today = () => new Date().toISOString().slice(0, 10);
export function usage() {
  const day = `${today()}T00:00:00`;
  const month = `${today().slice(0, 7)}-01T00:00:00`;
  const n = (sql, ...p) => q.get(sql, ...p).n;
  return {
    configured: configured(),
    searchesToday: n(`SELECT COUNT(*) n FROM sprouts_calls WHERE kind IN ('account','contact') AND ok = 1 AND at >= ?`, day),
    searchCap: SEARCH_CAP(),
    reveals: n(`SELECT COUNT(*) n FROM sprouts_calls WHERE kind = 'enrich' AND ok = 1 AND at >= ?`, month),
  };
}

function guardSearch() {
  if (!configured()) throw new SproutsError('Sprouts is not configured. Set SPROUTS_API_SECRET, SPROUTS_LOGIN_EMAIL and SPROUTS_CUSTOMER_ID.');
  const u = usage();
  if (u.searchesToday >= u.searchCap) throw new SproutsError(`Daily Sprouts search limit reached (${u.searchCap}). Raise SPROUTS_DAILY_SEARCH_CAP to allow more.`);
}

// 60 requests per 60 seconds: serialise and keep about a second between calls.
let chain = Promise.resolve();
let nextAt = 0;
function call(path, body, ledger) {
  const run = chain.then(async () => {
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAt = Date.now() + 1100;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    let ok = false, records = 0;
    try {
      const res = await fetch(`${BASE()}${path}`, {
        method: 'POST', signal: ctl.signal,
        headers: {
          'content-type': 'application/json',
          'x-api-secret': process.env.SPROUTS_API_SECRET,
          'x-login-email': process.env.SPROUTS_LOGIN_EMAIL,
          'x-customer-id': process.env.SPROUTS_CUSTOMER_ID,
        },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) throw new SproutsError('Sprouts rejected the credentials');
      if (res.status === 429) throw new SproutsError('Sprouts rate limit or credits exhausted; try again in a minute');
      if (res.status === 422) throw new SproutsError(`Sprouts rejected the request: ${detail(j)}`);
      if (!res.ok) throw new SproutsError(`Sprouts error ${res.status}: ${detail(j)}`);
      ok = true;
      records = Array.isArray(j.list) ? j.list.length : (j.email || j.phone) ? 1 : 0;
      return j;
    } catch (e) {
      if (e.name === 'AbortError') throw new SproutsError('Sprouts timed out');
      throw e;
    } finally {
      clearTimeout(timer);
      // Only answered requests are assumed billable; failures are logged as ok = 0.
      q.run('INSERT INTO sprouts_calls(kind, company_id, contact_id, records, ok, at) VALUES(?,?,?,?,?,?)', ledger.kind, ledger.companyId ?? null, ledger.contactId ?? null, records, ok ? 1 : 0, nowIso());
    }
  });
  chain = run.catch(() => {});
  return run;
}

const detail = (j) => {
  const d = j?.detail ?? j?.message ?? j?.error;
  if (Array.isArray(d)) return d.map((x) => x.msg || x.message || JSON.stringify(x)).join('; ');
  return typeof d === 'string' ? d : JSON.stringify(d || {}).slice(0, 200);
};

// The docs do not list record fields yet, so read the first present key from likely names.
const pick = (o, ...keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((x, p) => (x == null ? undefined : x[p]), o);
    if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) return v;
  }
  return null;
};
const asNum = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : typeof v === 'object' ? asNum(v.max ?? v.min ?? v.value) : null);
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : x?.name || x?.title || x?.value)).filter(Boolean) : String(v).split(/\s*[,;|]\s*/).filter(Boolean));
const isLinkedIn = (u) => typeof u === 'string' && /linkedin\.com\/(in|pub)\//i.test(u);

function normaliseAccount(r) {
  const dist = pick(r, 'employee_distribution', 'employeeDistribution', 'employees_by_country', 'employee_countries', 'country_distribution');
  let countries = [];
  if (Array.isArray(dist)) countries = dist.map((x) => ({ country: x.country || x.name || x.country_name, employees: asNum(x.employees ?? x.count ?? x.employee_count) })).filter((x) => x.country);
  else if (dist && typeof dist === 'object') countries = Object.entries(dist).map(([country, v]) => ({ country, employees: asNum(v) }));
  countries.sort((a, b) => (b.employees || 0) - (a.employees || 0));
  return {
    name: pick(r, 'company_name', 'companyName', 'name'),
    website: pick(r, 'website', 'domain', 'company_domain', 'companyDomain'),
    linkedin: pick(r, 'linkedin_url', 'linkedinUrl', 'company_linkedin_url', 'linkedin'),
    industry: pick(r, 'industry', 'industries'),
    description: pick(r, 'description', 'company_description', 'companyDescription', 'about'),
    employees: asNum(pick(r, 'employee_count', 'employeeCount', 'employees', 'headcount', 'company_size')),
    revenue: asNum(pick(r, 'revenue', 'annual_revenue', 'annualRevenue', 'revenue_range')),
    founded: asNum(pick(r, 'founded_year', 'foundedYear', 'founded')),
    hq: pick(r, 'hq_location', 'headquarters', 'location', 'hq', 'company_location', 'country'),
    businessType: pick(r, 'business_type', 'businessType'),
    fundingStage: pick(r, 'funding.stage', 'funding_stage', 'fundingStage', 'last_funding_stage', 'last_funding_type'),
    totalFunding: asNum(pick(r, 'funding.total_funding', 'total_funding', 'totalFunding')),
    lastFundingDate: pick(r, 'funding.last_funding_date', 'last_funding_date', 'lastFundingDate'),
    technologies: asList(pick(r, 'technologies', 'technology', 'tech_stack', 'techStack')).slice(0, 30),
    countries: countries.slice(0, 10),
    openJobs: asNum(pick(r, 'job_openings_count', 'open_jobs', 'jobOpenings', 'job_openings.count')),
  };
}

function normaliseContact(r) {
  const first = pick(r, 'first_name', 'firstName');
  const last = pick(r, 'last_name', 'lastName');
  return {
    name: pick(r, 'full_name', 'fullName', 'name', 'contact_name') || [first, last].filter(Boolean).join(' ') || null,
    role: pick(r, 'job_title', 'jobTitle', 'title', 'designation'),
    linkedin: [pick(r, 'linkedin_url', 'linkedinUrl', 'linkedin', 'profile_url', 'li_url')].find(isLinkedIn) || null,
  };
}

const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);
const domainOfCompany = (c) => (c.domain || '').replace(/^www\./, '') || null;

// ---------- company snapshot ----------
export function cachedSnapshot(companyId) {
  const row = q.get('SELECT * FROM sprouts_company WHERE company_id = ?', companyId);
  return row ? { found: Boolean(row.found), data: J(row.data, null), fetchedAt: row.fetched_at, stale: daysSince(row.fetched_at) > (row.found ? SNAPSHOT_DAYS : NOT_FOUND_DAYS) } : null;
}

export async function companySnapshot(companyId, { refresh = false } = {}) {
  const c = q.get('SELECT id, name, domain FROM companies WHERE id = ?', companyId);
  if (!c) throw new SproutsError('Lead not found');
  const domain = domainOfCompany(c);
  if (!domain) throw new SproutsError('No website on file for this lead. Run "Research now" first.');
  const cached = cachedSnapshot(companyId);
  if (cached && !cached.stale && !refresh) return cached;
  guardSearch();
  // One record for one known domain: the smallest possible account search.
  const j = await call('/sproutsdata', { request_type: 'Account', filters: { company: [domain] }, page: 1, page_size: 1 }, { kind: 'account', companyId });
  const rec = (j.list || [])[0] || null;
  const data = rec ? normaliseAccount(rec) : null;
  q.run(`INSERT INTO sprouts_company(company_id, domain, found, data, raw, fetched_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(company_id) DO UPDATE SET domain = excluded.domain, found = excluded.found, data = excluded.data, raw = excluded.raw, fetched_at = excluded.fetched_at`,
  c.id, domain, rec ? 1 : 0, JSON.stringify(data), rec ? JSON.stringify(rec) : null, nowIso());
  if (data?.employees) saveTeam(c.id, { min: data.employees, max: data.employees, exact: true, source: 'sprouts', evidence: 'Employee count from Sprouts' });
  log('people', `Sprouts snapshot for ${c.name} (${domain}): ${rec ? 'found' : 'no record'}`);
  return cachedSnapshot(companyId);
}

// ---------- people ----------
// LinkedIn URL for a person we already know by name: a one-record contact search.
export async function findLinkedIn(contactId) {
  const ct = q.get('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!ct) throw new SproutsError('Contact not found');
  if (ct.linkedin) return { linkedin: ct.linkedin, cached: true };
  if (ct.do_not_contact) throw new SproutsError('This person is on the do-not-contact list');
  if (ct.sprouts_checked_at && daysSince(ct.sprouts_checked_at) < NOT_FOUND_DAYS) throw new SproutsError(`Sprouts had no profile for ${ct.name} when checked ${Math.round(daysSince(ct.sprouts_checked_at))} days ago`);
  const c = q.get('SELECT id, name, domain FROM companies WHERE id = ?', ct.company_id);
  guardSearch();
  const filters = { contact_name: [ct.name], company: [domainOfCompany(c) || c.name] };
  const j = await call('/sproutsdata', { request_type: 'Contact', filters, page: 1, page_size: 1, contacts_per_account: 1 }, { kind: 'contact', companyId: c.id, contactId: ct.id });
  const p = (j.list || []).map(normaliseContact)[0];
  q.run('UPDATE contacts SET sprouts_checked_at = ?, linkedin = COALESCE(linkedin, ?), role = COALESCE(role, ?), updated_at = ? WHERE id = ?', nowIso(), p?.linkedin || null, p?.role || null, nowIso(), ct.id);
  log('people', `Sprouts profile search for a contact at ${c.name}: ${p?.linkedin ? 'LinkedIn found' : 'not found'}`);
  return { linkedin: p?.linkedin || null };
}

// No named people yet: ask for the few roles the drawer would recommend, not the whole company.
export async function findDecisionMakers(companyId) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) throw new SproutsError('Lead not found');
  const domain = domainOfCompany(c);
  if (!domain) throw new SproutsError('No website on file for this lead. Run "Research now" first.');
  const last = q.get(`SELECT at FROM sprouts_calls WHERE kind = 'contact' AND company_id = ? AND contact_id IS NULL AND ok = 1 ORDER BY id DESC LIMIT 1`, c.id);
  if (last && daysSince(last.at) < NOT_FOUND_DAYS) throw new SproutsError(`Sprouts was already asked for people here ${Math.max(0, Math.round(daysSince(last.at)))} days ago; add or remove people manually instead`);
  guardSearch();
  const plan = targetPlan(c, contactsOf(c.id));
  const n = plan.team?.n ?? null;
  const small = n == null ? c.size !== 'enterprise' : n <= getConfig().contacts.smallTeamMax;
  // Filters are ANDed, so each branch is one narrow query.
  const filters = small
    ? { company: [domain], governance_level: ['Founder', 'Co Founder'] }
    : { company: [domain], department: ['Finance'], seniority: ['C-Suite', 'VP', 'Director / Head'] };
  const j = await call('/sproutsdata', { request_type: 'Contact', filters, page: 1, page_size: 3, contacts_per_account: 3 }, { kind: 'contact', companyId: c.id });
  const people = (j.list || []).map(normaliseContact).filter((p) => p.name);
  const added = saveContacts(c.id, people.map((p) => ({ ...p, evidence: `Listed in Sprouts (${small ? 'founders' : 'finance leadership'})` })), { source: 'sprouts', url: null, confidence: 0.8 });
  log('people', `Sprouts people search for ${c.name}: ${people.length} found, ${added} new`);
  return { found: people.length, added, searched: small ? 'founders' : 'finance leadership' };
}

// ---------- email reveal (used by email-finders.js) ----------
// Work email only; phone stays off (costlier and more sensitive under DPDP).
export async function revealEmail({ contactId, companyId, linkedin, domain }) {
  const j = await call('/enrich-contact-email', { linkedin_url: linkedin, enrich_email: true, enrich_phone: false, ...(domain ? { domain } : {}) }, { kind: 'enrich', companyId, contactId });
  return { email: typeof j.email === 'string' && j.email.includes('@') ? j.email.trim() : null };
}

