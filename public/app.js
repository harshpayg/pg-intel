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

const state = { view: 'brief', threshold: 60, stats: null, leadsOffset: 0, intelCat: '', config: null, pendingLeads: 0 };

// ---------- routing ----------
const VIEWS = ['brief', 'leads', 'intel', 'live', 'sources', 'config'];
function route() {
  const [v, id] = location.hash.slice(1).split('/');
  const view = VIEWS.includes(v) ? v : 'brief';
  state.view = view;
  for (const x of VIEWS) $(`#view-${x}`).hidden = x !== view;
  $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  ({ brief: loadBrief, leads: () => loadLeads(true), intel: loadIntel, live: loadLive, sources: loadSources, config: loadConfig })[view]();
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
      <div class="meta">${esc(fundTxt || 'No funding signal')}${where ? ` · ${esc(where)}` : ''}</div>
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
  $('#briefTitle').textContent = b.totalNew + b.totalUpdated ? `${b.totalNew} new companies, ${b.totalUpdated} with fresh signals` : "You're all caught up";
  $('#briefCount').textContent = b.leads.length ? `Showing ${b.leads.length}, ranked, with ${b.leads.filter((l) => l.explore).length} exploration picks` : '';
  $('#briefLeads').innerHTML = b.leads.length ? b.leads.map(leadCard).join('') : `<div class="empty"><strong>Nothing new since your last check.</strong>The engine keeps scanning. New funding, expansion and payment-pain signals will appear here automatically.</div>`;
  bindLeadClicks($('#briefLeads'));
  $('#briefIntel').innerHTML = b.intel.length ? b.intel.slice(0, 6).map(intelMini).join('') : '<div class="muted small">No new intel since last check.</div>';
}

const impDots = (n) => `<span class="imp" title="Importance ${n}/3">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
const intelMini = (i) => `<div class="it">${impDots(i.importance)}<span class="cat ${i.category}">${esc(i.category)}</span><div><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></div>${i.so_what ? `<p>${esc(i.so_what)}</p>` : ''}</div>`;

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
}

function closeDrawer() {
  $('#drawerWrap').classList.remove('open');
  if (location.hash.includes('/')) history.replaceState(null, '', `#${state.view}`);
  if (state.view === 'leads') loadLeads(true);
}
$('#drawerWrap').addEventListener('click', (e) => { if (e.target.id === 'drawerWrap') closeDrawer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

// ---------- intel ----------
async function loadIntel() {
  const r = await api(`/intel${state.intelCat ? `?category=${state.intelCat}` : ''}`);
  const counts = Object.fromEntries(r.counts.map((c) => [c.category, c.n]));
  const total = r.counts.reduce((s, c) => s + c.n, 0);
  const cats = [['', 'All', total], ['regulatory', 'Regulatory', counts.regulatory], ['competitor', 'Competitors', counts.competitor], ['market', 'Market', counts.market], ['voice', 'Voice of customer', counts.voice]];
  $('#intelTabs').innerHTML = cats.map(([k, l, n]) => `<button class="chipbtn ${state.intelCat === k ? 'active' : ''}" data-k="${k}">${l} ${n ? `· ${n}` : ''}</button>`).join('');
  $$('#intelTabs button').forEach((b) => (b.onclick = () => { state.intelCat = b.dataset.k; loadIntel(); }));
  $('#intelList').innerHTML = r.items.length ? r.items.map((i) => `<article class="intel-card">
    <div>${impDots(i.importance)}<span class="cat ${i.category}">${esc(i.category)}</span> <span class="muted small">· ${esc(i.source_name || '')} · ${ago(i.published_at || i.created_at)}</span></div>
    <h4><a href="${esc(safeUrl(i.url))}" target="_blank" rel="noopener">${esc(i.title)}</a></h4>
    ${i.summary ? `<p>${esc(i.summary.slice(0, 260))}</p>` : ''}
    ${i.so_what ? `<div class="so-what"><b>So what:</b> ${esc(i.so_what)}</div>` : ''}
  </article>`).join('') : '<div class="empty"><strong>No intel yet.</strong>RBI, competitor and market feeds are scanned on a schedule.</div>';
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
      <div class="cfg-row"><span>Max article age (days)</span>${range('maxItemAgeDays', c.maxItemAgeDays, 3, 120)}</div></div>`;
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
