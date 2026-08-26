import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import minimist from 'minimist';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pool from '../../db.js';

puppeteer.use(StealthPlugin());

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

// Rotate profile daily
const PROFILE_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
  '.cache',
  'va-scrapper',
  'goodfirms-discovery-profile-' + Math.floor(Date.now() / 86_400_000)
);

const NAV_TIMEOUT = 90_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').trim();

async function ensureScreenshotDir() {
  const dir = path.join(process.cwd(), 'outputs', 'discovery-debug');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function saveScreenshot(page, filename, debug) {
  if (!debug) return;
  try {
    const dir = await ensureScreenshotDir();
    const filepath = path.join(dir, filename);
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
    default: { limit: 50, fromId: 0, companyId: null, headful: false, dryRun: false, debug: false },
  });

  if (a.help) {
    console.log(
      'Usage: node src/discovery/scrape-goodfirms-discovery.js [options]\n' +
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

function validateUrlMatch(dbWebsiteUrl, goodfirmsWebsiteUrl) {
  if (!dbWebsiteUrl || !goodfirmsWebsiteUrl) return false;
  const dbDomain = extractDomainFromUrl(dbWebsiteUrl);
  const gfDomain = extractDomainFromUrl(goodfirmsWebsiteUrl);
  if (!dbDomain || !gfDomain) return false;
  const cleanDb = dbDomain.replace(/^www\./, '').toLowerCase();
  const cleanGf = gfDomain.replace(/^www\./, '').toLowerCase();
  return cleanDb === cleanGf || cleanGf.includes(cleanDb) || cleanDb.includes(cleanGf);
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
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();
  const ver = (await browser.version()).split('/')[1] || '126.0.0.0';
  await page.setUserAgent(
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
  );
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  console.log('[proxy] Disabled (no proxy used in this scraper)');
  return { browser, page };
}

// Extract the actual website URL from a GoodFirms profile page
async function extractWebsiteFromProfilePage(page) {
  try {
    return await page.evaluate(() => {
      // Primary: "Visit website" button
      const btn = document.querySelector('a.visit-website-btn');
      if (btn) return btn.getAttribute('href');

      // Fallback: any external link in the header area
      const fallback = document.querySelector('a[rel="nofollow"][target="_blank"][href^="http"]');
      if (fallback) return fallback.getAttribute('href');

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

  console.log(`  [search] Searching on GoodFirms for: ${name}`);

  try {
    // Use the companies search page which shows full paginated results
    const searchUrl = `https://www.goodfirms.co/search/companies?query=${encodeURIComponent(name)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await sleep(jitter(2500, 4000));

    if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-goodfirms-search.png`, debug);

    // Extract all cards from search results
    const cards = await page.evaluate(() => {
      const results = [];
      const wrappers = Array.from(document.querySelectorAll('.firm-wrapper'));
      for (const wrapper of wrappers) {
        const anchor = wrapper.querySelector('.firm-information h3 a');
        if (!anchor) continue;
        // Use title attribute for clean name (no <em> highlight tags)
        const displayedName = (anchor.getAttribute('title') || anchor.textContent || '').trim();
        const href = anchor.getAttribute('href') || '';
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

      // Step 1: Name must match — exact OR card name starts with DB name (e.g. "Codenex Solutions LLP" matches "CodeNex")
      const nameMatches = cardNameNorm === dbNameNorm || cardNameNorm.startsWith(dbNameNorm);
      if (!nameMatches) {
        console.log(`  [skip] Name mismatch — Card: "${displayedName}"`);
        continue;
      }

      console.log(`  [name match] "${displayedName}" ✓ — visiting profile to verify website...`);

      const fullUrl = href.startsWith('http') ? href : `https://www.goodfirms.co${href}`;

      // Step 2: Visit profile page to get the actual website URL
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await sleep(jitter(2000, 3500));

      if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-goodfirms-profile.png`, debug);

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
    try { if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-goodfirms-error.png`, debug); } catch (e) { }
    return null;
  }
}

async function updateCompanyUrl(companyId, goodfirmsReviewUrl, dryRun = false) {
  if (dryRun) {
    console.log(`  [db] DRY RUN — would update company ${companyId} with GoodFirms URL`);
    return true;
  }
  try {
    const result = await pool.query(
      'UPDATE companies SET goodfirms_review_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [goodfirmsReviewUrl, companyId]
    );
    if (result.rows.length > 0) {
      console.log(`  [db] Updated company ${companyId} with GoodFirms URL`);
      return true;
    }
    console.log(`  [db] Company ${companyId} not found`);
    return false;
  } catch (error) {
    console.log(`  [db] Error updating company: ${error.message}`);
    return false;
  }
}

async function updateDiscoveryStatus(companyId, success, dryRun = false) {
  if (dryRun) {
    const status = success ? 'TRUE' : 'FALSE';
    console.log(`  [db] DRY RUN — would set show_goodfirms_review = ${status} for company ${companyId}`);
    return;
  }

  try {
    await pool.query(
      'UPDATE companies SET show_goodfirms_review = $1, updated_at = NOW() WHERE id = $2',
      [success, companyId]
    );
    const status = success ? 'TRUE' : 'FALSE';
    console.log(`  [db] Updated show_goodfirms_review = ${status} for company ${companyId}`);
  } catch (error) {
    console.log(`  [db] Error updating discovery status: ${error.message}`);
  }
}

async function processCompany(page, company, args) {
  const { id, name, website } = company;
  console.log(`\n[${id}] Processing: ${name}`);
  console.log(`  Website: ${website}`);
  try {
    const goodfirmsUrl = await searchAndCheckProfiles(page, company, args);
    if (!goodfirmsUrl) {
      await updateDiscoveryStatus(id, false, args.dryRun);
      return false;
    }
    const success = await updateCompanyUrl(id, goodfirmsUrl, args.dryRun);
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
  console.log('GoodFirms Discovery Scraper');
  console.log(`${'='.repeat(80)}`);
  console.log(`Limit:    ${args.limit}`);
  console.log(`From ID:  ${args.fromId}`);
  console.log(`Dry Run:  ${args.dryRun}`);
  console.log(`Debug:    ${args.debug}`);
  console.log(`Profile:  ${PROFILE_DIR}`);
  console.log(`${'='.repeat(80)}\n`);

  let { browser, page } = await launchBrowser(args.headful);

  try {
    console.log('[db] Fetching companies for GoodFirms discovery...');

    let query = `SELECT id, name, website FROM companies
       WHERE goodfirms_review_url IS NULL
         AND (show_goodfirms_review IS NULL OR show_goodfirms_review = true)`;

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
