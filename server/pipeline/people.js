import * as cheerio from 'cheerio';
import { q, J, nowIso, getSetting, setSetting } from '../db.js';
import { getConfig } from '../config.js';
import { fetchText, fetchJson } from '../util/http.js';
import { domainOf, normName, clip } from '../util/text.js';
import * as llm from './llm.js';
import { log } from '../bus.js';

// Who works at a lead, how big it is, and who we should reach out to.
// Only names, roles and work emails are kept, each with its source (DPDP provenance).
// No LinkedIn scraping, no email guessing, no personal phone numbers.

// ---------- names and roles ----------
const NAME = "[A-Z][a-z]+(?:[ -](?:[A-Z][a-z]+|[A-Z]\\.?(?=\\s))){1,2}(?![\\w-])";
const ROLE = '(?:(?:[Aa]ssistant |[Ss]enior |[Ee]xecutive )?(?:Vice President|VP)(?:\\s*[-–,]\\s*[A-Z][a-z]+(?:\\s*(?:&|and)\\s*[A-Z][a-z]+| [A-Z][a-z]+)?)?|[Cc]o-?[Ff]ounder|[Ff]ounder|CEO|CTO|COO|CFO|CMO|CPO|CBO|[Cc]hief [A-Z]?[a-z]+ [Oo]fficer|[Mm]anaging [Dd]irector|MD|[Hh]ead of [A-Z]?[a-z]+(?: [A-Z]?[a-z]+)?|VP,? [A-Z][a-z]+|[Pp]resident|[Cc]hairman)';
const DEPT = '(?:Finance|Accounts|Treasury|Payments|Sales|Ad Sales|Marketing|Growth|Revenue|Partnerships|Business Development|Strategy|Operations|Engineering|Technology|Product|E-?commerce|Digital|Exports?|International Business|Global Business|HR|People|Legal|Compliance|Risk)';
const ROLE_CHAIN = `${ROLE}(?:\\s*(?:and|&|,|/)\\s*${ROLE})*(?:\\s*[-–]\\s*${DEPT}(?:\\s*(?:&|and|,)\\s*${DEPT})*)?`;

const NOT_NAME = new Set(('Founder Co Cofounder Ceo Cto India Indian Ventures Venture Capital Partners Partner Fund Funds Labs Lab Technologies Technology Tech Private Limited ' +
  'Bengaluru Bangalore Mumbai Delhi Gurugram Gurgaon Noida Pune Hyderabad Chennai Kolkata Jaipur Ahmedabad Series Seed Round Angel Network Group Global Holdings ' +
  'The This That Its Their Our His Her Said Says Also Startup Company Inc Media News Today Read More Team Board Advisor Investor Investors Family Office ' +
  'January February March April May June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
  'Managing Director Chief Officer Head President Chairman Executive Vice Assistant Senior Junior Lead Manager Engineer Consultant Sales Marketing Office ' +
  'Business School University College Institute Chartered Accountant Doctor Resident Professor Prof Dr Mr Ms Mrs Ex Former Partner Associate Analyst Intern ' +
  'Operations Finance Product Engineering Technology Growth Strategy Design Legal Human Resources People Talent Customer Success Support Admin Our Meet Join').split(' '));

function validName(name, companyName) {
  if (!name) return false;
  const words = name.trim().split(/[ -]+/);
  if (words.length < 2 || words.length > 3) return false;
  if (words.some((w) => NOT_NAME.has(w.replace(/\.$/, '')))) return false;
  if (ORG_SUFFIX.test(name) || /\b(Initiative|Foundation|Network|Association|Council|Mobility|Energy|Motors|Pharma|Healthcare|Infra)\b/.test(name)) return false;
  const cn = normName(companyName || '');
  const nn = normName(name);
  if (!nn || nn.length < 5) return false;
  if (cn && (nn === cn || cn.includes(nn) || nn.includes(cn))) return false;
  return true;
}

const tidyRole = (r) => String(r || '').replace(/\s+/g, ' ').replace(/\bco-?founder\b/i, 'Co-founder').replace(/^founder/, 'Founder').trim();

const BUCKETS = {
  founder: /founder|owner|promoter/i,
  ceo: /\bceo\b|chief executive|managing director|\bmd\b/i,
  md: /managing director|\bmd\b|whole-?time director|chairman/i,
  cto: /\bcto\b|chief technology|vp,? engineering|head of (engineering|technology|tech)\b/i,
  cfo: /\bcfo\b|chief financial/i,
  finance: /financ|controller|treasur|accounts/i,
  payments: /payments?\b/i,
  coo: /\bcoo\b|chief operating|operations/i,
  ecommerce: /e-?commerce|growth|digital|marketing|\bcmo\b/i,
  director: /director/i,
};
const BUCKET_LABEL = { founder: 'Founder', ceo: 'CEO', md: 'Managing Director', cto: 'CTO', cfo: 'CFO', finance: 'Head of Finance', payments: 'Head of Payments', coo: 'COO', ecommerce: 'Head of E-commerce/Growth', director: 'Director' };

// Context guards: "Raul Rai, co-founder of Nicobar" (another company) or "backed by angel investors including X".
const ORG_SUFFIX = /\b(Technologies|Technology|Pvt|Ltd|Limited|Inc|LLC|Labs|Solutions|Products|Systems|Ventures|Capital|Partners|Group|Industries|Enterprises|Corp|Company|Studio|Media|Foods|Brands)\b/;
function aboutOtherCompany(after, companyName) {
  // "CTO, VerdeMobility Products" / "Co-Founder, EVAMP Technologies": a title at another organisation.
  const comma = after.match(/^\s*[,@|]\s*([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/);
  if (comma && normName(comma[1]) && !normName(companyName).includes(normName(comma[1]).slice(0, 5)) && (ORG_SUFFIX.test(comma[1]) || /^[A-Z][a-z]+[A-Z]/.test(comma[1]))) return true;
  const m = after.match(/^\s*(?:of|at)\s+([A-Z0-9][\w&.'-]*(?:\s+[A-Z0-9][\w&.'-]*){0,3})/);
  if (!m) return false;
  const other = normName(m[1]);
  const mine = normName(companyName);
  return !(other && mine && (other.includes(mine) || mine.includes(other) || /^(the|our|its|this)/i.test(m[1])));
}
const investorContext = (before) => /(investor|angel|participation from|participated|backed by|led by|along with|alongside|including|family office|venture partner|general partner)\W*$/i.test(before.slice(-90)) || /\b(investors? (include|including)|participation from)\b/i.test(before.slice(-160));

// Customer quotes on a homepage ("Name, Title, Company: “Quote…”"): the person is a customer, not staff.
const testimonial = (text, idx, len) => /^[^.]{0,60}[“"]/.test(text.slice(idx + len, idx + len + 70));

function snippet(text, idx, len) {
  const start = Math.max(0, text.lastIndexOf('.', idx) + 1);
  const endDot = text.indexOf('.', idx + len);
  return clip(text.slice(start, endDot > 0 ? endDot + 1 : idx + len + 80).trim(), 220);
}

// Rule-based people extraction from article or page text.
export function peopleFromText(text, companyName) {
  if (!text) return [];
  const out = new Map();
  const add = (raw, role, idx, len) => {
    // "Our Team Aditya Oza" -> try "Team Aditya Oza", then "Aditya Oza".
    const words = raw.trim().split(/\s+/);
    // "Siraj Naviwala Vice" + "President": move trailing role words back into the role.
    const moved = [];
    while (words.length > 2 && NOT_NAME.has(words[words.length - 1])) moved.unshift(words.pop());
    if (moved.length) role = `${moved.join(' ')} ${role || ''}`.trim();
    let name = null;
    for (let i = 0; words.length - i >= 2 && !name; i++) if (validName(words.slice(i).join(' '), companyName)) name = words.slice(i).join(' ');
    if (!name) return;
    const key = normName(name);
    const prev = out.get(key);
    const r = tidyRole(role);
    // Keep the first role unless the new one refines it ("Co-founder" -> "Co-founder & CEO").
    const refines = r && prev?.role && r.toLowerCase().includes(prev.role.toLowerCase()) && r.length > prev.role.length;
    if (!prev || (!prev.role && r) || refines) out.set(key, { name, role: r || prev?.role || null, evidence: snippet(text, idx, len) });
  };

  // "Founded by A and B" / "co-founded in 2021 by A, B and C"
  const p3 = new RegExp(`(?:[Ff]ounded|[Cc]o-founded|[Ss]tarted|[Ss]et up|[Ee]stablished)\\s+(?:in\\s+\\d{4}\\s+)?by\\s+((?:(?:former\\s+[\\w ]+?\\s+executives?|IIT[\\w ]*?alumni|serial entrepreneurs?)\\s+)?${NAME}(?:\\s*(?:,|and|&)\\s*${NAME})*)`, 'g');
  for (const m of text.matchAll(p3)) {
    const names = m[1].replace(/^(former\s+[\w ]+?\s+executives?|IIT[\w ]*?alumni|serial entrepreneurs?)\s+/, '').split(/\s*(?:,|\band\b|&)\s*/);
    for (const n of names) add(n, 'Co-founder', m.index, m[0].length);
  }
  // "Saket Saurav, co-founder and CEO" (skip "... of OtherCo")
  const p1 = new RegExp(`((?:[A-Z][a-z]+ )?${NAME}),?\\s+(?:the\\s+|its\\s+)?(${ROLE_CHAIN})`, 'g');
  for (const m of text.matchAll(p1)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    if (aboutOtherCompany(after, companyName) || investorContext(text.slice(0, m.index)) || testimonial(text, m.index, m[0].length)) continue;
    add(m[1], m[2], m.index, m[0].length);
  }
  // "co-founder and CEO Suhas Rajkumar" (skip "Atomberg co-founder X")
  const p2 = new RegExp(`(?:\\b(?:its|the|and|said)\\s+)?(${ROLE_CHAIN}),?\\s+(${NAME})`, 'g');
  for (const m of text.matchAll(p2)) {
    const before = text.slice(Math.max(0, m.index - 40), m.index);
    const prevWord = before.match(/([A-Z][\w&.'-]*)\s*$/)?.[1];
    if (prevWord && !/^(The|Its|And|Said|Says|While|According)$/.test(prevWord) && normName(prevWord) && !normName(companyName).includes(normName(prevWord))) continue;
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
    const quoted = /^said\s/i.test(m[0]); // "..., said co-founder X" quotes the company's own person
    if (aboutOtherCompany(after, companyName) || (!quoted && investorContext(text.slice(0, m.index))) || testimonial(text, m.index, m[0].length)) continue;
    add(m[2], m[1], m.index, m[0].length);
  }
  return [...out.values()].slice(0, 8);
}

// ---------- team size ----------
export function teamFromText(text) {
  if (!text) return null;
  const pats = [
    /\b(?:team|workforce|headcount|staff) of (?:about |around |over |more than |nearly |close to |~)?(\d[\d,]*)\+?/i,
    /\b(\d[\d,]*)\+?[- ](?:member|people|person|strong)\b/i,
    /\b(?:employs|employing|employ) (?:about |around |over |more than |nearly |close to )?(\d[\d,]*)/i,
    /\b(\d[\d,]*)\+? (?:employees|full-time employees|staff members|team members)\b/i,
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (!m) continue;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (n >= 2 && n <= 200000) return { min: n, max: n, exact: true, evidence: snippet(text, m.index, m[0].length) };
  }
  return null;
}

const STAGE_TEAM = {
  'Pre-Seed': [2, 15], Angel: [2, 15], Seed: [5, 40], 'Pre-Series A': [10, 50], 'Series A': [20, 120],
  'Pre-Series B': [40, 200], 'Series B': [60, 300], 'Series C': [150, 800], 'Series D': [300, 2000],
};
const SOURCE_RANK = { manual: 6, apollo: 5, yc: 5, website: 4, article: 3, news: 3, stage: 1 };

export function bandOf(team) {
  if (!team) return null;
  const n = team.exact ? team.min : Math.round(Math.sqrt(team.min * team.max));
  const label = n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 1000 ? '201-1000' : '1000+';
  return { n, label };
}

// Keep the most trustworthy team-size reading.
export function saveTeam(companyId, team) {
  if (!team) return;
  const cur = J(q.get('SELECT team FROM companies WHERE id = ?', companyId)?.team, null);
  if (cur && (SOURCE_RANK[cur.source] || 0) > (SOURCE_RANK[team.source] || 0)) return;
  q.run('UPDATE companies SET team = ? WHERE id = ?', JSON.stringify({ ...team, at: nowIso() }), companyId);
}

function stageEstimate(companyId) {
  const e = q.get(`SELECT stage FROM events WHERE company_id = ? AND stage IS NOT NULL ORDER BY occurred_at DESC LIMIT 1`, companyId);
  const r = e && STAGE_TEAM[e.stage];
  return r ? { min: r[0], max: r[1], exact: false, source: 'stage', evidence: `Typical team size at ${e.stage}` } : null;
}

// ---------- contacts ----------
// People removed by a user stay suppressed so automated research never re-adds them.
const suppressedKey = (companyId, norm) => `${companyId}:${norm}`;
export function suppressContact(companyId, norm) {
  const list = getSetting('suppressed_contacts', []);
  if (!list.includes(suppressedKey(companyId, norm))) setSetting('suppressed_contacts', [...list, suppressedKey(companyId, norm)].slice(-5000));
}

export function saveContacts(companyId, people, { source, url, confidence = 0.6 }) {
  const company = q.get('SELECT name FROM companies WHERE id = ?', companyId);
  const suppressed = new Set(getSetting('suppressed_contacts', []));
  let added = 0;
  for (const p of people || []) {
    const name = String(p.name || '').trim().replace(/\s+/g, ' ');
    if (!validName(name, company?.name)) continue;
    const norm = normName(name);
    if (suppressed.has(suppressedKey(companyId, norm))) continue;
    const role = tidyRole(p.role) || null;
    const ex = q.get('SELECT * FROM contacts WHERE company_id = ? AND norm_name = ?', companyId, norm);
    if (ex) {
      if (role && (!ex.role || role.length > ex.role.length)) q.run('UPDATE contacts SET role = ?, updated_at = ? WHERE id = ?', role, nowIso(), ex.id);
      if (p.linkedin && !ex.linkedin) q.run('UPDATE contacts SET linkedin = ? WHERE id = ?', p.linkedin, ex.id);
      continue;
    }
    q.run(`INSERT INTO contacts(company_id, name, norm_name, role, linkedin, source, source_url, evidence, confidence) VALUES(?,?,?,?,?,?,?,?,?)`,
      companyId, name, norm, role, p.linkedin || null, source, url || null, clip(p.evidence || '', 240) || null, p.confidence ?? confidence);
    added++;
  }
  return added;
}

export function contactsOf(companyId) {
  return q.all('SELECT * FROM contacts WHERE company_id = ? ORDER BY do_not_contact, confidence DESC, id', companyId);
}

// Who to reach out to, given team size and sector.
export function targetPlan(company, contacts = contactsOf(company.id)) {
  const cfg = getConfig().contacts;
  // No stated headcount: a big named leadership (CFO, VPs...) is better evidence than the funding stage.
  const leaders = contacts.filter((c) => c.role && !c.do_not_contact);
  const layered = leaders.length >= 5 || leaders.some((c) => /\b(cfo|chief financial|vice president|\bvp\b|head of finance)\b/i.test(c.role));
  const leadershipEstimate = layered ? { min: 51, max: 200, exact: false, source: 'leadership', evidence: `${leaders.length} named leaders${leaders.some((c) => /cfo|chief financial|finance/i.test(c.role)) ? ', including finance leadership' : ''}` } : null;
  const team = J(company.team, null) || leadershipEstimate || stageEstimate(company.id);
  const band = bandOf(team);
  const n = band?.n ?? null;
  const tech = ['SaaS', 'AI', 'IT Services', 'Gaming'].includes(company.sector);
  const ownerLed = ['Exporter', 'Manufacturing'].includes(company.sector);
  let roles, reason;
  if (company.size === 'enterprise' || (n != null && n > cfg.midTeamMax)) {
    roles = ['cfo', 'finance', 'payments'];
    reason = 'Large organisation: the CFO or treasury team owns banking and payment partners.';
  } else if (ownerLed && (n == null || n > cfg.smallTeamMax)) {
    roles = ['md', 'founder', 'ceo', 'cfo', 'director'];
    reason = 'Owner-led exporter: the managing director or promoter decides on collections.';
  } else if (n == null || n <= cfg.smallTeamMax) {
    roles = tech ? ['founder', 'ceo', 'cto'] : ['founder', 'ceo', 'coo'];
    reason = `${n == null ? 'Likely a small team' : `Small team (~${band.label})`}: go straight to the founder${tech ? ' or CTO (they own the billing stack)' : ''}.`;
  } else {
    roles = ['cfo', 'finance', 'payments', 'coo', 'founder'];
    if (['D2C', 'Marketplace'].includes(company.sector)) roles.splice(2, 0, 'ecommerce');
    reason = `Mid-size team (~${band.label}): finance or payments owns the decision; founder as backup.`;
  }
  const usable = contacts.filter((c) => !c.do_not_contact);
  let primary = null;
  for (const r of roles) {
    primary = usable.find((c) => c.role && BUCKETS[r].test(c.role));
    if (primary) break;
  }
  return {
    team: team ? { ...team, label: band.label, n: band.n } : null,
    roles: roles.map((r) => BUCKET_LABEL[r]),
    reason,
    primaryId: primary?.id ?? null,
  };
}

// ---------- research: article + about/team pages + job boards ----------
function pageText(html) {
  // Space out adjacent elements so "<h3>Varun Chandran</h3><p>Co-Founder</p>" does not read as "Varun ChandranCo-Founder".
  const $ = cheerio.load(html.replace(/>\s*</g, '> <'));
  $('script:not([type="application/ld+json"]),style,noscript,svg,nav,footer,header,form,iframe').remove();
  const paras = $('article p, main p').map((_, el) => $(el).text()).get();
  const text = (paras.join(' ').length > 400 ? paras.join(' ') : $('body').text()).replace(/\s+/g, ' ').trim();
  return text;
}

function jsonLd(html) {
  const $ = cheerio.load(html);
  const people = [];
  let team = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    const nodes = [].concat(data?.['@graph'] || data || []);
    for (const n of nodes) {
      for (const f of [].concat(n?.founder || n?.founders || [])) if (f?.name) people.push({ name: f.name, role: 'Founder', evidence: 'Listed as founder in site metadata' });
      const e = n?.numberOfEmployees;
      const v = Number(e?.value ?? e);
      if (Number.isFinite(v) && v > 0) team = { min: v, max: v, exact: true, evidence: 'numberOfEmployees in site metadata' };
      else if (e?.minValue) team = { min: Number(e.minValue), max: Number(e.maxValue || e.minValue * 2), exact: false, evidence: 'Employee range in site metadata' };
    }
  });
  return { people, team };
}

function aboutLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  const host = domainOf(baseUrl);
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const label = $(el).text().trim();
    if (!/about|team|leadership|founders?|people|our-story|who-we-are|company/i.test(`${href} ${label}`)) return;
    try {
      const u = new URL(href, baseUrl);
      if (domainOf(u.href) === host && !/\.(pdf|jpg|png)$/i.test(u.pathname) && u.pathname.length > 1) links.add(u.origin + u.pathname);
    } catch {}
  });
  const ranked = [...links].sort((a, b) => (/team|leadership|founder|people/i.test(b) ? 1 : 0) - (/team|leadership|founder|people/i.test(a) ? 1 : 0));
  return ranked.length ? ranked.slice(0, 2) : ['/about', '/about-us'].map((p) => new URL(p, baseUrl).href);
}

async function tryHtml(url) {
  try {
    const { text, finalUrl } = await fetchText(url, { timeoutMs: 9000, maxBytes: 2_500_000, accept: 'text/html' });
    return { html: text, url: finalUrl };
  } catch {
    return null;
  }
}

// Public job-board APIs (Greenhouse, Lever, Ashby): open roles = hiring momentum.
async function openRoles(html, baseUrl) {
  const atsIn = (s) => {
    const m = s.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]+)|jobs\.lever\.co\/([a-z0-9_-]+)|jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/i);
    return !m ? null : m[1] ? ['greenhouse', m[1]] : m[2] ? ['lever', m[2]] : ['ashby', m[3]];
  };
  let ats = atsIn(html);
  if (!ats) {
    const $ = cheerio.load(html);
    const careers = $('a[href]').map((_, el) => $(el).attr('href')).get().find((h) => /careers|jobs|join-us|work-with-us/i.test(h || ''));
    if (!careers) return null;
    let cu;
    try { cu = new URL(careers, baseUrl).href; } catch { return null; }
    ats = atsIn(cu);
    if (!ats) {
      const page = await tryHtml(cu);
      if (!page) return null;
      ats = atsIn(page.html);
      if (!ats) return { count: null, ats: null, url: cu, titles: [] };
    }
  }
  const [kind, slug] = ats;
  try {
    let titles = [];
    if (kind === 'greenhouse') titles = ((await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`)).jobs || []).map((j) => j.title);
    if (kind === 'lever') titles = (await fetchJson(`https://api.lever.co/v0/postings/${slug}?mode=json`) || []).map((j) => j.text);
    if (kind === 'ashby') titles = ((await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`)).jobs || []).map((j) => j.title);
    return { count: titles.length, ats: kind, url: kind === 'greenhouse' ? `https://boards.greenhouse.io/${slug}` : kind === 'lever' ? `https://jobs.lever.co/${slug}` : `https://jobs.ashbyhq.com/${slug}`, titles: titles.slice(0, 12) };
  } catch {
    return null;
  }
}

const PEOPLE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    people: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { name: { type: 'STRING' }, role: { type: 'STRING' }, evidence: { type: 'STRING' }, source: { type: 'INTEGER' } },
        required: ['name', 'role', 'evidence', 'source'],
      },
    },
    team_size: { type: 'OBJECT', nullable: true, properties: { min: { type: 'INTEGER' }, max: { type: 'INTEGER' }, evidence: { type: 'STRING' }, source: { type: 'INTEGER' } }, required: ['min', 'max', 'evidence', 'source'] },
  },
  required: ['people'],
};

async function llmPeople(companyName, docs) {
  const body = docs.map((d, i) => `### source ${i} (${d.kind}: ${d.url})\n${clip(d.text, 5000)}`).join('\n\n');
  return llm.json(
    `You extract the leadership team of one specific company from news articles and its own website, for B2B outreach by a payments company.
Rules: only people who currently work at "${companyName}" (founders, co-founders, CXOs, managing directors, heads of finance/payments/engineering/growth).
Never include investors, board members of other firms, journalists, customers, government officials, or people who only founded a different company.
"evidence" must be a short verbatim quote (max 25 words) from the source that shows the person and role. "source" is the source index.
team_size: only if a source states the headcount or a range (e.g. "a 40-member team", "11-50 employees"); otherwise null. Never guess.`,
    `Company: ${companyName}\n\n${body}`,
    PEOPLE_SCHEMA,
    { temperature: 0.1, maxTokens: 1500 },
  );
}

// Called from enrichment. siteHtml/siteUrl come from the homepage fetch already done there.
export async function researchPeople(companyId, { siteHtml, siteUrl } = {}) {
  const c = q.get('SELECT * FROM companies WHERE id = ?', companyId);
  if (!c) return null;
  const docs = [];
  const result = { contactsAdded: 0, team: null, openRoles: null };

  // 1. Full text of the most recent funding/expansion article (Google News links are JS redirects, so skip those).
  const evs = q.all(`SELECT * FROM events WHERE company_id = ? AND type IN ('funding','expansion','launch','export','partnership') ORDER BY occurred_at DESC LIMIT 3`, companyId);
  const urls = [...new Set(evs.flatMap((e) => [e.url, ...J(e.extra_urls, [])]))].filter((u) => u && !/news\.google\.com|reddit\.com|ycombinator\.com/.test(u));
  for (const u of urls.slice(0, 3)) {
    const page = await tryHtml(u);
    if (!page) continue;
    const text = pageText(page.html);
    if (text.length > 300 && text.toLowerCase().includes(c.name.toLowerCase().split(' ')[0])) { docs.push({ kind: 'article', url: page.url, text }); break; }
  }

  // 2. About / team pages + structured metadata on the company site.
  let ld = { people: [], team: null };
  if (siteHtml && siteUrl) {
    ld = jsonLd(siteHtml);
    for (const u of aboutLinks(siteHtml, siteUrl)) {
      const page = await tryHtml(u);
      if (!page) continue;
      const more = jsonLd(page.html);
      ld.people.push(...more.people);
      ld.team ||= more.team;
      const text = pageText(page.html);
      if (text.length > 200) docs.push({ kind: 'website', url: page.url, text });
      if (docs.filter((d) => d.kind === 'website').length >= 2) break;
    }
    result.openRoles = await openRoles(siteHtml, siteUrl).catch(() => null);
  }

  // 3. Extract people + headcount: Gemini when available, rules otherwise.
  let viaLlm = false;
  if (docs.length && llm.available()) {
    try {
      const out = await llmPeople(c.name, docs);
      for (const p of out.people || []) {
        const d = docs[p.source] || docs[0];
        result.contactsAdded += saveContacts(companyId, [p], { source: d.kind, url: d.url, confidence: 0.8 });
      }
      if (out.team_size?.min) {
        const d = docs[out.team_size.source] || docs[0];
        result.team = { min: out.team_size.min, max: Math.max(out.team_size.min, out.team_size.max || out.team_size.min), exact: out.team_size.min === out.team_size.max, source: d.kind, url: d.url, evidence: out.team_size.evidence };
      }
      viaLlm = true;
    } catch { /* rules below */ }
  }
  if (!viaLlm) {
    for (const d of docs) {
      result.contactsAdded += saveContacts(companyId, peopleFromText(d.text, c.name), { source: d.kind, url: d.url, confidence: d.kind === 'website' ? 0.7 : 0.6 });
      if (!result.team) {
        const t = teamFromText(d.text);
        if (t) result.team = { ...t, source: d.kind, url: d.url };
      }
    }
  }
  if (ld.people.length) result.contactsAdded += saveContacts(companyId, ld.people, { source: 'website', url: siteUrl, confidence: 0.8 });
  if (!result.team && ld.team) result.team = { ...ld.team, source: 'website', url: siteUrl };
  if (result.team) saveTeam(companyId, result.team);

  // Hiring abroad is a strong expansion signal: record it as an event once a month.
  const intlRoles = (result.openRoles?.titles || []).filter((t) => /international|global|\b(us|usa|uk|uae|emea|apac|europe|dubai|singapore|north america)\b|export|overseas/i.test(t));
  if (intlRoles.length && !q.get(`SELECT 1 FROM events WHERE company_id = ? AND type = 'hiring' AND created_at > ?`, companyId, new Date(Date.now() - 30 * 86400000).toISOString())) {
    q.run(`INSERT INTO events(company_id, source_id, type, title, summary, url, signals, confidence, occurred_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      companyId, 'website', 'hiring', `Hiring for international roles (${intlRoles.length} open)`, intlRoles.slice(0, 4).join('; '), result.openRoles.url,
      JSON.stringify(['hiring for international roles']), 0.8, nowIso());
  }

  q.run('UPDATE companies SET people_checked_at = ? WHERE id = ?', nowIso(), companyId);
  const total = q.get('SELECT COUNT(*) n FROM contacts WHERE company_id = ?', companyId).n;
  log('people', `${c.name}: ${total} people${result.contactsAdded ? ` (+${result.contactsAdded})` : ''}${result.team ? ` · team ${result.team.min}${result.team.max !== result.team.min ? `-${result.team.max}` : ''}` : ''}${result.openRoles?.count != null ? ` · ${result.openRoles.count} open roles` : ''} · ${viaLlm ? 'LLM' : 'rules'} over ${docs.length} page(s)`);
  return result;
}
