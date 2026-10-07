# PayGlocal Lead Intel

A lead-intelligence engine that runs 24/7. It watches Indian startup news, Google News, Y Combinator, Hacker News, Reddit, RBI and competitor feeds, and turns them into scored, explained and de-duplicated cross-border leads. It also builds a market-intel feed.

## Run

```bash
npm install
cp .env.example .env      # optional: add GEMINI_API_KEY for LLM extraction
npm start                 # http://localhost:4300
```

Requires Node 22.5+ (uses the built-in `node:sqlite`, so nothing needs compiling). Data lives in `data/leadintel.db`.

Within about 2 minutes of the first start, every source has been fetched and the Brief is filled. After that, each source runs on its own schedule.

To keep it running on a Mac, use `npx pm2 start server/index.js --name leadintel --node-args="--disable-warning=ExperimentalWarning"`, then `npx pm2 save`.

## How it works

```
Scheduler ─► Source plugins ─► raw_items ─► Prefilter ─► Extract ─► Resolve ─► Score ─► Enrich
(per-source    rss, gnews,       URL hash +    regex gate   Gemini or   entity      config     website: checkout
 cadence,      reddit, hn, yc    near-dup      (~60% cut)   rules       dedup,      weights,   stack, currencies,
 host pacing)                    titles                                  events      breakdown  shipping, pitch
                                                                                      │
Agent (every 2h): new queries, retire dead ones, tune cadence by yield ◄──────────────┘ feedback 👍/👎
```

- **Sources** (`server/sources/index.js`): each source has a `kind` plus `params`. You can add new RSS feeds, Google News queries, Reddit or HN searches from the Sources tab; each is validated with a live fetch before it's saved.
- **Fresh leads, not repeats**: a company is one record and every signal is an event attached to it.
  - The same story from several outlets counts as corroboration on one event, not a duplicate.
  - The Brief only shows companies with a new event since you last clicked "Mark brief as read".
  - 20% of Brief slots go to sectors that are under-represented, so the list doesn't settle on one segment.
- **Scoring** (`server/pipeline/score.js`): a weighted sum of funding, international intent, sector fit, payment stack, payment pain, momentum, corroboration and novelty, plus soft penalties. Every lead shows its breakdown. All weights are editable in Config, and you can preview the effect before saving.
- **Learning**: 👍/👎 nudges the sector weights (capped at ±25%), counts towards source quality, and is passed to the LLM as calibration examples.
- **Agent** (`server/agent.js`): plans new Google News queries. With Gemini it builds them from what sales liked and where coverage is thin; without Gemini it rotates through segment and intent combinations. Agent queries expire unless they produce leads. "Find lookalikes" on any lead creates targeted searches on demand.
- **Rules vs LLM**: without a key, a rule extractor handles the usual Indian funding and expansion headline formats. Gemini adds:
  - Indian-entity checks
  - judgement on whether a company sells internationally
  - better market and sector tagging
  - "so what" notes on intel items
  - tailored outreach angles

## Guardrails

- Rate limits are applied per host and robots-friendly pacing is used. If a host returns 429, its sources are rescheduled rather than marked as failed.
- No LinkedIn scraping. Only business data is stored; enrichment keeps role inboxes only (sales@, hello@) and never personal contacts.
- API keys stay server-side in `.env` and never reach the browser.

## Tests

There are no automated tests yet.

## API

`GET /api/brief`, `POST /api/brief/ack`, `GET /api/leads?q&sector&stage&minScore&status&days&intl&sort`, `GET /api/leads/:id`, `PATCH /api/leads/:id {status,notes,feedback}`, `POST /api/leads/:id/enrich`, `POST /api/leads/:id/lookalike`, `GET /api/leads.csv`, `GET /api/intel`, `GET|POST|PATCH|DELETE /api/sources`, `POST /api/scan`, `POST /api/agent/run`, `GET|PUT /api/config`, `POST /api/config/preview`, `GET /api/stream` (SSE).

The original single-file prototype is in `legacy/`.

## Deploy on Railway

1. Push this folder to a Git repo (`data/` and `.env` are git-ignored) and create a Railway project from it. `railway.json` sets the start command, the `/api/health` healthcheck and a single replica.
2. **Add a Volume** to the service, mounted at `/data`. The SQLite DB lives there (picked up automatically via `RAILWAY_VOLUME_MOUNT_PATH`, or set `DB_PATH=/data/leadintel.db`). Without a volume, all data is lost on every deploy.
3. **Variables** (service > Variables):
   - `AUTH_PASSWORD` (required). Users get a branded password-only sign-in page and a 30-day session cookie; `/api/health` stays open. Optionally set `SESSION_SECRET` (changing it or the password signs everyone out).
   - `GEMINI_API_KEY`, `GEMINI_MODEL` (optional but recommended).
   - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (recommended; anonymous Reddit is often blocked from cloud IPs).
   - Do not set `PORT`; Railway provides it.
4. Generate a public domain under Settings > Networking.
5. Keep it at **one replica**: SQLite and the in-process schedulers are not safe to run twice.
