import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import minimist from 'minimist';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pool from '../../db.js';

// Use stealth plugin to evade bot detection
puppeteer.use(StealthPlugin());

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

// Rotate profile daily to avoid fingerprint buildup
const PROFILE_DIR = path.join(
    process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
    '.cache',
    'va-scrapper',
    'google-discovery-profile-' + Math.floor(Date.now() / 86_400_000)
);

const NAV_TIMEOUT = 90_000;
const SEARCH_TIMEOUT = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const now = () => new Date().toISOString();
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

async function ensureScreenshotDir() {
  const screenshotDir = path.join(process.cwd(), 'outputs', 'discovery-debug');
  await fs.mkdir(screenshotDir, { recursive: true });
  return screenshotDir;
}

async function saveScreenshot(page, filename, debug) {
  if (!debug) return;
  try {
    const screenshotDir = await ensureScreenshotDir();
    const filepath = path.join(screenshotDir, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`  [debug] Screenshot saved: ${filepath}`);
  } catch (e) {
    console.log(`  [debug] Failed to save screenshot: ${e.message}`);
  }
}

function parseArgs(argv) {
  const a = minimist(argv.slice(2), {
    boolean: ['headful', 'help', 'dryRun', 'debug'],
    string: ['limit', 'fromId', 'companyId'],
    default: {
      limit: 50,
      fromId: 0,
      companyId: null,
      headful: false,
      dryRun: false,
      debug: false,
    },
  });

  if (a.help) {
    console.log(
        'Usage: node src/discovery/scrape-google-discovery.js [options]\n' +
        '  --companyId N   Process only company with id=N (default: process all)\n' +
        '  --limit N       Process at most N companies (default: 50)\n' +
        '  --fromId N      Start from company id >= N (default: 0)\n' +
        '  --headful       Open browser in visible mode\n' +
        '  --debug         Save screenshots for debugging\n' +
        '  --dryRun        Do not update database\n' +
        '  --help          Show this help message\n'
    );
    process.exit(0);
  }

  a.companyId = a.companyId ? Number(a.companyId) : null;
  a.limit = Math.max(1, Number(a.limit) || 50);
  a.fromId = Math.max(0, Number(a.fromId) || 0);

  return a;
}

function extractDomainFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname || null;
  } catch {
    return null;
  }
}

// ── Clean domain helper (strips www, lowercases) ──────────────────────────────
function cleanDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// ── Domain match check ────────────────────────────────────────────────────────
function doDomainsMatch(domainA, domainB) {
  if (!domainA || !domainB) return false;
  return (
      domainA === domainB ||
      domainA.includes(domainB) ||
      domainB.includes(domainA)
  );
}

function validateUrlMatch(dbWebsiteUrl, mapsWebsiteUrl) {
  if (!dbWebsiteUrl || !mapsWebsiteUrl) return false;
  const dbDomain = cleanDomain(dbWebsiteUrl);
  const mapsDomain = cleanDomain(mapsWebsiteUrl);
  return doDomainsMatch(dbDomain, mapsDomain);
}

// ── Extract website link from the currently open Maps place panel ─────────────
async function extractWebsiteFromMapsPage(page) {
  try {
    await sleep(jitter(2000, 3000));
    const website = await page.evaluate(() => {
      const selectors = [
        'a[data-item-id="authority"]',
        'a[aria-label^="Website"]',
        'a[aria-label="Open website"]',
        'a[data-tooltip="Open website"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el?.href) return el.href;
      }
      // Fallback: any external link inside the main place panel
      const all = Array.from(document.querySelectorAll('a[href^="http"]'));
      const external = all.find(
          (a) =>
              !a.href.includes('google.com') &&
              !a.href.includes('goo.gl') &&
              a.closest('[role="main"]')
      );
      return external?.href || null;
    });
    return website;
  } catch (error) {
    console.log(`  [extract] Error extracting website: ${error.message}`);
    return null;
  }
}

async function launchBrowser(headful = false) {
  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--lang=en-US,en',

    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',

    '--disable-infobars',
    '--exclude-switches=enable-automation',
    '--disable-extensions-except=',

    '--disable-web-resources',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
  ];

  const browser = await puppeteer.launch({
    headless: !headful ? 'new' : false,
    executablePath: CHROME,
    userDataDir: PROFILE_DIR,
    args,
    defaultViewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  const ver = (await browser.version()).split('/')[1] || '126.0.0.0';

  const userAgents = [
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`,
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`,
    `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`,
  ];

  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  await page.setUserAgent(userAgent);

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  });

  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    if (window.chrome) {
      window.chrome.runtime = {};
    }
  });

  console.log('[proxy] Disabled (no proxy used in this scraper)');

  return { browser, page };
}

// ── Extract and force the full /place/ URL ────────────────────────────────────
async function extractCompleteMapUrl(page) {
  try {
    await sleep(2000);

    let currentUrl = page.url();

    if (currentUrl.includes('/place/') || currentUrl.includes('cid=')) {
      return currentUrl;
    }

    console.log(`  [maps] URL does not look like a /place/ page: ${currentUrl}. Forcing URL update...`);

    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
      const targetTab =
          tabs.find(t => t.textContent.toLowerCase().includes('review') || t.textContent.toLowerCase().includes('reseña')) ||
          tabs.find(t => t.textContent.toLowerCase().includes('about') || t.textContent.toLowerCase().includes('acerca')) ||
          tabs[0];
      if (targetTab) targetTab.click();
    });

    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      currentUrl = page.url();
      if (currentUrl.includes('/place/') || currentUrl.includes('cid=')) {
        console.log(`  [maps] URL successfully updated to full place URL.`);
        return currentUrl;
      }
    }

    console.log(`  [maps] URL did not update after clicking tabs. Using search URL as fallback.`);
    return currentUrl;

  } catch (error) {
    console.log(`  [maps] Error extracting URL: ${error.message}`);
    return null;
  }
}

// ── Main search + navigation logic (covers all 3 scenarios) ──────────────────
//
//  Scenario A — Lands directly on a single /place/ page
//               (search term matched exactly one result)
//
//  Scenario B — Shows a results list with a preview panel already open
//               (first result auto-selected, panel visible on right)
//
//  Scenario C — Shows a plain results list, no panel open
//               (need to click each result and check website)
//
async function searchAndClickMapsPreview(page, companyName, website, debug = false) {
  console.log(`  [search] Searching on Google Maps for: ${companyName}`);

  const targetDomain = cleanDomain(website);

  try {
    const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(companyName)}`;
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT });
    await sleep(jitter(3000, 5000));

    // Scroll to trigger lazy loading
    await page.evaluate(() => {
      const sidebar = document.querySelector('[role="region"]');
      if (sidebar) sidebar.scrollTop = sidebar.scrollHeight;
    });
    await sleep(jitter(2000, 3000));

    if (debug) await saveScreenshot(page, `${companyName.replace(/\W+/g, '-')}-after-search.png`, debug);

    const currentUrl = page.url();
    console.log(`  [search] Current URL: ${currentUrl}`);

    // ── Scenario A: Landed directly on a single place page ───────────────────
    if (currentUrl.includes('/place/')) {
      console.log(`  [search] Scenario A: Landed directly on single place page`);

      // Wait for panel to fully render
      try {
        await page.waitForSelector('[role="main"]', { timeout: 10000 });
      } catch (e) { /* ignore */ }
      await sleep(jitter(3000, 6000));

      if (debug) await saveScreenshot(page, `${companyName.replace(/\W+/g, '-')}-single-place.png`, debug);

      // Still validate website matches before accepting
      const panelWebsite = await extractWebsiteFromMapsPage(page);
      if (!panelWebsite) {
        console.log(`  [search] Scenario A: No website found on place page`);
        return null;
      }

      const panelDomain = cleanDomain(panelWebsite);
      console.log(`  [search] Scenario A: panel=${panelDomain} target=${targetDomain}`);

      if (doDomainsMatch(panelDomain, targetDomain)) {
        console.log(`  [search] Scenario A: Website matches ✓`);
        return currentUrl;
      }

      console.log(`  [search] Scenario A: Website mismatch — falling through to result list`);
      // Don't return null yet; fall through to check the results list below
      // by navigating back
      await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(companyName)}`, {
        waitUntil: 'networkidle2',
        timeout: NAV_TIMEOUT,
      });
      await sleep(jitter(3000, 5000));
    }

    // ── Scenario B & C: Results list (panel may or may not be pre-opened) ────
    // Look for result items — try multiple selectors
    let resultSelector = 'a[href*="/maps/place/"]';
    let resultCount = await page.$$eval(resultSelector, (els) => els.length).catch(() => 0);

    if (resultCount === 0) {
      console.log(`  [search] No /maps/place/ anchors found, trying div[data-result-index]...`);
      resultSelector = 'div[data-result-index]';
      resultCount = await page.$$eval(resultSelector, (els) => els.length).catch(() => 0);
    }

    if (resultCount === 0) {
      console.log(`  [search] No div[data-result-index] found, trying article...`);
      resultSelector = 'article';
      resultCount = await page.$$eval(resultSelector, (els) => els.length).catch(() => 0);
    }

    if (resultCount === 0) {
      console.log(`  [search] ⚠️ No result items found on search page — possibly zero results or DOM changed`);
      if (debug) await saveScreenshot(page, `${companyName.replace(/\W+/g, '-')}-no-results.png`, debug);
      return null;
    }

    console.log(`  [search] Found ${resultCount} result items (selector: ${resultSelector})`);

    // Check if a preview panel is already open (Scenario B)
    const panelAlreadyOpen = await page.evaluate(() => {
      const main = document.querySelector('[role="main"]');
      if (!main) return false;
      // Panel is open if it contains a website link or tabs
      return (
          !!main.querySelector('a[data-item-id="authority"]') ||
          !!main.querySelector('a[aria-label^="Website"]') ||
          !!main.querySelector('button[role="tab"]')
      );
    });

    if (panelAlreadyOpen) {
      console.log(`  [search] Scenario B: Preview panel already open — checking website`);
      await sleep(jitter(3000, 6000));

      if (debug) await saveScreenshot(page, `${companyName.replace(/\W+/g, '-')}-panel-open.png`, debug);

      const panelWebsite = await extractWebsiteFromMapsPage(page);
      if (panelWebsite) {
        const panelDomain = cleanDomain(panelWebsite);
        console.log(`  [search] Scenario B: panel=${panelDomain} target=${targetDomain}`);
        if (doDomainsMatch(panelDomain, targetDomain)) {
          console.log(`  [search] Scenario B: Website matches ✓`);
          return page.url();
        }
        console.log(`  [search] Scenario B: First result mismatch — scanning remaining results`);
      }
    }

    // ── Scenario C (or B fallthrough): Click each result and check website ───
    const resultLinks = await page.$$(resultSelector);
    console.log(`  [search] Scenario C: Scanning ${resultLinks.length} results`);

    for (let i = 0; i < resultLinks.length; i++) {
      try {
        // Re-query after each click since DOM updates
        const links = await page.$$(resultSelector);
        if (i >= links.length) break;

        console.log(`  [search] Checking result ${i + 1}/${links.length}`);
        await links[i].click();

        // Wait for panel to render
        try {
          await page.waitForSelector('[role="main"]', { timeout: 8000 });
        } catch (e) { /* ignore */ }
        await sleep(jitter(3000, 6000));

        if (debug) await saveScreenshot(page, `${companyName.replace(/\W+/g, '-')}-result-${i + 1}.png`, debug);

        const panelWebsite = await extractWebsiteFromMapsPage(page);

        if (!panelWebsite) {
          console.log(`  [search] Result ${i + 1}: No website found, skipping`);
          continue;
        }

        const panelDomain = cleanDomain(panelWebsite);
        console.log(`  [search] Result ${i + 1}: panel=${panelDomain} target=${targetDomain}`);

        if (doDomainsMatch(panelDomain, targetDomain)) {
          console.log(`  [search] Result ${i + 1}: Website matches ✓`);
          return page.url();
        }
      } catch (e) {
        console.log(`  [search] Error checking result ${i + 1}: ${e.message}`);
        continue;
      }
    }

    console.log(`  [search] No matching result found among all results`);
    return null;

  } catch (error) {
    console.log(`  [search] Error: ${error.message}`);
    try { if (debug) await saveScreenshot(page, `${companyName.replace(/\W+/g, '-')}-error.png`, debug); } catch (e) {}
    return null;
  }
}

async function updateCompanyUrl(companyId, googleReviewUrl, dryRun = false) {
  if (dryRun) {
    console.log(`  [db] DRY RUN — would update company ${companyId} with URL`);
    return true;
  }

  try {
    const result = await pool.query(
        'UPDATE companies SET google_review_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
        [googleReviewUrl, companyId]
    );

    if (result.rows.length > 0) {
      console.log(`  [db] Updated company ${companyId} with URL`);
      return true;
    } else {
      console.log(`  [db] Company ${companyId} not found`);
      return false;
    }
  } catch (error) {
    console.log(`  [db] Error updating company: ${error.message}`);
    return false;
  }
}

async function updateDiscoveryStatus(companyId, success, dryRun = false) {
  if (dryRun) {
    const status = success ? 'TRUE' : 'FALSE';
    console.log(`  [db] DRY RUN — would set show_google_review = ${status} for company ${companyId}`);
    return;
  }

  try {
    await pool.query(
        'UPDATE companies SET show_google_review = $1, updated_at = NOW() WHERE id = $2',
        [success, companyId]
    );
    const status = success ? 'TRUE' : 'FALSE';
    console.log(`  [db] Updated show_google_review = ${status} for company ${companyId}`);
  } catch (error) {
    console.log(`  [db] Error updating discovery status: ${error.message}`);
  }
}

async function processCompany(page, company, args) {
  const { id, name, website } = company;
  const { debug, dryRun } = args;

  console.log(`\n[${id}] Processing: ${name}`);
  console.log(`  Website: ${website}`);

  let success = false;
  try {
    // searchAndClickMapsPreview now handles website validation internally
    // across all 3 scenarios (single place, panel open, results list)
    const mapsUrl = await searchAndClickMapsPreview(page, name, website, debug);

    if (!mapsUrl) {
      console.log(`  [result] No matching Maps listing found`);
      await updateDiscoveryStatus(id, false, dryRun);
      return false;
    }

    const completeUrl = await extractCompleteMapUrl(page);

    if (!completeUrl) {
      console.log(`  [result] Failed to extract complete Maps URL`);
      await updateDiscoveryStatus(id, false, dryRun);
      return false;
    }

    console.log(`  [success] Saving Maps URL: ${completeUrl}`);
    success = await updateCompanyUrl(id, completeUrl, dryRun);
    await updateDiscoveryStatus(id, success, dryRun);
    return success;
  } catch (error) {
    console.log(`  [error] ${error.message}`);
    if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-exception.png`, debug);
    await updateDiscoveryStatus(id, false, dryRun);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`\n${'='.repeat(80)}`);
  console.log('Google Maps Discovery Scraper');
  console.log(`${'='.repeat(80)}`);
  console.log(`Limit:    ${args.limit}`);
  console.log(`From ID:  ${args.fromId}`);
  console.log(`Dry Run:  ${args.dryRun}`);
  console.log(`Debug:    ${args.debug}`);
  console.log(`Profile:  ${PROFILE_DIR}`);
  console.log(`${'='.repeat(80)}\n`);

  let { browser, page } = await launchBrowser(args.headful);

  try {
    console.log('[db] Fetching companies for Google discovery...');

    let query = `
      SELECT id, name, website
      FROM companies
      WHERE google_review_url IS NULL
        AND (show_google_review IS NULL OR show_google_review = true)`;

    const queryParams = [];
    if (args.companyId) {
      query += ` AND id = $${queryParams.length + 1}`;
      queryParams.push(args.companyId);
    } else {
      query += ` AND id >= $${queryParams.length + 1}`;
      queryParams.push(args.fromId || 0);
    }

    query += ` ORDER BY id ASC LIMIT $${queryParams.length + 1}`;
    queryParams.push(args.limit);

    const result = await pool.query(query, queryParams);
    const companies = result.rows;

    console.log(`[db] Found ${companies.length} companies to process\n`);

    if (companies.length === 0) {
      console.log('No companies to process.');
      return;
    }

    let successCount = 0;
    let failureCount = 0;

    for (const company of companies) {
      try {
        const success = await processCompany(page, company, args);
        if (success) {
          successCount++;
        } else {
          failureCount++;
        }

        // Human-like delay between companies
        await sleep(jitter(3000, 7000));
      } catch (error) {
        console.log(`[error] Unexpected error for company ${company.id}: ${error.message}`);
        failureCount++;

        // Attempt recovery
        try {
          await page.goto('about:blank', { timeout: 10_000 });
          await sleep(2000);
        } catch (e) {
          console.log('[recovery] Page recovery failed — restarting browser...');
          try { await browser.close(); } catch {}
          const restarted = await launchBrowser(args.headful);
          browser = restarted.browser;
          page = restarted.page;
        }
      }
    }

    console.log(`\n${'='.repeat(80)}`);
    console.log('Summary');
    console.log(`${'='.repeat(80)}`);
    console.log(`Total:   ${companies.length}`);
    console.log(`Success: ${successCount}`);
    console.log(`Failed:  ${failureCount}`);
    console.log(`${'='.repeat(80)}\n`);
  } finally {
    await browser.close();
    await pool.end();
  }
}

main().catch(console.error);