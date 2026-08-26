import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import puppeteer from 'puppeteer-core';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PROFILE_DIR = path.join(process.cwd(), '.gmaps-profile');

const MAX_DEFAULT         = 3000;
const BATCH_SIZE          = 50;
const NAV_TIMEOUT         = 90_000;

// Scroll timing
const SCROLL_MS_MIN       = 800;
const SCROLL_MS_MAX       = 3000;
const SCROLL_STEP_MS      = 150;

// Stall / recovery
const NO_NEW_LIMIT        = 40;
const MAX_RECOVERY        = 8;
const RECOVERY_DELAY_MS   = 3500;
const POST_SORT_WAIT_MS   = 2500;
const POST_NAV_WAIT_MS    = 2500;

// Performance
const FEED_REFRESH_EVERY      = 30;   // re-acquire feed handle every N cycles
const PRUNE_EVERY             = 200;  // remove seen cards from DOM every N new reviews
const PRUNE_BATCH             = 150;  // max cards to remove per prune pass
const REVIEW_URLS_PER_CYCLE   = 3;    // when --reviewUrls, scrape at most N share URLs per scroll cycle
const MAX_BACKFILL_CYCLES     = 500;  // safety cap for backfill-only runs

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));
const now    = ()   => new Date().toISOString();
const norm   = (s)  => String(s || '').replace(/\s+/g, ' ').trim();
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJson(f) {
  try { return JSON.parse(await fs.readFile(f, 'utf8')); }
  catch { return null; }
}

async function writeAtomic(f, d) {
  if (f === '-') {
    console.log(JSON.stringify(d, null, 2));
  } else {
    const t = `${f}.${Date.now()}.tmp`;
    await fs.writeFile(t, JSON.stringify(d, null, 2), 'utf8');
    await fs.rename(t, f);
  }
}

async function appendNdjson(file, rows) {
  if (!rows.length) return;
  const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await fs.appendFile(file, payload, 'utf8');
}

function slugify(s) {
  return norm(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'place';
}

function cidFromUrl(url) {
  try {
    const m = [...String(url).matchAll(/:0x([0-9a-fA-F]{8,})/g)];
    return m.length ? BigInt('0x' + m.at(-1)[1]).toString(10) : null;
  } catch { return null; }
}

function placeFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean);
    const i = parts.indexOf('place');
    return i >= 0 ? decodeURIComponent(parts[i + 1]).replace(/\+/g, ' ') : null;
  } catch { return null; }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h  = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function reviewKey(r) {
  if (r?.reviewId) return `id:${r.reviewId}`;
  return `fb:${norm(r?.authorName)}|${norm(r?.relativeTime)}|${norm(r?.text).slice(0, 80)}`;
}

async function loadSeenKeysFromNdjson(file) {
  const seen = new Set();
  try { await fs.access(file); } catch { return seen; }

  const rl = readline.createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    try { seen.add(reviewKey(JSON.parse(t))); }
    catch { /* ignore malformed lines */ }
  }

  return seen;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    url:            null,
    maxReviews:     MAX_DEFAULT,
    out:            null,
    outDir:         'outputs',
    resume:         true,
    headful:        false,
    userDataDir:    PROFILE_DIR,
    blockAssets:    true,
    reviewUrls:     false,
    reviewUrlLimit: 200,
  };

  for (let i = 2; i < argv.length; i++) {
    const f = argv[i];
    if      (f === '--url')           a.url          = argv[++i];
    else if (f === '--maxReviews')    a.maxReviews   = Number(argv[++i]);
    else if (f === '--all')           a.maxReviews   = 0;
    else if (f === '--out')           a.out          = argv[++i];
    else if (f === '--outDir')        a.outDir       = argv[++i];
    else if (f === '--resume')        a.resume       = true;
    else if (f === '--noResume')      a.resume       = false;
    else if (f === '--headful')       a.headful      = true;
    else if (f === '--userDataDir')   a.userDataDir  = argv[++i];
    else if (f === '--blockAssets')   a.blockAssets  = true;
    else if (f === '--noBlockAssets') a.blockAssets  = false;
    else if (f === '--reviewUrls')       a.reviewUrls   = true;
    else if (f === '--noReviewUrls')     a.reviewUrls   = false;
    else if (f === '--reviewUrlLimit')   a.reviewUrlLimit = Number(argv[++i]);
    else if (f === '--help' || f === '-h') {
      console.log(
        `Usage: node src/ui/scrape-google-maps.js --url <url> [options]\n` +
        `  --maxReviews N      Cap reviews (default: ${MAX_DEFAULT})\n` +
        `  --all               Scrape all available reviews\n` +
        `  --out <file>        Output JSON file path (default: outputs/google/<place>-<id>.json)\n` +
        `  --outDir <dir>      Output root folder (default: outputs)\n` +
        `  --resume            Continue from existing files (default: on)\n` +
        `  --noResume          Start fresh\n` +
        `  --headful           Show browser\n` +
        `  --userDataDir <d>   Chrome profile dir\n` +
        `  --blockAssets       Block images/fonts (default: on)\n` +
        `  --noBlockAssets     Allow all assets\n` +
        `  --reviewUrls        Scrape each review's real Share URL (slow)\n` +
        `  --noReviewUrls      Disable review URL scraping\n` +
        `  --reviewUrlLimit N  Backfill at most N missing reviewUrls when resuming (default: 200)\n\n` +
        `Tip: wrap Google Maps URLs in single quotes (') because they contain ! characters.`
      );
      process.exit(0);
    }
  }

  if (!a.url) throw new Error('--url is required');
  return a;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser({ headful, userDataDir, blockAssets }) {
  const browser = await puppeteer.launch({
    headless:        headful ? false : 'new',
    executablePath:  CHROME,
    userDataDir,
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
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const ver = (await browser.version()).split('/')[1] || '124.0.0.0';
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
      if (t === 'stylesheet' &&
          (u.includes('fonts.googleapis') || u.includes('fonts.gstatic'))) {
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
      return;
    } catch (e) {
      if (i === retries - 1) throw e;
      await sleep(3000 * (i + 1));
    }
  }
}

// ── Consent / CAPTCHA ─────────────────────────────────────────────────────────
async function clickConsent(page) {
  try {
    await page.evaluate(() => {
      const want = ['accept all', 'accept', 'i agree', 'agree'];
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const btn = [...document.querySelectorAll('button,[role="button"]')]
        .find((b) => want.some((w) => n(b.textContent).includes(w)));
      if (btn) btn.click();
    });
  } catch {}
}

async function hasCaptcha(page) {
  return page.evaluate(() =>
    !!document.querySelector(
      'iframe[src*="recaptcha"],iframe[src*="challenges.cloudflare"],' +
      'div.g-recaptcha,form#captcha-form,[id*="captcha"],[class*="captcha"]'
    )
  );
}

// ── Place info ────────────────────────────────────────────────────────────────
async function extractPlaceInfo(page) {
  const onReviews = await page.evaluate(() =>
    !!(document.querySelector('[role="feed"]') || document.querySelector('[data-review-id]')) &&
    !document.querySelector('h1.DUwDvf,h1')
  );

  if (onReviews) {
    await page.evaluate(() => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const tab = [...document.querySelectorAll('[role="tab"],button')]
        .find((el) => n(el.textContent) === 'overview');
      if (tab) tab.click();
    });
    await sleep(1500);
  }

  // Rating/name can be late-rendered; wait briefly to reduce nulls
  try {
    await page.waitForFunction(() => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const readRating = (txt) => {
        const m = n(txt).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
        const v = m ? Number(m[1]) : NaN;
        return Number.isFinite(v) && v > 0 && v <= 5 ? v : null;
      };

      const name = document.querySelector('h1.DUwDvf,h1')?.textContent;
      const f7   = document.querySelector('div.F7nice');
      const aria = document.querySelector('span[aria-label*="star" i],span[aria-label*="stars" i],span[role="img"][aria-label*="star" i]');

      const okName   = Boolean(n(name));
      const okRating = Boolean(
        readRating(f7?.textContent || '') != null ||
        readRating(aria?.getAttribute('aria-label') || '') != null
      );

      return okName || okRating;
    }, { timeout: 8000 });
  } catch {}

  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const $ = (sel) => { const el = document.querySelector(sel); return el ? n(el.textContent) : null; };

    const name = $('h1.DUwDvf,h1');

    const overallRating = (() => {
      const read = (txt) => {
        const m = n(txt).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
        const v = m ? Number(m[1]) : NaN;
        // Guard: avoid accidentally reading the review-count as the rating
        return Number.isFinite(v) && v > 0 && v <= 5 ? v : null;
      };

      // 1) The rating block itself often has a clean numeric text
      const f7 = document.querySelector('div.F7nice');
      const fromF7 = read(f7?.textContent || '');
      if (fromF7 != null) return fromF7;

      // 2) Common: aria-label "4.4 stars" (sometimes becomes " stars" later)
      for (const el of document.querySelectorAll(
        'div.F7nice span[aria-label*="star" i],span[aria-label*="stars" i],span[aria-label*="star" i],span[role="img"][aria-label*="star" i]'
      )) {
        const got = read(el.getAttribute('aria-label') || '');
        if (got != null) return got;
      }

      // 3) Visible number in the rating block (avoid empty-text matches)
      for (const el of document.querySelectorAll(
        'div.F7nice span[aria-hidden="true"],div.F7nice span.fontDisplayLarge,span.fontDisplayLarge,span.ceNzKf'
      )) {
        const got = read(el.textContent || '');
        if (got != null) return got;
      }

      // 4) Schema/meta fallback
      const meta = document.querySelector('meta[itemprop="ratingValue"]')?.getAttribute('content');
      const fromMeta = read(meta || '');
      if (fromMeta != null) return fromMeta;

      // 5) JSON-LD fallback
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(s.textContent || 'null');
          const arr = Array.isArray(data) ? data : [data];
          for (const obj of arr) {
            const v = obj?.aggregateRating?.ratingValue ?? obj?.ratingValue;
            const got = read(String(v ?? ''));
            if (got != null) return got;
          }
        } catch { }
      }

      return null;
    })();

    const totalReviews = (() => {
      const f7 = document.querySelector('div.F7nice,span.jANrlb');
      if (f7) {
        const m = f7.textContent.replace(/,/g, '').match(/\((\d{1,9})\)/);
        if (m) return Number(m[1]);
      }
      const btn = document.querySelector(
        'button[jsaction="pane.rating.moreReviews"],[jsaction*="moreReviews"]'
      );
      if (btn) {
        const m = (btn.getAttribute('aria-label') || btn.textContent)
          .replace(/,/g, '').match(/(\d{1,9})/);
        if (m) return Number(m[1]);
      }
      return null;
    })();

    const category = $('button.DkEaL,button[jsaction*="pane.rating.category"]');

    const address = (() => {
      const el = document.querySelector('button[data-item-id="address"],[data-item-id="address"]');
      const a = n(el?.getAttribute('aria-label') || '');
      return a.toLowerCase().startsWith('address:') ? a.slice(8).trim() : n(el?.textContent) || null;
    })();

    const phone = (() => {
      const el = document.querySelector('button[data-item-id^="phone"],[data-item-id^="phone"]');
      const a = n(el?.getAttribute('aria-label') || '');
      return a.toLowerCase().startsWith('phone:') ? a.slice(6).trim() : n(el?.textContent) || null;
    })();

    const website = document.querySelector('a[data-item-id="authority"]')?.getAttribute('href') || null;

    const plusCode = (() => {
      const el = document.querySelector('[data-item-id="oloc"],button[aria-label*="plus code" i]');
      if (el) {
        const a = n(el.getAttribute('aria-label') || '');
        if (/plus\s*code/i.test(a)) return a.replace(/^.*plus\s*code[:\s]*/i, '').trim() || null;
        const t = n(el.textContent);
        if (/[A-Z0-9]{4,}\+[A-Z0-9]{2,}/.test(t)) return t;
      }
      for (const el of document.querySelectorAll('button,span')) {
        const t = n(el.textContent);
        if (/^[A-Z0-9]{4,}\+[A-Z0-9]{2,}(\s|$)/.test(t) && t.length < 60) return t;
      }
      return null;
    })();

    return { name, overallRating, totalReviews, category, address, phone, website, plusCode };
  });
}

// ── Reviews panel ─────────────────────────────────────────────────────────────
async function extractRatingOnly(page) {
  // Useful as a fallback after opening the reviews panel
  try {
    await page.waitForFunction(() => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const read = (txt) => {
        const m = n(txt).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
        const v = m ? Number(m[1]) : NaN;
        return Number.isFinite(v) && v > 0 && v <= 5 ? v : null;
      };

      const f7 = document.querySelector('div.F7nice');
      const aria = document.querySelector('span[aria-label*="star" i],span[aria-label*="stars" i],span[role="img"][aria-label*="star" i]');
      return Boolean(read(f7?.textContent || '') != null || read(aria?.getAttribute('aria-label') || '') != null);
    }, { timeout: 5000 });
  } catch {}

  return page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const read = (txt) => {
      const m = n(txt).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
      const v = m ? Number(m[1]) : NaN;
      return Number.isFinite(v) && v > 0 && v <= 5 ? v : null;
    };

    const overallRating = (() => {
      const f7 = document.querySelector('div.F7nice');
      const fromF7 = read(f7?.textContent || '');
      if (fromF7 != null) return fromF7;

      for (const el of document.querySelectorAll(
        'div.F7nice span[aria-label*="star" i],span[aria-label*="stars" i],span[aria-label*="star" i],span[role="img"][aria-label*="star" i]'
      )) {
        const got = read(el.getAttribute('aria-label') || '');
        if (got != null) return got;
      }

      for (const el of document.querySelectorAll(
        'span.fontDisplayLarge,span.ceNzKf,div.F7nice span[aria-hidden="true"],div.F7nice span.fontDisplayLarge'
      )) {
        const got = read(el.textContent || '');
        if (got != null) return got;
      }

      return null;
    })();

    const totalReviews = (() => {
      const f7 = document.querySelector('div.F7nice,span.jANrlb');
      if (f7) {
        const m = String(f7.textContent || '').replace(/,/g, '').match(/\((\d{1,9})\)/);
        if (m) return Number(m[1]);
      }
      return null;
    })();

    return { overallRating, totalReviews };
  });
}

async function openReviews(page) {
  await page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const tab = [...document.querySelectorAll('[role="tab"],button')]
      .find((el) => n(el.textContent) === 'reviews');
    if (tab) { tab.scrollIntoView({ block: 'center' }); tab.click(); return; }
    const btn = document.querySelector(
      'button[jsaction="pane.rating.moreReviews"],[jsaction*="moreReviews"]'
    );
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); }
  });

  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ok = await page.evaluate(() =>
      !!(document.querySelector('[role="feed"]') || document.querySelector('[data-review-id]'))
    );
    if (ok) return true;
  }
  return false;
}

async function setSort(page, mode) {
  try {
    await page.evaluate(async (m) => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const btn = [...document.querySelectorAll('button,[role="button"]')]
        .find((b) =>
          n(b.textContent) === 'sort' ||
          (n(b.getAttribute('aria-label')).includes('sort') &&
           n(b.getAttribute('aria-label')).includes('review'))
        );
      if (!btn) return;
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
      const want = m === 'newest' ? ['newest'] : ['most relevant', 'relevant'];
      const item = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],li')]
        .find((el) => want.some((w) => n(el.textContent).includes(w)));
      if (item) item.click();
    }, mode);
    await sleep(POST_SORT_WAIT_MS);
  } catch {}
}

// ── Feed element ──────────────────────────────────────────────────────────────
async function getFeedEl(page) {
  let handle;
  try {
    handle = await page.evaluateHandle(() => {
      const card = document.querySelector('[data-review-id],div.jftiEf');
      if (card) {
        let el = card.parentElement;
        while (el && el !== document.body) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
            return el;
          }
          el = el.parentElement;
        }
        const wrap = card.closest('div.m6QErb');
        if (wrap) return wrap;
      }
      return document.querySelector('[role="feed"]') || null;
    });

    const el = handle?.asElement?.();
    if (!el) {
      try { await handle.dispose(); } catch {}
      return null;
    }
    return el;
  } catch {
    try { await handle?.dispose(); } catch {}
    return null;
  }
}

// ── DOM pruning ───────────────────────────────────────────────────────────────
/**
 * Remove already-collected review cards from the DOM to keep
 * querySelectorAll fast. Only removes cards with a stable data-review-id
 * to avoid accidentally dropping unseen cards.
 */
async function pruneSeenCards(page, seenKeys) {
  const ids = [...seenKeys]
    .filter((k) => k.startsWith('id:'))
    .map((k) => k.slice(3))
    .slice(0, PRUNE_BATCH);

  if (!ids.length) return;

  const pruned = await page.evaluate((idList) => {
    const set = new Set(idList);
    let count = 0;
    for (const card of document.querySelectorAll('[data-review-id]')) {
      const id = card.getAttribute('data-review-id');
      if (id && set.has(id)) {
        const wrapper = card.closest('div.jftiEf') || card;
        wrapper.remove();
        count++;
      }
    }
    return count;
  }, ids);

  if (pruned > 0) {
    process.stdout.write(`\n🧹 Pruned ${pruned} seen cards from DOM\n`);
  }
}

// ── Content expansion ─────────────────────────────────────────────────────────
async function expandMore(page) {
  try {
    const clicked = await page.evaluate(() => {
      let n = 0;
      for (const b of document.querySelectorAll('button,[role="button"]')) {
        if (n >= 15) break;
        const txt = String(b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (txt === 'more' || txt === 'more…' || txt === 'see more') {
          try { b.click(); n++; } catch {}
        }
      }
      return n;
    });
    if (clicked > 0) await sleep(400);
  } catch {}
}

async function scrapeReviewShareUrl(page, reviewId) {
  if (!reviewId) return null;

  // Try to open share UI for this specific review, then read the link from the dialog.
  try {
    const clicked = await page.evaluate((id) => {
      const esc = (s) => {
        try { return CSS.escape(s); } catch { return String(s).replace(/"/g, '\\"'); }
      };
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const root = document.querySelector(`[data-review-id="${esc(id)}"]`) ||
        [...document.querySelectorAll('[data-review-id]')].find((el) => (el.getAttribute('data-review-id') || '') === id) ||
        null;

      const card = root?.closest('div.jftiEf') || root;
      if (!card) return { ok: false, reason: 'card_not_found' };

      try { card.scrollIntoView({ block: 'center' }); } catch {}

      const btns = [...card.querySelectorAll('button,[role="button"],a[role="button"]')];

      // 1) direct share button
      const shareBtn = btns.find((b) => {
        const a = n(b.getAttribute('aria-label'));
        const t = n(b.textContent);
        const js = n(b.getAttribute('jsaction'));
        return a.includes('share') || t === 'share' || js.includes('share');
      });

      if (shareBtn) {
        try { shareBtn.click(); return { ok: true, reason: 'share_button' }; } catch {}
      }

      // 2) overflow menu -> share
      const moreBtn = btns.find((b) => {
        const a = n(b.getAttribute('aria-label'));
        const t = n(b.textContent);
        return a.includes('more') || a.includes('options') || t === 'more' || t.includes('more options');
      });

      if (moreBtn) {
        try { moreBtn.click(); } catch {}
        return { ok: true, reason: 'more_menu' };
      }

      return { ok: false, reason: 'no_share_or_more' };
    }, reviewId);

    if (!clicked?.ok) return null;

    // If we opened the overflow menu, attempt to click "Share" item
    await page.evaluate(() => {
      const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const items = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],li,div[role="option"]')];
      const share = items.find((el) => n(el.textContent) === 'share' || n(el.textContent).includes('share'));
      if (share) {
        try { share.click(); } catch {}
      }
    });

    const url = await page.waitForFunction(() => {
      const isUrl = (v) => {
        if (typeof v !== 'string') return false;
        if (!/^https?:\/\//i.test(v)) return false;
        try {
          const u = new URL(v);
          const h = u.hostname;
          // Google often returns maps.app.goo.gl short links from the Share dialog
          if (h.endsWith('maps.app.goo.gl')) return true;
          if (h.endsWith('goo.gl') && /\/maps/i.test(u.pathname)) return true;
          if (h.endsWith('google.com') && /\/maps/i.test(u.pathname)) return true;
          return false;
        } catch {
          return false;
        }
      };

      const roots = [...document.querySelectorAll('[role="dialog"],div[aria-modal="true"],div[role="dialog"]')];
      for (const r of roots) {
        // input-based share dialog
        const inp = r.querySelector('input[type="text"],input:not([type]),textarea');
        const v = inp?.value || inp?.getAttribute?.('value');
        if (isUrl(v)) return v;

        // sometimes a link is rendered directly
        const a = r.querySelector('a[href^="http"]');
        const h = a?.getAttribute('href');
        if (isUrl(h)) return h;

        // sometimes stored on clipboard button attributes
        const clip = r.querySelector('[data-clipboard-text]');
        const c = clip?.getAttribute('data-clipboard-text');
        if (isUrl(c)) return c;
      }
      return null;
    }, { timeout: 6000 }).then((h) => h.jsonValue()).catch(() => null);

    // close any open dialogs/menus
    try { await page.keyboard.press('Escape'); } catch {}
    try { await page.keyboard.press('Escape'); } catch {}

    return typeof url === 'string' ? url : null;
  } catch {
    try { await page.keyboard.press('Escape'); } catch {}
    return null;
  }
}

// ── Review extraction (viewport-aware) ───────────────────────────────────────
/**
 * Only processes cards near or below the current scroll position.
 * Cards far above the viewport are already captured (or pruned), so skipping
 * them keeps each pass O(new cards) instead of O(all cards ever rendered).
 */
async function resolveShareUrl(u) {
  if (!u) return null;
  try {
    const res = await fetch(u, { redirect: 'follow' });
    const finalUrl = res.url || null;
    try { await res.body?.cancel?.(); } catch {}
    return finalUrl;
  } catch {
    return null;
  }
}

async function fillShareUrlsFromVisible(page, visible, byReviewId, budget) {
  let filled = 0;
  for (const r of visible) {
    if (budget <= 0) break;
    if (!r?.reviewId) continue;

    const existing = byReviewId.get(r.reviewId);
    // If we already resolved a long URL, skip
    if (existing?.reviewUrl && String(existing.reviewUrl).includes('/maps/reviews/data=')) continue;

    // Retry a bit because Share UI sometimes doesn't render the link instantly
    let u = await scrapeReviewShareUrl(page, r.reviewId);
    if (!u) u = await scrapeReviewShareUrl(page, r.reviewId);
    budget--;

    if (u) {
      const resolved = await resolveShareUrl(u);
      const finalUrl = resolved || u;

      if (existing) {
        existing.reviewShareUrl = u;
        existing.reviewUrl = finalUrl;
      } else {
        r.reviewShareUrl = u;
        r.reviewUrl = finalUrl;
      }

      filled++;
    }
  }
  return filled;
}

async function extractVisibleReviews(page) {
  return page.evaluate(() => {
    const n  = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pN = (t) => {
      const m = n(t).replace(/,/g, '').match(/(\d{1,7})/);
      const v = Number(m?.[1]);
      return Number.isFinite(v) ? v : null;
    };

    const parseMeta = (txt) => {
      const meta = n(txt);
      const isLocalGuide = /local guide/i.test(meta);
      let reviewsCount = null;
      let photosCount  = null;
      for (const p of meta.split('·').map(n)) {
        if (/reviews?/i.test(p))  reviewsCount = pN(p);
        if (/photos?/i.test(p))   photosCount  = pN(p);
      }
      return {
        authorMeta:          meta || null,
        authorReviewsCount:  reviewsCount,
        authorPhotosCount:   photosCount,
        authorIsLocalGuide:  isLocalGuide,
      };
    };

    // Locate the scrollable feed container (same logic as getFeedEl, but in-page)
    const feed = (() => {
      const card = document.querySelector('[data-review-id],div.jftiEf');
      if (card) {
        let el = card.parentElement;
        while (el && el !== document.body) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 10) {
            return el;
          }
          el = el.parentElement;
        }
        return card.closest('div.m6QErb') || null;
      }
      return document.querySelector('[role="feed"]') || null;
    })();

    // Skip cards that are more than half a screen above the current scroll bottom
    const scrollTop = feed?.scrollTop  ?? 0;
    const clientH   = feed?.clientHeight ?? window.innerHeight;
    const feedTop   = feed?.getBoundingClientRect().top ?? 0;
    const cutoff    = scrollTop - clientH * 0.5;

    const seen = new Map();

    for (const node of document.querySelectorAll('div.jftiEf,[data-review-id]')) {
      const card = node.closest('div.jftiEf') || node;

      // Position relative to the feed's scroll origin
      const cardTop = card.getBoundingClientRect().top - feedTop + scrollTop;
      if (cardTop < cutoff) continue;

      const reviewId =
        card.getAttribute('data-review-id') ||
        card.querySelector('[data-review-id]')?.getAttribute('data-review-id') ||
        null;

      const authorName   = n(card.querySelector('.d4r55')?.textContent) || null;
      const relativeTime = n(card.querySelector('.rsqaWe')?.textContent) || null;
      const text         = n(card.querySelector('.MyEned,.wiI7pd')?.textContent) || null;

      const key = reviewId
        ? `id:${reviewId}`
        : `fb:${authorName}|${relativeTime}|${(text || '').slice(0, 80)}`;

      if (seen.has(key)) continue;

      let authorLink =
        card.querySelector('a[href*="/maps/contrib/"]')?.getAttribute('href') ||
        card.querySelector('a[href*="/maps/contrib/"]')?.href ||
        card.querySelector('a[href*="maps/contrib/"]')?.getAttribute('href') ||
        null;
      if (authorLink && authorLink.startsWith('/')) authorLink = new URL(authorLink, location.origin).toString();
      const meta       = parseMeta(card.querySelector('.RfnDt')?.textContent || '');

      const reviewUrl = (() => {
        const abs = (u) => {
          try { return new URL(u, location.origin).toString(); }
          catch { return null; }
        };

        if (!reviewId) return null;

        // Best-effort: pick explicit non-contrib links that contain the reviewId
        for (const a of card.querySelectorAll('a[href]')) {
          const h = a.getAttribute('href');
          if (!h || !h.includes(reviewId)) continue;
          if (h.includes('/maps/contrib/') || h.includes('maps/contrib/')) continue;
          return abs(h);
        }

        // Best-effort: share URL sometimes exists in data attributes
        for (const el of card.querySelectorAll('[data-url],[data-share-url],[data-href]')) {
          const u = el.getAttribute('data-url') || el.getAttribute('data-share-url') || el.getAttribute('data-href');
          if (!u) continue;
          if (u.includes('/maps/contrib/') || u.includes('maps/contrib/')) continue;
          if (u.includes('google.') && (u.includes('maps') || u.includes('/maps'))) return abs(u);
        }

        return null;
      })();

      const ratingEl = card.querySelector(
        'span.kvMYJc[aria-label],span[role="img"][aria-label*="star" i]'
      );
      const rating = (() => {
        const m = n(ratingEl?.getAttribute('aria-label') || '').replace(',', '.').match(/(\d+(?:\.\d+)?)/);
        return m ? Number(m[1]) : null;
      })();

      const likeBtn = [...card.querySelectorAll('button,[role="button"]')]
        .find((b) => /like/i.test(b.getAttribute('aria-label') || b.textContent));
      const likes = likeBtn
        ? (pN(likeBtn.getAttribute('aria-label') || likeBtn.textContent) ?? 0)
        : 0;

      const resp = card.querySelector('.CDe7pd');
      const ownerResponse = resp ? {
        relativeTime: n(resp.querySelector('.rsqaWe')?.textContent) || null,
        text: n((resp.querySelector('.wiI7pd,.MyEned') || resp)?.textContent) || null,
      } : null;

      seen.set(key, {
        reviewId,
        reviewUrl,
        reviewShareUrl: null,
        authorName,
        ...meta,
        authorLink,
        rating,
        relativeTime,
        text,
        likes,
        ownerResponse,
      });
    }

    return [...seen.values()];
  });
}

// ── Scrolling ─────────────────────────────────────────────────────────────────
/**
 * Scroll the feed. Jump distance scales with depth so we don't waste cycles
 * re-visiting territory that's already been pruned.
 */
async function smartScroll(feedEl, page, collected = 0) {
  try {
    const depthMul = Math.min(1 + Math.floor(collected / 500) * 0.3, 3.0);

    // Small nudge — triggers lazy-load listeners
    await feedEl.evaluate((el) => {
      el.scrollTop += Math.max(300, Math.floor(el.clientHeight * 0.4));
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await sleep(200);

    // Big jump — depth-scaled
    await feedEl.evaluate((el, mul) => {
      el.scrollTop += Math.max(1600, Math.floor(el.clientHeight * 2 * mul));
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    }, depthMul);

  } catch {
    try {
      await page.keyboard.press('PageDown');
      await sleep(150);
      await page.keyboard.press('End');
    } catch {}
  }
}

// ── Misc helpers ──────────────────────────────────────────────────────────────
async function takeScreenshot(page, label) {
  try {
    const ssDir = path.join(process.cwd(), 'screenshots');
    await ensureDir(ssDir);
    await page.screenshot({
      path: path.join(ssDir, `${label}-${Date.now()}.png`),
      fullPage: false,
    });
  } catch {}
}

async function reloadAndEnter(page, url, sortMode) {
  await goto(page, url);
  await clickConsent(page);
  await sleep(POST_NAV_WAIT_MS);
  await openReviews(page);
  await setSort(page, sortMode);
  return getFeedEl(page);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv);

  const cid    = cidFromUrl(args.url);
  const slug   = slugify(placeFromUrl(args.url) || 'place');
  const fileId = cid || hashStr(args.url.split('?')[0]);

  const dataPath = args.out === '-'
    ? '-'
    : args.out
      ? (args.out.match(/\.json$/i) ? args.out : `${args.out.replace(/\.(json|ndjson)$/i, '')}.json`)
      : path.join(args.outDir, 'google', `${slug}-${fileId}.json`);

  if (dataPath !== '-') {
    await ensureDir(path.dirname(path.resolve(dataPath)));
    if (!args.resume) {
      await fs.rm(dataPath, { force: true }).catch(() => {});
    }
  }

  const prevState = args.resume && dataPath !== '-' ? await readJson(dataPath) : null;
  const existingReviews = Array.isArray(prevState)
    ? prevState
    : (Array.isArray(prevState?.reviews) ? prevState.reviews : []);
  const prevCompany = (!Array.isArray(prevState) && (prevState?.company || prevState?.place))
    ? (prevState.company || prevState.place)
    : null;

  const seenKeys = new Set();
  for (const r of existingReviews) seenKeys.add(reviewKey(r));

  const allReviews = [...existingReviews];
  const byReviewId = new Map();
  for (const r of allReviews) {
    if (r?.reviewId) byReviewId.set(r.reviewId, r);
  }

  let target = args.maxReviews > 0
    ? args.maxReviews
    : (prevCompany?.totalReviews || MAX_DEFAULT);

  console.log(`📁 Output : ${dataPath}`);
  console.log(`📝 Resumed: ${allReviews.length} reviews`);
  console.log(`🎯 Initial target: ${target}`);

  let lastFlushedSize = seenKeys.size;
  let lastPrunedAt    = seenKeys.size;

  const sortMode = target >= 200 ? 'newest' : 'relevant';

  const saveState = async ({ company, reason = null, done = false, extra = {} } = {}) => {
    await writeAtomic(dataPath, {
      sourceUrl:   args.url,
      company:     company || prevCompany || null,
      reviews:     allReviews,
      reviewsCount: allReviews.length,
      target,
      done,
      reason,
      updatedAt:   now(),
      ...extra,
    });
  };

  const { browser, page } = await launchBrowser(args);

  try {
    // ── Initial navigation ───────────────────────────────────────────────────
    await goto(page, args.url);
    await clickConsent(page);
    await sleep(POST_NAV_WAIT_MS);

    if (await hasCaptcha(page)) {
      console.warn('⚠️  CAPTCHA detected — waiting 30 s for manual solve...');
      await sleep(30_000);
    }

    // ── Extract place metadata ───────────────────────────────────────────────
    const raw     = await extractPlaceInfo(page);
    const pageUrl = page.url();

    let place = {
      name:          raw.name          || prevCompany?.name          || null,
      overallRating: raw.overallRating ?? prevCompany?.overallRating ?? null,
      totalReviews:  raw.totalReviews  ?? prevCompany?.totalReviews  ?? null,
      category:      raw.category      || prevCompany?.category      || null,
      address:       raw.address       || prevCompany?.address       || null,
      phone:         raw.phone         || prevCompany?.phone         || null,
      website:       raw.website       || prevCompany?.website       || null,
      plusCode:      raw.plusCode      || prevCompany?.plusCode      || null,
      pageUrl,
      cid:           cidFromUrl(pageUrl) || cid,
      scrapedAt:     now(),
    };

    console.log(
      `📍 ${place.name}  ⭐ ${place.overallRating}  ` +
      `📊 ${place.totalReviews ?? '?'} total reviews`
    );

    if (place.totalReviews) {
      target = args.maxReviews === 0
        ? place.totalReviews
        : Math.min(args.maxReviews, place.totalReviews);
    }
    console.log(`🎯 Effective target: ${target}`);

    await saveState({ company: place, done: seenKeys.size >= target });

    const missingUrlCount = args.reviewUrls
      ? allReviews.filter((r) => r?.reviewId && !r?.reviewUrl).length
      : 0;

    if (seenKeys.size >= target && missingUrlCount === 0) {
      console.log(`✅ Already have ${seenKeys.size} / ${target} — nothing to do`);
      await saveState({ company: place, done: true });
      return;
    }

    if (seenKeys.size >= target && missingUrlCount > 0) {
      console.log(
        `🔗 Have ${seenKeys.size}/${target} reviews but missing reviewUrl for ${missingUrlCount} — ` +
        `backfilling up to ${args.reviewUrlLimit} (use --reviewUrlLimit N to change)`
      );
    }

    // ── Open reviews panel ───────────────────────────────────────────────────
    console.log('🔍 Opening reviews panel...');
    const opened = await openReviews(page);
    if (!opened) {
      console.warn('⚠️  Reviews panel did not open');
      await saveState({ company: place, reason: 'reviews_ui_missing', done: false });
      return;
    }
    console.log('✅ Reviews panel open');

    // Fallback: if rating was missed on the overview render, try again on the reviews UI
    if (place.overallRating == null || place.totalReviews == null) {
      const r2 = await extractRatingOnly(page);
      if (place.overallRating == null && r2.overallRating != null) place = { ...place, overallRating: r2.overallRating };
      if (place.totalReviews == null && r2.totalReviews != null)   place = { ...place, totalReviews:  r2.totalReviews };
      await saveState({ company: place, done: seenKeys.size >= target });
    }

    await setSort(page, sortMode);

    // ── Scroll loop ──────────────────────────────────────────────────────────
    let feedEl       = await getFeedEl(page);
    let noFeedCount  = 0;
    let noNewCount   = 0;
    let recovery     = 0;
    let scrollCycle  = 0;
    let dynamicDelay = SCROLL_MS_MIN;
    let heartbeat    = Date.now();

    console.log(feedEl
      ? '📜 Feed element found — scrolling'
      : '⚠️  Feed element not found yet, will retry'
    );

    const backfillOnly = seenKeys.size >= target && missingUrlCount > 0 && args.reviewUrls;
    let backfilledTotal = 0;
    let backfillNoProgress = 0;

    while (seenKeys.size < target || (backfillOnly && backfilledTotal < args.reviewUrlLimit && backfillNoProgress < 30)) {

      // ── Heartbeat ──────────────────────────────────────────────────────────
      if (Date.now() - heartbeat > 20_000) {
        heartbeat = Date.now();
        console.log(
          `⏳ ${seenKeys.size}/${target}  ` +
          `noNew=${noNewCount}  recovery=${recovery}  delay=${dynamicDelay}ms`
        );
      }

      // ── DOM prune every PRUNE_EVERY new reviews ───────────────────────────
      if (seenKeys.size - lastPrunedAt >= PRUNE_EVERY) {
        lastPrunedAt = seenKeys.size;
        await pruneSeenCards(page, seenKeys);
        feedEl = await getFeedEl(page);  // re-acquire after DOM mutation
      }

      // ── Periodic feed handle refresh ──────────────────────────────────────
      if (++scrollCycle % FEED_REFRESH_EVERY === 0) {
        feedEl = await getFeedEl(page);
      }

      // ── Feed element: re-acquire if missing ───────────────────────────────
      if (!feedEl) {
        noFeedCount++;
        feedEl = await getFeedEl(page);

        if (!feedEl) {
          if (noFeedCount >= 10) {
            console.warn('⚠️  No feed for 10 s — reloading page');
            noFeedCount = 0;
            feedEl = await reloadAndEnter(page, args.url, sortMode);
          }
          await sleep(1000);
          continue;
        }

        noFeedCount = 0;
        console.log('📜 Feed element (re)acquired');
      }

      // ── Expand + extract ──────────────────────────────────────────────────
      await expandMore(page);
      const visible = await extractVisibleReviews(page);
      const newRows = [];

      for (const r of visible) {
        if (!backfillOnly && seenKeys.size >= target) break;
        const k = reviewKey(r);
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          newRows.push(r);
        }
      }

      // If enabled, scrape real Share URLs for a few on-screen cards per cycle.
      // This also backfills existing (resumed) reviews when they re-appear on screen.
      if (args.reviewUrls && visible.length) {
        const normalBudget = target <= 50
          ? Math.min(visible.length, 50)
          : REVIEW_URLS_PER_CYCLE;

        const budget = backfillOnly
          ? Math.min(
              Math.max(normalBudget, REVIEW_URLS_PER_CYCLE),
              Math.max(0, args.reviewUrlLimit - backfilledTotal)
            )
          : normalBudget;

        const got = budget > 0
          ? await fillShareUrlsFromVisible(page, visible, byReviewId, budget)
          : 0;

        if (backfillOnly) {
          if (got > 0) {
            backfilledTotal += got;
            backfillNoProgress = 0;
            process.stdout.write(`\r🔗 Backfilled: ${backfilledTotal}/${args.reviewUrlLimit}   `);
          } else {
            backfillNoProgress++;
          }
        }
      }

      if (!backfillOnly && newRows.length) {
        allReviews.push(...newRows);
        for (const r of newRows) {
          if (r?.reviewId) byReviewId.set(r.reviewId, r);
        }
      }

      // ── Adaptive delay ────────────────────────────────────────────────────
      if (newRows.length > 0) {
        noNewCount   = 0;
        dynamicDelay = SCROLL_MS_MIN;
      } else if (!backfillOnly) {
        noNewCount++;
        dynamicDelay = Math.min(dynamicDelay + SCROLL_STEP_MS, SCROLL_MS_MAX);
      } else {
        dynamicDelay = Math.min(dynamicDelay + SCROLL_STEP_MS, SCROLL_MS_MAX);
      }

      // ── Periodic meta flush ───────────────────────────────────────────────
      if (
        seenKeys.size - lastFlushedSize >= BATCH_SIZE ||
        (newRows.length > 0 && seenKeys.size >= target) ||
        (backfillOnly && backfilledTotal > 0 && backfilledTotal % 10 === 0)
      ) {
        lastFlushedSize = seenKeys.size;
        await saveState({ company: place, done: seenKeys.size >= target });
        if (!backfillOnly) process.stdout.write(`\r✅ ${seenKeys.size} / ${target}   `);
      }

      // ── Scroll ────────────────────────────────────────────────────────────
      await smartScroll(feedEl, page, seenKeys.size);
      await sleep(jitter(dynamicDelay, dynamicDelay + 200));

      // ── Stall detection ───────────────────────────────────────────────────
      if (noNewCount >= NO_NEW_LIMIT) {
        if (recovery >= MAX_RECOVERY) {
          console.warn(`\n⛔ Stalled after ${MAX_RECOVERY} recoveries — saving progress`);
          break;
        }

        recovery++;
        noNewCount   = 0;
        dynamicDelay = SCROLL_MS_MIN;

        console.warn(`\n🔄 Recovery ${recovery}/${MAX_RECOVERY} — ${seenKeys.size} collected`);
        await takeScreenshot(page, `stall-r${recovery}`);

        if (recovery <= 3) {
          // Cheap: scroll to top so Google re-renders the feed
          try { await feedEl?.evaluate((el) => { el.scrollTop = 0; }); } catch {}
          await sleep(RECOVERY_DELAY_MS);
          feedEl = await getFeedEl(page);
        } else {
          // Expensive: full page reload
          console.warn('   Full page reload...');
          feedEl = await reloadAndEnter(page, args.url, sortMode);
          await sleep(RECOVERY_DELAY_MS);
        }
      }
    }

    // ── Done ──────────────────────────────────────────────────────────────────
    const done = seenKeys.size >= target;
    await saveState({ company: place, done, reason: done ? null : 'stalled_or_blocked' });
    console.log(`\n🏁 Finished: ${seenKeys.size} / ${target}  done=${done}`);

  } catch (err) {
    console.error(`\n💥 Fatal error: ${err.message}`);
    await takeScreenshot(page, 'error');
    await saveState({
      company: prevCompany || null,
      done:    false,
      reason:  'error',
      extra:   { error: err.message },
    });
    process.exitCode = 1;

  } finally {
    await browser.close();
  }
}

await main();