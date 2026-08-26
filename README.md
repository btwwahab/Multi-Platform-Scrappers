# Google Maps Reviews Scraper

Node.js + Puppeteer scraper for Google Maps place reviews.

---

## Install

```bash
npm install
```

---

## Dynamic DB selection (Dev vs Prod)

This repo supports four Postgres environments:

- **Local DB** (your machine): configured via `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`
- **Development DB** (server): configured via `DEV_DB_HOST/DEV_DB_PORT/DEV_DB_USER/DEV_DB_PASSWORD/DEV_DB_NAME`
- **Staging DB** (server): configured via `STAGING_DB_HOST/STAGING_DB_PORT/STAGING_DB_USER/STAGING_DB_PASSWORD/STAGING_DB_NAME`
- **Production DB** (server): configured via `PROD_DB_HOST/PROD_DB_PORT/PROD_DB_USER/PROD_DB_PASSWORD/PROD_DB_NAME`

### Request-based routing (when using the URL server)

When you run `npm run scrape:url:server`, the server picks which DB to use **per incoming HTTP request** based on the request domain/URL headers:

- `x-forwarded-host` (preferred, if behind a proxy)
- `host`
- `origin`
- `referer`

Configure which domains map to which DB:

- `LOCAL_DOMAINS=localhost,127.0.0.1` (optional; defaults to these)
- `DEV_DOMAINS=localhost,dev.example.com`
- `STAGING_DOMAINS=staging.example.com`
- `PROD_DOMAINS=example.com,www.example.com`

The selected environment is passed into the background scraper job automatically (based on the incoming domain), so the spawned `src/scrape-google-maps-from-db.js` process writes into the same DB.
If the request domain does not match any configured environment, the server rejects the request instead of falling back.

### Non-HTTP runs (CLI / cron)

If you run DB scrapes directly (e.g. `npm run scrape:db:all` or via `run-scrape-db-cron.sh`), they use the local DB configuration by default.

If you intentionally want to target a different DB for a manual run, you can set `DB_ENV` to one of: `local`, `development`, `staging`, `production`.

> Requires Chrome/Chromium at `/usr/bin/google-chrome`  
> Override: `CHROME_PATH=/path/to/chrome npm run scrape -- --url '...'`

---

## Commands

### Google Maps: full scrape (up to 3000 reviews)
```bash
npm run scrape -- --url 'https://www.google.com/maps/place/...'
```

### Google Maps: resume interrupted scrape
```bash
npm run scrape:resume -- --url 'https://www.google.com/maps/place/...'
```

> **Always use single quotes** around the URL — Google Maps URLs contain `!` which bash treats specially in double quotes.

### Trustpilot: company reviews
```bash
npm run scrape:trustpilot -- --url 'https://www.trustpilot.com/review/setalarmclock.net' --maxReviews 200
```

To scrape everything available:
```bash
npm run scrape:trustpilot -- --url 'https://www.trustpilot.com/review/setalarmclock.net' --all
```

### G2: product reviews
```bash
npm run scrape:g2 -- --url 'https://www.g2.com/products/quickbase/reviews#reviews' --maxReviews 200
```

> G2 may show a bot challenge (Cloudflare / CAPTCHA). If that happens, rerun with a persistent profile + headful mode:
> ```bash
> npm run scrape:g2 -- --url 'https://www.g2.com/products/quickbase/reviews#reviews' --maxReviews 200 --headful --userDataDir .g2-profile
> ```

### GoodFirms: company reviews
```bash
npm run scrape:goodfirms -- --url 'https://www.goodfirms.co/company/closeloop-technologies' --maxReviews 200
```

The scraper pulls the review analytics section, what users say, strengths/weaknesses, and the paginated detailed reviews under `#reviews_list`.

#### GoodFirms: batch scrape from DB
If you have company GoodFirms URLs in the `goodfirms_review_url` column, scrape them all:
```bash
npm run scrape:goodfirms:db -- --limit 10
```

Reviews are upserted into the `reviews` table with `platform='goodfirms'`. Supports all standard flags:
- `--limit N` — process at most N companies
- `--fromId N` — start from company id >= N
- `--companyId N` — scrape only one company
- `--maxReviews N` — per-company review cap
- `--dryRun` — preview without writing DB
- `--headful` — show browser window

### Yelp: business reviews
```bash
npm run scrape:yelp -- --url 'https://www.yelp.com/biz/answering-legal-nesconset#reviews' --maxReviews 200
```

To scrape everything available:
```bash
npm run scrape:yelp -- --url 'https://www.yelp.com/biz/answering-legal-nesconset#reviews' --all
```

The scraper follows Yelp pagination (`?start=10,20,...`) and stores reviewer profile details, review text, rating, date, and reactions in output JSON.

> **Note:** GoodFirms is now part of the unified platform scraper (`scrape-google-maps-from-db.js`). It automatically processes all Google Maps, Clutch, Trustpilot, G2, and GoodFirms URLs found in the `companies` table. All scrapers share the same `PLATFORM_CONFIG` architecture for consistency and deduplication via `company_platform_sources` table.

---

## Unified Batch Scraping (All Platforms)

The main batch scraper reads company URLs from the **companies** table and processes them for multiple platforms in a single run:

```bash
# Scrape all platforms (default behavior)
npm run scrape:db:all

# Scrape specific platform(s)
npm run scrape:db:all -- --platforms google,clutch

# Scrape a specific company across all platforms
npm run scrape:db:all -- --companyId 42
```

The scraper handles:
- **URL validation** — only processes URLs matching each platform's URL pattern
- **Source deduplication** — tracks source URLs in `company_platform_sources` table to detect moved/changed URLs
- **Smart clearing** — automatically removes stale reviews when company URL changes, or when doing a full `--all` scrape
- **Source tracking** — maintains company_id + platform + source_key (e.g., "slug:mycompany") for consistency

---

## How it works

| Feature | Detail |
|---|---|
| **Resume** | Loads existing JSON, dedupes by `reviewId`, continues from where it stopped |
| **Crash-safe** | Atomic writes (tmp → rename) — file never corrupts mid-write |
| **Persistent profile** | Chrome profile saved to `.gmaps-profile/` — keeps cookies between runs |
| **Backup** | Existing output backed up to `backups/` before each run |
| **Batch saves** | Writes every 50 new reviews so progress is never lost |
| **Stall recovery** | Reloads page + retries up to 3× when feed stops loading |

---

## All CLI flags

| Flag | Default | Description |
|---|---|---|
| `--url <url>` | *(required)* | Google Maps place URL |
| `--maxReviews N` | `3000` | Stop after N reviews |
| `--all` | — | Scrape all available reviews |
| `--out <file.json>` | — | Exact output file path |
| `--outDir <dir>` | `outputs` | Auto-named file in this folder |
| `--resume` | `true` | Load existing + continue |
| `--noResume` | — | Start fresh, ignore existing file |
| `--headful` | — | Show browser window (for debugging) |
| `--userDataDir <dir>` | `.gmaps-profile` | Chrome profile directory |
| `--blockAssets` | `true` | Block images/fonts (faster) |
| `--noBlockAssets` | — | Allow all assets |

---

## Output format

```
outputs/<place-slug>-<cid>.json
```

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
    "plusCode": "Q27G+GR New York, USA",
    "pageUrl": "https://...",
    "cid": "5751...",
    "scrapedAt": "2026-04-03T..."
  },
  "reviewsCount": 880,
  "targetReviews": 3000,
  "done": false,
  "reason": null,
  "reviews": [ ... ]
}
```

**`done: false` + `reason: "stalled_or_blocked"`** → run again with `--resume` to continue.

---

## ⚠️ Profile lock

Chrome locks `.gmaps-profile` while running.  
**Never run two scrapes with the same `--userDataDir` at the same time.**  
Use different dirs for parallel scrapes:

```bash
npm run scrape -- --url '...' --userDataDir .profile-1
npm run scrape -- --url '...' --userDataDir .profile-2
```

---

## Diagnosing stalls

Stall screenshots are saved to `screenshots/stall-<timestamp>.png`.  
If stalling happens consistently at the same count, Google may be rate-limiting — wait a few minutes then resume.
