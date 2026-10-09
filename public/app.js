// PayGlocal Lead Intel: front end. Plain JS, talks to the Express API.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '#');

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, action) {
  const t = $('#toast');
  t.innerHTML = esc(msg) + (action ? ` <button>${esc(action.label)}</button>` : '');
  if (action) t.querySelector('button').onclick = () => { action.fn(); t.classList.remove('show'); };
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2600);
}

const scoreClass = (s, th = state.threshold) => (s >= th ? 'high' : s >= th - 20 ? 'mid' : 'low');
const initials = (n) => String(n).split(/\s+/).map((x) => x[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');
const avatar = (l) => `<div class="avatar">${l.logo ? `<img src="${esc(safeUrl(l.logo))}" alt="" loading="lazy" onerror="this.remove()">` : ''}${l.logo ? '' : esc(initials(l.name))}</div>`;

const state = { view: 'brief', threshold: 60, stats: null, leadsOffset: 0, config: null, pendingLeads: 0 };

// ---------- routing ----------
const VIEWS = ['brief', 'leads', 'intel', 'reddit', 'live', 'sources', 'config'];
function route() {
  const [v, id] = location.hash.slice(1).split('/');
  const view = VIEWS.includes(v) ? v : 'brief';
  state.view = view;
  for (const x of VIEWS) $(`#view-${x}`).hidden = x !== view;
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  ({ brief: loadBrief, leads: () => loadLeads(true), intel: loadIntel, reddit: loadReddit, live: loadLive, sources: loadSources, config: loadConfig })[view]();
  if (id) openLead(id);
}
window.addEventListener('hashchange', route);

// ---------- engine status ----------
async function loadStats() {
  try {
    const s = await api('/stats');
    state.stats = s;
    state.threshold = s.threshold;
    const llm = s.llm.provider === 'none' ? 'Rules engine' : `Gemini · ${s.llm.calls}/${s.llm.cap} calls`;
    const busy = s.running.length || s.queue > 0;
    $('#engine').className = `engine ${busy ? 'busy' : ''}`;
    $('#engineText').textContent = `${busy ? `Working · ${s.running.length} fetching · ${s.queue} queued` : 'Live'} · ${llm}`;
    $('#scanBtn').classList.toggle('scanning', s.running.length > 0);
    if (state.view === 'brief') renderKpis(s);
    if (state.view === 'live') renderFunnel(s);
  } catch {
    $('#engine').className = 'engine off';
    $('#engineText').textContent = 'Server offline';
  }
}

function renderKpis(s) {
  $('#kpis').innerHTML = [
    ['High intent', s.highIntent, `score ${s.threshold}+`],
    ['New today', s.newToday, 'companies discovered'],
    ['Funded (30d)', s.fundingSignals, 'fresh capital to deploy'],
    ['International', s.intlSignals, 'sell or likely sell abroad'],
    ['Signals (24h)', s.events24h, `${s.items24h} articles read`],
  ].map(([l, v, sub]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${Number(v).toLocaleString('en-IN')}</div><div class="sub">${sub}</div></div>`).join('');
  const max = Math.max(1, ...s.sectors.map((x) => x.n));
  $('#sectorBars').innerHTML = s.sectors.slice(0, 9).map((x) => `<div class="bar-row"><span class="trunc">${esc(x.sector)}</span><div class="bar"><i style="width:${(x.n / max) * 100}%"></i></div><span class="muted">${x.n} · ${x.avg ?? 0}</span></div>`).join('') || '<div class="muted small">No companies yet</div>';
}

// ---------- lead card ----------
function leadCard(l) {
  const f = l.funding;
  const fundTxt = f ? [f.type === 'directory' ? 'YC-backed' : f.stage, f.amount, f.type === 'directory' ? null : fmtDate(f.date)].filter(Boolean).join(' · ') : null;
  const where = [l.city, l.markets?.filter((m) => m !== 'Global').slice(0, 3).join(', ')].filter(Boolean).join(' → ');
  const stack = l.enrichment?.providers?.length ? `<span class="tag warn">${esc(l.enrichment.providers.join(', '))}</span>` : '';
  return `<article class="lead" data-id="${l.id}">
    <div class="lead-top">${avatar(l)}<div class="lead-main">
      <div class="name-row"><span class="name">${esc(l.name)}</span><span class="pill">${esc(l.sector || 'Other')}</span>
        ${l.badge ? `<span class="badge ${l.badge}">${l.badge}</span>` : ''}${l.explore ? '<span class="badge explore" title="Exploration slot: keeps the brief diverse">explore</span>' : ''}
        <span class="score ${scoreClass(l.score)}" title="${esc(l.breakdown.filter((b) => b.points).map((b) => `${b.label}: ${b.points > 0 ? '+' : ''}${b.points}`).join('\n'))}">${l.score}</span></div>
      <div class="meta">${esc(fundTxt || 'No funding signal')}${where ? ` · ${esc(where)}` : ''}${l.team ? ` · team ${l.team.exact ? '' : '~'}${esc(l.team.label)}` : ''}</div>
      ${l.contact ? `<div class="reach">Reach: <b>${esc(l.contact.name)}</b>${l.contact.role ? `, ${esc(l.contact.role)}` : ''}${l.contact.hasEmail ? ' · ✉ verified' : ''}</div>` : l.target ? `<div class="reach muted">Reach: ${esc(l.target.roles.slice(0, 2).join(' or '))}</div>` : ''}
      <div class="reason">${esc(l.why || '')}</div>
      <div class="tags">${l.signals.slice(0, 5).map((s) => `<span class="tag">${esc(s)}</span>`).join('')}${stack}</div>
    </div></div>
    <div class="lead-foot"><span>${esc(l.latest?.source || '')} · ${esc(l.latest?.title || '')}</span><span>${l.corroborations > 1 ? `${l.corroborations} sources · ` : ''}${ago(l.latest?.at || l.lastEventAt)}</span></div>
  </article>`;
}

function bindLeadClicks(root) {
  root.querySelectorAll('[data-id]').forEach((el) => el.addEventListener('click', (e) => {
    if (e.target.closest('a,button,select,input')) return;
    openLead(el.dataset.id);
  }));
}

// ---------- brief ----------
async function loadBrief() {
  $('#briefLeads').innerHTML = '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>';
  const [b] = await Promise.all([api('/brief'), loadStats(), loadMiniFeed()]);
  state.pendingLeads = 0;
  const first = b.checkpoint.startsWith('1970');
  $('#briefEyebrow').textContent = first ? 'First brief' : `Since ${new Date(b.checkpoint).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  $('#briefTitle').textContent = b.totalNew + b.totalUpdated ? `${b.totalNew} new companies` : "You're all caught up";
  $('#briefCount').textContent = b.leads.length ? `Showing ${b.leads.length}, ranked, with ${b.leads.filter((l) => l.explore).length} exploration picks` : '';
  $('#briefLeads').innerHTML = b.leads.length ? b.leads.map(leadCard).join('') : `<div class="empty"><strong>Nothing new since your last check.</strong>The engine keeps scanning. New funding, expansion and payment-pain signals will appear here automatically.</div>`;
  bindLeadClicks($('#briefLeads'));
  $('#briefIntel').innerHTML = (b.redditHot ? `<div class="it"><a href="#reddit">${b.redditHot} high-priority Reddit thread${b.redditHot > 1 ? 's' : ''} to answer</a><p>Indian businesses asking how to get paid from abroad (score 80+).</p></div>` : '')
    + (b.intel.length ? b.intel.slice(0, 6).map(intelMini).join('') : '<div class="muted small">No new intel since last check.</div>');
}

const intelMini = (i) => `<div class="it"><span class="cat ${i.category}">${esc(CAT_LABEL[i.category] || i.category)}</span>${i.importance >= 3 ? ' <span class="badge-act">Act now</span>' : ''}<div><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></div>${i.so_what ? `<p>${esc(i.so_what)}</p>` : ''}</div>`;

$('#ackBrief').onclick = async () => {
  await api('/brief/ack', { method: 'POST' });
  $('#undoAck').hidden = false;
  toast('Brief marked as read. Only new signals will show from now on.');
  loadBrief();
};
$('#undoAck').onclick = async () => { await api('/brief/undo', { method: 'POST' }); $('#undoAck').hidden = true; loadBrief(); };

// ---------- leads ----------
function leadParams() {
  const p = new URLSearchParams();
  const v = (id) => $(id).value;
  if (v('#fQ')) p.set('q', v('#fQ'));
  if (v('#fSector')) p.set('sector', v('#fSector'));
  if (v('#fStage')) p.set('stage', v('#fStage'));
  if (v('#fMin')) p.set('minScore', v('#fMin'));
  if (v('#fStatus')) p.set('status', v('#fStatus'));
  if (v('#fDays')) p.set('days', v('#fDays'));
  if (v('#fSort')) p.set('sort', v('#fSort'));
  if ($('#fIntl').checked) p.set('intl', '1');
  if ($('#fEnt').checked) p.set('hideEnterprise', '1');
  return p;
}

async function loadLeads(reset) {
  if (reset) state.leadsOffset = 0;
  const p = leadParams();
  $('#csvBtn').href = `/api/leads.csv?${p}`;
  p.set('limit', 50);
  p.set('offset', state.leadsOffset);
  if (reset) $('#leadTable').innerHTML = '<div class="skeleton" style="height:300px;border:0"></div>';
  const [r] = await Promise.all([api(`/leads?${p}`), state.stats ? null : loadStats()]);
  fillSectorFilter();
  $('#leadCount').textContent = `${r.total.toLocaleString('en-IN')} companies`;
  const head = '<div class="tr th"><div>Company</div><div>Score</div><div>Funding</div><div>Signal</div><div>Last signal</div><div>Status</div></div>';
  const rows = r.leads.map((l) => `<div class="tr row" data-id="${l.id}">
      <div class="cell-name">${avatar(l)}<div style="min-width:0"><b>${esc(l.name)} ${l.badge === 'new' ? '<span class="badge new">new</span>' : ''}</b><small>${esc([l.sector, l.city].filter(Boolean).join(' · '))}</small></div></div>
      <div><span class="score ${scoreClass(l.score)}" style="margin:0">${l.score}</span></div>
      <div class="trunc small">${esc(l.funding ? [l.funding.type === 'directory' ? 'YC' : l.funding.stage, l.funding.amount].filter(Boolean).join(' · ') : '-')}</div>
      <div class="trunc small muted" title="${esc(l.why)}">${esc(l.signals.slice(0, 3).join(' · ') || l.latest?.title || '')}</div>
      <div class="small muted">${ago(l.latest?.at || l.lastEventAt)}</div>
      <div class="small">${esc(l.status)}</div>
    </div>`).join('');
  if (reset) $('#leadTable').innerHTML = r.leads.length ? head + rows : '<div class="empty" style="border:0"><strong>No companies match these filters.</strong>Try widening the score or date range.</div>';
  else $('#leadTable').insertAdjacentHTML('beforeend', rows);
  bindLeadClicks($('#leadTable'));
  state.leadsOffset += r.leads.length;
  $('#moreBtn').hidden = state.leadsOffset >= r.total;
}
$('#moreBtn').onclick = () => loadLeads(false);
let fTimer;
for (const id of ['#fQ', '#fSector', '#fStage', '#fMin', '#fStatus', '#fDays', '#fSort', '#fIntl', '#fEnt']) {
  $(id).addEventListener(id === '#fQ' ? 'input' : 'change', () => { clearTimeout(fTimer); fTimer = setTimeout(() => loadLeads(true), 250); });
}

function fillSectorFilter() {
  const sel = $('#fSector');
  if (sel.options.length > 1 || !state.stats) return;
  for (const s of state.stats.sectors) sel.insertAdjacentHTML('beforeend', `<option value="${esc(s.sector)}">${esc(s.sector)} (${s.n})</option>`);
}

// ---------- lead drawer ----------
async function openLead(id) {
  $('#drawerWrap').classList.add('open');
  $('#drawer').innerHTML = '<div class="d-body"><div class="skeleton"></div><div class="skeleton"></div></div>';
  const l = await api(`/leads/${id}`);
  renderDrawer(l);
}

function renderDrawer(l) {
  const pos = l.breakdown.filter((b) => b.max > 0);
  const neg = l.breakdown.filter((b) => b.points < 0);
  const e = l.enrichment;
  $('#drawer').innerHTML = `
  <div class="d-head">
    <div class="d-title">${avatar(l)}<div style="min-width:0"><h2>${esc(l.name)}</h2>
      <div class="muted small">${esc([l.sector, l.city, l.size !== 'unknown' ? l.size : null].filter(Boolean).join(' · '))}${l.website ? ` · <a href="${esc(safeUrl(l.website))}" target="_blank" rel="noopener">${esc(l.domain || 'website')}</a>` : ''}${e?.social?.linkedin ? ` · <a href="${esc(safeUrl(e.social.linkedin))}" target="_blank" rel="noopener">LinkedIn</a>` : ''}</div></div>
      <div class="bigscore ${scoreClass(l.score)}"><b>${l.score}</b><span>score</span></div></div>
    <div class="d-actions">
      <select class="input" id="dStatus">${['new', 'reviewed', 'contacted', 'qualified', 'dismissed'].map((s) => `<option ${s === l.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="fb up ${l.feedback === 1 ? 'on' : ''}" data-fb="1" title="Good lead: teach the engine">👍</button>
      <button class="fb down ${l.feedback === -1 ? 'on' : ''}" data-fb="-1" title="Not relevant: teach the engine">👎</button>
      <span class="spacer"></span>
      <button class="btn small" id="dEnrich">${l.enrichedAt ? 'Re-research' : 'Research now'}</button>
      <button class="btn small" id="dLike" title="Spawn agent queries for similar companies">Find lookalikes</button>
      <button class="btn small ghost" id="dClose">Close</button>
    </div>
  </div>
  <div class="d-body">
    <div class="panel"><div class="panel-head"><h3>Why this company</h3></div><div>${esc(l.why || '')}</div>
      ${l.signals.length ? `<div class="tags" style="margin-top:10px">${l.signals.map((s) => `<span class="tag">${esc(s)}</span>`).join('')}</div>` : ''}</div>
    ${l.pitch ? `<div class="panel"><div class="panel-head"><h3>Outreach angle</h3></div><div class="pitch"><button class="btn small" id="dCopy">Copy</button><div style="padding-right:60px">${esc(l.pitch)}</div></div></div>` : ''}
    ${peoplePanel(l)}
    <div class="panel"><div class="panel-head"><h3>Score breakdown</h3><span class="muted small">weights editable in Config</span></div>
      ${pos.map((b) => `<div class="bd-row"><span>${esc(b.label)}</span><div class="bar"><i style="width:${b.max ? (b.points / b.max) * 100 : 0}%"></i></div><span class="muted">${b.points}/${b.max}</span><small>${esc(b.detail)}</small></div>`).join('')}
      ${neg.map((b) => `<div class="bd-row neg"><span>${esc(b.label)}</span><div class="bar"><i style="width:100%"></i></div><span class="muted">${b.points}</span><small>${esc(b.detail)}</small></div>`).join('')}
    </div>
    <div class="panel"><div class="panel-head"><h3>Company facts</h3>${l.enrichedAt ? `<span class="muted small">site checked ${ago(l.enrichedAt)}</span>` : ''}</div>
      <div class="facts">
        <div><span>Funding</span>${esc(l.funding ? [l.funding.stage, l.funding.amount, fmtDate(l.funding.date)].filter(Boolean).join(' · ') : 'None seen')}</div>
        <div><span>Investors</span>${esc(l.funding?.investors?.join(', ') || '-')}</div>
        <div><span>Sells internationally</span>${esc(l.sellsIntl)}</div>
        <div><span>Markets</span>${esc(l.markets.join(', ') || '-')}</div>
        <div><span>Checkout / platform</span>${esc(e ? ([e.platform, ...(e.providers || [])].filter(Boolean).join(', ') || (e.found ? 'None detected' : 'Website not found')) : 'Not researched yet')}</div>
        <div><span>Currencies on site</span>${esc(e?.currencies?.join(', ') || '-')}${e?.shipsIntl ? ' · ships internationally' : ''}${e?.switcher ? ' · currency switcher' : ''}</div>
        ${e?.emails?.length ? `<div><span>Business inbox</span>${esc(e.emails.join(', '))}</div>` : ''}
        <div><span>Description</span>${esc(l.description || '-')}</div>
      </div></div>
    <div class="panel"><div class="panel-head"><h3>Signal timeline</h3><span class="muted small">${l.events.length} events · ${l.corroborations} source mentions</span></div>
      <div class="timeline">${l.events.map((ev) => `<div class="tl ${ev.type}"><div class="when">${esc(ev.type)} · ${fmtDate(ev.occurredAt)} · ${esc(ev.source || '')}${ev.corroborations > 1 ? ` · confirmed by ${ev.corroborations} sources` : ''}</div>
        <a href="${esc(safeUrl(ev.url))}" target="_blank" rel="noopener">${esc(ev.title)}</a>
        ${ev.summary ? `<p>${esc(ev.summary)}</p>` : ''}
        ${[ev.stage, ev.amount, ev.investors.length ? `led/backed by ${ev.investors.join(', ')}` : null].filter(Boolean).length ? `<p class="small">${esc([ev.stage, ev.amount, ev.investors.length ? `led/backed by ${ev.investors.join(', ')}` : null].filter(Boolean).join(' · '))}</p>` : ''}
        ${ev.extraUrls.length ? `<p class="small">${ev.extraUrls.slice(0, 4).map((u, i) => `<a class="link" href="${esc(safeUrl(u))}" target="_blank" rel="noopener">source ${i + 2}</a>`).join(' · ')}</p>` : ''}
      </div>`).join('')}</div></div>
    <div class="panel"><div class="panel-head"><h3>Notes</h3><span class="muted small" id="noteState"></span></div><textarea class="input" id="dNotes" rows="4" placeholder="Context, contacts, next steps…">${esc(l.notes)}</textarea></div>
  </div>`;

  const patch = async (body, msg) => { await api(`/leads/${l.id}`, { method: 'PATCH', body }); if (msg) toast(msg); const fresh = await api(`/leads/${l.id}`); renderDrawer(fresh); };
  $('#dClose').onclick = closeDrawer;
  $('#dStatus').onchange = (ev) => patch({ status: ev.target.value }, `Marked ${ev.target.value}`);
  $$('.fb', $('#drawer')).forEach((b) => (b.onclick = () => {
    const v = Number(b.dataset.fb);
    patch({ feedback: l.feedback === v ? 0 : v }, v > 0 ? 'Noted. The engine will favour leads like this.' : 'Noted. Dismissed and the engine will down-weight similar leads.');
  }));
  $('#dNotes').onblur = async (ev) => { if (ev.target.value !== l.notes) { await api(`/leads/${l.id}`, { method: 'PATCH', body: { notes: ev.target.value } }); $('#noteState').textContent = 'Saved'; l.notes = ev.target.value; } };
  $('#dEnrich').onclick = async (ev) => { ev.target.disabled = true; ev.target.textContent = 'Researching…'; try { await api(`/leads/${l.id}/enrich`, { method: 'POST' }); renderDrawer(await api(`/leads/${l.id}`)); toast('Research complete'); } catch (err) { toast(err.message); ev.target.disabled = false; } };
  $('#dLike').onclick = async () => { const r = await api(`/leads/${l.id}/lookalike`, { method: 'POST' }); toast(r.sources.length ? `Agent launched ${r.sources.length} lookalike searches. New leads will stream in.` : 'Lookalike searches already running for this profile.'); };
  if ($('#dCopy')) $('#dCopy').onclick = () => { navigator.clipboard.writeText(l.pitch); toast('Copied'); };
  bindPeople(l);
}

// ---------- decision makers ----------
const liSearch = (q) => `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(q)}`;
const gSearch = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`;
const SRC_LABEL = { news: 'news', article: 'article', website: 'company site', yc: 'Y Combinator', apollo: 'Apollo', manual: 'added manually' };
const TEAM_SRC = { yc: 'Y Combinator', apollo: 'Apollo', website: 'company site', article: 'article', news: 'news', stage: 'estimated from funding stage', leadership: 'estimated from leadership size', manual: 'manual' };

function peoplePanel(l) {
  const prov = l.emailProviders;
  const canFind = prov?.configured?.length > 0;
  const people = l.contacts || [];
  const teamTxt = l.team ? `Team ${l.team.exact ? '' : '~'}${esc(l.team.label)} · ${esc(TEAM_SRC[l.team.source] || l.team.source)}` : 'Team size unknown';
  const person = (p) => {
    const emailBit = p.email
      ? `<a href="mailto:${esc(p.email)}">${esc(p.email)}</a> <span class="estatus ${esc(p.emailStatus)}">${esc(p.emailStatus === 'risky' ? 'accept-all, risky' : p.emailStatus)}</span>`
      : p.dnc ? '' : canFind ? `<button class="btn small" data-find="${p.id}">${p.emailCheckedAt ? 'Retry email lookup' : 'Find verified email'}</button>${p.emailCheckedAt ? ` <span class="muted small">none verified ${ago(p.emailCheckedAt)}</span>` : ''}` : '';
    return `<div class="person ${p.dnc ? 'dnc' : ''}">
      <div class="avatar sm">${esc(initials(p.name))}</div>
      <div class="person-main">
        <div><b>${esc(p.name)}</b>${p.primary ? ' <span class="badge new">best fit</span>' : ''}${p.dnc ? ' <span class="badge dnc-b">do not contact</span>' : ''}</div>
        <div class="muted small">${esc(p.role || 'Role unknown')} · <a class="link" href="${esc(safeUrl(p.sourceUrl))}" target="_blank" rel="noopener" title="${esc(p.evidence || '')}">from ${esc(SRC_LABEL[p.source] || p.source)}</a></div>
        <div class="person-links small">${emailBit}
          <a class="link" href="${esc(p.linkedin ? safeUrl(p.linkedin) : liSearch(`${p.name} ${l.name}`))}" target="_blank" rel="noopener">${p.linkedin ? 'LinkedIn profile' : 'Find on LinkedIn'}</a>
          <a class="link" href="${esc(gSearch(`"${p.name}" "${l.name}"`))}" target="_blank" rel="noopener">Google</a></div>
      </div>
      <div class="person-actions">
        <button class="btn small ghost" data-dnc="${p.id}" data-on="${p.dnc ? 1 : 0}" title="Never suggest or look up this person">${p.dnc ? 'Allow contact' : 'Do not contact'}</button>
        <button class="btn small ghost danger" data-del-contact="${p.id}" title="Delete and never re-add from research">✕</button>
      </div></div>`;
  };
  const roleLinks = l.target.roles.slice(0, 3).map((r) => `<a class="chip-link" href="${esc(liSearch(`${r} ${l.name}`))}" target="_blank" rel="noopener">${esc(r)} at ${esc(l.name)} ↗</a>`).join('');
  const jobs = l.openRoles;
  return `<div class="panel"><div class="panel-head"><h3>Decision makers</h3><span class="muted small" title="${esc(l.team?.evidence || '')}">${teamTxt}</span></div>
    <div class="target"><b>Reach out to:</b> ${esc(l.target.roles.join(' → '))}<div class="muted small">${esc(l.target.reason)}</div></div>
    ${people.length ? people.map(person).join('') : `<div class="muted small" style="margin:10px 0">No named people yet. ${l.enrichedAt ? 'Research found none on the article or site.' : 'Run "Research now" to read the article and the About/Team pages.'}</div>`}
    <div class="role-links"><span class="muted small">Search LinkedIn:</span> ${roleLinks}</div>
    ${l.inboxes?.length ? `<div class="small" style="margin-top:8px"><span class="muted">Company inboxes:</span> ${l.inboxes.map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join(', ')}</div>` : ''}
    ${jobs?.count != null ? `<div class="small" style="margin-top:6px"><span class="muted">Hiring:</span> <a class="link" href="${esc(safeUrl(jobs.url))}" target="_blank" rel="noopener">${jobs.count} open roles${jobs.ats ? ` on ${esc(jobs.ats)}` : ''}</a>${jobs.titles?.length ? ` <span class="muted">(${esc(jobs.titles.slice(0, 3).join(', '))}${jobs.titles.length > 3 ? '…' : ''})</span>` : ''}</div>` : ''}
    <details class="add-person"><summary class="small link">Add a person</summary>
      <form id="addPerson" class="add-grid" style="margin-top:8px"><input class="input" name="name" placeholder="Full name" required><input class="input" name="role" placeholder="Role (e.g. CFO)"><input class="input" name="email" type="email" placeholder="Work email (optional)"><button class="btn small primary">Add</button></form>
    </details>
    <div class="muted small" style="margin-top:10px">${canFind ? `Verified email lookups: ${esc(prov.configured.map((p) => p.label).join(', '))} · ${prov.used}/${prov.cap} this month.` : 'Verified email lookup is off: add APOLLO_API_KEY or HUNTER_API_KEY to enable it.'} Each person shows where they were found; removing someone keeps them out of future research.</div>
  </div>`;
}

function bindPeople(l) {
  const refresh = async () => renderDrawer(await api(`/leads/${l.id}`));
  $$('[data-find]', $('#drawer')).forEach((b) => (b.onclick = async () => {
    b.disabled = true; b.textContent = 'Looking up…';
    try { const r = await api(`/contacts/${b.dataset.find}/find-email`, { method: 'POST' }); toast(r.found ? `Found a ${r.status} email via ${r.provider}` : r.note || `No verified email at ${r.provider}`); }
    catch (e) { toast(e.message); }
    refresh();
  }));
  $$('[data-dnc]', $('#drawer')).forEach((b) => (b.onclick = async () => { await api(`/contacts/${b.dataset.dnc}`, { method: 'PATCH', body: { dnc: b.dataset.on !== '1' } }); refresh(); }));
  $$('[data-del-contact]', $('#drawer')).forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this person? They will not be re-added by future research.')) return;
    await api(`/contacts/${b.dataset.delContact}`, { method: 'DELETE' }); toast('Removed'); refresh();
  }));
  const f = $('#addPerson');
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try { await api(`/leads/${l.id}/contacts`, { method: 'POST', body: d }); toast('Added'); refresh(); } catch (err) { toast(err.message); }
  };
}

function closeDrawer() {
  $('#drawerWrap').classList.remove('open');
  if (location.hash.includes('/')) history.replaceState(null, '', `#${state.view}`);
  if (state.view === 'leads') loadLeads(true);
}
$('#drawerWrap').addEventListener('click', (e) => { if (e.target.id === 'drawerWrap') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------- intel ----------
const CAT_LABEL = { regulatory: 'Regulatory', competitor: 'Competitor', market: 'Market', payglocal: 'PayGlocal' };
const TOPIC_LABEL = {
  'policy-statement': 'RBI policy', 'pa-rules': 'PA / PA-CB rules', 'export-realisation': 'FEMA & export realisation', 'freelancer-inflows': 'Freelancer inflows',
  remittance: 'Remittances', 'kyc-data': 'KYC, AML & data', 'export-incentives': 'Export incentives', 'trade-corridor': 'Trade corridors', 'upi-global': 'UPI abroad',
  cards: 'Card acceptance', 'gift-city': 'GIFT City', 'export-data': 'Export data', 'xb-payments': 'Cross-border rails', competitor: 'Competitor moves', payglocal: 'PayGlocal coverage',
};
const intelState = { items: [], cat: '', topic: '', q: '', range: '30', act: false };
const whenOf = (i) => i.published_at || i.created_at;
const topicOf = (i) => i.meta?.topic || (i.category === 'competitor' ? 'competitor' : i.category === 'payglocal' ? 'payglocal' : null);

// Buckets read better than one header per day when items are spread over weeks.
function dayBucket(iso) {
  const d = new Date(iso), now = new Date();
  const days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'Earlier this week' : days < 30 ? 'Earlier this month' : 'Older';
}

async function loadIntel() {
  const r = await api('/intel');
  intelState.items = r.items;
  const latest = r.items[0];
  $('#intelMeta').textContent = latest ? `Latest item ${ago(whenOf(latest))}` : '';
  renderIntel();
}

function renderIntel() {
  const f = intelState;
  const q = f.q.trim().toLowerCase();
  const cutoff = f.range ? Date.now() - Number(f.range) * 86400000 : 0;
  const inRange = f.items.filter((i) => new Date(whenOf(i)).getTime() >= cutoff && (!f.act || i.importance >= 3) && (!q || `${i.title} ${i.so_what}`.toLowerCase().includes(q)));
  const count = (cat) => inRange.filter((i) => !cat || i.category === cat).length;
  $('#intelSeg').innerHTML = [['', 'All'], ['regulatory', 'Regulatory'], ['competitor', 'Competitors'], ['market', 'Market'], ['payglocal', 'PayGlocal']]
    .map(([k, l]) => `<button role="tab" aria-selected="${f.cat === k}" class="${f.cat === k ? 'on' : ''}" data-k="${k}">${l}<span class="n">${count(k)}</span></button>`).join('');
  $$('#intelSeg button').forEach((b) => (b.onclick = () => { f.cat = b.dataset.k; f.topic = ''; renderIntel(); }));

  const inCat = inRange.filter((i) => !f.cat || i.category === f.cat);
  const topics = Object.entries(inCat.reduce((m, i) => { const t = topicOf(i); if (t) m[t] = (m[t] || 0) + 1; return m; }, {})).sort((a, b) => b[1] - a[1]);
  $('#intelTopics').innerHTML = topics.length
    ? topics.map(([t, n]) => `<button class="topic ${f.topic === t ? 'on' : ''}" data-t="${esc(t)}"><span>${esc(TOPIC_LABEL[t] || t)}</span><span class="n">${n}</span></button>`).join('')
      + (f.topic ? '<button class="topic clear" data-t="">Clear topic</button>' : '')
    : '<div class="muted small">No topics in this range.</div>';
  $$('#intelTopics .topic').forEach((b) => (b.onclick = () => { f.topic = f.topic === b.dataset.t ? '' : b.dataset.t; renderIntel(); }));

  const items = inCat.filter((i) => !f.topic || topicOf(i) === f.topic);
  if (!items.length) {
    $('#intelList').innerHTML = `<div class="empty"><strong>${f.items.length ? 'Nothing matches these filters.' : 'Nothing relevant yet.'}</strong>${f.items.length ? 'Try a longer time range or clear the topic.' : 'RBI, competitor and market feeds are scanned on a schedule; only items with a clear PayGlocal angle land here.'}</div>`;
    return;
  }
  const groups = [];
  for (const i of items) {
    const b = dayBucket(whenOf(i));
    if (groups.at(-1)?.label !== b) groups.push({ label: b, items: [] });
    groups.at(-1).items.push(i);
  }
  $('#intelList').innerHTML = groups.map((g) => `<section class="day"><h2 class="day-label">${g.label}<span>${g.items.length}</span></h2><div class="feed-card">${g.items.map(intelRow).join('')}</div></section>`).join('');
}

function intelRow(i) {
  const t = topicOf(i);
  const meta = [t && TOPIC_LABEL[t], i.source_id?.startsWith('rbi') ? 'RBI' : null, ago(whenOf(i)), i.coverage > 1 ? `${i.coverage} outlets` : null].filter(Boolean);
  return `<article class="fi">
    <span class="fi-cat ${i.category}">${esc(CAT_LABEL[i.category] || i.category)}</span>
    <div class="fi-body">
      <a class="fi-title" href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a>
      ${i.so_what ? `<p class="fi-so">${esc(i.so_what)}</p>` : ''}
      <div class="fi-meta">${meta.map(esc).join('<i>·</i>')}</div>
    </div>
    <div class="fi-side">${i.importance >= 3 ? '<span class="badge-act">Act now</span>' : ''}</div>
  </article>`;
}

$('#intelQ').addEventListener('input', (e) => { intelState.q = e.target.value; renderIntel(); });
$('#intelRange').addEventListener('change', (e) => { intelState.range = e.target.value; renderIntel(); });
$('#intelAct').addEventListener('change', (e) => { intelState.act = e.target.checked; renderIntel(); });

// ---------- reddit ----------
// Triage inbox: list on the left, the selected thread on the right. Filters run client-side so they are instant.
const rd = { mode: 'inbox', items: [], status: 'open', band: '', segment: '', intent: '', q: '', sel: null, meta: null };
const RD_STATUS = [['open', 'Open'], ['lead', 'Sales leads'], ['replied', 'Replied'], ['ignored', 'Ignored']];
const RD_ACTIONS = [['replied', 'Mark replied', 'R'], ['lead', 'Sales lead', 'L'], ['ignored', 'Ignore', 'I']];
const rdStatusOf = (i) => (i.status === 'new' ? 'open' : i.status);
const BAND_RANK = { high: 0, research: 1, monitor: 2 };
const PROVIDER = { paypal: 'PayPal', payoneer: 'Payoneer', wise: 'Wise', stripe: 'Stripe', skydo: 'Skydo', xflow: 'Xflow', razorpay: 'Razorpay', cashfree: 'Cashfree', payu: 'PayU', 'dodo payments': 'Dodo Payments', paddle: 'Paddle', 'lemon squeezy': 'Lemon Squeezy', airwallex: 'Airwallex', whop: 'Whop', ccavenue: 'CCAvenue' };
const providerName = (p) => PROVIDER[p] || p.replace(/\b\w/g, (c) => c.toUpperCase());
const sourceLabel = (sub) => (sub ? `r/${sub}` : 'Keyword search');
const capFirst = (x) => String(x || '').replace(/^\w/, (c) => c.toUpperCase());

async function loadReddit() {
  $$('#rdMode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === rd.mode));
  $('#rdInbox').hidden = rd.mode !== 'inbox';
  $('#rdInsights').hidden = rd.mode !== 'insights';
  if (rd.mode === 'insights') return loadRedditInsights();
  const r = await api('/reddit?status=all');
  // Triage order: high priority first, then newest within each band.
  rd.items = r.items.sort((a, b) => (BAND_RANK[a.band?.id] ?? 3) - (BAND_RANK[b.band?.id] ?? 3) || new Date(whenOf(b)) - new Date(whenOf(a)));
  rd.meta = r;
  renderRedditFilters();
  renderReddit();
}

function rdFiltered(ignore) {
  const q = rd.q.trim().toLowerCase();
  return rd.items.filter((i) => (ignore === 'status' || rdStatusOf(i) === rd.status)
    && (ignore === 'band' || !rd.band || i.band?.id === rd.band)
    && (ignore === 'segment' || !rd.segment || i.meta.segment === rd.segment)
    && (ignore === 'intent' || !rd.intent || (i.meta.intents || []).includes(rd.intent))
    && (!q || `${i.title} ${i.summary || ''} ${i.meta.sub || ''}`.toLowerCase().includes(q)));
}

function renderRedditFilters() {
  const m = rd.meta;
  const n = (key, pred) => rdFiltered(key).filter(pred).length;
  $('#rdStatus').innerHTML = RD_STATUS.map(([k, l]) => `<button role="tab" aria-selected="${rd.status === k}" class="${rd.status === k ? 'on' : ''}" data-k="${k}">${l}<span class="n">${n('status', (i) => rdStatusOf(i) === k)}</span></button>`).join('');
  $$('#rdStatus button').forEach((b) => (b.onclick = () => { rd.status = b.dataset.k; rd.sel = null; renderRedditFilters(); renderReddit(); }));
  const opts = (key, all, list, pred) => `<option value="">${all}</option>` + list.map((x) => `<option value="${esc(x.id)}" ${rd[key] === x.id ? 'selected' : ''}>${esc(x.label)} (${n(key, (i) => pred(i, x.id))})</option>`).join('');
  $('#rdBand').innerHTML = opts('band', 'Any priority', m.bands.map((b) => ({ id: b.id, label: `${b.label} ${b.min ? `${b.min}+` : 'under 50'}` })), (i, id) => i.band?.id === id);
  $('#rdSegment').innerHTML = opts('segment', 'All segments', m.segments, (i, id) => i.meta.segment === id);
  $('#rdIntent').innerHTML = opts('intent', 'Any intent', m.intents, (i, id) => (i.meta.intents || []).includes(id));
}

function renderReddit() {
  const items = rdFiltered();
  if (!items.some((i) => i.id === rd.sel)) rd.sel = window.innerWidth > 900 ? items[0]?.id ?? null : null;
  $('#rdList').innerHTML = items.length ? items.map((i) => {
    const m = i.meta;
    const meta = [sourceLabel(m.sub), ago(whenOf(i)).replace(' ago', ''), m.segmentLabel].filter(Boolean);
    return `<button class="ib-row ${i.id === rd.sel ? 'sel' : ''}" role="option" aria-selected="${i.id === rd.sel}" data-id="${i.id}">
      <span class="sc ${i.band?.id}" title="${esc(i.band?.label)}">${i.score ?? 0}</span>
      <span class="ib-main"><span class="ib-title">${esc(i.title)}</span><span class="ib-meta">${meta.map(esc).join(' · ')}${m.restricted ? ' · <b class="is-neg">Restricted</b>' : ''}${m.comment ? ' · comment' : ''}</span></span>
    </button>`;
  }).join('') : `<div class="ib-empty"><strong>${rd.items.length ? 'No threads here.' : 'No threads yet.'}</strong><span>${rd.items.length ? 'Change the status or clear a filter.' : 'Reddit is scanned every few hours.'}</span></div>`;
  $$('#rdList .ib-row').forEach((b) => (b.onclick = () => selectThread(Number(b.dataset.id))));
  renderThread();
}

function selectThread(id) {
  rd.sel = id;
  $$('#rdList .ib-row').forEach((b) => { const on = Number(b.dataset.id) === id; b.classList.toggle('sel', on); b.setAttribute('aria-selected', on); if (on) b.scrollIntoView({ block: 'nearest' }); });
  renderThread();
}

function renderThread() {
  const i = rd.items.find((x) => x.id === rd.sel);
  $('#rdBox').classList.toggle('detail-open', !!i);
  if (!i) { $('#rdDetail').innerHTML = '<div class="ib-placeholder">Select a thread to see why it scored and how to reply.</div>'; return; }
  const m = i.meta, b = i.band || {};
  const parts = m.parts || (m.signals || []).map((label) => ({ label, on: true }));
  const facts = [['Segment', m.segmentLabel], ['Product fit', m.fit], ['Providers mentioned', (m.providers || []).map(providerName).join(', ')], ['Source', `${sourceLabel(m.sub)}${m.comment ? ' (comment)' : ''}`]].filter(([, v]) => v);
  const status = rdStatusOf(i);
  $('#rdDetail').innerHTML = `
    <button class="dt-back" data-act="back" aria-label="Back to list">← Threads</button>
    <div class="dt-head">
      <span class="sc lg ${b.id}">${i.score ?? 0}</span>
      <div><div class="dt-band">${esc(b.label || '')}${status !== 'open' ? ` <span class="pill">${esc(RD_STATUS.find(([k]) => k === status)?.[1] || status)}</span>` : ''}</div><div class="muted small">${esc(b.action || '')}</div></div>
    </div>
    <h2 class="dt-title"><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></h2>
    <div class="dt-meta">${m.sub ? `r/${esc(m.sub)} · ` : ''}posted ${ago(whenOf(i))}${m.comments ? ` · ${m.comments} comments` : ''}</div>
    ${m.restricted ? `<div class="callout danger"><b>Restricted category: ${esc(m.restricted)}.</b> Do not pitch. Route to compliance before any outreach.</div>` : ''}
    <div class="dt-actions">
      <a class="btn small primary" href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">Open on Reddit <kbd>O</kbd></a>
      ${RD_ACTIONS.filter(([k]) => k !== status).map(([k, l, key]) => `<button class="btn small" data-act="${k}">${l} <kbd>${key}</kbd></button>`).join('')}
      ${status !== 'open' ? '<button class="btn small" data-act="new">Reopen <kbd>U</kbd></button>' : ''}
    </div>
    ${i.summary ? `<section class="dt-sec"><h3>What they wrote</h3><p class="dt-quote">${esc(i.summary.slice(0, 700))}${i.summary.length > 700 ? '…' : ''}</p></section>` : ''}
    <section class="dt-sec"><div class="dt-sec-head"><h3>Suggested approach${m.intentLabel ? ` · ${esc(m.intentLabel)}` : ''}</h3><button class="link-btn" data-act="copy">Copy</button></div><p>${esc(i.so_what || '')}</p></section>
    <section class="dt-sec"><h3>Why it scored ${i.score ?? 0}</h3><ul class="why">${parts.map((p) => `<li class="${p.on ? 'on' : ''}"><span class="ck" aria-hidden="true">${p.on ? '✓' : ''}</span><span>${esc(capFirst(p.label))}</span>${p.pts != null ? `<span class="pts">${p.on ? `+${p.pts}` : '0'}</span>` : ''}</li>`).join('')}</ul></section>
    <section class="dt-sec"><dl class="dt-facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl></section>
    <div class="kbd-hint"><kbd>J</kbd><kbd>K</kbd> move · <kbd>O</kbd> open · <kbd>R</kbd> replied · <kbd>L</kbd> sales lead · <kbd>I</kbd> ignore</div>`;
  $$('#rdDetail [data-act]').forEach((el) => (el.onclick = () => threadAction(el.dataset.act)));
}

async function threadAction(act) {
  const i = rd.items.find((x) => x.id === rd.sel);
  if (!i) return;
  if (act === 'back') { rd.sel = null; renderReddit(); return; }
  if (act === 'copy') {
    try { await navigator.clipboard.writeText(i.so_what || ''); toast('Approach copied'); } catch { toast('Copy failed: select the text instead'); }
    return;
  }
  if (act === 'open') { window.open(safeUrl(i.url), '_blank', 'noopener'); return; }
  const list = rdFiltered();
  const idx = list.findIndex((x) => x.id === i.id);
  const prev = i.status;
  await api(`/reddit/${i.id}`, { method: 'PATCH', body: { status: act } });
  i.status = act;
  // Move on to the next thread so triage is one keystroke per item.
  const next = list[idx + 1] || list[idx - 1];
  rd.sel = rdFiltered().some((x) => x.id === i.id) ? i.id : next?.id ?? null;
  renderRedditFilters();
  renderReddit();
  const label = { replied: 'Marked replied', lead: 'Marked as sales lead', ignored: 'Ignored', new: 'Moved back to open' }[act];
  toast(label, act === 'new' ? null : { label: 'Undo', fn: async () => { await api(`/reddit/${i.id}`, { method: 'PATCH', body: { status: prev } }); i.status = prev; rd.sel = i.id; renderRedditFilters(); renderReddit(); } });
}

document.addEventListener('keydown', (e) => {
  if (state.view !== 'reddit' || rd.mode !== 'inbox' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^(input|select|textarea)$/i.test(e.target.tagName) || $('#drawerWrap')?.classList.contains('open')) return;
  const list = rdFiltered();
  const idx = list.findIndex((x) => x.id === rd.sel);
  const k = e.key.toLowerCase();
  if (k === 'j' || e.key === 'ArrowDown') { const n = list[Math.min(list.length - 1, idx + 1)]; if (n) { e.preventDefault(); selectThread(n.id); } }
  else if (k === 'k' || e.key === 'ArrowUp') { const n = list[Math.max(0, idx - 1)]; if (n) { e.preventDefault(); selectThread(n.id); } }
  else if (rd.sel && { o: 'open', r: 'replied', l: 'lead', i: 'ignored', u: 'new' }[k]) { e.preventDefault(); threadAction({ o: 'open', r: 'replied', l: 'lead', i: 'ignored', u: 'new' }[k]); }
});
$('#rdQ').addEventListener('input', (e) => { rd.q = e.target.value; renderRedditFilters(); renderReddit(); });
for (const k of ['band', 'segment', 'intent']) $(`#rd${k[0].toUpperCase()}${k.slice(1)}`).addEventListener('change', (e) => { rd[k] = e.target.value; renderRedditFilters(); renderReddit(); });
$$('#rdMode button').forEach((b) => (b.onclick = () => { rd.mode = b.dataset.mode; loadReddit(); }));

// Weekly voice-of-customer view: single-series bar lists, labels in ink, values beside each bar.
async function loadRedditInsights() {
  const [rep, r] = await Promise.all([api('/reddit/report'), rd.meta ? rd.meta : api('/reddit?status=all')]);
  rd.meta = r;
  const lbl = (list, id) => list.find((x) => x.id === id)?.label || (id === 'other' ? 'Other business' : capFirst(id));
  const bars = (obj, label, filterKey) => {
    const rows = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!rows.length) return '<div class="muted small">None this week.</div>';
    const max = rows[0][1];
    return `<div class="hb-list">${rows.map(([k, v]) => `<button class="hb-row" ${filterKey ? `data-f="${filterKey}" data-v="${esc(k)}"` : 'disabled'} title="${esc(label(k))}: ${v} thread${v === 1 ? '' : 's'}">
      <span class="hb-label">${esc(label(k))}</span><span class="hb-track"><span class="hb-fill" style="width:${Math.max(4, (v / max) * 100)}%"></span></span><span class="hb-val">${v}</span></button>`).join('')}</div>`;
  };
  const sum = (k) => rep.subs.reduce((n, x) => n + x[k], 0);
  const complaints = Object.fromEntries(Object.entries(rep.providers || {}).map(([p]) => [p, rep.complaints?.[p] || 0]));
  $('#rdInsights').innerHTML = rep.total ? `
    <div class="tiles">
      <div class="tile"><div class="tile-label">Qualified threads</div><div class="tile-value">${rep.total}</div><div class="tile-sub">last 7 days</div></div>
      <div class="tile"><div class="tile-label">High priority</div><div class="tile-value">${rep.bands.high || 0}</div><div class="tile-sub">score 80+</div></div>
      <div class="tile"><div class="tile-label">Replied</div><div class="tile-value">${sum('replied')}</div><div class="tile-sub">of this week's threads</div></div>
      <div class="tile"><div class="tile-label">Sales leads</div><div class="tile-value">${sum('lead')}</div><div class="tile-sub">${rep.restricted ? `${rep.restricted} restricted, held back` : 'flagged from Reddit'}</div></div>
    </div>
    <div class="ins-grid">
      <div class="panel"><div class="panel-head"><h3>What they ask</h3><span class="muted small">Click to filter the inbox</span></div>${bars(rep.intents, (k) => lbl(r.intents, k), 'intent')}</div>
      <div class="panel"><div class="panel-head"><h3>Who is asking</h3></div>${bars(rep.segments, (k) => lbl(r.segments, k), 'segment')}</div>
      <div class="panel"><div class="panel-head"><h3>Product fit</h3><span class="muted small">MCA for transfers, IPG for card checkout</span></div>${bars(rep.fit, (k) => k)}</div>
      <div class="panel"><div class="panel-head"><h3>Providers mentioned</h3><span class="muted small">Complaints in brackets</span></div>${bars(rep.providers, (k) => `${providerName(k)}${complaints[k] ? ` (${complaints[k]} unhappy)` : ''}`)}</div>
    </div>
    <div class="panel"><div class="panel-head"><h3>Yield by subreddit</h3><span class="muted small">Expand to new subreddits only where this produces 80+ threads and leads</span></div>
      <div class="ytable"><div class="yr yh"><span>Source</span><span>Threads</span><span>80+</span><span>Replied</span><span>Leads</span></div>
      ${rep.subs.map((x) => `<div class="yr"><span>${x.sub === 'search' ? 'Keyword searches' : esc(sourceLabel(x.sub))}</span><span>${x.posts}</span><span>${x.high}</span><span>${x.replied}</span><span>${x.lead}</span></div>`).join('')}</div>
    </div>` : '<div class="empty"><strong>No Reddit threads in the last 7 days yet.</strong>Insights fill in as threads are scored.</div>';
  $$('#rdInsights .hb-row[data-f]').forEach((b) => (b.onclick = () => {
    Object.assign(rd, { mode: 'inbox', status: 'open', band: '', segment: '', intent: '', q: '', sel: null, [b.dataset.f]: b.dataset.v });
    $('#rdQ').value = '';
    loadReddit();
  }));
}

// ---------- live ----------
const feedRow = (a, mini) => `<div class="fe"><time>${new Date(a.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(mini ? {} : { second: '2-digit' }) })}</time><span class="t t-${esc(a.type)}">${esc(a.type)}</span><span>${esc(a.msg)}</span></div>`;

async function loadMiniFeed() {
  const a = await api('/activity?n=25');
  $('#miniFeed').innerHTML = a.map((x) => feedRow(x, true)).join('');
}

async function loadLive() {
  const [a, runs] = await Promise.all([api('/activity?n=200'), api('/runs'), loadStats()]);
  $('#liveFeed').innerHTML = a.map((x) => feedRow(x)).join('');
  $('#runsPanel').innerHTML = runs.slice(0, 40).map((r) => `<div><span class="trunc">${esc(r.name || r.source_id)}</span><span class="${r.status === 'error' ? 'status-error' : 'muted'}" style="white-space:nowrap">${r.status === 'error' ? 'error' : r.status === 'deferred' ? 'rate limited' : `${r.new_items} new / ${r.fetched}`} · ${ago(r.started_at)}</span></div>`).join('');
}

function renderFunnel(s) {
  $('#funnel').innerHTML = [
    ['Articles read', s.itemsTotal, `${s.items24h} in last 24h`],
    ['Passed filter', s.passedTotal, `${s.filteredTotal} dropped as noise/dupes`],
    ['Companies', s.companies, `${s.newToday} new today`],
    ['High intent', s.highIntent, `score ${s.threshold}+`],
    ['Sources live', s.sourcesActive, `${s.agentQueries} agent queries · ${s.sourcesError} erroring`],
  ].map(([l, v, sub]) => `<div class="stage"><div class="l">${l}</div><div class="v">${Number(v).toLocaleString('en-IN')}</div><div class="muted small">${sub}</div></div>`).join('');
  const u = s.llm;
  $('#llmPanel').innerHTML = [
    ['Provider', u.provider === 'none' ? 'Rules engine (add GEMINI_API_KEY)' : `${u.provider} · ${u.model}`],
    ['Calls today', `${u.calls} / ${u.cap}`],
    ['Tokens today', `${(u.tokens_in || 0).toLocaleString()} in · ${(u.tokens_out || 0).toLocaleString()} out`],
    ['Extraction mix', `${s.pipeline.via.llm || 0} LLM · ${s.pipeline.via.rules || 0} rules · ${s.pipeline.via.structured || 0} structured`],
    ['Status', u.cooling ? 'Cooling down (rate limit)' : u.lastError ? `Last error: ${u.lastError}` : 'OK'],
  ].map(([k, v]) => `<div><span class="muted">${k}</span><b>${esc(v)}</b></div>`).join('');
  $('#liveCount').textContent = s.running.length ? `fetching: ${s.running.join(', ')}` : '';
}

$('#agentBtn').onclick = async (e) => {
  e.target.disabled = true;
  try { const r = await api('/agent/run', { method: 'POST' }); toast(`Agent planned ${r.added.length} new searches`); } catch (err) { toast(err.message); }
  e.target.disabled = false;
};

// ---------- sources ----------
async function loadSources() {
  const rows = await api('/sources');
  const head = '<div class="tr th"><div>Source</div><div>Type</div><div>Category</div><div>Last run</div><div>Every</div><div>Items</div><div>Passed</div><div>Leads</div><div>Quality</div><div></div></div>';
  const groups = [['system', 'Core sources'], ['user', 'Added by you'], ['agent', 'Agent-discovered queries']];
  let html = head;
  for (const [g, label] of groups) {
    const list = rows.filter((r) => r.created_by === g);
    if (!list.length) continue;
    html += `<div class="group-label">${label} · ${list.filter((r) => r.enabled).length} active</div>`;
    html += list.map((s) => {
      const st = s.running ? 'running' : s.last_status || 'pending';
      const detail = s.params.query || s.params.url || (s.params.sub ? `r/${s.params.sub}` : '') || s.params.search || '';
      return `<div class="tr" style="${s.enabled ? '' : 'opacity:.5'}">
        <div style="min-width:0"><b class="trunc" style="display:block">${esc(s.name)}</b><small class="muted trunc" style="display:block" title="${esc(s.last_error || detail)}">${esc(s.last_error ? `⚠ ${s.last_error}` : detail)}${s.created_by === 'agent' && s.expires_at ? ` · expires ${fmtDate(s.expires_at)}` : ''}${s.params.why ? ` · ${esc(s.params.why)}` : ''}</small></div>
        <div class="small">${esc(s.kind)}</div><div class="small">${esc(s.category)}</div>
        <div class="small status-${st}">${st === 'running' ? 'fetching…' : s.last_run_at ? `${st === 'error' ? 'error · ' : st === 'deferred' ? 'rate limited · ' : ''}${ago(s.last_run_at)}` : 'queued'}</div>
        <div class="small muted">${s.cadence_min >= 60 ? `${Math.round(s.cadence_min / 6) / 10}h` : `${s.cadence_min}m`}</div>
        <div class="small">${s.items_total}</div><div class="small">${s.passed_total}</div><div class="small"><b>${s.leads_total}</b></div>
        <div class="small muted">${s.quality == null ? '-' : `${s.quality}%`}</div>
        <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
          <button class="btn small" data-run="${esc(s.id)}" ${s.enabled ? '' : 'disabled'}>Run</button>
          ${s.created_by !== 'system' ? `<button class="btn small danger" data-del="${esc(s.id)}" title="Delete">✕</button>` : ''}
          <button class="toggle ${s.enabled ? 'on' : ''}" data-toggle="${esc(s.id)}" data-en="${s.enabled}" title="Enable/disable"><i></i></button>
        </div></div>`;
    }).join('');
  }
  $('#sourceTable').innerHTML = html;
  $$('[data-run]').forEach((b) => (b.onclick = async () => { b.disabled = true; b.textContent = '…'; const r = await api(`/sources/${b.dataset.run}/run`, { method: 'POST' }); toast(r.error ? `Error: ${r.error}` : `Fetched ${r.fetched ?? 0} items, ${r.fresh ?? 0} new`); loadSources(); }));
  $$('[data-toggle]').forEach((b) => (b.onclick = async () => { await api(`/sources/${b.dataset.toggle}`, { method: 'PATCH', body: { enabled: b.dataset.en !== '1' } }); loadSources(); }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => { if (!confirm('Delete this source?')) return; await api(`/sources/${b.dataset.del}`, { method: 'DELETE' }); loadSources(); }));
}

const PLACEHOLDER = { rss: 'https://example.com/feed', gnews: 'Indian handicrafts exporter US buyers when:14d', reddit: 'Subreddit name (e.g. freelance_india) or search:"export invoice"', hn: 'Search terms, e.g. Bengaluru SaaS' };
$('#srcKind').onchange = (e) => ($('#srcValue').placeholder = PLACEHOLDER[e.target.value]);
function sourceBody() {
  const f = new FormData($('#addSource'));
  const kind = f.get('kind');
  const v = String(f.get('value') || '').trim();
  const body = { kind, category: f.get('category'), name: f.get('name') || undefined };
  if (kind === 'rss') body.url = v;
  else if (kind === 'reddit') { if (v.startsWith('search:')) body.search = v.slice(7).trim(); else body.sub = v.replace(/^\/?r\//, ''); }
  else body.query = v;
  return body;
}
$('#testSrc').onclick = async () => {
  $('#srcTest').textContent = 'Fetching…';
  try {
    const r = await api('/sources/test', { method: 'POST', body: sourceBody() });
    $('#srcTest').innerHTML = `<b>${r.count} items found.</b><ul>${r.sample.map((s) => `<li>${esc(s.title)} <span class="muted">${s.date ? fmtDate(s.date) : ''}</span></li>`).join('')}</ul>`;
  } catch (e) { $('#srcTest').textContent = `Error: ${e.message}`; }
};
$('#addSource').onsubmit = async (e) => {
  e.preventDefault();
  $('#srcTest').textContent = 'Validating and adding…';
  try {
    const r = await api('/sources', { method: 'POST', body: sourceBody() });
    $('#srcTest').textContent = `Added. ${r.fetched} items fetched, ${r.fresh} queued for processing.`;
    e.target.reset();
    loadSources();
  } catch (err) { $('#srcTest').textContent = `Error: ${err.message}`; }
};

// ---------- config ----------
const WEIGHT_HELP = { funding: 'Recency x stage fit x ticket size', international: 'Sells abroad, target markets, ICP keywords, site currencies', sector: 'Sector fit (per-sector weights below)', paymentStack: 'Checkout stack detected on website', pain: 'Publicly described payment friction', momentum: 'Expansion, launches, hiring in last 60 days', corroboration: 'Confirmed by multiple sources', novelty: 'Freshly discovered' };

async function loadConfig() {
  const r = await api('/config');
  state.config = r.config;
  renderConfigForm(r.config, r.learned);
}

function renderConfigForm(c, learned = {}) {
  const range = (path, val, min, max, step = 1) => `<input type="range" data-path="${path}" min="${min}" max="${max}" step="${step}" value="${val}" oninput="this.nextElementSibling.value=this.value"><output>${val}</output>`;
  const list = (path, arr) => `<textarea class="input" data-list="${path}" rows="3">${esc(arr.join(', '))}</textarea>`;
  const totalW = Object.values(c.weights).reduce((a, b) => a + b, 0);
  $('#configForm').innerHTML = `
    <div class="panel"><div class="panel-head"><h3>Signal weights</h3><span class="muted small">total ${totalW} pts</span></div>
      ${Object.entries(c.weights).map(([k, v]) => `<div class="cfg-row" title="${esc(WEIGHT_HELP[k] || '')}"><span>${esc(k)}<br><small class="muted">${esc(WEIGHT_HELP[k] || '')}</small></span>${range(`weights.${k}`, v, 0, 50)}</div>`).join('')}
      <div class="cfg-row"><span><b>High-intent threshold</b></span>${range('threshold', c.threshold, 20, 90)}</div></div>
    <div class="panel"><div class="panel-head"><h3>Sector fit</h3><span class="muted small">0 = ignore, 1 = ideal</span></div>
      ${Object.entries(c.sectors).map(([k, v]) => `<div class="cfg-row"><span>${esc(k)}${learned.sector?.[k] ? ` <small class="${learned.sector[k] > 0 ? 'delta-up' : 'delta-down'}">${learned.sector[k] > 0 ? '+' : ''}${Math.round(learned.sector[k] * 100)}% learned</small>` : ''}</span>${range(`sectors.${k}`, v, 0, 1, 0.05)}</div>`).join('')}</div>
    <div class="panel"><div class="panel-head"><h3>Penalties (soft)</h3></div>
      ${Object.entries(c.penalties).map(([k, v]) => `<div class="cfg-row"><span>${esc(k)}</span>${range(`penalties.${k}`, v, -50, 0)}</div>`).join('')}
      <div class="cfg-field"><label>Competitor on their checkout means…</label><select class="input" data-path="competitorMode"><option value="opportunity" ${c.competitorMode === 'opportunity' ? 'selected' : ''}>Switch opportunity (boost)</option><option value="deprioritize" ${c.competitorMode === 'deprioritize' ? 'selected' : ''}>Deprioritize</option></select></div>
      <div class="cfg-field"><label>Funding sweet spot (USD M)</label><div style="display:flex;gap:8px"><input class="input" type="number" step="0.1" data-path="fundingSweetSpotUsdM.min" value="${c.fundingSweetSpotUsdM.min}"><input class="input" type="number" data-path="fundingSweetSpotUsdM.max" value="${c.fundingSweetSpotUsdM.max}"></div></div>
      <div class="cfg-row"><span>Recency half-life (days)</span>${range('recencyHalfLifeDays', c.recencyHalfLifeDays, 7, 120)}</div></div>
    <div class="panel"><div class="panel-head"><h3>Keywords and lists</h3></div><p class="hint">Comma separated.</p>
      <div class="cfg-field"><label>Positive (international intent)</label>${list('keywords.positive', c.keywords.positive)}</div>
      <div class="cfg-field"><label>Negative news</label>${list('keywords.negative', c.keywords.negative)}</div>
      <div class="cfg-field"><label>Competitors</label>${list('competitors', c.competitors)}</div>
      <div class="cfg-field"><label>Preferred funding stages</label>${list('preferredStages', c.preferredStages)}</div>
      <div class="cfg-field"><label>Enterprise watch list (deprioritized)</label>${list('enterpriseNames', c.enterpriseNames)}</div>
      <div class="cfg-field"><label>Never a lead (publishers, investors, regulators)</label>${list('blocklist', c.blocklist)}</div></div>
    <div class="panel"><div class="panel-head"><h3>Brief, agent and budget</h3></div>
      <div class="cfg-row"><span>Brief size</span>${range('brief.size', c.brief.size, 5, 60)}</div>
      <div class="cfg-row"><span>Exploration share</span>${range('brief.explorationShare', c.brief.explorationShare, 0, 0.5, 0.05)}</div>
      <div class="cfg-row"><span>Agent interval (min)</span>${range('agent.intervalMinutes', c.agent.intervalMinutes, 30, 720, 15)}</div>
      <div class="cfg-row"><span>Agent queries per cycle</span>${range('agent.queriesPerCycle', c.agent.queriesPerCycle, 0, 8)}</div>
      <div class="cfg-row"><span>Agent query lifetime (days)</span>${range('agent.queryTtlDays', c.agent.queryTtlDays, 1, 14)}</div>
      <div class="cfg-row"><span>LLM daily call cap</span>${range('llm.dailyCallCap', c.llm.dailyCallCap, 0, 2000, 50)}</div>
      <div class="cfg-row"><span>LLM batch size</span>${range('llm.batchSize', c.llm.batchSize, 1, 15)}</div>
      <div class="cfg-row"><span>Auto-research min score</span>${range('enrichment.minScore', c.enrichment.minScore, 0, 90)}</div>
      <div class="cfg-row"><span>Max article age (days)</span>${range('maxItemAgeDays', c.maxItemAgeDays, 3, 120)}</div></div>
    <div class="panel"><div class="panel-head"><h3>Decision makers</h3></div>
      <p class="hint">Team size decides who the engine suggests: founder/CTO for small teams, finance/payments owner for mid-size, CFO/treasury for large.</p>
      <div class="cfg-row"><span>Small team up to</span>${range('contacts.smallTeamMax', c.contacts.smallTeamMax, 5, 200, 5)}</div>
      <div class="cfg-row"><span>Mid-size up to</span>${range('contacts.midTeamMax', c.contacts.midTeamMax, 50, 2000, 50)}</div>
      <div class="cfg-field"><label>Email lookup provider (needs its API key on the server)</label><select class="input" data-path="contacts.emailProvider">${['auto', 'apollo', 'hunter'].map((v) => `<option value="${v}" ${c.contacts.emailProvider === v ? 'selected' : ''}>${v === 'auto' ? 'Auto (whichever key is set)' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}</select></div>
      <div class="cfg-row"><span>Paid lookups per month</span>${range('contacts.monthlyLookupCap', c.contacts.monthlyLookupCap, 0, 1000, 10)}</div>
      <div class="cfg-row"><span>Auto-find email at score (0 = only on click)</span>${range('contacts.autoFindEmailMinScore', c.contacts.autoFindEmailMinScore, 0, 100, 5)}</div></div>`;
  $('#cfgRaw').value = JSON.stringify(c, null, 2);
}

function readConfigForm() {
  const c = structuredClone(state.config);
  const set = (path, val) => { const ks = path.split('.'); let o = c; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = val; };
  $$('#configForm [data-path]').forEach((el) => set(el.dataset.path, el.tagName === 'SELECT' ? el.value : Number(el.value)));
  $$('#configForm [data-list]').forEach((el) => set(el.dataset.list, el.value.split(',').map((s) => s.trim()).filter(Boolean)));
  return c;
}

$('#cfgPreview').onclick = async () => {
  const draft = readConfigForm();
  const r = await api('/config/preview', { method: 'POST', body: { config: draft } });
  $('#previewPanel').hidden = false;
  $('#previewSummary').textContent = `${r.movedIntoHigh} would enter high intent, ${r.movedOutOfHigh} would drop out`;
  $('#previewTable').innerHTML = `<div class="table" style="box-shadow:none">${r.preview.map((p) => {
    const d = p.after - p.before;
    return `<div class="tr" style="grid-template-columns:1fr 100px 60px 60px 70px"><b>${esc(p.name)}</b><span class="small muted">${esc(p.sector)}</span><span class="small">${p.before}</span><span class="small"><b>${p.after}</b></span><span class="small ${d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : 'muted'}">${d > 0 ? '+' : ''}${d}</span></div>`;
  }).join('')}</div>`;
  $('#previewPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};
$('#cfgSave').onclick = async () => {
  const r = await api('/config', { method: 'PUT', body: { config: readConfigForm() } });
  state.config = r.config;
  toast('Config saved. All companies rescored.');
  loadConfig();
};
$('#cfgReset').onclick = async () => { if (!confirm('Reset all config to defaults?')) return; await api('/config/reset', { method: 'POST' }); toast('Defaults restored'); loadConfig(); };
$('#cfgRawApply').onclick = () => { try { state.config = JSON.parse($('#cfgRaw').value); renderConfigForm(state.config); toast('Applied to form. Preview or save.'); } catch (e) { toast(`Invalid JSON: ${e.message}`); } };

// ---------- scan ----------
$('#scanBtn').onclick = async () => {
  $('#scanBtn').classList.add('scanning');
  await api('/scan', { method: 'POST' });
  toast('Scanning every enabled source now. Leads stream in as they are processed.');
  setTimeout(loadStats, 1500);
};

// ---------- live stream ----------
function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('activity', (e) => {
    const a = JSON.parse(e.data);
    if (state.view === 'live') { $('#liveFeed').insertAdjacentHTML('afterbegin', feedRow(a)); const f = $('#liveFeed'); while (f.children.length > 300) f.lastChild.remove(); }
    if (state.view === 'brief') { $('#miniFeed').insertAdjacentHTML('afterbegin', feedRow(a, true)); const f = $('#miniFeed'); while (f.children.length > 25) f.lastChild.remove(); }
  });
  es.addEventListener('lead', (e) => {
    const l = JSON.parse(e.data);
    if (l.kind === 'new') {
      state.pendingLeads++;
      if (state.view === 'brief' || state.view === 'leads') {
        toast(`${state.pendingLeads} new compan${state.pendingLeads > 1 ? 'ies' : 'y'} found (latest: ${l.name})`, { label: 'Refresh', fn: () => (state.view === 'brief' ? loadBrief() : loadLeads(true)) });
      }
    }
  });
  let statsTimer;
  const refreshStats = () => { clearTimeout(statsTimer); statsTimer = setTimeout(loadStats, 800); };
  es.addEventListener('stats', refreshStats);
  es.addEventListener('source', () => { refreshStats(); if (state.view === 'sources') { clearTimeout(window.__srcT); window.__srcT = setTimeout(loadSources, 1200); } });
  es.onerror = () => { $('#engine').className = 'engine off'; $('#engineText').textContent = 'Reconnecting…'; };
  es.onopen = () => loadStats();
}

route();
// ?static skips the live stream (used for headless screenshots).
if (!new URLSearchParams(location.search).has('static')) {
  connectStream();
  setInterval(loadStats, 20000);
}

// Show "Sign out" only when the server has a password set.
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (!h.auth) return;
  const b = $('#logoutBtn');
  b.hidden = false;
  b.onclick = async () => { await fetch('/auth/logout', { method: 'POST' }); location.href = '/login'; };
}).catch(() => {});
