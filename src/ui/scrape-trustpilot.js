import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 2500;

// ── Tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(f) {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); }
  catch { return null; }
}

async function writeAtomic(f, data) {
  if (f === '-') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const tmp = `${f}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, f);
  }
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
    .slice(0, 60) || 'company';
}

function companySlugFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.indexOf('review');
    if (i >= 0 && parts[i + 1]) return parts[i + 1];
    return parts.at(-1) || null;
  } catch {
    return null;
  }
}

function normalizeTrustpilotUrl(url) {
  const u = new URL(String(url || ''));
  // Always use the /review/<domain> canonical route
  if (!u.pathname.includes('/review/')) {
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts.at(-1);
    u.pathname = `/review/${last}`;
  }
  return u.toString();
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    url: null,
    maxReviews: 500,
    maxPages: 2000,
    captchaWaitMs: 600_000,
    userDataDir: path.join(
      process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
      '.cache', 'va-scrapper', 'trustpilot-profile'
    ),
    outDir: path.join('outputs', 'trustpilot'),
    resume: true,
    headful: false,
    blockAssets: true,
  };

  for (let i = 2; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--url') a.url = argv[++i];
    else if (f === '--maxReviews') a.maxReviews = Number(argv[++i]);
    else if (f === '--all') a.maxReviews = 0;
    else if (f === '--maxPages') a.maxPages = Number(argv[++i]);
    else if (f === '--captchaWaitMs') a.captchaWaitMs = Number(argv[++i]);
    else if (f === '--out') a.out = argv[++i];
    else if (f === '--outDir') a.outDir = argv[++i];
    else if (f === '--resume') a.resume = true;
    else if (f === '--noResume') a.resume = false;
    else if (f === '--headful') a.headful = true;
    else if (f === '--blockAssets') a.blockAssets = true;
    else if (f === '--noBlockAssets') a.blockAssets = false;
    else if (f === '--help' || f === '-h') {
      console.log(
        `Usage: node src/ui/scrape-trustpilot.js --url <companyReviewUrl> [options]\n\n` +
        `  --maxReviews N    Cap reviews (default: 500)\n` +
        `  --all             Scrape all available reviews\n` +
        `  --maxPages N      Safety cap on pages (default: 2000)\n` +
        `  --captchaWaitMs N Wait for manual captcha solve in headful mode (default: 600000)\n` +
        `  --userDataDir D   Chrome profile dir (default: .trustpilot-profile)\n` +
        `  --out <file>      Output file path (default: outputs/trustpilot/<slug>-<hash>.json)\n` +
        `  --outDir <dir>    Output folder (default: outputs/trustpilot)\n` +
        `  --resume          Continue from existing file (default: on)\n` +
        `  --noResume        Start fresh\n` +
        `  --headful         Show browser window\n` +
        `  --blockAssets     Block images/fonts (default: on)\n` +
        `  --noBlockAssets   Allow all assets`
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
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  );

  if (blockAssets) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') return req.abort();
      req.continue();
    });
  }

  return { browser, page };
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(POST_NAV_WAIT_MS);
}

async function clickConsent(page) {
  try {
    // Trustpilot commonly uses OneTrust. Try known IDs + fallback by button text.
    const clicked = await page.evaluate(() => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const byId = document.querySelector('#onetrust-accept-btn-handler');
      if (byId) {
        try { byId.click(); return true; } catch { }
      }

      for (const b of document.querySelectorAll('button,[role="button"]')) {
        const t = n(b.textContent);
        const a = n(b.getAttribute('aria-label'));
        if (
          t === 'accept' ||
          t.includes('accept all') ||
          t.includes('agree') ||
          a.includes('accept')
        ) {
          try { b.click(); return true; } catch { }
        }
      }

      return false;
    });

    if (clicked) await sleep(1200);
  } catch { }
}

async function waitForReviews(page) {
  try {
    await page.waitForSelector('article[data-service-review-card-paper="true"], [data-testid="service-review-card-v2"]', { timeout: 45_000 });
    return true;
  } catch {
    await sleep(2500);
    return false;
  }
}

async function detectBlockState(page) {
  try {
    return await page.evaluate(() => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const t = n(document.body?.innerText).slice(0, 2000).toLowerCase();
      const title = n(document.title).toLowerCase();
      const flags = {
        captcha: /captcha|verify|robot|human|unusual/i.test(t) || /captcha|verify/i.test(title),
        accessDenied: /access denied|forbidden|blocked|temporarily unavailable/i.test(t),
        cloudflare: /cloudflare/i.test(t) || /attention required/i.test(title),
      };
      const blocked = flags.captcha || flags.accessDenied || flags.cloudflare;
      return { blocked, flags, title: n(document.title), snippet: n(document.body?.innerText).slice(0, 300) };
    });
  } catch {
    return { blocked: false, flags: null, title: null, snippet: null };
  }
}

// ── Extraction ────────────────────────────────────────────────────────────────
function parseIntLoose(s) {
  const t = norm(s).replace(/,/g, '');
  const m = t.match(/(\d{1,12})/);
  return m ? Number(m[1]) : null;
}

function parseFloatLoose(s) {
  const t = norm(s).replace(',', '.');
  const m = t.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

async function extractCompanyInfo(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pInt = (s) => {
      const t = n(s).replace(/,/g, '');
      const m = t.match(/(\d{1,12})/);
      return m ? Number(m[1]) : null;
    };
    const pFloat = (s) => {
      const t = n(s).replace(',', '.');
      const m = t.match(/(\d+(?:\.\d+)?)/);
      return m ? Number(m[1]) : null;
    };

    const jsonLd = (() => {
      const all = [];
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        const txt = s.textContent;
        if (!txt) continue;
        try {
          const parsed = JSON.parse(txt);
          if (Array.isArray(parsed)) all.push(...parsed);
          else all.push(parsed);
        } catch {
          // ignore
        }
      }

      // Look for an object that contains aggregateRating
      for (const obj of all) {
        if (obj && typeof obj === 'object' && obj.aggregateRating && (obj.aggregateRating.ratingValue || obj.aggregateRating.reviewCount)) {
          return obj;
        }
      }
      return null;
    })();

    const ldName = jsonLd?.name ? n(jsonLd.name) : null;
    const h1 = n(document.querySelector('h1')?.textContent) || null;
    let name = ldName || h1;
    if (name) name = name.replace(/\bReviews\b.*$/i, '').trim() || name;

    const trustScore = (() => {
      const v = jsonLd?.aggregateRating?.ratingValue;
      const num = v != null ? pFloat(String(v)) : null;
      if (num != null && num > 0 && num <= 5) return num;

      // Trustpilot UI: score is usually the span right before the "Trustscore" info button
      const btn = document.querySelector('button[aria-label*="Trustscore" i]');
      const span = btn?.previousElementSibling;
      const ui = span ? pFloat(span.textContent) : null;
      if (ui != null && ui > 0 && ui <= 5) return ui;

      // Last-resort fallback: search nearby numeric spans
      const root = document.querySelector('[data-reviews-overview-paper="true"]')?.closest('div') || document.body;
      for (const el of root.querySelectorAll('span')) {
        const t = n(el.textContent);
        const num2 = pFloat(t);
        if (num2 != null && num2 > 0 && num2 <= 5 && t.length <= 4) return num2;
      }
      return null;
    })();

    const totalReviews = (() => {
      const v = jsonLd?.aggregateRating?.reviewCount;
      const num = v != null ? pInt(String(v)) : null;
      if (num != null) return num;

      const el = document.querySelector('[data-reviews-count-typography]');
      return el ? pInt(el.textContent) : null;
    })();

    const ratingDistribution = (() => {
      const out = {};
      for (const row of document.querySelectorAll('label[data-star-rating]')) {
        const k = row.getAttribute('data-star-rating');
        const title = row.getAttribute('title') || '';
        const count = pInt(title);
        const pctEl = row.querySelector('[data-rating-distribution-row-percentage-typography]');
        const pct = pctEl ? pInt(pctEl.textContent) : null;
        if (k) out[k] = { count, percent: pct };
      }
      return Object.keys(out).length ? out : null;
    })();

    const categories = [...document.querySelectorAll('[data-business-unit-info-category-typography] a')]
      .map((a) => n(a.textContent))
      .filter(Boolean);

    const description = n(document.querySelector('[data-testid="company-details-card"] [data-relevant-review-text-typography]')?.textContent) || null;

    const website = document.querySelector('[data-business-unit-about-section="true"] a[href*="utm_source=trustpilot"], [data-business-unit-about-section="true"] a[target="_blank"]')?.getAttribute('href') || null;

    const country = (() => {
      const v = jsonLd?.address?.addressCountry;
      const c = v ? n(v) : null;
      if (c) return c;

      const h2 = [...document.querySelectorAll('h2')].find((h) => n(h.textContent).toLowerCase() === 'contact info');
      const ul = h2?.parentElement?.querySelector('ul') || null;
      if (!ul) return null;
      for (const li of ul.querySelectorAll('li')) {
        const t = n(li.textContent);
        if (!t) continue;
        if (t.includes('http') || t.includes('www.') || t.includes('@')) continue;
        if (t.length > 60) continue;
        return t;
      }
      return null;
    })();

    return {
      name,
      trustScore,
      totalReviews,
      ratingDistribution,
      categories: categories.length ? categories : null,
      description,
      country,
      website,
      pageUrl: location.href,
      scrapedAt: new Date().toISOString(),
    };
  });
}

async function extractPageReviews(page) {
  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pInt = (s) => {
      const t = n(s).replace(/,/g, '');
      const m = t.match(/(\d{1,12})/);
      return m ? Number(m[1]) : null;
    };
    const abs = (u) => {
      try { return new URL(u, location.origin).toString(); }
      catch { return null; }
    };

    const nodes = [...document.querySelectorAll('[data-testid="service-review-card-v2"]')];
    const cards = nodes.length ? nodes : [...document.querySelectorAll('article[data-service-review-card-paper="true"]')];

    const idFromAttrs = (el) => {
      if (!el || !el.getAttributeNames) return null;
      for (const name of el.getAttributeNames()) {
        if (!name.toLowerCase().includes('id')) continue;
        const v = el.getAttribute(name);
        if (v && /^[0-9a-f]{24}$/i.test(v)) return v;
      }
      return null;
    };

    const out = [];
    for (const card of cards) {
      const a = card.querySelector('a[href*="/reviews/"]');
      const reviewHref = a?.getAttribute('href') || null;
      const reviewUrl = reviewHref ? abs(reviewHref) : null;
      const reviewId = (() => {
        const fromHref = reviewHref ? reviewHref.split('/').filter(Boolean).at(-1) : null;
        if (fromHref && /^[0-9a-f]{24}$/i.test(fromHref)) return fromHref;
        return idFromAttrs(card) || idFromAttrs(card.closest('article')) || null;
      })();

      const rating = (() => {
        const v = card.querySelector('[data-service-review-rating]')?.getAttribute('data-service-review-rating');
        if (v) {
          const num = Number(v);
          if (Number.isFinite(num)) return num;
        }
        const alt = card.querySelector('img[alt*="out of 5" i]')?.getAttribute('alt') || '';
        const m = alt.match(/Rated\s+(\d)\s+out\s+of\s+5/i);
        return m ? Number(m[1]) : null;
      })();

      const title = (() => {
        const t1 = n(card.querySelector('[data-service-review-title-typography]')?.textContent);
        if (t1) return t1;
        const t2 = n(card.querySelector('a[href*="/reviews/"] h2')?.textContent);
        if (t2) return t2;
        const t3 = n(card.querySelector('h2')?.textContent);
        return t3 || null;
      })();

      const text = (() => {
        const t1 = n(card.querySelector('[data-service-review-text-typography]')?.textContent);
        if (t1) return t1;
        const t2 = n(card.querySelector('[data-review-content] p')?.textContent);
        if (t2) return t2;
        const t3 = n(card.querySelector('p')?.textContent);
        return t3 || null;
      })();

      const dateEl = card.querySelector('time[data-service-review-date-time-ago]') || card.querySelector('time[datetime]');
      const reviewDate = n(dateEl?.textContent) || null;
      const reviewDateTime = dateEl?.getAttribute('datetime') || null;

      const root = card.closest('article') || card;

      const consumerName = n(root.querySelector('[data-consumer-name-typography]')?.textContent) || null;
      const consumerProfileHref = root.querySelector('a[data-consumer-profile-link]')?.getAttribute('href') || null;
      const consumerProfileUrl = consumerProfileHref ? abs(consumerProfileHref) : null;
      const consumerCountry = n(root.querySelector('[data-consumer-country-typography]')?.textContent) || null;
      const consumerReviewsCount = pInt(root.querySelector('[data-consumer-reviews-count-typography]')?.textContent) || null;

      const badges = [...card.querySelectorAll('[data-testid^="review-badge-"]')]
        .map((b) => n(b.textContent))
        .filter(Boolean);

      const usefulBtn = card.querySelector('button[name="find-useful"],button[data-find-useful-button]');
      const usefulCount = usefulBtn ? (pInt(usefulBtn.textContent) ?? 0) : null;

      const reply = (() => {
        const replyText = n(root.querySelector('[data-service-review-business-reply-text-typography]')?.textContent);
        if (!replyText) return null;
        const replyFrom = n(root.querySelector('[data-service-review-business-reply-title-typography]')?.textContent) || null;
        const rt = root.querySelector('time[data-service-review-business-reply-date-time-ago]');
        return {
          from: replyFrom,
          date: n(rt?.textContent) || null,
          dateTime: rt?.getAttribute('datetime') || null,
          text: replyText,
        };
      })();

      out.push({
        reviewId,
        reviewUrl,
        rating,
        title,
        text,
        date: reviewDate,
        dateTime: reviewDateTime,
        badges: badges.length ? badges : null,
        usefulCount,
        reviewer: {
          name: consumerName,
          profileUrl: consumerProfileUrl,
          country: consumerCountry,
          reviewsCount: consumerReviewsCount,
        },
        companyReply: reply,
        scrapedAt: new Date().toISOString(),
      });
    }

    return out;
  });
}

async function getNextPageUrl(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Pagination"]');
    if (!nav) return null;

    const candidates = [
      'a[rel="next"]',
      'a[data-pagination-button-next-link="true"]',
      'a[name="pagination-button-next"]',
      'a[aria-label*="Next" i]',
    ];

    for (const sel of candidates) {
      const a = nav.querySelector(sel);
      if (!a) continue;
      const disabled = a.getAttribute('aria-disabled');
      if (disabled === 'true') return null;
      const href = a.getAttribute('href');
      if (href) return href;
    }

    return null;
  });
}

function buildNextByIncrement(url) {
  const u = new URL(url);
  const cur = Number(u.searchParams.get('page') || '1');
  const next = Number.isFinite(cur) && cur > 0 ? cur + 1 : 2;
  u.searchParams.set('page', String(next));
  return u.toString();
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  const baseUrl = normalizeTrustpilotUrl(args.url);
  const slug = slugify(companySlugFromUrl(baseUrl) || 'company');
  const fileId = hashStr(baseUrl.split('?')[0]);

  const outPath = args.out === '-'
    ? '-'
    : args.out
      ? args.out
      : path.join(outDir, `${slug}-${fileId}.json`);

  if (outPath !== '-') {
    await ensureDir(path.dirname(path.resolve(outPath)));
    if (!args.resume) {
      await fs.rm(outPath, { force: true }).catch(() => { });
    }
  }

  const prev = args.resume && outPath !== '-' ? await readJson(outPath) : null;
  const existing = Array.isArray(prev?.reviews) ? prev.reviews : [];
  const prevCompany = prev?.company || null;

  const seen = new Set(existing.map((r) => r?.reviewId).filter(Boolean));
  const reviews = [...existing];

  const target = args.maxReviews === 0 ? Infinity : args.maxReviews;

  console.log(`📁 Output : ${outPath}`);
  console.log(`📝 Resumed: ${reviews.length} reviews`);

  const { browser, page } = await launchBrowser(args);

  let company = prevCompany;
  const prevProgress = prev?.progress || null;

  let current = prevProgress?.nextUrl || baseUrl;
  let pageNum = prevProgress?.nextPageNum ? (prevProgress.nextPageNum - 1) : 0;

  // Back-compat: old files didn't store progress. Infer next page from count (20 per page).
  if (!prevProgress?.nextUrl && reviews.length) {
    const inferredNextPage = Math.floor(reviews.length / 20) + 1;
    const u = new URL(baseUrl);
    if (inferredNextPage > 1) u.searchParams.set('page', String(inferredNextPage));
    current = u.toString();
    pageNum = inferredNextPage - 1;
  }

  let progress = prevProgress || null;
  const visited = new Set();
  let noNewPages = 0;

  let stopReason = null;
  let stopExtra = null;

  try {
    while (reviews.length < target && pageNum < args.maxPages) {
      pageNum++;
      if (visited.has(current)) {
        throw new Error(`Pagination loop detected at ${current}`);
      }
      visited.add(current);

      console.log(`\n🌐 Page ${pageNum}: ${current}`);

      await goto(page, current);
      await clickConsent(page);
      await waitForReviews(page);

      // Human-ish pacing (reduces rate-limit)
      await sleep(900 + Math.floor(Math.random() * 1400));

      if (!company) {
        company = await extractCompanyInfo(page);
        console.log(`🏷️  Company: ${company?.name || '(unknown)'}`);
      }

      let pageReviews = [];
      let blockedState = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        pageReviews = await extractPageReviews(page);
        if (pageReviews.length) break;

        const bs = await detectBlockState(page);
        if (bs?.blocked) {
          // If headful, let user solve reCAPTCHA/login then continue.
          if (args.headful && bs.flags?.captcha && args.captchaWaitMs > 0) {
            console.log(`⚠️  reCAPTCHA/login detected on ${page.url()}`);
            console.log(`➡️  Please solve it in the opened browser. Waiting up to ${Math.round(args.captchaWaitMs / 1000)}s...`);
            try {
              await page.bringToFront();
              await page.waitForSelector('article[data-service-review-card-paper="true"], [data-testid="service-review-card-v2"]', { timeout: args.captchaWaitMs });
              blockedState = null;
              continue;
            } catch {
              blockedState = bs;
              break;
            }
          }

          blockedState = bs;
          break;
        }

        if (attempt < 3) {
          await sleep(1500 * attempt);
          try {
            await page.reload({ waitUntil: 'domcontentloaded' });
            await clickConsent(page);
            await waitForReviews(page);
          } catch {
            // ignore
          }
        }
      }

      if (!pageReviews.length) {
        const retrySame = blockedState?.blocked ? true : false;
        stopReason = blockedState?.blocked ? 'blocked_or_captcha' : 'empty_page_no_reviews';
        stopExtra = blockedState?.blocked ? { blockedState } : null;
        progress = {
          lastPageNum: pageNum,
          lastPageUrl: page.url(),
          nextPageNum: retrySame ? pageNum : null,
          nextUrl: retrySame ? current : null,
        };
        break;
      }

      let added = 0;
      for (const r of pageReviews) {
        if (reviews.length >= target) break;
        const id = r?.reviewId;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        reviews.push(r);
        added++;
      }

      if (added === 0) noNewPages++;
      else noNewPages = 0;

      let nextUrl = null;
      if (reviews.length < target) {
        const nextHref = await getNextPageUrl(page);
        nextUrl = nextHref ? new URL(nextHref, page.url()).toString() : buildNextByIncrement(page.url());
      }

      progress = {
        lastPageNum: pageNum,
        lastPageUrl: page.url(),
        nextPageNum: nextUrl ? pageNum + 1 : null,
        nextUrl,
      };

      await writeAtomic(outPath, {
        sourceUrl: args.url,
        company,
        reviews,
        reviewsCount: reviews.length,
        target: args.maxReviews === 0 ? (company?.totalReviews ?? null) : args.maxReviews,
        done: false,
        reason: null,
        updatedAt: now(),
        progress,
      });

      console.log(`✅ Added ${added} (total ${reviews.length})`);

      if (reviews.length >= target) break;
      if (!nextUrl) break;
      if (noNewPages >= 3) {
        console.log('⚠️  No new reviews on 3 consecutive pages — stopping (resume will continue from progress.nextUrl).');
        stopReason = 'no_new_reviews';
        break;
      }

      current = nextUrl;
    }

    const done = args.maxReviews === 0
      ? (company?.totalReviews ? reviews.length >= company.totalReviews : false)
      : reviews.length >= args.maxReviews;

    await writeAtomic(outPath, {
      sourceUrl: args.url,
      company,
      reviews,
      reviewsCount: reviews.length,
      target: args.maxReviews === 0 ? (company?.totalReviews ?? null) : args.maxReviews,
      done,
      reason: done ? null : (stopReason || (pageNum >= args.maxPages ? 'max_pages_reached' : 'no_more_pages_or_blocked')),
      updatedAt: now(),
      extra: done ? null : stopExtra,
      progress,
    });

    console.log(`\n🏁 Finished: ${reviews.length}  done=${done}`);

  } catch (err) {
    console.error(`\n💥 Error: ${err.message}`);
    await writeAtomic(outPath, {
      sourceUrl: args.url,
      company,
      reviews,
      reviewsCount: reviews.length,
      target: args.maxReviews === 0 ? (company?.totalReviews ?? null) : args.maxReviews,
      done: false,
      reason: 'error',
      updatedAt: now(),
      extra: { error: err.message },
    }).catch(() => { });
    process.exitCode = 1;

  } finally {
    await browser.close();
  }
}

await main();
