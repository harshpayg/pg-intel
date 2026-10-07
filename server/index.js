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
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

if (PUBLIC && !AUTH_PASSWORD && process.env.ALLOW_NO_AUTH !== '1') {
  console.error('Refusing to start publicly without auth: this app exposes lead data and editable config. Set AUTH_PASSWORD (and optionally AUTH_USER), or ALLOW_NO_AUTH=1 to override.');
  process.exit(1);
}

const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

function basicAuth(req, res, next) {
  if (!AUTH_PASSWORD || req.path === '/api/health') return next(); // health stays open for the platform healthcheck
  const m = (req.headers.authorization || '').match(/^Basic (.+)$/i);
  if (m) {
    const [user, ...rest] = Buffer.from(m[1], 'base64').toString('utf8').split(':');
    if ([safeEq(user, AUTH_USER), safeEq(rest.join(':'), AUTH_PASSWORD)].every(Boolean)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="PayGlocal Lead Intel", charset="UTF-8"').status(401).send('Authentication required');
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway's proxy
app.use(basicAuth);
app.use(express.json({ limit: '1mb' }));
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
