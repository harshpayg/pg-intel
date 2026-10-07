import { q } from '../db.js';
import { getConfig } from '../config.js';
import { log } from '../bus.js';

// Provider-agnostic surface: llm.available(), llm.json(system, prompt, schema).
// Gemini first; another provider can be added behind the same functions.
const MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const KEY = () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

let chain = Promise.resolve();
let nextAt = 0;
let cooldownUntil = 0;
let lastError = null;

const today = () => new Date().toISOString().slice(0, 10);

export function usage() {
  const row = q.get('SELECT * FROM llm_usage WHERE day = ?', today()) || { calls: 0, tokens_in: 0, tokens_out: 0, failures: 0 };
  return { provider: KEY() ? 'gemini' : 'none', model: KEY() ? MODEL() : null, cap: getConfig().llm.dailyCallCap, cooling: cooldownUntil > Date.now(), lastError, ...row };
}

export function available() {
  if (!KEY()) return false;
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
    const wait = nextAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    nextAt = Date.now() + getConfig().llm.minIntervalMs;
    return callGemini(system, prompt, schema, temperature, maxTokens);
  });
  chain = run.catch(() => {});
  return run;
}

async function callGemini(system, prompt, schema, temperature, maxTokens) {
  const model = MODEL();
  const generationConfig = { temperature, maxOutputTokens: maxTokens, responseMimeType: 'application/json' };
  if (schema) generationConfig.responseSchema = schema;
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = body?.error?.message || `HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503) cooldownUntil = Date.now() + 90_000;
      else if (res.status >= 400 && res.status < 500) cooldownUntil = Date.now() + 10 * 60_000; // bad key/model: stop hammering, rules take over
      lastError = `${res.status}: ${msg.slice(0, 200)}`;
      track(0, 0, true);
      log('llm', `Gemini error ${lastError}`);
      throw new Error(`Gemini ${lastError}`);
    }
    const text = (body.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const u = body.usageMetadata || {};
    track(u.promptTokenCount || 0, u.candidatesTokenCount || 0, false);
    lastError = null;
    return parseJsonLoose(text);
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonLoose(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/[[{][\s\S]*[\]}]/);
  if (m) return JSON.parse(m[0]);
  throw new Error('LLM returned non-JSON');
}
