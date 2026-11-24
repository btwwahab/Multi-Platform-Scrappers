import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import { getNextProxy, getBrowserProxyArgs, applyProxyToPage, logCurrentProxy } from '../utils/proxyManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 3000;
const CHALLENGE_WAIT_MS = 5_000;
const DEFAULT_MAX_REVIEWS = 5000000;
const DEFAULT_MAX_PAGES = 200000;

const VERIFY_RE = /cloudflare|just a moment|checking your browser|performing security|verifying you are human|attention required|security verification|verify you are human|captcha|robot check|access denied|forbidden|blocked/i;

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
    headful: true,
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
        `Usage: node src/network/scrape-goodfirms-network.js --url <companyUrl> [options]\n\n` +
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
    headless: 'new',
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
      try {
        await page.goto(url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT });
      } catch (err) {
        if (err?.name === 'TimeoutError') {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        } else {
          throw err;
        }
      }

      await sleep(POST_NAV_WAIT_MS);

      const isChallengePage = await page.evaluate(() => {
        const text = `${document.body?.innerText || ''} ${document.title || ''}`;
        return /cloudflare|just a moment|checking your browser|performing security|verifying you are human|attention required|security verification|verify you are human|captcha|robot check|access denied|forbidden|blocked/i.test(text);
      }).catch(() => false);

      if (isChallengePage) {
        console.log(`[cf] Cloudflare challenge detected, waiting for auto-solve (up to ${Math.round(CHALLENGE_WAIT_MS / 1000)}s)...`);
        const maxWait = CHALLENGE_WAIT_MS;
        const startTime = Date.now();
        let stillOnChallenge = true;
        while (Date.now() - startTime < maxWait) {
          await sleep(1000);
          stillOnChallenge = await page.evaluate(() => {
            const text = `${document.body?.innerText || ''} ${document.title || ''}`;
            return /cloudflare|just a moment|checking your browser|performing security|verifying you are human|attention required|security verification|verify you are human|captcha|robot check|access denied|forbidden|blocked/i.test(text);
          }).catch(() => true);

          if (!stillOnChallenge) {
            console.log('[cf] Challenge passed!');
            break;
          }
        }

        if (stillOnChallenge) {
          const err = new Error('Cloudflare challenge did not clear after wait');
          err.retryWithNextProxy = true;
          throw err;
        }
      }

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

// GoodFirms rebuilt its profile pages (Next.js, "cp2-*" classes). The legacy selector is kept as a
// fallback so an older cached/layout variant still works.
const REVIEW_CARD_SELECTOR = 'article.cp2-review, #reviews_list article.profile-review, article.profile-review';

async function waitForReviews(page) {
  try {
    await page.waitForSelector(REVIEW_CARD_SELECTOR, { timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function detectBlock(page) {
  try {
    return await page.evaluate((cardSelector) => {
      const title = String(document.title || '');
      const body = String(document.body?.innerText || '');
      // A real profile page has review cards; never treat it as blocked just because a review
      // happens to contain a word like "blocked" or "forbidden".
      const hasContent = !!document.querySelector(cardSelector) || !!document.querySelector('h1') && body.length > 2500;
      const text = `${title}\n${body.slice(0, 1500)}`.toLowerCase();
      const blocked = !hasContent && /captcha|verify you are human|access denied|forbidden|blocked|cloudflare|security check|robot check|just a moment|attention required|checking your browser|performing security/i.test(text);
      return { blocked, title, snippet: body.slice(0, 300) };
    }, REVIEW_CARD_SELECTOR);
  } catch {
    return { blocked: false, title: null, snippet: null };
  }
}

function isVerificationBlock(result) {
  if (!result) return false;
  if (result.blocked) return true;
  const text = `${result.title || ''}\n${result.snippet || ''}`.toLowerCase();
  return VERIFY_RE.test(text);
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

    // New layout: schema.org aggregateRating in JSON-LD is the most stable source.
    let ld = null;
    const findAgg = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (node.aggregateRating && typeof node.aggregateRating === 'object') return node.aggregateRating;
      for (const v of Array.isArray(node) ? node : Object.values(node)) {
        const hit = findAgg(v);
        if (hit) return hit;
      }
      return null;
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { ld = findAgg(JSON.parse(s.textContent || 'null')); } catch { /* ignore */ }
      if (ld) break;
    }
    const heroRating = num(document.querySelector('.cp2-rating-big-num, .cp2-hero-ratingnum')?.textContent);
    const heroCount = num(document.querySelector('.cp2-rating-big-count')?.textContent);
    const metricRating = (() => {
      const raw = metrics['overall rating'];
      const value = raw ? Number.parseFloat(raw) : null;
      return Number.isFinite(value) ? value : null;
    })();

    return {
      company: {
        name: companyName,
        profileUrl: location.origin + location.pathname,
        totalReviews: num(metrics['total reviews']) ?? num(ld?.reviewCount ?? ld?.ratingCount) ?? heroCount ?? null,
        overallRating: metricRating ?? num(ld?.ratingValue) ?? heroRating ?? null,
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

async function extractPageReviews(page, htmlSnippet = null) {
  return page.evaluate((htmlSnippet) => {
    const root = htmlSnippet
      ? new DOMParser().parseFromString(htmlSnippet, 'text/html')
      : document;

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

    // ── New layout (Next.js "cp2-*" markup) ─────────────────────────────────────
    for (const card of root.querySelectorAll('article.cp2-review')) {
      const reviewId = card.id ? card.id.replace(/^review-/, '') : null;

      // Name node contains: "<name>, <role>" + a "Verified Review" badge we must drop.
      const nameEl = card.querySelector('.cp2-review-name');
      let nameFull = '';
      if (nameEl) {
        const clone = nameEl.cloneNode(true);
        clone.querySelectorAll('.cp2-review-verified').forEach((e) => e.remove());
        nameFull = n(clone.textContent);
      }
      const avatarAlt = n(card.querySelector('img.cp2-review-avatar')?.getAttribute('alt'));
      let reviewerName = null;
      let reviewerRole = null;
      if (nameFull) {
        if (avatarAlt && nameFull.startsWith(avatarAlt)) {
          reviewerName = avatarAlt;
          reviewerRole = n(nameFull.slice(avatarAlt.length).replace(/^\s*,\s*/, '')) || null;
        } else {
          const m = nameFull.match(/^([^,]+),\s*(.+)$/);
          reviewerName = n(m ? m[1] : nameFull) || null;
          reviewerRole = m ? n(m[2]) || null : null;
        }
      }

      const verified = !!card.querySelector('.cp2-review-verified');
      const reviewDate = n(card.querySelector('.cp2-review-date')?.textContent).replace(/^Posted on\s*/i, '') || null;
      const title = n(card.querySelector('.cp2-review-quote')?.textContent).replace(/^[“"']+|[”"']+$/g, '').trim() || null;
      const summary = n(card.querySelector('.cp2-review-text')?.textContent) || null;

      const ratingBreakdown = {};
      const overall = parseFloat(n(card.querySelector('.cp2-review-overall-val')?.textContent));
      if (Number.isFinite(overall)) ratingBreakdown['Overall Rating'] = overall;
      for (const m of card.querySelectorAll('.cp2-review-metric')) {
        const label = n(m.querySelector(':scope > span:first-child')?.textContent) || null;
        const val = parseFloat(n(m.querySelector('.cp2-review-metric-val')?.textContent));
        if (label && Number.isFinite(val)) ratingBreakdown[label] = val;
      }

      const projectDetails = [];
      const projectDetailsMap = {};
      for (const chip of card.querySelectorAll('.cp2-review-tags [class*="cp2-chip"]')) {
        const value = n(chip.textContent);
        const label = n(chip.getAttribute('title')) || 'Category';
        if (!value) continue;
        projectDetails.push({ label, value });
        (projectDetailsMap[label] ||= []).push(value);
      }

      if (!reviewId && !summary && !title) continue;
      out.push({
        reviewId,
        reviewUrl: reviewId ? `${location.origin}${location.pathname}#review-${reviewId}` : null,
        title,
        summary,
        reviewer: { name: reviewerName, role: reviewerRole, verified },
        date: reviewDate,
        ratingBreakdown,
        projectDetails,
        projectDetailsMap,
        projectInformation: [],
        projectInformationMap: {},
        scrapedAt: new Date().toISOString(),
      });
    }

    // ── Legacy layout (kept as fallback) ────────────────────────────────────────
    for (const card of root.querySelectorAll('#reviews_list article.profile-review, article.profile-review')) {
      const reviewId = card.id ? card.id.replace(/^review-/, '') : null;
      const title = n(card.querySelector('.review-title')?.textContent) || null;
      const reviewerFull = n(card.querySelector('.reviewer-name')?.textContent) || null;
      const reviewerSpanName = n(card.querySelector('.reviewer-name span')?.textContent) || null;

      let reviewerName = reviewerSpanName;
      let reviewerRole = null;

      if (reviewerFull) {
        if (!reviewerName) {
          const m = reviewerFull.match(/^([^,]+),\s*(.+)$/);
          reviewerName = n(m ? m[1] : reviewerFull) || null;
          reviewerRole = m ? n(m[2]) || null : null;
        } else {
          reviewerRole = n(reviewerFull.replace(reviewerName, '').replace(/^,\s*/, '')) || null;
        }
      }
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
  }, htmlSnippet);
}

async function getNextPageNumber(page, htmlSnippet = null) {
  return page.evaluate((htmlSnippet) => {
    const root = htmlSnippet
      ? new DOMParser().parseFromString(htmlSnippet, 'text/html')
      : document;
    const next = root.querySelector('.pagination .next-page a[data-href], .pagination .next-page a[href]');
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
  }, htmlSnippet);
}

async function fetchPageViaNetwork(page, url) {
  return page.evaluate(async (fetchUrl) => {
    try {
      const res = await fetch(fetchUrl, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          'accept': 'text/html, */*; q=0.01',
          'x-requested-with': 'XMLHttpRequest'
        }
      });
      if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
      const html = await res.text();
      return { html, status: res.status };
    } catch (err) {
      return { error: String(err.message || err), status: 0 };
    }
  }, url);
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

  let company = prevCompany;
  let analytics = prevAnalytics;
  let progress = prevProgress || null;
  let stopReason = null;
  let stopExtra = null;
  let lastError = null;

  const maxProxyAttempts = 2;

  for (let proxyAttempt = 1; proxyAttempt <= maxProxyAttempts; proxyAttempt++) {
    let browser;
    let page;
    const tempUserDataDir = args.userDataDir;

    let pageNum = Number(progress?.nextPageNum || prevProgress?.nextPageNum || 1) || 1;
    if (!progress?.nextPageNum && !prevProgress?.nextPageNum && reviews.length) {
      pageNum = Math.floor(reviews.length / 10) + 1;
    }

    let hasLoadedFirstPage = false;

    try {
      ({ browser, page } = await launchBrowser(args));
      stopReason = null;
      stopExtra = null;

      while (reviews.length < target && pageNum <= args.maxPages) {
        const currentUrl = buildPageUrl(baseUrl, pageNum);
        let htmlSnippet = null;

        if (pageNum === 1 || !hasLoadedFirstPage) {
          console.log(`\n🌐 Page ${pageNum} (SSR): ${currentUrl}`);
          await goto(page, currentUrl);
          await clickConsent(page);

          const block = await detectBlock(page);
          if (isVerificationBlock(block)) {
            const err = new Error(`Blocked on page load: ${block.title || '(unknown)'} — ${block.snippet || ''}`);
            err.retryWithNextProxy = true;
            throw err;
          }

          const loaded = await waitForReviews(page);
          if (!loaded) {
            const afterWaitBlock = await detectBlock(page);
            if (isVerificationBlock(afterWaitBlock)) {
              const err = new Error(`Blocked on page load: ${afterWaitBlock.title || '(unknown)'} — ${afterWaitBlock.snippet || ''}`);
              err.retryWithNextProxy = true;
              throw err;
            }
          }

          hasLoadedFirstPage = true;

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
        } else {
          console.log(`\n📄 Page ${pageNum} (Network): ${currentUrl}`);
          const response = await fetchPageViaNetwork(page, currentUrl);
          if (response.error || !response.html) {
            stopReason = `api_error_${response.status || 'unknown'}`;
            console.warn(`  ⚠️  API returned error: ${response.error}`);
            break;
          }
          htmlSnippet = response.html;
          await sleep(1500 + Math.random() * 1000); // polite delay for network requests
        }

        const pageReviews = await extractPageReviews(page, htmlSnippet);
        if (!pageReviews.length) {
          console.log(`  ℹ️  No reviews found on page ${pageNum}`);
          stopReason = 'no_reviews_found';
          stopExtra = { url: currentUrl };
          progress = {
            lastPageNum: pageNum,
            lastPageUrl: currentUrl,
            nextPageNum: pageNum,
          };
          break;
        }

        let added = 0, duplicates = 0;
        for (const review of pageReviews) {
          const key = String(review.reviewId || review.reviewUrl || '');
          if (!key || seen.has(key)) { duplicates++; continue; }
          seen.add(key);
          reviews.push(review);
          added++;
          if (reviews.length >= target) break;
        }

        const nextPageNum = await getNextPageNumber(page, htmlSnippet);
        progress = {
          lastPageNum: pageNum,
          lastPageUrl: currentUrl,
          nextPageNum: nextPageNum || (pageNum + 1),
        };

        console.log(`  ✅ Added ${added} reviews (duplicates: ${duplicates}, total: ${reviews.length})`);

        if (reviews.length >= target) break;

        if (!nextPageNum || nextPageNum <= pageNum) {
          console.log(`  ℹ️  No more pages found after page ${pageNum}`);
          stopReason = 'no_more_pages';
          stopExtra = { url: currentUrl, nextPageNum };
          break;
        }

        pageNum = nextPageNum;
      }

      if (!stopReason && pageNum > args.maxPages) {
        stopReason = 'max_pages_reached';
        stopExtra = { maxPages: args.maxPages };
      }

      break;
    } catch (err) {
      const message = String(err?.message || err || '');
      const retryable = err?.retryWithNextProxy || VERIFY_RE.test(message) || /blocked on page load|challenge|verify|check/i.test(message);

      if (retryable && proxyAttempt < maxProxyAttempts) {
        lastError = err;
        console.warn(`\n[proxy] ${message}; retrying with next IP (${proxyAttempt}/${maxProxyAttempts})...`);
        const delay = 15000 + Math.floor(Math.random() * 10000);
        console.log(`[proxy] Waiting ${delay}ms before retry...`);
        await sleep(delay);
        continue;
      }

      if (retryable) {
        console.warn(`\n[proxy] Verification persisted after ${proxyAttempt}/${maxProxyAttempts} attempts.`);
      }

      console.error(`\n💥 Error: ${message}`);
      await writeAtomic(outPath, {
        sourceUrl: baseUrl,
        company,
        reviews,
        reviewsCount: reviews.length,
        done: false,
        reason: 'error',
        updatedAt: now(),
        extra: { error: message },
        progress,
      }).catch(() => { });
      process.exitCode = 1;
      lastError = err;
      break;
    } finally {
      await fs.rm(tempUserDataDir, { recursive: true, force: true }).catch(() => { });
      await browser?.close().catch(() => { });
    }
  }

  if (lastError && process.exitCode) {
    return;
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

  // Never fail silently: the profile says it has reviews but we parsed none → selectors are stale
  // (GoodFirms changed its layout again) or the page was a soft block. Exit non-zero so the
  // orchestrator marks the job FAILED instead of treating it as "0 reviews, all good".
  const expected = Number(totalReviews) || 0;
  if (reviews.length === 0 && expected > 0) {
    console.error(`❌ Profile reports ${expected} reviews but 0 were parsed (stopReason=${stopReason}). GoodFirms layout likely changed.`);
    process.exitCode = 1;
  } else if (expected > 0 && reviews.length < Math.min(expected, 15) && stopReason !== 'max_pages_reached') {
    console.warn(`⚠️  Parsed ${reviews.length} of ${expected} reviews (stopReason=${stopReason}).`);
  }
}

main().catch((err) => {
  console.error('❌ GoodFirms scraper failed:');
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});