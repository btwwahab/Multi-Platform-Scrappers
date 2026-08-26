# Discovery Scrapers

Central documentation for all discovery scrapers. These scrapers help discover platform URLs by searching for companies and extracting review/profile URLs from search results.

## Overview

Discovery scrapers differ from standard scrapers in that they:
- Start with company name/website from the database
- Search platforms (Google, etc.) for the company
- Extract the platform-specific review/profile URL
- Save the URL back to the database for later use by standard scrapers
- Can now be triggered from the shared URL server using `/discover/...` routes
- Support both all-companies runs and single-company runs by company slug

### URL Server

Use the main server for both scraping and discovery:

```bash
npm run scrape:url:server
```

Discovery endpoints:

- `/discover/all` - discover all companies, all platforms
- `/discover/:company/all` - discover one company, all platforms
- `/discover/:company/:platform` - discover one company, one platform

Query params:

- `limit=N` - process at most N companies
- `fromId=N` - start from company id >= N
- `headful=true` - open browser in visible mode
- `dryRun=true` - do not update database

Example:

```bash
curl -X POST 'http://127.0.0.1:7500/discover/diesel-staffing/all'
```

When a single company is requested, the scraper receives `--companyId` and only processes that one company.

---

## Google Maps Discovery

Reads company data from your database, searches Google for each company, clicks the maps preview button in the search results, extracts the complete Google Maps company page URL, and saves it to the `companies.google_review_url` column.

### How it works

1. **Database Lookup**: Reads companies from the `companies` table where `google_review_url` is NULL
2. **Google Search**: Opens Google.com and searches for each company name
3. **Maps Preview**: Finds the maps location preview div (`id="lu_map"`) in the search results
4. **Click & Navigate**: Clicks the preview to navigate to the Google Maps company page
5. **URL Extraction**: Extracts the complete Google Maps URL
6. **Validation**: Verifies the extracted URL matches the company's website from the DB
7. **Database Update**: Updates the `companies.google_review_url` column with the validated URL

### Usage

```bash
# Run with defaults (process 50 companies, starting from id=0)
npm run scrape:google:discovery

# Process more companies
npm run scrape:google:discovery -- --limit 100

# Start from a specific company ID
npm run scrape:google:discovery -- --fromId 5

# Process just one company
npm run scrape:google:discovery -- --limit 1

# Show help
npm run scrape:google:discovery -- --help

# With all options
npm run scrape:google:discovery -- --limit 50 --fromId 10 --headful
```

### Options

- `--limit N` - Process at most N companies (default: 50)
- `--fromId N` - Start from company id >= N (default: 0)
- `--headful` - Open browser in visible mode (for debugging)
- `--dryRun` - Do not update database (for testing)
- `--help` - Show help message

### Database Schema

The scraper expects the following columns in your `companies` table:

- `id` - Company ID (primary key)
- `name` - Company name (used for Google search)
- `website` - Company website URL (used for validation)
- `google_review_url` - Column where the extracted Google Maps URL is saved
- `show_google_review` - `TRUE` to keep trying, `FALSE` to skip failed discovery, `NULL` for not yet processed
- `updated_at` - Timestamp (automatically updated)

### Features

- **Proxy Support**: Uses the proxy manager from `src/utils/proxyManager.js` for IP rotation
- **Error Recovery**: Automatically recovers from browser crashes
- **Rate Limiting**: Adds random delays between company searches to avoid rate limiting
- **URL Validation**: Verifies extracted URLs match the company website before saving
- **Progress Tracking**: Shows detailed progress with company IDs and status

### Example Output

```
================================================================================
Google Maps Discovery Scraper
================================================================================
Limit: 50
From ID: 0
Dry Run: false
================================================================================

[db] Fetching companies with NULL google_review_url...
[db] Found 3 companies to process

[1] Processing: Diesel Pro Staffing
  Website: https://www.dieselprostaffing.com
  [search] Searching for: Diesel Pro Staffing
  [search] Maps preview found, clicking...
  [search] Successfully navigated to Google Maps
  [search] URL: https://www.google.com/maps/place/Diesel+Pro+Staffing/@27.447415,-80.3231835,...
  [validation] URL matches website ✓
  [success] Found URL: https://www.google.com/maps/place/Diesel+Pro+Staffing/@27.447415,-80.3231835,...
  [db] Updated company 1 with URL

================================================================================
Summary
================================================================================
Total: 3
Success: 3
Failed: 0
================================================================================
```

### Troubleshooting

- **Maps preview not found**: Google search results may not show the maps preview for all companies. Try searching manually on Google to see if it appears.
- **URL validation failed**: The company name in search results may not exactly match the website domain. Manual verification may be needed.
- **Navigation timeout**: Network delays or bot detection may cause timeouts. The scraper will retry automatically.
- **Browser crashes**: The scraper will automatically restart the browser and continue.

### Environment Variables

The scraper uses environment variables from your `.env` file:

- Database configuration: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- Chrome path: `CHROME_PATH` (defaults to `/usr/bin/google-chrome-stable`)
- Proxy configuration: `PROXY_POOL` (JSON array format for proxy rotation)

---

## Clutch Discovery

Reads company data from your database, searches Clutch.co for each company, iterates through the search results to find a profile with a matching website URL, and saves the matching profile URL to the `companies.clutch_review_url` column.

### How it works

1. **Database Lookup**: Reads companies from the `companies` table where `clutch_review_url` is NULL.
2. **Clutch Search**: Directly navigates to `clutch.co/search?q=CompanyName`.
3. **Profile Extraction**: Extracts all profile links from the search results.
4. **Website Validation**: Visits each profile one by one, extracts the actual website link (resolving redirects if necessary), and validates it against the company's website from the DB.
5. **Database Update**: If a match is found, updates the `companies.clutch_review_url` column with the validated profile URL.
6. **Skip/Continue**: If no profiles match, it skips the company.

### Usage

```bash
# Run with defaults (process 50 companies, starting from id=0)
npm run scrape:clutch:discovery

# Process more companies
npm run scrape:clutch:discovery -- --limit 100

# Start from a specific company ID
npm run scrape:clutch:discovery -- --fromId 5

# Process just one company for testing
npm run scrape:clutch:discovery -- --limit 1 --headful --debug
```

### Options

- `--limit N` - Process at most N companies (default: 50)
- `--fromId N` - Start from company id >= N (default: 0)
- `--headful` - Open browser in visible mode (for debugging)
- `--dryRun` - Do not update database (for testing)
- `--debug` - Save screenshots for debugging
- `--help` - Show help message

### Database Schema

The scraper expects the following columns in your `companies` table:

- `id` - Company ID (primary key)
- `name` - Company name (used for Clutch search)
- `website` - Company website URL (used for validation)
- `clutch_review_url` - Column where the extracted Clutch profile URL is saved
- `show_clutch_review` - `TRUE` to keep trying, `FALSE` to skip failed discovery, `NULL` for not yet processed

---

## Trustpilot Discovery

Reads company data from your database, searches Trustpilot for each company, iterates through the search results to find a profile with a matching website URL, and saves the matching profile URL to the `companies.trustpilot_review_url` column.

### How it works

1. **Database Lookup**: Reads companies from the `companies` table where `trustpilot_review_url` is NULL.
2. **Trustpilot Search**: Directly navigates to `www.trustpilot.com/search?query=CompanyName`.
3. **Profile Extraction**: Extracts all profile links from the search results using the business-unit-card selector.
4. **Website Validation**: Visits each profile one by one, extracts the website link via the "Visit website" button, and validates it against the company's website from the DB.
5. **Database Update**: If a match is found, updates the `companies.trustpilot_review_url` column with the validated profile URL.
6. **Skip/Continue**: If no profiles match, it skips the company.

### Usage

```bash
# Run with defaults (process 50 companies, starting from id=0)
npm run scrape:trustpilot:discovery

# Process more companies
npm run scrape:trustpilot:discovery -- --limit 100

# Start from a specific company ID
npm run scrape:trustpilot:discovery -- --fromId 5

# Process just one company for testing
npm run scrape:trustpilot:discovery -- --limit 1 --headful --debug
```

### Options

- `--limit N` - Process at most N companies (default: 50)
- `--fromId N` - Start from company id >= N (default: 0)
- `--headful` - Open browser in visible mode (for debugging)
- `--dryRun` - Do not update database (for testing)
- `--debug` - Save screenshots for debugging
- `--help` - Show help message

### Database Schema

The scraper expects the following columns in your `companies` table:

- `id` - Company ID (primary key)
- `name` - Company name (used for Trustpilot search)
- `website` - Company website URL (used for validation)
- `trustpilot_review_url` - Column where the extracted Trustpilot profile URL is saved
- `show_trustpilot_review` - `TRUE` to keep trying, `FALSE` to skip failed discovery, `NULL` for not yet processed

---

## GoodFirms Discovery

Reads company data from your database, searches GoodFirms for each company, filters by exact name match, visits the matched profile, validates the website URL, and saves the profile URL to `companies.goodfirms_review_url`.

### How it works

1. **Database Lookup**: Reads companies where `goodfirms_review_url` is NULL.
2. **GoodFirms Search**: Navigates to `goodfirms.co/search/companies?query=CompanyName`.
3. **Name Filter**: Extracts all `.firm-wrapper` cards, skips any where displayed name doesn't match DB company name.
4. **Profile Visit**: For name-matched cards only, visits the profile page.
5. **Website Validation**: Extracts the "Visit website" button URL, compares domain with DB `website`.
6. **Database Update**: If match found, saves profile URL to `goodfirms_review_url`.

### Usage

```bash
# Run with defaults
npm run scrape:goodfirms:discovery

# Process a limited number
npm run scrape:goodfirms:discovery -- --limit 10

# Start from a specific ID
npm run scrape:goodfirms:discovery -- --fromId 500

# Test one company with browser open
npm run scrape:goodfirms:discovery -- --limit 1 --fromId 509 --headful --debug
```

### Options

- `--limit N` - Process at most N companies (default: 50)
- `--fromId N` - Start from company id >= N (default: 0)
- `--headful` - Open browser in visible mode (for debugging)
- `--dryRun` - Do not update database (for testing)
- `--debug` - Save screenshots for debugging
- `--help` - Show help message

### Database Schema

- `id` - Company ID (primary key)
- `name` - Company name (used for GoodFirms search & name match)
- `website` - Company website URL (used for validation)
- `goodfirms_review_url` - Column where the extracted GoodFirms profile URL is saved
- `show_goodfirms_review` - `TRUE` to keep trying, `FALSE` to skip failed discovery, `NULL` for not yet processed

---

## Other Discoveries

*More discovery scrapers coming soon...*
