# PayGlocal Lead Tracker — MVP

Open `index.html` in a browser. The workspace uses localStorage only.

- `index.html` — complete UI + filters + scoring display + local config editor + JSON import + local scan simulation.
- `leads.json` — seed data; replace/import with real pipeline output.
- `config.json` — default scoring/source/keyword configuration.

The live Firecrawl/RSS pipeline is intentionally not embedded in the browser because API keys should not live in client-side HTML. A later local `scan.py`/Node script can write `leads.json`, then use **Import JSON**.
