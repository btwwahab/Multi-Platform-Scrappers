import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import { getNextProxy, getBrowserProxyArgs, applyProxyToPage, logCurrentProxy } from '../utils/proxyManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 3000;
const DEFAULT_MAX_REVIEWS = 50000;
const DEFAULT_MAX_PAGES = 2000;

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function writeAtomic(filePath, data) {
  if (filePath === '-') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const tmp = `${filePath}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, filePath);
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function slugify(s) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'company';
}

function companySlugFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const companyIdx = parts.indexOf('company');
    if (companyIdx >= 0 && parts[companyIdx + 1]) return parts[companyIdx + 1];
    return parts.at(-1) || null;
  } catch {
    return null;
  }
}

function normalizeGoodFirmsUrl(input) {
  const u = new URL(String(input || ''));
  u.hash = 'review_analytics';
  u.search = '';
  return u.toString();
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(String(baseUrl || '').split('#')[0]);
  if (pageNum <= 1) u.searchParams.delete('page');
  else u.searchParams.set('page', String(pageNum));
  u.hash = 'reviews_list';
  return u.toString();
}

function parsePercentWidth(value) {
  const m = String(value || '').match(/([\d.]+)\s*%/);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(5, pct / 20));
}

function parseStarRating(card) {
  const star = card.querySelector('.rating-star-container[style*="width"]');
  const width = star?.getAttribute('style') || '';
  return parsePercentWidth(width);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    url: null,
    maxReviews: DEFAULT_MAX_REVIEWS,
    maxPages: DEFAULT_MAX_PAGES,
    out: null,
    outDir: path.join('outputs', 'goodfirms'),
    resume: true,
    headful: false,
    blockAssets: true,
    userDataDir: path.join(os.tmpdir(), `goodfirms-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  };

  for (let i = 2; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--url') a.url = argv[++i];
    else if (f === '--maxReviews') a.maxReviews = Number(argv[++i]);
    else if (f === '--all') a.maxReviews = 0;
    else if (f === '--maxPages') a.maxPages = Number(argv[++i]);
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--outDir') a.outDir = argv[++i];
    else if (f === '--resume') a.resume = true;
    else if (f === '--noResume') a.resume = false;
    else if (f === '--headful') a.headful = true;
    else if (f === '--blockAssets') a.blockAssets = true;
    else if (f === '--noBlockAssets') a.blockAssets = false;
    else if (f === '--userDataDir') a.userDataDir = argv[++i];
    else if (f === '--help' || f === '-h') {
      console.log(
        `Usage: node src/ui/scrape-goodfirms.js --url <companyUrl> [options]\n\n` +
        `  --maxReviews N   Cap reviews (default: ${DEFAULT_MAX_REVIEWS})\n` +
        `  --all            Scrape all available reviews\n` +
        `  --maxPages N     Safety cap on review pages (default: ${DEFAULT_MAX_PAGES})\n` +
        `  --out <file>     Output file path (default: outputs/goodfirms/<slug>-<hash>.json)\n` +
        `  --outDir <dir>   Output folder (default: outputs/goodfirms)\n` +
        `  --resume         Continue from existing file (default: on)\n` +
        `  --noResume       Start fresh\n` +
        `  --headful        Show browser window\n` +
        `  --userDataDir D  Chrome profile dir (default: temp dir, cleaned up after run)\n` +
        `  --blockAssets    Block images/fonts (default: on)\n` +
        `  --noBlockAssets  Allow all assets`
      );
      process.exit(0);
    } else if (!a.url && typeof f === 'string' && /^https?:\/\//i.test(f)) {
      a.url = f;
    }
  }

  if (!a.url) throw new Error('--url is required');
  return a;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser({ headful, blockAssets, userDataDir }) {
  const proxy = getNextProxy();
  await logCurrentProxy(proxy);

  const browser = await puppeteer.launch({
    headless: headful ? false : 'new',
    executablePath: CHROME,
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=en-US,en',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      ...getBrowserProxyArgs(proxy),
    ],
    defaultViewport: { width: 1440, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  await applyProxyToPage(page, proxy);

  const ver = (await browser.version()).split('/')[1] || '126.0.0.0';
  await page.setUserAgent(
    `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${ver} Safari/537.36`
  );

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (blockAssets) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      const u = req.url();
      if (t === 'image' || t === 'media' || t === 'font') return req.abort();
      if (t === 'stylesheet' && (u.includes('fonts.googleapis') || u.includes('fonts.gstatic'))) {
        return req.abort();
      }
      req.continue();
    });
  }

  return { browser, page };
}

async function goto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await sleep(POST_NAV_WAIT_MS);
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(3000 * (i + 1));
    }
  }
}

async function clickConsent(page) {
  try {
    await page.evaluate(() => {
      const want = ['accept all', 'accept', 'i agree', 'agree', 'ok'];
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const btn = [...document.querySelectorAll('button,[role="button"]')]
        .find((b) => want.some((w) => n(b.textContent).includes(w)));
      if (btn) btn.click();
    });
  } catch {
    // ignore
  }
}

async function waitForReviews(page) {
  try {
    await page.waitForSelector('#reviews_list article.profile-review', { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

// ── Extraction ────────────────────────────────────────────────────────────────
async function extractCompanyAndAnalytics(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const num = (s) => {
      const t = n(s).replace(/,/g, '');
      const m = t.match(/(\d+(?:\.\d+)?)/);
      return m ? Number(m[1]) : null;
    };
    const abs = (href) => {
      if (!href) return null;
      try { return new URL(href, location.href).toString(); } catch { return href; }
    };

    const companyName = n(
      document.querySelector('h1')?.textContent ||
      document.querySelector('.profile-review-analytics-title')?.textContent?.replace(/^Review Analytics of\s+/i, '') ||
      document.querySelector('.profile-review-list-title')?.textContent?.replace(/^Detailed Reviews of\s+/i, '') ||
      ''
    ) || null;

    const metrics = {};
    for (const wrap of document.querySelectorAll('.profile-review-metrics-wrap')) {
      const value = n(wrap.querySelector('dd')?.textContent) || null;
      const label = n(wrap.querySelector('dt')?.textContent) || null;
      if (label) metrics[label.toLowerCase()] = value;
    }

    const whatUsersSay = [...document.querySelectorAll('.user-conclusion-wrap')].map((el) => {
      const quote = n(el.querySelector('q')?.textContent) || null;
      const reviewerRaw = n(el.querySelector('.user-name')?.childNodes?.[0]?.textContent || el.querySelector('.user-name')?.textContent || '') || null;
      const reviewerFull = n(el.querySelector('.user-name')?.textContent) || null;
      const role = reviewerRaw && reviewerFull
        ? n(reviewerFull.replace(reviewerRaw, '').replace(/^,\s*/, '')) || null
        : null;
      const verified = !!el.querySelector('.custom_tooltip[data-content*="Verified" i], .icon-verified');
      const img = el.querySelector('.reviewer-image img');
      return {
        quote,
        reviewer: {
          name: reviewerRaw,
          role,
          avatarUrl: abs(img?.getAttribute('src') || img?.getAttribute('data-src')),
        },
        verified,
      };
    });

    const strengths = [...document.querySelectorAll('.strength-containers .strength-weakness-wrapper li')]
      .map((el) => n(el.textContent))
      .filter(Boolean);

    const weaknesses = [...document.querySelectorAll('.weakness-containers .strength-weakness-wrapper li')]
      .map((el) => n(el.textContent))
      .filter(Boolean);

    return {
      company: {
        name: companyName,
        profileUrl: location.origin + location.pathname,
        totalReviews: num(metrics['total reviews']) ?? null,
        overallRating: (() => {
          const raw = metrics['overall rating'];
          const value = raw ? Number.parseFloat(raw) : null;
          return Number.isFinite(value) ? value : null;
        })(),
        recentReviews: num(metrics['recent reviews']) ?? null,
      },
      analytics: {
        metrics,
        whatUsersSay,
        strengths,
        weaknesses,
      },
    };
  });
}

async function extractPageReviews(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const abs = (href) => {
      if (!href) return null;
      try { return new URL(href, location.href).toString(); } catch { return href; }
    };
    const percentToRating = (style) => {
      const m = String(style || '').match(/width\s*:\s*([\d.]+)%/i);
      if (!m) return null;
      const pct = Number(m[1]);
      if (!Number.isFinite(pct)) return null;
      return Math.max(0, Math.min(5, pct / 20));
    };

    const out = [];
    for (const card of document.querySelectorAll('#reviews_list article.profile-review')) {
      const reviewId = card.id ? card.id.replace(/^review-/, '') : null;
      const title = n(card.querySelector('.review-title')?.textContent) || null;
      const reviewerName = n(card.querySelector('.reviewer-name span')?.textContent) || null;
      const reviewerFull = n(card.querySelector('.reviewer-name')?.textContent) || null;
      const reviewerRole = reviewerName && reviewerFull
        ? n(reviewerFull.replace(reviewerName, '').replace(/^,\s*/, '')) || null
        : null;
      const reviewDate = n(card.querySelector('.review-date')?.textContent) || null;
      const summary = n(card.querySelector('.review-summary')?.textContent) || null;
      const shareUrl = card.querySelector('.profile-review-share-btn')?.getAttribute('data-url') || null;
      const reviewUrl = abs(shareUrl) || (reviewId ? `${location.origin}${location.pathname}#review-${reviewId}` : null);

      const ratingBreakdown = {};
      for (const li of card.querySelectorAll('.review-rating-breakdown-list li')) {
        const label = n(li.querySelector('span:first-child')?.textContent) || null;
        const style = li.querySelector('.rating-star-container')?.getAttribute('style') || '';
        if (label) ratingBreakdown[label] = percentToRating(style);
      }

      const projectDetails = [];
      const projectDetailsMap = {};
      for (const li of card.querySelectorAll('.project-services-list li')) {
        const spans = [...li.querySelectorAll('span')].map((s) => n(s.textContent)).filter(Boolean);
        const value = spans.at(-1) || null;
        const label = li.getAttribute('data-content')
          ? n(li.getAttribute('data-content').replace(/<[^>]+>/g, ''))
          : n(spans.slice(0, -1).join(' ')) || null;
        if (!value) continue;
        projectDetails.push({ label, value });
        if (label) projectDetailsMap[label] = value;
      }

      const projectInformation = [];
      const projectInformationMap = {};
      for (const block of card.querySelectorAll('.project-info')) {
        const question = n(block.querySelector('h4')?.textContent) || null;
        const answer = n(block.querySelector('p')?.textContent) || null;
        if (!question && !answer) continue;
        projectInformation.push({ question, answer });
        if (question) projectInformationMap[question] = answer;
      }

      out.push({
        reviewId,
        reviewUrl,
        title,
        summary,
        reviewer: {
          name: reviewerName,
          role: reviewerRole,
        },
        date: reviewDate,
        ratingBreakdown,
        projectDetails,
        projectDetailsMap,
        projectInformation,
        projectInformationMap,
        scrapedAt: new Date().toISOString(),
      });
    }

    const seen = new Set();
    return out.filter((r) => {
      const key = String(r.reviewId || r.reviewUrl || '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
}

async function getNextPageNumber(page) {
  return page.evaluate(() => {
    const next = document.querySelector('.pagination .next-page a[data-href], .pagination .next-page a[href]');
    if (!next) return null;

    const href = next.getAttribute('data-href') || next.getAttribute('href') || '';
    if (!href) return null;

    try {
      const u = new URL(href, location.href);
      const pageNum = u.searchParams.get('page');
      if (pageNum) {
        const parsed = Number(pageNum);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return 2;
    } catch {
      return null;
    }
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  const baseUrl = normalizeGoodFirmsUrl(args.url);
  const slug = slugify(companySlugFromUrl(baseUrl) || 'company');
  const fileId = hashStr(baseUrl.split('?')[0]);

  const outPath = args.out === '-'
    ? '-'
    : args.out
      ? args.out
      : path.join(args.outDir, `${slug}-${fileId}.json`);

  if (outPath !== '-') {
    await ensureDir(path.dirname(path.resolve(outPath)));
    if (!args.resume) {
      await fs.rm(outPath, { force: true }).catch(() => { });
    }
  }

  const prev = args.resume && outPath !== '-' ? await readJson(outPath) : null;
  const existingReviews = Array.isArray(prev?.reviews) ? prev.reviews : [];
  const seen = new Set(existingReviews.map((r) => String(r?.reviewId || r?.reviewUrl || '')).filter(Boolean));
  const reviews = [...existingReviews];

  const target = args.maxReviews === 0 ? Infinity : args.maxReviews;
  const prevCompany = prev?.company || null;
  const prevAnalytics = prev?.analytics || null;
  const prevProgress = prev?.progress || null;

  console.log(`📁 Output : ${outPath}`);
  console.log(`🌐 Base   : ${baseUrl}`);
  console.log(`📝 Resumed: ${reviews.length} reviews`);

  const { browser, page } = await launchBrowser(args);
  const tempUserDataDir = args.userDataDir;

  let company = prevCompany;
  let analytics = prevAnalytics;
  let progress = prevProgress || null;

  let pageNum = prevProgress?.nextPageNum || 1;
  if (!prevProgress?.nextPageNum && reviews.length) {
    pageNum = Math.floor(reviews.length / 10) + 1;
  }

  let stopReason = null;
  let stopExtra = null;

  try {
    while (reviews.length < target && pageNum <= args.maxPages) {
      const currentUrl = buildPageUrl(baseUrl, pageNum);
      console.log(`\n🌐 Page ${pageNum}: ${currentUrl}`);

      await goto(page, currentUrl);
      await clickConsent(page);
      await waitForReviews(page);

      if (!company || !analytics) {
        const extracted = await extractCompanyAndAnalytics(page);
        company = {
          ...(prevCompany || {}),
          ...extracted.company,
          scrapedAt: now(),
        };
        analytics = extracted.analytics;
        console.log(`🏢 ${company.name || '(unknown)'}  ⭐ ${company.overallRating ?? '?'}  📊 ${company.totalReviews ?? '?'} total`);
      }

      const pageReviews = await extractPageReviews(page);
      if (!pageReviews.length) {
        stopReason = 'no_reviews_found';
        stopExtra = { url: page.url() };
        progress = {
          lastPageNum: pageNum,
          lastPageUrl: page.url(),
          nextPageNum: pageNum,
        };
        break;
      }

      let added = 0;
      for (const review of pageReviews) {
        const key = String(review.reviewId || review.reviewUrl || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        reviews.push(review);
        added++;
        if (reviews.length >= target) break;
      }

      const nextPageNum = await getNextPageNumber(page);
      progress = {
        lastPageNum: pageNum,
        lastPageUrl: page.url(),
        nextPageNum: nextPageNum || (pageNum + 1),
      };

      console.log(`📝 Added ${added} reviews (total: ${reviews.length})`);

      if (reviews.length >= target) {
        break;
      }

      if (!nextPageNum || nextPageNum <= pageNum) {
        stopReason = 'no_more_pages';
        stopExtra = { url: page.url(), nextPageNum };
        break;
      }

      pageNum = nextPageNum;
    }

    if (!stopReason && pageNum > args.maxPages) {
      stopReason = 'max_pages_reached';
      stopExtra = { maxPages: args.maxPages };
    }
  } finally {
    // Clean up temp profile to avoid server disk bloat
    await fs.rm(tempUserDataDir, { recursive: true, force: true }).catch(() => { });
    await browser.close().catch(() => { });
  }

  const totalReviews = company?.totalReviews ?? analytics?.metrics?.['Total Reviews'] ?? null;
  const done = reviews.length >= target || stopReason === 'no_more_pages';

  const output = {
    sourceUrl: baseUrl,
    company: {
      ...(company || {}),
      totalReviews,
      scrapedAt: company?.scrapedAt || now(),
    },
    analytics: analytics || prevAnalytics || null,
    reviewsCount: reviews.length,
    targetReviews: target,
    done,
    reason: done ? null : stopReason,
    stopExtra: done ? null : stopExtra,
    progress,
    updatedAt: now(),
    reviews,
  };

  await writeAtomic(outPath, output);
  console.log(`✅ Saved ${reviews.length} reviews to ${outPath}`);
}

main().catch((err) => {
  console.error('❌ GoodFirms scraper failed:');
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});