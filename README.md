<div align="center">

# 🕸️ Multi-Platform Review Scraper Engine

**A production-grade, database-driven scraping pipeline that discovers, harvests, and normalizes business reviews from six major platforms — Google Maps, Clutch, Trustpilot, G2, GoodFirms, and Yelp.**

[![Node](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Type](https://img.shields.io/badge/type-ESM-blue)](package.json)
[![Postgres](https://img.shields.io/badge/Postgres-multi--env-336791?logo=postgresql&logoColor=white)](db.js)
[![Puppeteer](https://img.shields.io/badge/Puppeteer-stealth-40B5A4?logo=puppeteer&logoColor=white)](package.json)
[![Camoufox](https://img.shields.io/badge/Camoufox-anti--bot-orange)](src/python/scrape-g2-camoufox.py)
[![License](https://img.shields.io/badge/license-private-lightgrey)](#)

</div>

---

## What this is

This repo is the review-data backbone for a multi-environment (local → dev → staging → production) platform. It doesn't just scrape one site — it runs an entire **pipeline**: discover a company's profile URL on each review platform, validate it against the company's known website, scrape every review that platform will give up, normalize it into a common shape, and upsert it into Postgres — with deduplication, resume-on-crash, proxy rotation, and stealth evasion baked in at every stage.

It ships in two operating modes:

- **Database-driven batch mode** — reads companies from a `companies` table, scrapes across all six platforms, writes structured rows into a `reviews` table. This is what runs in production and via cron.
- **Standalone CLI mode** — point any single scraper at one URL and get a clean JSON file back. Useful for debugging, spot-checks, and one-off pulls without touching the database.

Everything is orchestrated through one HTTP server that also does **automatic, zero-config database routing** based on the domain the request came from.

---

## ✨ Highlights

| | |
|---|---|
| 🎯 **6 platforms, 1 pipeline** | Google Maps, Clutch, Trustpilot, G2, GoodFirms, Yelp — discovery + scraping for each |
| 🧠 **Self-healing discovery** | Finds each company's platform profile by searching + validating against its real website domain, no manual URL hunting |
| 🗄️ **4-environment DB routing** | Local / Development / Staging / Production Postgres pools, auto-selected per HTTP request by hostname |
| 🌐 **Fire-and-forget job server** | One HTTP API triggers background scrape/discovery jobs and tracks their status by job ID |
| 🕶️ **Layered anti-bot defense** | `puppeteer-extra-stealth`, residential proxy rotation (Webshare), Camoufox for the hardest targets (G2), asset blocking, human-like jitter |
| 💾 **Crash-safe everywhere** | Atomic tmp→rename JSON writes, resumable scrapes, deduped-by-ID review batches, DB source tracking that detects moved/changed profile URLs |
| ⏱️ **Cron-ready** | Lock-file-guarded shell script for unattended, non-overlapping scheduled runs |
| 🔍 **Category importers** | Bulk-seed the companies table straight from Clutch/GoodFirms category directory listings |

---

## 🏗️ Architecture

```
                         ┌─────────────────────────────┐
                         │   scrape-url-server.js       │   HTTP API (port 8787)
                         │   domain-based DB routing     │   /scrape/*  /discover/*  /jobs
                         └───────────────┬───────────────┘
                                         │ spawns (fire-and-forget)
                                         ▼
              ┌──────────────────────────────────────────────────┐
              │       src/scrape-google-maps-from-db.js            │
              │       the unified batch orchestrator                │
              │  • reads companies from Postgres                    │
              │  • maps each platform URL → PLATFORM_CONFIG          │
              │  • spawns one child scraper process per company/platform
              │  • normalizes + dedupes + upserts into `reviews`     │
              └───────┬───────────┬───────────┬───────────┬────────┘
                      │           │           │           │
           ┌──────────┘   ┌───────┘   ┌───────┘   ┌───────┘ ...
           ▼              ▼           ▼           ▼
   scrape-google-    scrape-clutch- scrape-trust- scrape-good-   scrape-yelp-
   maps-network.js   network.js     pilot-        firms-         network.js
                                    network.js     network.js
        (src/network/*.js — the production, proxy-aware, DB-writing scrapers)

   src/python/scrape-g2-camoufox.py  →  G2 handled separately via Camoufox
                                          (Cloudflare-grade anti-bot on G2)

   src/discovery/*.js  →  find + validate profile URLs, write back to `companies`
   src/ui/*.js         →  standalone single-URL CLI scrapers → JSON files (no DB)
   src/category-import/*.js → bulk-seed `companies` from category directory pages
```

### The two scraper "families"

| Folder | Purpose | Output | Proxy-aware |
|---|---|---|---|
| `src/network/` | Production scrapers, driven by the DB orchestrator | Writes to Postgres `reviews` table | ✅ Yes (Webshare rotation) |
| `src/ui/` | Standalone CLI tools for one URL at a time | Writes atomic JSON to `outputs/` | Varies |
| `src/discovery/` | Finds & validates platform profile URLs per company | Writes URL columns back to `companies` | ✅ Yes |
| `src/category-import/` | Crawls category/directory listing pages to discover new companies | Inserts new rows into `companies` | Stealth plugin |
| `src/python/` | Camoufox-based scraper for the hardest anti-bot target (G2) | JSON / optional direct Postgres via `psycopg` | ✅ Yes, with burn-tracking |

---

## 📦 Tech stack

- **Runtime:** Node.js 20+, native ESM (`"type": "module"`)
- **Browser automation:** `puppeteer` / `puppeteer-core` + `puppeteer-extra` with `puppeteer-extra-plugin-stealth`
- **Hard-target automation:** Python + [Camoufox](https://github.com/daijro/camoufox) (anti-detect Firefox) for G2
- **HTTP scraping:** `got-scraping` for lightweight requests where a full browser isn't needed
- **Database:** PostgreSQL via `pg`, with per-environment connection pools
- **Config:** `dotenv`, `minimist` for CLI flag parsing
- **Orchestration:** Node's built-in `http` + `child_process.spawn` (no framework — deliberately minimal)

---

## 🚀 Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in at minimum your local Postgres credentials (`DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`) and the path to Chrome:

```bash
CHROME_PATH=/usr/bin/google-chrome-stable
```

> Requires Chrome/Chromium installed at that path. Override per-command with `CHROME_PATH=/path/to/chrome npm run scrape -- --url '...'`.

### 3. Verify the DB connection

```bash
node test.js
node test-env-routing.js
```

### 4. Run a scrape

```bash
# Single Google Maps place, JSON output
npm run scrape -- --url 'https://www.google.com/maps/place/...'

# Whole DB, every platform, straight into Postgres
npm run scrape:db:all
```

---

## 🗄️ Multi-environment database routing

This is one of the more distinctive pieces of the codebase: **the same running server can write to four different Postgres databases**, chosen automatically per request — no redeploys, no separate server instances per environment.

| Environment | Configured via |
|---|---|
| **Local** | `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` |
| **Development** | `DEV_DB_HOST` / `DEV_DB_PORT` / `DEV_DB_USER` / `DEV_DB_PASSWORD` / `DEV_DB_NAME` |
| **Staging** | `STAGING_DB_HOST` / `STAGING_DB_PORT` / `STAGING_DB_USER` / `STAGING_DB_PASSWORD` / `STAGING_DB_NAME` |
| **Production** | `PROD_DB_HOST` / `PROD_DB_PORT` / `PROD_DB_USER` / `PROD_DB_PASSWORD` / `PROD_DB_NAME` |

### How the environment is chosen

**Over HTTP** (`npm run scrape:url:server`), [src/request-db-env.js](src/request-db-env.js) inspects, in priority order:

1. `x-forwarded-host` header
2. `host` header
3. `origin` header
4. `referer` header

...and matches the hostname against `LOCAL_DOMAINS` / `DEV_DOMAINS` / `STAGING_DOMAINS` / `PROD_DOMAINS`. If nothing matches an explicit list, it falls back to hostname heuristics (`dev.*` → development, `stage.*`/`uat.*` → staging, `prod.*`/`live.*` → production), and only then to a static default. Set `DEFAULT_DB_ENV=automatic` to make routing **strict** — unmatched domains get a `400` instead of silently falling back to local.

The resolved environment is passed straight through to the spawned scraper child process, so a request from `staging.example.com` scrapes into the staging DB, end-to-end, with no manual flag.

**On the CLI / cron** (no HTTP request to inspect), scrapers default to the **local** DB. Force a different target explicitly:

```bash
DB_ENV=production npm run scrape:db:all
```

Valid values: `local`, `development` (`dev`), `staging` (`stage`, `uat`, `preprod`), `production` (`prod`, `live`).

Routing logic is unit-tested in [test-env-routing.js](test-env-routing.js) — run it any time you touch domain lists.

---

## 🌐 The job server

```bash
npm run scrape:url:server
```

Starts an HTTP API on `SCRAPE_HOST:SCRAPE_PORT` (defaults `0.0.0.0:8787`). All scrape/discovery routes respond **immediately with `202`** and stream real work through a background child process — check on it via the job ID.

### Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/jobs` | List all tracked jobs (running/done/failed) |
| `GET` | `/jobs/:jobId` | Status of one job |
| `POST` | `/scrape/all` | Scrape every company, every platform |
| `POST` | `/scrape/:company/all` | Scrape one company (by slug), every platform it has URLs for |
| `POST` | `/scrape/:company/:platform` | Scrape one company on one platform |
| `POST` | `/discover/all` | Run URL discovery for every company, every platform |
| `POST` | `/discover/:company/all` | Discover profile URLs for one company, every platform |
| `POST` | `/discover/:company/:platform` | Discover a profile URL for one company on one platform |

**Query params (scrape routes):** `maxReviews`, `headful`, `limit`, `fromId`, `dryRun`
**Query params (discover routes):** `limit`, `fromId`, `headful`, `dryRun`

```bash
curl -X POST 'http://127.0.0.1:8787/scrape/acme-inc/clutch?maxReviews=500'
curl -X POST 'http://127.0.0.1:8787/discover/acme-inc/all'
curl 'http://127.0.0.1:8787/jobs/job-1735689600000'
```

Duplicate in-flight requests (same company + platform + environment) are **deduped** — hitting the same route twice while a job is running returns the existing job instead of double-spawning.

---

## 🔎 Discovery scrapers

Before you can scrape a company's reviews on a given platform, you need that platform's profile URL. Discovery scrapers automate that hunt: they search the platform for the company by name, extract candidate profile links, **validate each candidate against the company's known website domain**, and only then write the URL back to the `companies` table.

| Platform | Search strategy | Saves to column |
|---|---|---|
| **Google Maps** | Google web search → clicks the Maps preview panel → extracts place URL | `google_review_url` |
| **Clutch** | Direct `clutch.co/search?q=...` → visits candidates → resolves redirect → compares domain | `clutch_review_url` |
| **Trustpilot** | Direct `trustpilot.com/search?query=...` → "Visit website" link comparison | `trustpilot_review_url` |
| **GoodFirms** | Direct `goodfirms.co/search/companies` → exact name filter → website validation | `goodfirms_review_url` |

```bash
npm run scrape:google:discovery -- --limit 50 --fromId 10
npm run scrape:clutch:discovery -- --limit 1 --headful --debug
npm run scrape:trustpilot:discovery -- --limit 100
npm run scrape:goodfirms:discovery -- --fromId 500
```

Every discovery script accepts `--limit`, `--fromId`, `--headful`, `--dryRun`, and (Clutch/Trustpilot/GoodFirms) `--debug` for screenshot capture. Full behavior, database schema expectations, and troubleshooting notes live in **[discovery.md](discovery.md)**.

---

## 🧵 Unified batch scraping

```bash
npm run scrape:db:all                                # every company, every platform
npm run scrape:db:all -- --platforms google,clutch    # just these platforms
npm run scrape:db:all -- --companyId 42               # just this company
npm run scrape:db:all -- --limit 25 --fromId 100      # paginate through the table
npm run scrape:db:all -- --dryRun                     # preview, no DB writes
```

[src/scrape-google-maps-from-db.js](src/scrape-google-maps-from-db.js) is the heart of the pipeline. Per platform it:

1. Pulls companies with a non-null URL in that platform's column
2. Validates the URL actually matches the platform (regex per platform, e.g. `g2.com/products/...`)
3. Spawns the matching `src/network/*` scraper as a child process against a temp JSON file
4. Normalizes the scraped payload into a canonical **source key** (e.g. Clutch → `slug:company-name`, Google → `cid:<place-id>`) so the same company can never get duplicate rows even if the URL format changes
5. Detects when a company's source URL has changed and **clears stale reviews** for the old source before writing new ones
6. Tracks every (company, platform, source_key) combination in `company_platform_sources` for consistency across runs
7. Upserts normalized reviews into the `reviews` table, tagged with `platform`

This is what `npm run scrape:db:all` and the `/scrape/*` HTTP routes both ultimately drive.

---

## 🛠️ Per-platform standalone scrapers

Each platform also has a direct, single-URL CLI entry point that writes clean JSON to disk — no database required. Good for debugging a specific profile or grabbing data ad hoc.

### Google Maps
```bash
npm run scrape -- --url 'https://www.google.com/maps/place/...'
npm run scrape:resume -- --url 'https://www.google.com/maps/place/...'   # continue a stalled run
```
> Always wrap Google Maps URLs in **single quotes** — they contain `!` characters bash will mangle inside double quotes.

### Clutch
```bash
npm run scrape:clutch:ui -- --url 'https://clutch.co/profile/...' --maxReviews 200
```

### Trustpilot
```bash
npm run scrape:trustpilot -- --url 'https://www.trustpilot.com/review/setalarmclock.net' --maxReviews 200
npm run scrape:trustpilot -- --url '...' --all   # everything available
```

### GoodFirms
```bash
npm run scrape:goodfirms:ui -- --url 'https://www.goodfirms.co/company/closeloop-technologies' --maxReviews 200
```
Pulls the review-analytics block, "what users say," strengths/weaknesses, and the full paginated `#reviews_list`.

### Yelp
```bash
npm run scrape:yelp:ui -- --url 'https://www.yelp.com/biz/answering-legal-nesconset#reviews' --maxReviews 200
npm run scrape:yelp:ui -- --url '...' --all
```
Follows Yelp's `?start=10,20,...` pagination; captures reviewer profile, text, rating, date, and reaction counts.

### G2 (Camoufox)
```bash
python3 src/python/scrape-g2-camoufox.py --url 'https://www.g2.com/products/quickbase/reviews#reviews' --maxReviews 200
```
G2 sits behind Cloudflare-grade bot detection, so it's handled outside the Node/Puppeteer stack entirely by a Python [Camoufox](https://github.com/daijro/camoufox) worker with session rotation and 403 backoff (see below).

---

## 🕵️ Anti-bot & anti-detection layers

Scraping six independent platforms at scale means six independent sets of defenses to respect. This repo layers several tools depending on how aggressive a given target is:

- **`puppeteer-extra-plugin-stealth`** — patches the usual headless-browser tells (used in category-import and several UI scrapers)
- **Residential proxy rotation** — Webshare-backed, two modes:
  - `rotate`: single gateway credential (`<prefix>-rotate`) that auto-rotates IP per request
  - `list`: round-robins through N static proxy credentials (`<prefix>-1` … `<prefix>-N`)
  - configured centrally in [src/utils/proxyManager.js](src/utils/proxyManager.js) and per-platform via `GMAPS_USE_PROXY`, `CLUTCH_USE_PROXY`, etc.
- **Asset blocking** (`--blockAssets`) — strips images/fonts for faster, lighter page loads
- **Human-like jitter** — randomized delays between page navigations and searches to avoid rate-limit fingerprinting
- **Persistent Chrome profiles** — `.gmaps-profile/` (and per-scraper equivalents) retain cookies/session state across runs so each run doesn't look like a fresh, suspicious visitor
- **Camoufox + session rotation** (G2 only) — rotates the entire browser+proxy pairing every `MAX_PAGES_PER_SESSION` (40) pages, tracks "burned" proxies, and backs off 45s on a `403` / 20s on a CAPTCHA before retrying with a fresh identity

### Proxy configuration (`.env`)

```bash
PROXY_MODE=rotate            # rotate | list | none
PROXY_PASSWORD=...
PROXY_HOST=p.webshare.io
PROXY_PORT=80
PROXY_USER_PREFIX=virtualassistants
PROXY_COUNT=10

# Static pool for Google Maps / other network scrapers:
GMAPS_PROXY_POOL=[["host","port","user","pass"], ...]
GMAPS_USE_PROXY=1
CLUTCH_USE_PROXY=1
```

---

## 📂 Category import (directory seeding)

Bulk-discover **new** companies straight from a platform's category/directory pages, rather than scraping reviews for companies you already have:

```bash
npm run scrape:clutch:category -- --url 'https://clutch.co/it-services' --pages 5
npm run scrape:goodfirms:category -- --url 'https://www.goodfirms.co/directory/...' --pages 5
```

These walk paginated directory listings, extract company name + resolved website (following Clutch's redirect-wrapped links where needed), and insert new rows into the `companies` table — the seed data that every discovery/scrape step downstream depends on.

---

## ⏰ Scheduled runs (cron)

[run-scrape-db-cron.sh](run-scrape-db-cron.sh) is a lock-file-guarded wrapper safe for unattended scheduling:

```bash
*/30 * * * * /var/www/html/va-scrapper/run-scrape-db-cron.sh >> /var/www/html/va-scrapper/logs/cron.log 2>&1
```

It uses `flock` to skip a run entirely if the previous one is still in progress (no overlapping scrapes fighting over the same Chrome profile), then runs the unified DB batch across Google/Clutch/Trustpilot/G2, followed by a dedicated GoodFirms pass.

> Note: the script's `PROJECT_DIR` currently points at `/var/www/html/va-scrapper` — update it to match wherever this repo is actually deployed.

---

## ⚙️ CLI flags reference

Common across most scrapers (`src/ui/*`, `src/network/*`):

| Flag | Default | Description |
|---|---|---|
| `--url <url>` | *(required for single-URL scrapers)* | Target profile/place URL |
| `--maxReviews N` | `3000` (Google) / varies | Stop after N reviews |
| `--all` | — | Scrape everything available, ignore the cap |
| `--out <file.json>` | — | Exact output file path |
| `--outDir <dir>` | `outputs/<platform>` | Auto-named output folder |
| `--resume` | `true` | Load existing output, dedupe, continue |
| `--noResume` | — | Start fresh, ignore any existing file |
| `--headful` | — | Show the browser window (debugging) |
| `--userDataDir <dir>` | `.gmaps-profile` / platform-specific | Chrome profile directory |
| `--blockAssets` | `true` | Block images/fonts for speed |
| `--noBlockAssets` | — | Load all page assets |

Batch/discovery-specific:

| Flag | Description |
|---|---|
| `--limit N` | Process at most N companies |
| `--fromId N` | Start from company id ≥ N |
| `--companyId N` | Process exactly one company |
| `--platforms a,b,c` | Restrict to specific platforms |
| `--dryRun` | Preview only, no DB writes |
| `--debug` | Save debug screenshots (discovery scripts) |

Run any script with `--help` for its exact supported flags.

---

## 📤 Output format

Standalone scrapers write to `outputs/<place-slug>-<id>.json`:

```json
{
  "place": {
    "name": "Apple Fifth Avenue",
    "overallRating": 4.4,
    "totalReviews": 12300,
    "category": "Electronics store",
    "address": "767 5th Ave, New York, NY 10153",
    "phone": "+1 212-336-1440",
    "website": "https://www.apple.com/...",
    "cid": "5751...",
    "scrapedAt": "2026-08-26T..."
  },
  "reviewsCount": 880,
  "targetReviews": 3000,
  "done": false,
  "reason": null,
  "reviews": [ /* ... */ ]
}
```

`"done": false` with `"reason": "stalled_or_blocked"` means: rerun with `--resume` to pick up where it left off.

---

## 🛡️ Resilience features

| Feature | How |
|---|---|
| **Resume** | Loads existing JSON, dedupes by `reviewId`, continues from where it stopped |
| **Crash-safe writes** | Every write is tmp-file → atomic rename — a killed process never corrupts output |
| **Batch flushing** | Progress is saved every 50 (or `GMAPS_FLUSH_EVERY`) new reviews, not just at the end |
| **Stall recovery** | Detects a stopped feed, reloads, retries up to 3× before giving up cleanly |
| **Pre-run backups** | Existing output is copied to `backups/` before each run touches it |
| **Source-change detection** | If a company's platform URL changes, stale reviews from the old source are cleared automatically |
| **Job dedup** | The HTTP server won't spawn a second identical job while one is already running |
| **Non-overlapping cron** | `flock`-based lock file prevents concurrent scheduled runs |

---

## ⚠️ Known gotchas

- **Profile locks** — Chrome locks its `--userDataDir` while running. Never run two scrapes against the same profile directory concurrently; use `--userDataDir .profile-1`, `.profile-2`, etc. for parallel runs.
- **Quote your URLs** — Google Maps URLs contain `!`, which bash expands inside double quotes. Always use single quotes.
- **G2 challenges** — Cloudflare/CAPTCHA walls are expected. The Camoufox script handles this with session rotation; if you're still blocked, try `--headful` with a persistent profile.
- **Strict domain routing** — with `DEFAULT_DB_ENV=automatic`, an HTTP request from an unrecognized domain is rejected outright (`400`) rather than silently falling back to a database you didn't intend.
- **Stall screenshots** — saved to `screenshots/stall-<timestamp>.png`. Consistent stalls at the same review count usually mean you're being rate-limited — wait a few minutes and resume.

---

## 📁 Project layout

```
.
├── db.js                          # Multi-environment Postgres pool manager
├── scrape-url-server.js           # HTTP job server + domain-based DB routing
├── run-scrape-db-cron.sh          # Lock-guarded cron entry point
├── discovery.md                   # Deep-dive docs for discovery scrapers
├── src/
│   ├── scrape-google-maps-from-db.js   # Unified batch orchestrator (PLATFORM_CONFIG)
│   ├── request-db-env.js               # Domain → environment resolution logic
│   ├── network/                        # Production, DB-writing, proxy-aware scrapers
│   ├── ui/                             # Standalone single-URL CLI scrapers → JSON
│   ├── discovery/                      # Profile-URL discovery + validation
│   ├── category-import/                # Directory/category page → new companies
│   ├── python/                         # Camoufox-based G2 scraper
│   └── utils/proxyManager.js           # Webshare proxy rotation helper
├── test.js                        # Quick DB connectivity check
└── test-env-routing.js            # Unit tests for domain→environment routing
```

---

## 🧪 Testing

```bash
node test.js                 # confirms the active DB pool can connect
node test-env-routing.js     # asserts hostname → environment resolution rules
```

---

<div align="center">

Built for high-volume, multi-tenant review aggregation across a rotating cast of hostile-to-scrapers platforms — so the pipeline does the fighting, not you.

</div>
