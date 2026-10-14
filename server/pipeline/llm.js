import { q } from '../db.js';
import { getConfig } from '../config.js';
import { log } from '../bus.js';

// Provider-agnostic surface: llm.available(), llm.json(system, prompt, schema), llm.usage().
// Groq (OpenAI-compatible, fast) is preferred when GROQ_API_KEY is set; Gemini is the fallback.
// LLM_PROVIDER=groq|gemini forces one. Schemas are written once in Gemini's format and converted for Groq.
const PROVIDERS = {
  groq: { key: () => process.env.GROQ_API_KEY || '', model: () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b', label: 'Groq' },
  gemini: { key: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '', model: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash', label: 'Gemini' },
};

function provider() {
  const forced = process.env.LLM_PROVIDER;
  if (forced && PROVIDERS[forced]?.key()) return forced;
  return Object.keys(PROVIDERS).find((k) => PROVIDERS[k].key()) || null;
}

let chain = Promise.resolve();
let nextAt = 0;
let cooldownUntil = 0;
let lastError = null;
// Groq's free tier is limited by tokens per minute, so pace on what the API says is left rather than a fixed gap.
const budget = { remaining: null, resetAt: 0 };

const today = () => new Date().toISOString().slice(0, 10);

export function usage() {
  const p = provider();
  const row = q.get('SELECT * FROM llm_usage WHERE day = ?', today()) || { calls: 0, tokens_in: 0, tokens_out: 0, failures: 0 };
  return { provider: p || 'none', label: p ? PROVIDERS[p].label : null, model: p ? PROVIDERS[p].model() : null, cap: getConfig().llm.dailyCallCap, cooling: cooldownUntil > Date.now(), lastError, ...row };
}

export function available() {
  if (!provider()) return false;
  if (cooldownUntil > Date.now()) return false;
  return usage().calls < getConfig().llm.dailyCallCap;
}

function track(tin, tout, failed) {
  q.run(`INSERT INTO llm_usage(day, calls, tokens_in, tokens_out, failures) VALUES(?, 1, ?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET calls = calls + 1, tokens_in = tokens_in + excluded.tokens_in,
         tokens_out = tokens_out + excluded.tokens_out, failures = failures + excluded.failures`, today(), tin, tout, failed ? 1 : 0);
}

export function json(system, prompt, schema, { temperature = 0.1, maxTokens = 8192 } = {}) {
  const run = chain.then(async () => {
    if (!available()) throw new Error('LLM unavailable (no key, cooling down, or daily cap reached)');
    const p = provider();
    let wait = nextAt - Date.now();
    if (p === 'groq' && budget.remaining != null) {
      // Rough size of this call: prompt characters / 4, plus room for the answer.
      const need = Math.ceil((system.length + prompt.length) / 4) + Math.min(maxTokens, 3000);
      if (budget.remaining < need) wait = Math.max(wait, budget.resetAt - Date.now() + 250);
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 70_000)));
    nextAt = Date.now() + (p === 'groq' ? 1000 : getConfig().llm.minIntervalMs);
    return p === 'groq' ? callGroq(system, prompt, schema, temperature, maxTokens) : callGemini(system, prompt, schema, temperature, maxTokens);
  });
  chain = run.catch(() => {});
  return run;
}

function fail(label, status, msg, retryAfterMs) {
  if (status === 429 || status === 503) cooldownUntil = Date.now() + (retryAfterMs || 90_000);
  else if (status >= 400 && status < 500) cooldownUntil = Date.now() + 10 * 60_000; // bad key/model: stop hammering, rules take over
  lastError = `${status}: ${String(msg).slice(0, 200)}`;
  track(0, 0, true);
  log('llm', `${label} error ${lastError}`);
  return new Error(`${label} ${lastError}`);
}

// ---------- Groq (OpenAI-compatible chat completions) ----------
// Gemini schema dialect -> JSON Schema: lower-case types, `nullable` becomes a null union.
function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  if (s.type) {
    const t = String(s.type).toLowerCase();
    out.type = s.nullable ? [t, 'null'] : t;
  }
  if (s.enum) out.enum = s.nullable ? [...s.enum, null] : s.enum;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (s.items) out.items = toJsonSchema(s.items);
  if (s.required) out.required = s.required;
  if (s.description) out.description = s.description;
  return out;
}

// "1m26.4s", "4.657s", "250ms" -> milliseconds
function durationMs(v) {
  if (!v) return 0;
  let ms = 0;
  for (const [, n, unit] of String(v).matchAll(/([\d.]+)(ms|s|m|h)/g)) ms += Number(n) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit];
  return ms;
}

async function callGroq(system, prompt, schema, temperature, maxTokens) {
  const model = PROVIDERS.groq.model();
  const body = {
    model, temperature,
    max_completion_tokens: Math.min(maxTokens, 8192),
    messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    response_format: schema ? { type: 'json_schema', json_schema: { name: 'result', strict: false, schema: toJsonSchema(schema) } } : { type: 'json_object' },
  };
  // gpt-oss models think before answering; low effort keeps extraction fast and inside the token budget.
  if (/gpt-oss/.test(model)) body.reasoning_effort = 'low';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${PROVIDERS.groq.key()}` },
      body: JSON.stringify(body),
    });
    const rem = res.headers.get('x-ratelimit-remaining-tokens');
    if (rem != null) { budget.remaining = Number(rem); budget.resetAt = Date.now() + durationMs(res.headers.get('x-ratelimit-reset-tokens')); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retry = Number(res.headers.get('retry-after')) * 1000 || durationMs(res.headers.get('x-ratelimit-reset-tokens'));
      throw fail('Groq', res.status, j?.error?.message || `HTTP ${res.status}`, retry ? retry + 500 : null);
    }
    const text = j.choices?.[0]?.message?.content || '';
    track(j.usage?.prompt_tokens || 0, j.usage?.completion_tokens || 0, false);
    lastError = null;
    return parseJsonLoose(text);
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Gemini ----------
async function callGemini(system, prompt, schema, temperature, maxTokens) {
  const model = PROVIDERS.gemini.model();
  const generationConfig = { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
  if (schema) generationConfig.responseSchema = schema;
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': PROVIDERS.gemini.key() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw fail('Gemini', res.status, body?.error?.message || `HTTP ${res.status}`);
    const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const u = body.usageMetadata || {};
    track(u.promptTokenCount || 0, u.candidatesTokenCount || 0, false);
    lastError = null;
    return parseJsonLoose(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(raw) {
  // Some models emit non-breaking hyphens (pre‑seed); plain ones keep search and matching working.
  const text = String(raw).replace(/[\u2010\u2011\u2012]/g, '-');
  try { return JSON.parse(text); } catch {}
  const m = text.match(/[[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('LLM returned non-JSON');
}
