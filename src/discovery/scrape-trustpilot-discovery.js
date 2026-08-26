import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import minimist from 'minimist';
import puppeteer from 'puppeteer-core';
import pool from '../../db.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

// Use the SAME persistent profile as the network scraper so Cloudflare cookies are shared
const PROFILE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
  '.cache',
  'va-scrapper',
  'trustpilot-profile'
);

const NAV_TIMEOUT = 90_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

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
      'Usage: node src/discovery/scrape-trustpilot-discovery.js [options]\n' +
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
    let uStr = urlStr;
    if (!uStr.startsWith('http')) uStr = 'https://' + uStr;
    const u = new URL(uStr);
    return u.hostname || null;
  } catch {
    return null;
  }
}

function validateUrlMatch(dbWebsiteUrl, trustpilotWebsiteUrl) {
  if (!dbWebsiteUrl || !trustpilotWebsiteUrl) return false;
  const dbDomain = extractDomainFromUrl(dbWebsiteUrl);
  const tpDomain = extractDomainFromUrl(trustpilotWebsiteUrl);
  if (!dbDomain || !tpDomain) return false;
  const cleanDb = dbDomain.replace(/^www\./, '').toLowerCase();
  const cleanTp = tpDomain.replace(/^www\./, '').toLowerCase();
  return cleanDb === cleanTp || cleanTp.includes(cleanDb) || cleanDb.includes(cleanTp);
}

async function launchBrowser(headful = false) {
  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    executablePath: CHROME,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=en-US,en',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  const version = (await browser.version()).split('/')[1] || '126.0.0.0';
  await page.setUserAgent(
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${version} Safari/537.36`
  );
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('[proxy] Disabled (no proxy used in this scraper)');
  return { browser, page };
}

// Wait for Cloudflare challenge to pass
async function waitForRealTrustpilotPage(page, timeoutMs = 60_000) {
  try {
    await page.waitForFunction(() => {
      const title = String(document.title || '').toLowerCase();
      const isCloudflare = title.includes('verifying connection');
      const isLoaded =
        document.querySelector('a[name="business-unit-card"]') ||
        document.querySelector('[class*="styles_card"]') ||
        document.querySelector('[class*="CDS_Card_card"]') ||
        document.querySelector('article[data-service-review-card-paper="true"]') ||
        document.querySelector('#__NEXT_DATA__') ||
        document.querySelector('[data-business-unit-profile-wrapper]') ||
        document.body.innerText.includes('find a company') ||
        document.body.innerText.includes('No results');
      return !isCloudflare && !!isLoaded;
    }, { timeout: timeoutMs });
  } catch (e) {
    console.log(`  [debug] waitForRealTrustpilotPage timed out: ${e.message}`);
  }
}

// Extract the actual website URL from a Trustpilot profile page
async function extractWebsiteFromProfilePage(page) {
  try {
    return await page.evaluate(() => {
      // Primary selector (provided by user)
      const btn = document.querySelector('a[name="visit-website-button"]');
      if (btn) return btn.href;

      // Selector from network scraper
      const networkBtn = document.querySelector(
        '[data-business-unit-about-section="true"] a[href*="utm_source=trustpilot"], ' +
        '[data-business-unit-about-section="true"] a[target="_blank"]'
      );
      if (networkBtn) return networkBtn.getAttribute('href');

      // Generic fallback
      const anyVisitBtn = document.querySelector('a[data-visit-website-button-link="true"]');
      if (anyVisitBtn) return anyVisitBtn.href;

      return null;
    });
  } catch {
    return null;
  }
}

async function searchAndCheckProfiles(page, company, args) {
  const { name, website } = company;
  const { debug } = args;
  const dbNameNorm = normName(name);

  console.log(`  [search] Searching on Trustpilot for: ${name}`);

  try {
    const searchUrl = `https://www.trustpilot.com/search?query=${encodeURIComponent(name)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });

    await waitForRealTrustpilotPage(page);
    await sleep(jitter(2000, 3000));

    if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-trustpilot-search.png`, debug);

    // Extract all cards from search results
    const cards = await page.evaluate(() => {
      const results = [];
      const anchors = Array.from(document.querySelectorAll(
        'a[name="business-unit-card"], a[data-business-unit-card-link="true"]'
      ));
      for (const anchor of anchors) {
        const href = anchor.getAttribute('href') || '';
        const nameEl = anchor.querySelector('p[class*="heading-s"]');
        const displayedName = nameEl ? nameEl.textContent.trim() : '';
        results.push({ href, displayedName });
      }
      return results;
    });

    if (cards.length === 0) {
      console.log(`  [search] No cards found in search results.`);
      return null;
    }

    console.log(`  [search] Found ${cards.length} cards. Filtering by name: "${name}"`);

    for (const card of cards) {
      const { href, displayedName } = card;
      const cardNameNorm = normName(displayedName);

      // Step 1: Name must match (normalized)
      if (cardNameNorm !== dbNameNorm) {
        console.log(`  [skip] Name mismatch — Card: "${displayedName}"`);
        continue;
      }

      console.log(`  [name match] "${displayedName}" ✓ — visiting profile to verify website...`);

      const fullUrl = href.startsWith('http')
        ? href
        : `https://www.trustpilot.com${href.startsWith('/') ? '' : '/'}${href}`;

      // Step 2: Visit profile page to get the actual website URL
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await waitForRealTrustpilotPage(page);
      await sleep(jitter(1500, 2500));

      const profileWebsiteUrl = await extractWebsiteFromProfilePage(page);

      if (!profileWebsiteUrl) {
        console.log(`    [skip] No website link found on profile page.`);
        continue;
      }

      console.log(`    [profile website] ${profileWebsiteUrl}`);

      // Step 3: Domain match
      const domainMatches = validateUrlMatch(website, profileWebsiteUrl);

      if (domainMatches) {
        console.log(`    [domain match] ✓ → Saving: ${fullUrl}`);
        return fullUrl;
      } else {
        console.log(`    [domain mismatch] DB: ${website} | Profile: ${profileWebsiteUrl}`);
      }
    }

    console.log(`  [result] No matching profile found.`);
    return null;

  } catch (error) {
    console.log(`  [search] Error: ${error.message}`);
    try { if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-trustpilot-error.png`, debug); } catch (e) { }
    return null;
  }
}

async function updateCompanyUrl(companyId, trustpilotReviewUrl, dryRun = false) {
  if (dryRun) {
    console.log(`  [db] DRY RUN — would update company ${companyId} with Trustpilot URL`);
    return true;
  }
  try {
    const result = await pool.query(
      'UPDATE companies SET trustpilot_review_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [trustpilotReviewUrl, companyId]
    );
    if (result.rows.length > 0) {
      console.log(`  [db] Updated company ${companyId} with Trustpilot URL`);
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
    console.log(`  [db] DRY RUN — would set show_trustpilot_review = ${status} for company ${companyId}`);
    return;
  }

  try {
    await pool.query(
      'UPDATE companies SET show_trustpilot_review = $1, updated_at = NOW() WHERE id = $2',
      [success, companyId]
    );
    const status = success ? 'TRUE' : 'FALSE';
    console.log(`  [db] Updated show_trustpilot_review = ${status} for company ${companyId}`);
  } catch (error) {
    console.log(`  [db] Error updating discovery status: ${error.message}`);
  }
}

async function processCompany(page, company, args) {
  const { id, name, website } = company;
  console.log(`\n[${id}] Processing: ${name}`);
  console.log(`  Website: ${website}`);
  try {
    const trustpilotUrl = await searchAndCheckProfiles(page, company, args);
    if (!trustpilotUrl) {
      await updateDiscoveryStatus(id, false, args.dryRun);
      return false;
    }
    const success = await updateCompanyUrl(id, trustpilotUrl, args.dryRun);
    await updateDiscoveryStatus(id, success, args.dryRun);
    return success;
  } catch (error) {
    console.log(`  [error] ${error.message}`);
    await updateDiscoveryStatus(id, false, args.dryRun);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`\n${'='.repeat(80)}`);
  console.log('Trustpilot Discovery Scraper');
  console.log(`${'='.repeat(80)}`);
  console.log(`Limit:    ${args.limit}`);
  console.log(`From ID:  ${args.fromId}`);
  console.log(`Dry Run:  ${args.dryRun}`);
  console.log(`Debug:    ${args.debug}`);
  console.log(`Profile:  ${PROFILE_DIR}`);
  console.log(`${'='.repeat(80)}\n`);

  let { browser, page } = await launchBrowser(args.headful);

  try {
    console.log('[db] Fetching companies for Trustpilot discovery...');

    let query = `SELECT id, name, website FROM companies
       WHERE trustpilot_review_url IS NULL
         AND (show_trustpilot_review IS NULL OR show_trustpilot_review = true)`;

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
        if (success) successCount++;
        else failureCount++;
        await sleep(jitter(3000, 6000));
      } catch (error) {
        console.log(`[error] Unexpected error for company ${company.id}: ${error.message}`);
        failureCount++;
        try {
          await page.goto('about:blank', { timeout: 10_000 });
          await sleep(2000);
        } catch (e) {
          console.log('[recovery] Restarting browser...');
          try { await browser.close(); } catch { }
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
