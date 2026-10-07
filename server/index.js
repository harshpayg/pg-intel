import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

if (fs.existsSync('.env')) process.loadEnvFile('.env');

const { default: express } = await import('express');
const { q, db } = await import('./db.js');
const { SEED_SOURCES } = await import('./sources/index.js');
const { startScheduler } = await import('./scheduler.js');
const { startProcessor } = await import('./pipeline/processor.js');
const { startAgent } = await import('./agent.js');
const { api } = await import('./routes.js');
const { log } = await import('./bus.js');
const llm = await import('./pipeline/llm.js');

// Seed the source catalogue without overwriting anything the user changed.
for (const s of SEED_SOURCES) {
  q.run(`INSERT OR IGNORE INTO sources(id, name, kind, category, params, cadence_min, min_cadence, max_cadence, created_by)
    VALUES(?,?,?,?,?,?,?,?, 'system')`,
    s.id, s.name, s.kind, s.category || 'leads', JSON.stringify(s.params), s.cadence_min || 60, s.min_cadence || 15, s.max_cadence || 720);
}

// Public mode: any hosted environment (Railway sets PORT and RAILWAY_*), or an explicit HOST.
const PUBLIC = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.PUBLIC_MODE === '1' || process.env.NODE_ENV === 'production');
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

if (PUBLIC && !AUTH_PASSWORD && process.env.ALLOW_NO_AUTH !== '1') {
  console.error('Refusing to start publicly without auth: this app exposes lead data and editable config. Set AUTH_PASSWORD, or ALLOW_NO_AUTH=1 to override.');
  process.exit(1);
}

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Password-only login with a signed, HttpOnly session cookie. Changing the password (or SESSION_SECRET) logs everyone out.
const COOKIE = 'lis';
const SESSION_DAYS = 30;
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update(`leadintel:${AUTH_PASSWORD}`).digest('hex');
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const makeToken = () => { const exp = String(Date.now() + SESSION_DAYS * 86400000); return `${exp}.${sign(exp)}`; };
function validToken(t) {
  const [exp, sig] = String(t || '').split('.');
  return Boolean(exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp)));
}
const cookieOf = (req) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === COOKIE)?.[1];
const authed = (req) => !AUTH_PASSWORD || validToken(cookieOf(req));
const here = path.dirname(fileURLToPath(import.meta.url));

// Brute-force guard: 8 failed attempts per IP per 15 minutes.
const fails = new Map();
const tooMany = (ip) => { const f = fails.get(ip); return f && f.until > Date.now() && f.n >= 8; };
const noteFail = (ip) => { const f = fails.get(ip); fails.set(ip, f && f.until > Date.now() ? { n: f.n + 1, until: f.until } : { n: 1, until: Date.now() + 15 * 60000 }); };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway's proxy
app.use(express.json({ limit: '1mb' }));

app.get('/login', (req, res) => (authed(req) ? res.redirect('/') : res.sendFile(path.join(here, 'login.html'))));
app.post('/auth/login', (req, res) => {
  if (!AUTH_PASSWORD) return res.json({ ok: true });
  if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  if (!safeEq(req.body?.password ?? '', AUTH_PASSWORD)) { noteFail(req.ip); return res.status(401).json({ error: 'Incorrect password' }); }
  fails.delete(req.ip);
  res.cookie(COOKIE, makeToken(), { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_DAYS * 86400000, path: '/' });
  res.json({ ok: true });
});
app.post('/auth/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

// Gate everything else. /api/health stays open for the platform healthcheck.
app.use((req, res, next) => {
  if (req.path === '/api/health' || authed(req)) return next();
  return req.path.startsWith('/api') ? res.status(401).json({ error: 'auth' }) : res.redirect('/login');
});
app.use('/api', api);
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'), { extensions: ['html'] }));

const PORT = Number(process.env.PORT) || 4300;
// Local: loopback on both IPv4 and IPv6 so "localhost" works whichever one the browser picks.
// Public: all interfaces. '::' is dual-stack on Linux (covers IPv4 too), so stop after the first success.
const HOSTS = process.env.HOST ? [process.env.HOST] : PUBLIC ? ['::', '0.0.0.0'] : ['127.0.0.1', '::1'];

function listen(host) {
  return new Promise((resolve, reject) => {
    const server = app.listen(PORT, host);
    server.once('listening', () => resolve(host));
    server.once('error', reject);
  });
}

const bound = [];
for (const host of HOSTS) {
  try {
    bound.push(await listen(host));
    if (PUBLIC && !process.env.HOST) break;
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use on ${host}. Another Lead Intel instance is probably running; stop it first (pkill -f server/index.js) or set PORT.`);
      process.exit(1);
    }
    if (e.code !== 'EADDRNOTAVAIL' && e.code !== 'EAFNOSUPPORT') throw e; // no IPv6 on this machine is fine
    console.warn(`Skipping ${host}: ${e.code}`);
  }
}
if (!bound.length) {
  console.error(`Could not bind port ${PORT}`);
  process.exit(1);
}

const u = llm.usage();
log('boot', `Lead Intel running on http://localhost:${PORT} (${bound.join(', ')}) · LLM: ${u.provider === 'none' ? 'rules only (set GEMINI_API_KEY in .env)' : `${u.provider} ${u.model}`}`);
startScheduler();
startProcessor();
if (process.env.DISABLE_AGENT !== '1') startAgent();

// Railway sends SIGTERM on every deploy: stop the loops and checkpoint the WAL so the volume copy is clean.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('boot', 'Shutting down');
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {}
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => log('error', `Unhandled: ${e?.message || e}`));
