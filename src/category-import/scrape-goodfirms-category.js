import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import pool from '../../db.js';
import minimist from 'minimist';
import path from 'path';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const CHALLENGE_WAIT_MS = 25_000;
const PAGE_DELAY_MIN = 3000;
const PAGE_DELAY_MAX = 6000;

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'company';
}

function norm(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ── parse companies from the firm-directory-list on current page ──────────────
async function parseCompaniesFromPage(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const companies = [];
    const items = document.querySelectorAll('ul.firm-directory-list li.firm-wrapper');

    for (const li of items) {
      // ── Name ────────────────────────────────────────────────────────────────
      const name = n(li.querySelector('h3.firm-name a')?.textContent) || null;
      if (!name) continue;

      // ── entity-id attribute (GoodFirms internal ID) ──────────────────────
      const entityId = li.getAttribute('entity-id') || null;

      // ── Profile URL ──────────────────────────────────────────────────────
      const profileAnchor = li.querySelector('a.firm-logo, h3.firm-name a');
      let goodfirmsUrl = profileAnchor?.getAttribute('href') || null;
      if (goodfirmsUrl && !goodfirmsUrl.startsWith('http')) {
        goodfirmsUrl = 'https://www.goodfirms.co' + goodfirmsUrl;
      }

      // ── Website ──────────────────────────────────────────────────────────
      const websiteAnchor = li.querySelector('a.visit-website.web-url');
      let website = websiteAnchor?.getAttribute('href') || null;

      // ── Rating ───────────────────────────────────────────────────────────
      const ratingEl = li.querySelector('.rating-number');
      const rating = ratingEl ? parseFloat(ratingEl.textContent.trim()) || null : null;

      // ── Review count ─────────────────────────────────────────────────────
      const reviewsAnchor = li.querySelector('.firm-rating a[href*="review_analytics"]');
      const reviewsText = reviewsAnchor?.textContent?.trim() || '';
      const reviewsCount = parseInt(reviewsText.match(/\d+/)?.[0]) || 0;

      // ── Description ──────────────────────────────────────────────────────
      const descEl = li.querySelector('p.firm-short-description');
      const about = descEl ? n(descEl.textContent) : null;

      // ── Logo ─────────────────────────────────────────────────────────────
      const logoEl = li.querySelector('a.firm-logo img');
      const logo = logoEl?.getAttribute('src') || null;

      // ── service details (pricing, employees, founded, location) ──────────
      let hourlyRate = null;
      let employees = null;
      let founded = null;
      let location = null;

      for (const detail of li.querySelectorAll('.firm-services-list > div')) {
        const text = n(detail.querySelector('span:last-child')?.textContent);
        if (detail.classList.contains('firm-pricing'))   hourlyRate = text || null;
        if (detail.classList.contains('firm-employees')) employees  = text || null;
        if (detail.classList.contains('firm-founded'))   founded    = text || null;
        if (detail.classList.contains('firm-location'))  location   = text || null;
      }

      // ── Review highlight quote ────────────────────────────────────────────
      const quoteEl = li.querySelector('.review-highlight-text q');
      const quoterEl = li.querySelector('.review-highlight-text .review-provider');
      const reviewHighlight = quoteEl
        ? { quote: n(quoteEl.textContent), reviewer: n(quoterEl?.textContent).replace(/^-\s*/, '') }
        : null;

      companies.push({
        name,
        entityId,
        goodfirmsUrl,
        website,
        rating,
        reviewsCount,
        about,
        logo,
        hourlyRate,
        employees,
        founded,
        location,
        reviewHighlight,
      });
    }

    return companies;
  });
}

// ── detect next page number from pagination ───────────────────────────────────
async function getNextPageNum(page, currentPageNum) {
  return page.evaluate((current) => {
    // Look for a "next" pagination link
    const nextLink = document.querySelector(
      '.pagination li.next a, .pagination a[rel="next"], a.next-page'
    );
    if (nextLink) {
      try {
        const u = new URL(nextLink.href, location.href);
        const p = u.searchParams.get('page');
        if (p) return parseInt(p);
      } catch { /* fall through */ }
    }

    // Fallback: check if current page indicator exists and bump by 1
    const activePageEl = document.querySelector('.pagination .active a, .pagination li.active a');
    if (activePageEl) {
      const activePage = parseInt(activePageEl.textContent.trim());
      if (Number.isFinite(activePage)) {
        // Check that there's a page link for current+1
        const pages = [...document.querySelectorAll('.pagination a')];
        const hasNext = pages.some((a) => {
          try {
            const u = new URL(a.href, location.href);
            return parseInt(u.searchParams.get('page')) === activePage + 1;
          } catch { return false; }
        });
        return hasNext ? activePage + 1 : null;
      }
    }

    // Last resort: look for any page link with number > current
    const allPageLinks = [...document.querySelectorAll('.pagination a[href*="page="]')];
    const nums = allPageLinks
      .map((a) => {
        try { return parseInt(new URL(a.href, location.href).searchParams.get('page')); }
        catch { return null; }
      })
      .filter((n) => Number.isFinite(n) && n > current);
    return nums.length ? Math.min(...nums) : null;
  }, currentPageNum);
}

// ── upsert company into DB ────────────────────────────────────────────────────
async function upsertCompany(company, dryRun) {
  const {
    name, slug, goodfirmsUrl, website,
    rating, reviewsCount, about, logo,
  } = company;

  if (dryRun) {
    console.log(`  [dry-run] Would upsert: ${name} | ${website || 'no website'} | ${location || ''}`);
    return null;
  }

  try {
    const result = await pool.query(
      `INSERT INTO companies (
          name, slug, website, rating, reviews_count, about, logo,
          goodfirms_review_url, show_goodfirms_review,
          source, is_active, record_status, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,'admin',TRUE,'success',NOW(),NOW())
        ON CONFLICT (slug) DO UPDATE SET
          name                 = EXCLUDED.name,
          website              = COALESCE(NULLIF(EXCLUDED.website, ''), companies.website),
          rating               = COALESCE(EXCLUDED.rating, companies.rating),
          reviews_count        = COALESCE(EXCLUDED.reviews_count, companies.reviews_count),
          about                = COALESCE(NULLIF(EXCLUDED.about, ''), companies.about),
          logo                 = COALESCE(NULLIF(EXCLUDED.logo, ''), companies.logo),
          goodfirms_review_url = COALESCE(NULLIF(EXCLUDED.goodfirms_review_url, ''), companies.goodfirms_review_url),
          show_goodfirms_review= TRUE,
          updated_at           = NOW()
        RETURNING id, (xmax = 0) AS inserted`,
      [name, slug, website, rating, reviewsCount, about, logo, goodfirmsUrl]
    );
    const row = result.rows[0];
    return { id: row.id, action: row.inserted ? 'inserted' : 'updated' };
  } catch (err) {
    console.error(`  [db] Error upserting "${name}": ${err.message}`);
    return null;
  }
}

// ── launch browser ────────────────────────────────────────────────────────────
const PROFILE_DIR = `/home/${process.env.USER || 'hp'}/.cache/va-scrapper/goodfirms-category-profile`;

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

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const t = req.resourceType();
    // block heavy assets to speed things up
    if (t === 'image' || t === 'media' || t === 'font') return req.abort();

    const headers = req.headers();
    headers['Accept-Language']           = 'en-US,en;q=0.9';
    headers['Accept']                    = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
    headers['Accept-Encoding']           = 'gzip, deflate, br';
    headers['Upgrade-Insecure-Requests'] = '1';
    headers['Sec-Fetch-Dest']            = 'document';
    headers['Sec-Fetch-Mode']            = 'navigate';
    headers['Sec-Fetch-Site']            = 'none';
    headers['Sec-Fetch-User']            = '?1';
    headers['Sec-Ch-Ua']                 = `"Not A(Brand";v="99", "Google Chrome";v="${ver.split('.')[0]}", "Chromium";v="${ver.split('.')[0]}"`;
    headers['Sec-Ch-Ua-Mobile']          = '?0';
    headers['Sec-Ch-Ua-Platform']        = '"Linux"';
    req.continue({ headers });
  });

  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  page.setDefaultTimeout(NAV_TIMEOUT);
  return { browser, page };
}

// ── navigate to a URL and wait for CF challenge to clear ─────────────────────
async function gotoGoodFirms(page, url) {
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
    return /cloudflare|just a moment|checking your browser|performing security|verifying you are human/i.test(text);
  }).catch(() => false);

  if (isChallenge) {
    console.log(`  [cf] Challenge detected — waiting up to ${CHALLENGE_WAIT_MS / 1000}s for auto-solve...`);
    const deadline = Date.now() + CHALLENGE_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(1500);
      const still = await page.evaluate(() => {
        const text = (document.body?.innerText || '') + (document.title || '');
        return /cloudflare|just a moment|checking your browser|performing security|verifying you are human/i.test(text);
      }).catch(() => true);
      if (!still) { console.log('  [cf] Challenge passed!'); break; }
    }
  }

  // Wait for the company list to appear
  await page.waitForSelector('ul.firm-directory-list', { timeout: 30_000 }).catch(() => {
    console.warn('  [warn] firm-directory-list not found — page may be empty or blocked');
  });

  await sleep(1500);
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = minimist(process.argv.slice(2), {
    string: ['url'],
    boolean: ['dry-run'],
    alias: { u: 'url', d: 'dry-run', p: 'pages' },
    default: { 'dry-run': false, pages: 0 },
  });

  const categoryUrl = args.url;
  const dryRun      = args['dry-run'];
  const maxPages    = parseInt(args.pages) || 0; // 0 = all pages

  if (!categoryUrl) {
    console.error(
      'Usage: node src/category-import/scrape-goodfirms-category.js \\\n' +
      '         --url https://www.goodfirms.co/bpo-services [--pages 5] [--dry-run]'
    );
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
  console.log('GoodFirms Category Scraper');
  console.log('='.repeat(80));
  console.log(`URL:       ${categoryUrl}`);
  console.log(`Max pages: ${maxPages || 'all'}`);
  console.log(`Dry Run:   ${dryRun}`);
  console.log('='.repeat(80) + '\n');

  const { browser, page } = await launchBrowser();

  let pageNum      = 1;
  let totalScraped = 0;
  let totalInserted = 0;
  let totalUpdated  = 0;

  try {
    while (true) {
      // Build URL: page 1 = base URL, subsequent = ?page=N
      const currentUrl = pageNum === 1
        ? categoryUrl
        : (() => {
            const u = new URL(categoryUrl);
            u.searchParams.set('page', String(pageNum));
            return u.toString();
          })();

      console.log(`\n[page ${pageNum}] Loading: ${currentUrl}`);
      await gotoGoodFirms(page, currentUrl);

      const title = await page.title().catch(() => '(unknown)');
      console.log(`[page ${pageNum}] Title: ${title}`);

      const companies = await parseCompaniesFromPage(page);
      console.log(`[page ${pageNum}] Found ${companies.length} companies`);

      if (!companies.length) {
        console.log('[done] No companies found — stopping.');
        break;
      }

      for (const company of companies) {
        const slug = slugify(company.name);
        const enriched = { ...company, slug };

        const result = await upsertCompany(enriched, dryRun);
        totalScraped++;

        if (result) {
          if (result.action === 'inserted') {
            totalInserted++;
            console.log(`  [insert] ${company.name} | ${company.website || 'no website'} | ${company.location || ''}`);
          } else {
            totalUpdated++;
            console.log(`  [update] ${company.name} | ${company.website || 'no website'} | ${company.location || ''}`);
          }
        }
      }

      // Stop if max pages reached
      if (maxPages > 0 && pageNum >= maxPages) {
        console.log(`\n[stop] Reached max pages limit (${maxPages})`);
        break;
      }

      // Find next page number
      const nextNum = await getNextPageNum(page, pageNum);
      if (!nextNum) {
        console.log('\n[done] No more pages found.');
        break;
      }

      pageNum = nextNum;
      await sleep(jitter(PAGE_DELAY_MIN, PAGE_DELAY_MAX));
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
  console.error('[fatal]', err.message || err);
  process.exit(1);
});
