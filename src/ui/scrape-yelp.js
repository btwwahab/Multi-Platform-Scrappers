import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import { getNextProxy, getBrowserProxyArgs, applyProxyToPage, logCurrentProxy } from '../utils/proxyManager.js';

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 2500;
const DEFAULT_MAX_REVIEWS = 500;
const DEFAULT_MAX_PAGES = 2000;

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
    const i = parts.indexOf('biz');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return parts.at(-1) || null;
  } catch {
    return null;
  }
}

function normalizeYelpUrl(input) {
  const u = new URL(String(input || ''));
  if (!/(^|\.)yelp\.com$/i.test(u.hostname)) {
    throw new Error('URL must be a yelp.com business page');
  }
  if (!u.pathname.includes('/biz/')) {
    throw new Error('URL must include /biz/');
  }
  u.hash = 'reviews';
  return u.toString();
}

function buildPageUrl(baseUrl, pageNum) {
  const u = new URL(String(baseUrl || '').split('#')[0]);
  if (pageNum <= 1) u.searchParams.delete('start');
  else u.searchParams.set('start', String((pageNum - 1) * 10));
  u.hash = 'reviews';
  return u.toString();
}

function parseArgs(argv) {
  const a = {
    url: null,
    maxReviews: DEFAULT_MAX_REVIEWS,
    maxPages: DEFAULT_MAX_PAGES,
    out: null,
    outDir: path.join('outputs', 'yelp'),
    resume: true,
    headful: true,
    blockAssets: true,
    userDataDir: path.join(os.tmpdir(), `yelp-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`),
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
        `Usage: node src/ui/scrape-yelp.js --url <yelpBizUrl> [options]\n\n` +
        `  --maxReviews N   Cap reviews (default: ${DEFAULT_MAX_REVIEWS})\n` +
        `  --all            Scrape all available reviews\n` +
        `  --maxPages N     Safety cap on review pages (default: ${DEFAULT_MAX_PAGES})\n` +
        `  --out <file>     Output file path (default: outputs/yelp/<slug>-<hash>.json)\n` +
        `  --outDir <dir>   Output folder (default: outputs/yelp)\n` +
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
      if (t === 'media' || t === 'font') return req.abort();
      if (t === 'image') {
        // Allow Yelp CDN user avatar photos — Yelp sets img.src lazily via JS
        // only after the request completes, so blocking these causes avatarUrl
        // to remain unset and every reviewer falls back to the default avatar.
        const url = req.url();
        if (/yelpcdn\.com\/photo\//i.test(url)) return req.continue();
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
      await sleep(2500 * (i + 1));
    }
  }
}

async function clickConsent(page) {
  try {
    await page.evaluate(() => {
      const want = ['accept all', 'accept', 'i agree', 'agree', 'allow all'];
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
    await page.waitForSelector(
      'ul li p.comment__09f24__RPzvj, [data-testid="review-comment"], [data-testid="review-summary"]',
      { timeout: 25_000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function detectChallengeOrBlock(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    if (!text) return null;

    const patterns = [
      'unusual traffic',
      'verify you are a human',
      'verify you\'re a human',
      'security check',
      'press and hold',
      'captcha',
      'access denied',
      'temporarily blocked',
    ];

    for (const p of patterns) {
      if (text.includes(p)) return p;
    }
    return null;
  });
}

async function extractReviewsWithRetry(page, { attempts = 3 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const rows = await extractPageReviews(page);
    if (rows.length) return rows;

    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight || 0);
    }).catch(() => { });
    await sleep(1000 + (i * 600));

    if (i === 1) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => { });
      await sleep(POST_NAV_WAIT_MS);
      await clickConsent(page);
      await waitForReviews(page);
    }
  }

  return [];
}

async function extractCompanyInfo(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();

    const parseFloatLoose = (s) => {
      const m = n(s).match(/(\d+(?:\.\d+)?)/);
      return m ? Number(m[1]) : null;
    };

    const parseIntLoose = (s) => {
      const m = n(s).replace(/,/g, '').match(/(\d{1,10})/);
      return m ? Number(m[1]) : null;
    };

    const nameFromDom = n(document.querySelector('h1')?.textContent) || null;

    let overallRating = null;
    const overallNode = [...document.querySelectorAll('[role="img"][aria-label*="star rating" i]')]
      .find((el) => /\d/.test(el.getAttribute('aria-label') || '') &&
        (el.closest('[data-testid="review-summary"]') || el.closest('.review-summary') || !el.closest('li')));
    if (overallNode) overallRating = parseFloatLoose(overallNode.getAttribute('aria-label'));

    let totalReviews = null;
    const summaryRoot = document.querySelector('[data-testid="review-summary"]') || document.body;
    const reviewCountCandidates = [];

    for (const el of summaryRoot.querySelectorAll('span,p,div')) {
      const text = n(el.textContent);
      const m = text.match(/(\d[\d,]*)\s+reviews?/i);
      if (!m) continue;
      const value = Number(String(m[1]).replace(/,/g, ''));
      if (Number.isFinite(value)) reviewCountCandidates.push(value);
    }

    if (reviewCountCandidates.length) {
      totalReviews = Math.max(...reviewCountCandidates);
    }

    const jsonLdNodes = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let jsonLdName = null;
    let jsonLdRating = null;
    let jsonLdTotal = null;
    for (const node of jsonLdNodes) {
      let parsed = null;
      try {
        parsed = JSON.parse(node.textContent || 'null');
      } catch {
        parsed = null;
      }
      const objs = Array.isArray(parsed) ? parsed : [parsed];
      for (const obj of objs) {
        if (!obj || typeof obj !== 'object') continue;
        const t = String(obj['@type'] || '').toLowerCase();
        const aggregate = obj.aggregateRating || null;
        const hasAggregate = aggregate && typeof aggregate === 'object';
        if (!jsonLdName && obj.name) jsonLdName = n(obj.name);
        if ((t.includes('localbusiness') || t.includes('organization') || hasAggregate) && hasAggregate) {
          const rv = parseFloatLoose(aggregate.ratingValue);
          const rc = parseIntLoose(aggregate.reviewCount);
          if (jsonLdRating == null && Number.isFinite(rv)) jsonLdRating = rv;
          if (jsonLdTotal == null && Number.isFinite(rc)) jsonLdTotal = rc;
        }
      }
    }

    return {
      name: nameFromDom || jsonLdName || null,
      profileUrl: location.origin + location.pathname,
      overallRating: overallRating ?? jsonLdRating ?? null,
      totalReviews: totalReviews ?? jsonLdTotal ?? null,
    };
  });
}

async function extractPageReviews(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const toAbs = (href) => {
      if (!href) return null;
      try { return new URL(href, location.href).toString(); } catch { return href; }
    };

    const parseDate = (s) => {
      const raw = n(s);
      if (!raw) return null;
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return raw;
    };

    const parseRating = (ariaLabel) => {
      const m = n(ariaLabel).match(/(\d+(?:\.\d+)?)\s*star/i);
      return m ? Number(m[1]) : null;
    };

    const parseCountFromAria = (el, label) => {
      if (!el) return null;
      const target = [...el.querySelectorAll('[aria-label]')]
        .find((x) => new RegExp(`^${label}`, 'i').test(x.getAttribute('aria-label') || ''));
      if (!target) return null;
      const m = (target.getAttribute('aria-label') || '').match(/(\d{1,10})/);
      return m ? Number(m[1]) : null;
    };

    const firstSrcFromSrcSet = (srcset) => {
      const raw = n(srcset);
      if (!raw) return null;
      return raw.split(',')[0]?.trim().split(/\s+/)[0] || null;
    };

    const imgUrlFromEl = (img) => {
      if (!img) return null;
      return (
        img.getAttribute('src') ||
        firstSrcFromSrcSet(img.getAttribute('srcset')) ||
        img.getAttribute('data-src') ||
        firstSrcFromSrcSet(img.getAttribute('data-srcset')) ||
        null
      );
    };

    const out = [];
    const candidates = [
      ...document.querySelectorAll('[data-testid="review-card"]'),
      ...document.querySelectorAll('ul li'),
    ];

    for (const li of candidates) {
      const textNode = li.querySelector(
        '[data-testid="review-comment"], p.comment__09f24__RPzvj span.raw__09f24__PkHSg, p span.raw__09f24__PkHSg, p span[class*="raw__"]'
      );
      const reviewText = n(textNode?.textContent);
      if (!reviewText) continue;

      const userAnchors = [...li.querySelectorAll('a[href*="/user_details?"]')];
      const namedAnchor = userAnchors.find((a) => n(a.textContent));
      const userAnchor = namedAnchor || userAnchors[0] || null;

      const reviewerRegion = li.querySelector('[role="region"][aria-label]');
      const ariaReviewer = n(reviewerRegion?.getAttribute('aria-label')) || null;
      const author = n(userAnchor?.textContent) || ariaReviewer || null;
      const profileUrl = toAbs(userAnchor?.getAttribute('href'));

      const avatarImg = (() => {
        // Only match an img that has a real user-photo URL (/photo/ path on yelpcdn)
        const direct = li.querySelector('img[alt^="Photo of"], img[src*="yelpcdn.com/photo"]');
        if (direct) return direct;

        const imgs = [...li.querySelectorAll('img')];
        const likely = imgs.find((img) => {
          const candidate = n(
            img.getAttribute('src') ||
            img.getAttribute('srcset') ||
            img.getAttribute('data-src') ||
            img.getAttribute('data-srcset') ||
            ''
          );
          if (!candidate) return false;
          // Must be a Yelp CDN user photo (has /photo/ in the path)
          if (!/yelpcdn\.com\/photo\//i.test(candidate)) return false;
          return true;
        });
        return likely || null;
      })();
      const authorImage = imgUrlFromEl(avatarImg);

      const locationNode = li.querySelector('[data-testid="UserPassportInfoTextContainer"] span');
      const authorLocation = n(locationNode?.textContent) || null;

      const ratingNode = li.querySelector('[role="img"][aria-label*="star rating" i]');
      const rating = parseRating(ratingNode?.getAttribute('aria-label') || '');

      const timeEl = li.querySelector('time');
      const dateNode = [...li.querySelectorAll('span')]
        .find((el) => /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(n(el.textContent)) && /\d{4}/.test(n(el.textContent)));
      const dateRaw = n(timeEl?.getAttribute('datetime') || timeEl?.textContent || dateNode?.textContent) || null;
      const date = parseDate(dateRaw);

      const reviewId = (() => {
        const href = userAnchor?.getAttribute('href') || '';
        const uid = href.match(/userid=([^&]+)/)?.[1] || '';
        const base = [uid, dateRaw || '', reviewText.slice(0, 120)].join('|');
        let h = 0;
        for (let i = 0; i < base.length; i++) h = ((h << 5) - h) + base.charCodeAt(i);
        return `yelp-${Math.abs(h)}`;
      })();

      const reactionsWrap = li.querySelector('[data-testid^="reactions-wrapper"]') || li;
      const helpfulCount = parseCountFromAria(reactionsWrap, 'Helpful');
      const thanksCount = parseCountFromAria(reactionsWrap, 'Thanks');
      const loveThisCount = parseCountFromAria(reactionsWrap, 'Love this');
      const ohNoCount = parseCountFromAria(reactionsWrap, 'Oh no');

      const statsMap = {};
      for (const stat of li.querySelectorAll('.user-passport-stats__09f24__aueOr [aria-label]')) {
        const label = stat.getAttribute('aria-label') || '';
        const valueNode = stat.querySelector('[data-font-weight="semibold"]');
        const value = n(valueNode?.textContent);
        if (!label || !value) continue;
        const num = Number(value.replace(/,/g, ''));
        statsMap[label.toLowerCase()] = Number.isFinite(num) ? num : value;
      }

      out.push({
        reviewId,
        reviewUrl: location.href.split('#')[0] + '#reviews',
        title: null,
        text: reviewText,
        date,
        dateRaw,
        rating,
        reviewer: {
          name: author,
          profileUrl,
          avatarUrl: authorImage,
          location: authorLocation,
          friendsCount: statsMap.friends ?? null,
          reviewsCount: statsMap.reviews ?? null,
          photosCount: statsMap.photos ?? null,
        },
        reactions: {
          helpful: helpfulCount,
          thanks: thanksCount,
          loveThis: loveThisCount,
          ohNo: ohNoCount,
        },
        scrapedAt: new Date().toISOString(),
      });
    }

    const dedupe = (rows) => {
      const seen = new Set();
      return rows.filter((r) => {
        const key = String(r.reviewId || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const domRows = dedupe(out);
    if (domRows.length) return domRows;

    const parseJsonDate = (s) => {
      const raw = n(s);
      if (!raw) return null;
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      return raw;
    };

    const parseJsonReviews = () => {
      const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
      const rows = [];

      const reviewObjectsFrom = (obj) => {
        if (!obj || typeof obj !== 'object') return [];
        if (Array.isArray(obj)) return obj.flatMap((x) => reviewObjectsFrom(x));

        const bucket = [];
        const t = String(obj['@type'] || '').toLowerCase();
        if (t === 'review' || (Array.isArray(obj['@type']) && obj['@type'].some((x) => String(x).toLowerCase() === 'review'))) {
          bucket.push(obj);
        }
        if (Array.isArray(obj.review)) bucket.push(...obj.review);
        if (Array.isArray(obj['@graph'])) bucket.push(...obj['@graph']);
        return bucket.flatMap((x) => reviewObjectsFrom(x));
      };

      for (const node of scripts) {
        let parsed = null;
        try {
          parsed = JSON.parse(node.textContent || 'null');
        } catch {
          parsed = null;
        }
        const objs = reviewObjectsFrom(parsed);
        for (const r of objs) {
          if (!r || typeof r !== 'object') continue;
          const text = n(r.reviewBody || r.description || r.text || '');
          if (!text) continue;

          const authorName = n(
            (typeof r.author === 'string' ? r.author : r.author?.name) || ''
          ) || null;
          const authorImage = typeof r.author === 'object' ? (r.author?.image || null) : null;
          const rating = Number(r?.reviewRating?.ratingValue);
          const rawDate = n(r.datePublished || r.dateCreated || '');
          const date = parseJsonDate(rawDate);
          const base = [authorName || '', rawDate || '', text.slice(0, 160)].join('|');
          let h = 0;
          for (let i = 0; i < base.length; i++) h = ((h << 5) - h) + base.charCodeAt(i);
          const reviewId = `yelp-jsonld-${Math.abs(h)}`;

          rows.push({
            reviewId,
            reviewUrl: location.href.split('#')[0] + '#reviews',
            title: null,
            text,
            date,
            dateRaw: rawDate || null,
            rating: Number.isFinite(rating) ? rating : null,
            reviewer: {
              name: authorName,
              profileUrl: null,
              avatarUrl: authorImage,
              location: null,
              friendsCount: null,
              reviewsCount: null,
              photosCount: null,
            },
            reactions: {
              helpful: null,
              thanks: null,
              loveThis: null,
              ohNo: null,
            },
            scrapedAt: new Date().toISOString(),
          });
        }
      }
      return dedupe(rows);
    };

    const jsonRows = parseJsonReviews();
    if (jsonRows.length) return jsonRows;

    return dedupe(out);
  });
}

async function getNextPageNumber(page, currentPage) {
  return page.evaluate((current) => {
    const next = document.querySelector('a[aria-label="Next"], a.next-link');
    if (!next) return null;

    const href = next.getAttribute('href') || '';
    if (!href) return null;

    try {
      const u = new URL(href, location.href);
      const start = Number(u.searchParams.get('start') || '0');
      if (Number.isFinite(start) && start >= 0) return Math.floor(start / 10) + 1;
      return current + 1;
    } catch {
      return null;
    }
  }, currentPage);
}

async function main() {
  const args = parseArgs(process.argv);

  const baseUrl = normalizeYelpUrl(args.url);
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
  const seen = new Set(existingReviews.map((r) => String(r?.reviewId || '')).filter(Boolean));
  const reviews = [...existingReviews];

  const target = args.maxReviews === 0 ? Infinity : args.maxReviews;

  console.log(`📁 Output : ${outPath}`);
  console.log(`🌐 Base   : ${baseUrl}`);
  console.log(`📝 Resumed: ${reviews.length} reviews`);

  const { browser, page } = await launchBrowser(args);
  const tempUserDataDir = args.userDataDir;

  let company = prev?.company || null;
  let pageNum = prev?.progress?.nextPageNum || 1;
  let progress = prev?.progress || null;
  let stopReason = null;
  let stopExtra = null;

  try {
    while (reviews.length < target && pageNum <= args.maxPages) {
      const currentUrl = buildPageUrl(baseUrl, pageNum);
      console.log(`\n🌐 Page ${pageNum}: ${currentUrl}`);

      await goto(page, currentUrl);
      await clickConsent(page);
      await waitForReviews(page);
      const challenge = await detectChallengeOrBlock(page);
      if (challenge) {
        throw new Error(`Yelp challenge/block page detected: ${challenge}`);
      }

      if (!company) {
        company = await extractCompanyInfo(page);
        company.scrapedAt = now();
        console.log(`🏢 ${company.name || '(unknown)'}  ⭐ ${company.overallRating ?? '?'}  📊 ${company.totalReviews ?? '?'} total`);
      }

      const pageReviews = await extractReviewsWithRetry(page, { attempts: pageNum === 1 ? 3 : 2 });
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
        const key = String(review.reviewId || '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        reviews.push(review);
        added++;
        if (reviews.length >= target) break;
      }

      const nextPageNum = await getNextPageNumber(page, pageNum);
      progress = {
        lastPageNum: pageNum,
        lastPageUrl: page.url(),
        nextPageNum: nextPageNum || (pageNum + 1),
      };

      console.log(`📝 Added ${added} reviews (total: ${reviews.length})`);

      if (reviews.length >= target) break;

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
    await fs.rm(tempUserDataDir, { recursive: true, force: true }).catch(() => { });
    await browser.close().catch(() => { });
  }

  const done = reviews.length >= target || stopReason === 'no_more_pages';

  const output = {
    sourceUrl: baseUrl,
    company: {
      ...(company || {}),
      scrapedAt: company?.scrapedAt || now(),
    },
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
  console.error('❌ Yelp scraper failed:');
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
