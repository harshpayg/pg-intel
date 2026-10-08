import { q, J, nowIso, getSetting, setSetting } from '../db.js';
import { getConfig } from '../config.js';
import { domainOf } from '../util/text.js';
import { saveTeam } from './people.js';
import { log } from '../bus.js';

// Verified work-email lookup through licensed providers. Only verified (or accept-all, marked "risky")
// addresses are stored; we never guess patterns or probe mail servers ourselves.
const PROVIDERS = {
  apollo: { key: () => process.env.APOLLO_API_KEY, label: 'Apollo' },
  hunter: { key: () => process.env.HUNTER_API_KEY, label: 'Hunter' },
};

const month = () => new Date().toISOString().slice(0, 7);

export function providerStatus() {
  const cfg = getConfig().contacts;
  const usage = getSetting('email_lookups', {});
  const used = usage.month === month() ? usage.count || 0 : 0;
  return {
    configured: Object.entries(PROVIDERS).filter(([, p]) => p.key()).map(([k, p]) => ({ id: k, label: p.label })),
    preferred: cfg.emailProvider,
    used,
    cap: cfg.monthlyLookupCap,
  };
}

function countLookup() {
  const u = getSetting('email_lookups', {});
  setSetting('email_lookups', u.month === month() ? { month: month(), count: (u.count || 0) + 1 } : { month: month(), count: 1 });
}

function pickProvider() {
  const st = providerStatus();
  if (!st.configured.length) throw new Error('No email provider configured. Add APOLLO_API_KEY or HUNTER_API_KEY.');
  if (st.used >= st.cap) throw new Error(`Monthly lookup cap reached (${st.used}/${st.cap}). Raise it in Config.`);
  const want = st.preferred !== 'auto' && st.configured.find((p) => p.id === st.preferred);
  return (want || st.configured[0]).id;
}

async function getJson(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw new Error('Provider rejected the API key');
    if (res.status === 429) throw new Error('Provider rate limit or credits exhausted');
    if (!res.ok) throw new Error(body?.errors?.[0]?.details || body?.error || body?.message || `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function apollo({ first, last, name, company, domain }) {
  const params = new URLSearchParams({ first_name: first, last_name: last, name, organization_name: company, reveal_personal_emails: 'false' });
  if (domain) params.set('domain', domain);
  const body = await getJson(`https://api.apollo.io/api/v1/people/match?${params}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', 'x-api-key': PROVIDERS.apollo.key() },
  });
  const p = body.person;
  if (!p) return { email: null };
  const verified = p.email && p.email_status === 'verified';
  return {
    email: verified ? p.email : null,
    status: verified ? 'verified' : null,
    note: p.email && !verified ? `Apollo has an unverified address (${p.email_status || 'unknown'}); not stored` : null,
    linkedin: p.linkedin_url || null,
    title: p.title || null,
    teamSize: p.organization?.estimated_num_employees || null,
  };
}

async function hunter({ first, last, domain }) {
  if (!domain) return { email: null, note: 'Hunter needs the company website; research the company first' };
  const params = new URLSearchParams({ domain, first_name: first, last_name: last, api_key: PROVIDERS.hunter.key() });
  const body = await getJson(`https://api.hunter.io/v2/email-finder?${params}`);
  const d = body.data || {};
  const st = d.verification?.status;
  const status = st === 'valid' ? 'verified' : st === 'accept_all' ? 'risky' : null;
  return {
    email: status ? d.email : null,
    status,
    note: d.email && !status ? `Hunter found an unverified address (${st || 'unknown'}); not stored` : null,
    linkedin: d.linkedin_url || null,
    title: d.position || null,
  };
}

export async function findEmail(contactId) {
  const ct = q.get('SELECT * FROM contacts WHERE id = ?', contactId);
  if (!ct) throw new Error('Contact not found');
  if (ct.do_not_contact) throw new Error('This person is on the do-not-contact list');
  const c = q.get('SELECT * FROM companies WHERE id = ?', ct.company_id);
  const provider = pickProvider();
  const parts = ct.name.split(/\s+/);
  const args = { first: parts[0], last: parts[parts.length - 1], name: ct.name, company: c.name, domain: c.domain || domainOf(c.website) || J(c.enrichment, {})?.domain };
  const r = provider === 'apollo' ? await apollo(args) : await hunter(args);
  countLookup(); // only answered lookups count towards the cap
  q.run(`UPDATE contacts SET email = COALESCE(?, email), email_status = COALESCE(?, email_status), email_source = CASE WHEN ? IS NOT NULL THEN ? ELSE email_source END,
    email_checked_at = ?, linkedin = COALESCE(linkedin, ?), role = COALESCE(role, ?), updated_at = ? WHERE id = ?`,
    r.email, r.status, r.email, provider, nowIso(), r.linkedin, r.title, nowIso(), ct.id);
  if (r.teamSize) saveTeam(c.id, { min: r.teamSize, max: r.teamSize, exact: true, source: 'apollo', evidence: 'Apollo estimated employee count' });
  log('people', `${PROVIDERS[provider].label} lookup for ${ct.name} (${c.name}): ${r.email ? `${r.status} email found` : r.note || 'no verified email'}`);
  return { provider, found: Boolean(r.email), status: r.status, note: r.note };
}
