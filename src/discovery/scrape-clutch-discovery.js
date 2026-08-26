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
  'clutch-discovery-profile-' + Math.floor(Date.now() / 86_400_000)
);

const NAV_TIMEOUT = 90_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      'Usage: node src/discovery/scrape-clutch-discovery.js [options]\n' +
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
    if (!uStr.startsWith('http')) {
      uStr = 'https://' + uStr;
    }
    const u = new URL(uStr);
    return u.hostname || null;
  } catch {
    return null;
  }
}

function validateUrlMatch(dbWebsiteUrl, clutchWebsiteUrl) {
  if (!dbWebsiteUrl || !clutchWebsiteUrl) return false;

  const dbDomain = extractDomainFromUrl(dbWebsiteUrl);
  const clutchDomain = extractDomainFromUrl(clutchWebsiteUrl);

  if (!dbDomain || !clutchDomain) return false;

  // Remove 'www.' prefix for comparison
  const cleanDb = dbDomain.replace(/^www\./, '').toLowerCase();
  const cleanClutch = clutchDomain.replace(/^www\./, '').toLowerCase();

  return cleanDb === cleanClutch || cleanClutch.includes(cleanDb) || cleanDb.includes(cleanClutch);
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
    // Remove webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => false });

    // Restore vendor
    Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });

    // Spoof languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    if (window.chrome) {
      window.chrome.runtime = {};
    }
  });

  console.log('[proxy] Disabled (no proxy used in this scraper)');

  return { browser, page };
}

async function extractWebsiteFromProfilePage(page) {
  try {
    const websiteUrl = await page.evaluate(() => {
      // Find the website button based on class or title
      const btn = document.querySelector('a.website-link__item, a[title="Visit website"], a[data-link]');
      if (btn) {
        const href = btn.href || btn.getAttribute('data-link');
        
        // Clutch usually obscures the real URL inside a redirect
        if (href && href.includes('r.clutch.co/redirect')) {
          try {
            const u = new URL(href);
            // URL is sometimes passed in 'u' parameter
            const originalUrl = u.searchParams.get('u');
            if (originalUrl) return originalUrl;
            
            // Or 'provider_website' parameter
            const providerWebsite = u.searchParams.get('provider_website');
            if (providerWebsite) return 'https://' + providerWebsite;
          } catch(e) {}
        }
        return href;
      }
      return null;
    });
    return websiteUrl;
  } catch (error) {
    return null;
  }
}

async function searchAndCheckProfiles(page, company, args) {
  const { name, website, id } = company;
  const { debug } = args;

  console.log(`  [search] Searching on Clutch for: ${name}`);

  try {
    const searchUrl = `https://clutch.co/search?q=${encodeURIComponent(name)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    
    // Give results some time to load
    await sleep(jitter(2000, 3500));

    if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-clutch-search.png`, debug);

    // Get all profile links from the search results
    const profileLinks = await page.evaluate(() => {
      // Typically elements with class profile__view-link
      const anchors = Array.from(document.querySelectorAll('a.profile__view-link'));
      return anchors.map(a => a.getAttribute('href')).filter(Boolean);
    });

    if (profileLinks.length === 0) {
      console.log(`  [search] No profiles found in search results.`);
      return null;
    }

    console.log(`  [search] Found ${profileLinks.length} profiles to check.`);

    for (let i = 0; i < profileLinks.length; i++) {
      let href = profileLinks[i];
      if (!href.startsWith('http')) {
        href = `https://clutch.co${href.startsWith('/') ? '' : '/'}${href}`;
      }

      console.log(`  [profile] Checking profile ${i + 1}/${profileLinks.length}: ${href}`);

      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await sleep(jitter(1500, 3000));

      const profileWebsiteUrl = await extractWebsiteFromProfilePage(page);

      if (!profileWebsiteUrl) {
        console.log(`    [validation] No website link found on this profile.`);
        continue;
      }

      const isValidMatch = validateUrlMatch(website, profileWebsiteUrl);

      if (isValidMatch) {
        console.log(`    [validation] Website matches ✓`);
        console.log(`    [success] Found matching profile URL: ${href}`);
        return href;
      } else {
        console.log(`    [validation] Website does not match (DB: ${website} | Clutch: ${profileWebsiteUrl})`);
      }
    }

    console.log(`  [result] No matching profile found after checking all search results.`);
    return null;

  } catch (error) {
    console.log(`  [search] Error: ${error.message}`);
    try { if (debug) await saveScreenshot(page, `${name.replace(/\W+/g, '-')}-clutch-error.png`, debug); } catch (e) {}
    return null;
  }
}

async function updateCompanyUrl(companyId, clutchReviewUrl, dryRun = false) {
  if (dryRun) {
    console.log(`  [db] DRY RUN — would update company ${companyId} with Clutch URL`);
    return true;
  }

  try {
    const result = await pool.query(
      'UPDATE companies SET clutch_review_url = $1, updated_at = NOW() WHERE id = $2 RETURNING id',
      [clutchReviewUrl, companyId]
    );

    if (result.rows.length > 0) {
      console.log(`  [db] Updated company ${companyId} with Clutch URL`);
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
    console.log(`  [db] DRY RUN — would set show_clutch_review = ${status} for company ${companyId}`);
    return;
  }

  try {
    await pool.query(
      'UPDATE companies SET show_clutch_review = $1, updated_at = NOW() WHERE id = $2',
      [success, companyId]
    );
    const status = success ? 'TRUE' : 'FALSE';
    console.log(`  [db] Updated show_clutch_review = ${status} for company ${companyId}`);
  } catch (error) {
    console.log(`  [db] Error updating discovery status: ${error.message}`);
  }
}

async function processCompany(page, company, args) {
  const { id, name, website } = company;
  const { dryRun } = args;

  console.log(`\n[${id}] Processing: ${name}`);
  console.log(`  Website: ${website}`);

  let success = false;
  try {
    const clutchUrl = await searchAndCheckProfiles(page, company, args);

    if (!clutchUrl) {
      await updateDiscoveryStatus(id, false, dryRun);
      return false;
    }

    success = await updateCompanyUrl(id, clutchUrl, dryRun);
    await updateDiscoveryStatus(id, success, dryRun);
    return success;
  } catch (error) {
    console.log(`  [error] ${error.message}`);
    await updateDiscoveryStatus(id, false, dryRun);
    return false;
  }
}

async function main() {
  const args = parseArgs(process.argv);

  console.log(`\n${'='.repeat(80)}`);
  console.log('Clutch Discovery Scraper');
  console.log(`${'='.repeat(80)}`);
  console.log(`Limit:    ${args.limit}`);
  console.log(`From ID:  ${args.fromId}`);
  console.log(`Dry Run:  ${args.dryRun}`);
  console.log(`Debug:    ${args.debug}`);
  console.log(`Profile:  ${PROFILE_DIR}`);
  console.log(`${'='.repeat(80)}\n`);

  let { browser, page } = await launchBrowser(args.headful);

  try {
    console.log('[db] Fetching companies for Clutch discovery...');

    let query = `
      SELECT id, name, website
      FROM companies
      WHERE clutch_review_url IS NULL
        AND (show_clutch_review IS NULL OR show_clutch_review = true)`;

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

        // Human-like delay between requests
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
