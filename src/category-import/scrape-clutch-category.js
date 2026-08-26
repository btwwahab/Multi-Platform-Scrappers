import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pool from '../../db.js';
import minimist from 'minimist';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 60_000;
const PAGE_DELAY_MS = [3000, 6000]; // random delay between pages

// ── helpers ─────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractWebsiteFromRedirect(href) {
  if (!href) return null;
  try {
    if (href.includes('r.clutch.co/redirect')) {
      const u = new URL(href);
      const website = u.searchParams.get('u');
      if (website) {
        // Strip UTM params for clean storage
        const clean = new URL(decodeURIComponent(website));
        clean.search = '';
        return clean.href;
      }
    }
    return href.startsWith('http') ? href : null;
  } catch {
    return null;
  }
}

// ── parse companies from current page DOM ────────────────────────────────────
async function parseCompaniesFromPage(page) {
  return await page.evaluate(() => {
    const companies = [];
    const items = document.querySelectorAll('li.provider-list-item');

    for (const li of items) {
      const providerDiv = li.querySelector('[data-clutch-pid]');
      if (!providerDiv) continue;

      const clutchPid = providerDiv.getAttribute('data-clutch-pid');
      const name = (providerDiv.getAttribute('data-title') || '').trim();
      if (!name) continue;

      // Profile URL
      const profileAnchor = li.querySelector('a.provider__title-link, a.provider__logotype');
      let clutchUrl = profileAnchor ? profileAnchor.getAttribute('href') : null;
      if (clutchUrl && !clutchUrl.startsWith('http')) {
        clutchUrl = 'https://clutch.co' + clutchUrl;
      }

      // Website redirect URL
      const websiteAnchor = li.querySelector('a.website-link__item');
      const websiteRedirectHref = websiteAnchor
        ? (websiteAnchor.getAttribute('href') || websiteAnchor.getAttribute('data-link'))
        : null;

      // Rating
      const ratingEl = li.querySelector('.sg-rating__number');
      const rating = ratingEl ? parseFloat(ratingEl.textContent.trim()) || null : null;

      // Review count
      const reviewsEl = li.querySelector('.sg-rating__reviews');
      const reviewsText = reviewsEl ? reviewsEl.textContent.trim() : '';
      const reviewsCount = parseInt(reviewsText.match(/\d+/)?.[0]) || 0;

      // About/description
      const descEl = li.querySelector('.provider__description-text-more');
      const about = descEl ? descEl.textContent.trim() : null;

      // Logo
      const logoEl = li.querySelector('.provider__logotype img, .sg-provider-logotype-v2 img');
      const logo = logoEl ? logoEl.getAttribute('src') : null;

      // Location
      const locationEl = li.querySelector('.location .provider__highlights-icon + *') ||
        li.querySelector('[data-tooltip-content*="Location"] + *') ||
        li.querySelector('.location');
      // Try itemprop address
      const localityMeta = li.querySelector('meta[itemprop="addressLocality"]');
      const regionMeta = li.querySelector('meta[itemprop="addressRegion"]');
      const countryMeta = li.querySelector('meta[itemprop="addressCountry"]');
      let location = null;
      if (localityMeta) {
        location = [localityMeta.getAttribute('content'), regionMeta?.getAttribute('content')]
          .filter(Boolean).join(', ');
      }

      companies.push({
        name,
        clutchPid,
        clutchUrl,
        websiteRedirectHref,
        rating,
        reviewsCount,
        about,
        logo,
        location,
      });
    }

    return companies;
  });
}

// ── get next page URL from current page ──────────────────────────────────────
async function getNextPageUrl(page) {
  return await page.evaluate(() => {
    const nextBtn = document.querySelector(
      'a.sg-pagination-v2-next:not(.sg-pagination-v2-disabled), a[aria-label="Go to Next Page"]:not([disabled])'
    );
    return nextBtn ? nextBtn.href : null;
  });
}

// ── upsert company into DB ───────────────────────────────────────────────────
async function upsertCompany(company, categoryUrl, dryRun) {
  const { name, clutchUrl, website, rating, reviewsCount, about, logo, slug } = company;

  if (dryRun) {
    console.log(`  [dry-run] Would upsert: ${name} | ${website || 'no website'}`);
    return null;
  }

  try {
    // Check if exists by clutch URL or slug
    const existing = await pool.query(
      'SELECT id FROM companies WHERE clutch_review_url = $1 OR slug = $2 LIMIT 1',
      [clutchUrl, slug]
    );

    if (existing.rows.length > 0) {
      // Update existing
      const id = existing.rows[0].id;
      await pool.query(
        `UPDATE companies SET
          name = $1,
          website = COALESCE(NULLIF($2, ''), website),
          rating = COALESCE($3, rating),
          reviews_count = COALESCE($4, reviews_count),
          about = COALESCE(NULLIF($5, ''), about),
          logo = COALESCE(NULLIF($6, ''), logo),
          clutch_review_url = $7,
          show_clutch_review = TRUE,
          updated_at = NOW()
        WHERE id = $8`,
        [name, website, rating, reviewsCount, about, logo, clutchUrl, id]
      );
      return { id, action: 'updated' };
    } else {
      // Insert new
      const result = await pool.query(
        `INSERT INTO companies (
          name, slug, website, rating, reviews_count, about, logo,
          clutch_review_url, show_clutch_review,
          source, is_active, record_status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,'admin',TRUE,'success',NOW(),NOW())
        RETURNING id`,
        [name, slug, website, rating, reviewsCount, about, logo, clutchUrl]
      );
      return { id: result.rows[0].id, action: 'inserted' };
    }
  } catch (err) {
    console.error(`  [db] Error upserting ${name}: ${err.message}`);
    return null;
  }
}

// ── launch browser ───────────────────────────────────────────────────────────
const PROFILE_DIR = `/home/${process.env.USER || 'hp'}/.cache/va-scrapper/clutch-category-profile`;

async function launchBrowser() {
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=en-US,en',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-device-emulation',
      '--enable-automation=false',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    defaultViewport: { width: 1440, height: 900 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = await browser.newPage();

  // ── Anti-detection: hide automation signals ──────────────────────────────
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      ],
    });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'language',  { get: () => 'en-US' });
    window.Notification = { permission: 'denied' };
  });

  const ver = (await browser.version()).split('/')[1] || '126.0.0.0';
  await page.setUserAgent(
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`
  );

  // ── Request interception: add legitimate-looking headers ─────────────────
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const headers = req.headers();
    headers['Accept-Language']          = 'en-US,en;q=0.9';
    headers['Accept']                   = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    headers['Accept-Encoding']          = 'gzip, deflate, br';
    headers['Upgrade-Insecure-Requests']= '1';
    headers['Sec-Fetch-Dest']           = 'document';
    headers['Sec-Fetch-Mode']           = 'navigate';
    headers['Sec-Fetch-Site']           = 'none';
    headers['Sec-Fetch-User']           = '?1';
    headers['Sec-Ch-Ua']                = `"Not A(Brand";v="99", "Google Chrome";v="${ver.split('.')[0]}", "Chromium";v="${ver.split('.')[0]}"`;
    headers['Sec-Ch-Ua-Mobile']         = '?0';
    headers['Sec-Ch-Ua-Platform']       = '"Linux"';
    req.continue({ headers });
  });

  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(NAV_TIMEOUT);
  return { browser, page };
}

// ── Smart goto: navigate + wait for CF challenge to pass ─────────────────────
async function gotoClutch(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT });
  } catch (e) {
    if (e?.name === 'TimeoutError') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
    } else throw e;
  }

  await sleep(3000);

  const isChallenge = await page.evaluate(() => {
    const text = (document.body?.innerText || '') + (document.title || '');
    return /cloudflare|just a moment|checking your browser|performing security/i.test(text);
  }).catch(() => false);

  if (isChallenge) {
    console.log('  [cf] Cloudflare challenge detected — waiting for auto-solve (up to 20s)...');
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await sleep(1500);
      const still = await page.evaluate(() => {
        const text = (document.body?.innerText || '') + (document.title || '');
        return /cloudflare|just a moment|checking your browser|performing security/i.test(text);
      }).catch(() => true);
      if (!still) { console.log('  [cf] Challenge passed!'); break; }
    }
  }

  await sleep(2000);
}


// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = minimist(process.argv.slice(2), {
    string: ['url'],
    boolean: ['dry-run', 'headless'],
    alias: { u: 'url', d: 'dry-run', p: 'pages' },
    default: { 'dry-run': false, pages: 0 },
  });

  const categoryUrl = args.url;
  const dryRun = args['dry-run'];
  const maxPages = parseInt(args.pages) || 0; // 0 = all pages

  if (!categoryUrl) {
    console.error('Usage: node scrape-clutch-category.js --url https://clutch.co/web-designers [--pages 5] [--dry-run]');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
  console.log('Clutch Category Scraper');
  console.log('='.repeat(80));
  console.log(`URL:      ${categoryUrl}`);
  console.log(`Max pages: ${maxPages || 'all'}`);
  console.log(`Dry Run:  ${dryRun}`);
  console.log('='.repeat(80) + '\n');

  const { browser, page } = await launchBrowser();

  let currentUrl = categoryUrl;
  let pageNum = 1;
  let totalScraped = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

  try {
    while (currentUrl) {
      console.log(`\n[page ${pageNum}] Loading: ${currentUrl}`);
      await gotoClutch(page, currentUrl);

      const title = await page.title();
      console.log(`[page ${pageNum}] Title: ${title}`);

      const companies = await parseCompaniesFromPage(page);
      console.log(`[page ${pageNum}] Found ${companies.length} companies`);

      for (const company of companies) {
        // Resolve website from redirect URL
        const website = extractWebsiteFromRedirect(company.websiteRedirectHref);
        const slug = slugify(company.name);

        const enriched = { ...company, website, slug };

        const result = await upsertCompany(enriched, categoryUrl, dryRun);
        totalScraped++;

        if (result) {
          if (result.action === 'inserted') {
            totalInserted++;
            console.log(`  [insert] ${company.name} | ${website || 'no website'}`);
          } else {
            totalUpdated++;
            console.log(`  [update] ${company.name} | ${website || 'no website'}`);
          }
        }
      }

      // Check if we've reached max pages
      if (maxPages > 0 && pageNum >= maxPages) {
        console.log(`\n[stop] Reached max pages limit (${maxPages})`);
        break;
      }

      // Get next page URL using pagination or /directory/facets API
      const nextUrl = await getNextPageUrl(page);
      if (!nextUrl) {
        console.log('\n[done] No more pages found.');
        break;
      }

      currentUrl = nextUrl;
      pageNum++;
      await sleep(jitter(PAGE_DELAY_MS[0], PAGE_DELAY_MS[1]));
    }
  } finally {
    await browser.close();
  }

  console.log('\n' + '='.repeat(80));
  console.log('Summary');
  console.log('='.repeat(80));
  console.log(`Pages scraped:    ${pageNum}`);
  console.log(`Companies found:  ${totalScraped}`);
  console.log(`Inserted (new):   ${totalInserted}`);
  console.log(`Updated:          ${totalUpdated}`);
  console.log('='.repeat(80) + '\n');
}

main().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
