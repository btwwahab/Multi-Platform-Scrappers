import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import puppeteer from "puppeteer-core";

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || "/usr/bin/google-chrome-stable";
const PROFILE_DIR = path.join(process.env.HOME || process.env.USERPROFILE || os.tmpdir(), ".cache", "va-scrapper", "gmaps-profile");
const MAX_DEFAULT = 50000000;
const BATCH_SIZE = Math.max(1, Number(process.env.GMAPS_FLUSH_EVERY || 500));
const NAV_TIMEOUT = 90_000;
const USE_PROXY = /^(1|true|yes|on)$/i.test(String(process.env.GMAPS_USE_PROXY || ""));

// ── Residential proxy pool (round-robin) ──────────────────────────────────────
function parseProxyPool(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const pool = parsed.map((entry) => {
      if (!Array.isArray(entry) || entry.length < 4) return null;
      const [host, port, username, password] = entry;
      return [String(host || "").trim(), String(port || "").trim(), String(username || "").trim(), String(password || "").trim()];
    }).filter((entry) => entry && entry.every(Boolean));
    return pool.length ? pool : null;
  } catch { return null; }
}

const PROXY_POOL = parseProxyPool(process.env.GMAPS_PROXY_POOL);
let _proxyIdx = PROXY_POOL?.length ? Math.floor(Math.random() * PROXY_POOL.length) : 0;
function nextProxy() {
  if (!USE_PROXY || !PROXY_POOL?.length) return null;
  const entry = PROXY_POOL[_proxyIdx % PROXY_POOL.length];
  _proxyIdx++;
  return { host: entry[0], port: entry[1], username: entry[2], password: entry[3] };
}

const POST_SORT_WAIT_MS = 2500;
const POST_NAV_WAIT_MS = 2500;

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
const jitter = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));

function enforceEnglish(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('hl', 'en');
    return u.toString();
  } catch { return url; }
}

function stripXssiPrefix(s) { return String(s || "").replace(/^\)\]\}'\s*/, ""); }

function toAbsUrl(u) {
  try {
    if (!u) return null;
    const uu = new URL(u, "https://www.google.com");
    return uu.toString();
  } catch { return null; }
}

function buildDeterministicReviewUrl(reviewId, placeHexPair) {
  if (!reviewId || !placeHexPair) return null;
  const rid = encodeURIComponent(reviewId);
  return `https://www.google.com/maps/reviews/data=!4m5!3m4!1s${rid}!2m1!1s${placeHexPair}`;
}

async function ensureDir(p) { await fs.mkdir(p, { recursive: true }); }
async function readJson(f) { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return null; } }
async function writeAtomic(f, d) {
  const t = `${f}.${Date.now()}.tmp`;
  await fs.writeFile(t, JSON.stringify(d, null, 2), "utf8");
  await fs.rename(t, f);
}

function slugify(s) { return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "place"; }

function cidFromUrl(url) {
  try {
    const m = [...String(url).matchAll(/:0x([0-9a-fA-F]{8,})/g)];
    return m.length ? BigInt("0x" + m.at(-1)[1]).toString(10) : null;
  } catch { return null; }
}

function placeFromUrl(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const i = parts.indexOf("place");
    return i >= 0 ? decodeURIComponent(parts[i + 1]).replace(/\+/g, " ") : null;
  } catch { return null; }
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function reviewKey(r) {
  if (r?.reviewId) return `id:${r.reviewId}`;
  return `fb:${norm(r?.authorName)}|${norm(r?.relativeTime)}|${norm(r?.text).slice(0, 80)}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { url: null, maxReviews: MAX_DEFAULT, out: null, outDir: "outputs", resume: true, headful: true, userDataDir: PROFILE_DIR };
  for (let i = 2; i < argv.length; i++) {
    const f = argv[i];
    if (f === "--url") a.url = argv[++i];
    else if (f === "--maxReviews") a.maxReviews = Number(argv[++i]);
    else if (f === "--all") a.maxReviews = 0;
    else if (f === "--out") a.out = argv[++i];
    else if (f === "--outDir") a.outDir = argv[++i];
    else if (f === "--resume") a.resume = true;
    else if (f === "--noResume") a.resume = false;
    else if (f === "--headful") a.headful = true;
    else if (f === "--blockAssets") a.blockAssets = true;
    else if (f === "--noBlockAssets") a.blockAssets = false;
  }
  if (!a.url) throw new Error("--url is required");
  return a;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser({ headful, userDataDir, blockAssets }) {
  const proxy = nextProxy();
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    userDataDir,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--lang=en-US,en",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      ...(proxy ? [`--proxy-server=${proxy.host}:${proxy.port}`] : []),
    ],
    defaultViewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();
  if (proxy) {
    await page.authenticate({ username: proxy.username, password: proxy.password });
  }
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);
  const ver = (await browser.version()).split("/")[1] || "124.0.0.0";
  await page.setUserAgent(`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`);
  await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); Object.defineProperty(navigator, "onLine", { get: () => true }); });
  try {
    const cdp = await page.createCDPSession();
    await cdp.send("Storage.clearDataForOrigin", { origin: "https://www.google.com", storageTypes: "service_workers,cache_storage" });
    await cdp.detach();
  } catch (e) { }
  if (blockAssets) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType(), u = req.url();
      if (t === "image" || t === "media" || t === "font") return req.abort();
      if (t === "stylesheet" && (u.includes("fonts.googleapis") || u.includes("fonts.gstatic"))) return req.abort();
      req.continue();
    });
  }
  if (proxy) {
    console.log(`[proxy] Using ${proxy.host}:${proxy.port} (user: ${proxy.username})`);
  } else {
    console.log(`[proxy] Disabled (set GMAPS_USE_PROXY=1 to enable)`);
  }
  return { browser, page };
}

async function goto(page, url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }); return; }
    catch (e) { if (i === retries - 1) throw e; await sleep(3000 * (i + 1)); }
  }
}

async function clickConsent(page) {
  try {
    await page.evaluate(() => {
      const want = ["accept all", "accept", "i agree", "agree"];
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const btn = [...document.querySelectorAll('button,[role="button"]')].find((b) => want.some((w) => n(b.textContent).includes(w)));
      if (btn) btn.click();
    });
  } catch { }
}

async function hasCaptcha(page) { return page.evaluate(() => !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="challenges.cloudflare"],form#captcha-form,[id*="captcha"],[class*="captcha"]')); }

async function extractPlaceInfo(page) {
  const onReviews = await page.evaluate(() => !!(document.querySelector('[role="feed"]') || document.querySelector("[data-review-id]")) && !document.querySelector("h1.DUwDvf,h1"));
  if (onReviews) {
    await page.evaluate(() => {
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const tab = [...document.querySelectorAll('[role="tab"],button')].find((el) => n(el.textContent) === "overview");
      if (tab) tab.click();
    });
    await sleep(1500);
  }
  try {
    await page.waitForFunction(() => {
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const name = document.querySelector("h1.DUwDvf,h1")?.textContent;
      return Boolean(n(name));
    }, { timeout: 8000 });
  } catch { }
  return page.evaluate(() => {
    const n = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const $ = (sel) => { const el = document.querySelector(sel); return el ? n(el.textContent) : null; };
    const name = $("h1.DUwDvf,h1");
    const overallRating = (() => {
      const read = (txt) => { const m = n(txt).replace(",", ".").match(/(\d+(?:\.\d+)?)/); const v = m ? Number(m[1]) : NaN; return Number.isFinite(v) && v > 0 && v <= 5 ? v : null; };
      const f7 = document.querySelector("div.F7nice");
      const fromF7 = read(f7?.textContent || "");
      if (fromF7 != null) return fromF7;
      for (const el of document.querySelectorAll('div.F7nice span[aria-label*="star" i],span[aria-label*="stars" i],span[aria-label*="star" i],span[role="img"][aria-label*="star" i]')) {
        const got = read(el.getAttribute("aria-label") || ""); if (got != null) return got;
      }
      return null;
    })();
    const totalReviews = (() => {
      const f7 = document.querySelector("div.F7nice,span.jANrlb");
      if (f7) { const m = f7.textContent.replace(/,/g, "").match(/\((\d{1,9})\)/); if (m) return Number(m[1]); }
      const btn = document.querySelector('button[jsaction="pane.rating.moreReviews"],[jsaction*="moreReviews"]');
      if (btn) { const m = (btn.getAttribute("aria-label") || btn.textContent).replace(/,/g, "").match(/(\d{1,9})/); if (m) return Number(m[1]); }
      return null;
    })();
    const category = $('button.DkEaL,button[jsaction*="pane.rating.category"]');
    const address = (() => { const el = document.querySelector('button[data-item-id="address"],[data-item-id="address"]'); const a = n(el?.getAttribute("aria-label") || ""); return a.toLowerCase().startsWith("address:") ? a.slice(8).trim() : n(el?.textContent) || null; })();
    const phone = (() => { const el = document.querySelector('button[data-item-id^="phone"],[data-item-id^="phone"]'); const a = n(el?.getAttribute("aria-label") || ""); return a.toLowerCase().startsWith("phone:") ? a.slice(6).trim() : n(el?.textContent) || null; })();
    const website = document.querySelector('a[data-item-id="authority"]')?.getAttribute("href") || null;
    const plusCode = (() => {
      const el = document.querySelector('[data-item-id="oloc"],button[aria-label*="plus code" i]');
      if (el) { const a = n(el.getAttribute("aria-label") || ""); if (/plus\s*code/i.test(a)) return a.replace(/^.*plus\s*code[:\s]*/i, "").trim() || null; const t = n(el.textContent); if (/[A-Z0-9]{4,}\+[A-Z0-9]{2,}/.test(t)) return t; }
      return null;
    })();
    return { name, overallRating, totalReviews, category, address, phone, website, plusCode };
  });
}

async function extractRatingOnly(page) {
  try {
    await page.waitForFunction(() => {
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const read = (txt) => { const m = n(txt).replace(",", ".").match(/(\d+(?:\.\d+)?)/); const v = m ? Number(m[1]) : NaN; return Number.isFinite(v) && v > 0 && v <= 5 ? v : null; };
      const f7 = document.querySelector("div.F7nice"); return Boolean(read(f7?.textContent || "") != null);
    }, { timeout: 5000 });
  } catch { }
  return page.evaluate(() => {
    const n = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const read = (txt) => { const m = n(txt).replace(",", ".").match(/(\d+(?:\.\d+)?)/); const v = m ? Number(m[1]) : NaN; return Number.isFinite(v) && v > 0 && v <= 5 ? v : null; };
    const overallRating = read(document.querySelector("div.F7nice")?.textContent || "");
    const totalReviews = (() => { const f7 = document.querySelector("div.F7nice,span.jANrlb"); if (f7) { const m = String(f7.textContent || "").replace(/,/g, "").match(/\((\d{1,9})\)/); if (m) return Number(m[1]); } return null; })();
    return { overallRating, totalReviews };
  });
}

async function openReviews(page) {
  await page.evaluate(() => {
    const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const isReviewsLabel = (txt) => { const t = n(txt); return t === 'reviews' || t.startsWith('reviews ') || t.startsWith('reviews(') || t.includes(' reviews'); };
    let tab = [...document.querySelectorAll('[role="tab"],button,[role="button"]')].find((el) => isReviewsLabel(el.textContent) || isReviewsLabel(el.getAttribute('aria-label')));
    if (!tab) tab = document.querySelector('[role="tab"][data-tab-index="1"]');
    if (tab) { tab.scrollIntoView({ block: 'center' }); tab.click(); }
  });
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const ok = await page.evaluate(() => !!(document.querySelector('[role="feed"]') || document.querySelector('[data-review-id]')));
    if (ok) return true;
  }
  return false;
}

function setCursorInPb(pb, cursor) {
  if (!pb) return pb;
  const cur = cursor == null ? "" : String(cursor);
  const precise = pb.replace(/(!2m2!1i\d{1,4}!2s)([^!]*)!/, (_m, prefix) => `${prefix}${cur}!`);
  if (precise !== pb) return precise;
  const i = pb.indexOf("!2s"); if (i < 0) return pb;
  const j = pb.indexOf("!", i + 3); if (j < 0) return pb;
  return pb.slice(0, i) + `!2s${cur}!` + pb.slice(j + 1);
}

function setPageSizeInPb(pb, pageSize) {
  if (!pb) return pb;
  const size = Math.max(1, Math.min(200, Number(pageSize) || 10));
  return pb.replace(/(!2m2!1i)\d{1,4}(!2s)/, `$1${size}$2`);
}

// Patch the pb parameter to include both 1e1 (star reviews) AND 1e3 (non-star/Q&A)
// contributions. Google's curl shows !6m4!4m1!1e1!4m1!1e3 which returns both types.
// Without !4m1!1e3, some reviews (contributions without ratings) are hidden.
function ensureAllReviewsFilter(pb) {
  if (!pb) return pb;
  // If 1e3 already present, nothing to do
  if (pb.includes('!4m1!1e3')) return pb;
  // Replace !6m2!4m1!1e1 with !6m4!4m1!1e1!4m1!1e3 (add 1e3 type, update count 2→4)
  let patched = pb.replace(/!6m2(!4m1!1e1)/, '!6m4$1!4m1!1e3');
  if (patched !== pb) return patched;
  // Fallback: if the filter block uses different count, just append !4m1!1e3 after !1e1
  patched = pb.replace(/(!4m1!1e1)(?!!4m1!1e3)/, '$1!4m1!1e3');
  return patched;
}

function pickNextCursorFromData(root) {
  const REVIEW_PREFIXES = ['ChdDSUh', 'ChZDSUh', 'Ci9DQU', 'CioD', 'ChcD', 'ChgD', 'ChYD', 'ChdD', 'ChZD'];
  const isCursorCandidate = (s) => {
    if (typeof s !== 'string' || s.length < 20) return false;
    if (!/^CA[A-Za-z0-9+/=_:-]{18,}$/.test(s)) return false;
    if (REVIEW_PREFIXES.some((p) => s.startsWith(p))) return false;
    return true;
  };
  const counts = new Map();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const v of cur) { if (isCursorCandidate(v)) counts.set(v, (counts.get(v) || 0) + 1); else if (v && typeof v === 'object') stack.push(v); }
    } else if (cur && typeof cur === 'object') {
      for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  if (!counts.size) return null;
  let best = null, bestCount = -1, bestLen = -1;
  for (const [k, c] of counts.entries()) { if (c > bestCount || (c === bestCount && k.length > bestLen)) { best = k; bestCount = c; bestLen = k.length; } }
  return best;
}

function collectListUgcReviewEntries(root) {
  const out = [];
  const stack = [root];
  const isReviewId = (s) => {
    if (typeof s !== "string" || s.length < 20) return false;
    return s.startsWith("ChdDSUh") || s.startsWith("ChZDSUh") || s.startsWith("Ci9DQU") ||
           s.startsWith("CioDQU") || s.startsWith("ChcDSUh") || s.startsWith("ChgDSUh") ||
           s.startsWith("ChYDSUh") || s.startsWith("ChdD") || s.startsWith("ChZD");
  };
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      if (cur.length >= 2 && isReviewId(cur[0]) && Array.isArray(cur[1])) { out.push(cur); continue; }
      for (const v of cur) if (v && typeof v === "object") stack.push(v);
    } else if (cur && typeof cur === "object") {
      for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

function parseAuthorMetaString(meta) {
  const txt = norm(meta);
  const pN = (t) => { const m = norm(t).replace(/,/g, "").match(/(\d{1,7})/); return m ? Number(m[1]) : null; };
  let reviewsCount = null, photosCount = null;
  for (const p of txt.split("·").map(norm)) { if (/reviews?/i.test(p)) reviewsCount = pN(p); if (/photos?/i.test(p)) photosCount = pN(p); }
  return { authorMeta: txt || null, authorReviewsCount: reviewsCount, authorPhotosCount: photosCount, authorIsLocalGuide: /local\s*guide/i.test(txt) };
}

function findLikelyReviewText(tuple, authorName) {
  const bad = (s) => {
    const t = norm(s);
    if (!t || t.startsWith("http") || t === "Google" || t.startsWith("0ahU") || t.startsWith("CAES") || t === norm(authorName) || /^\d+\s+reviews?$/i.test(t) || /^\d+\s+photos?$/i.test(t) || (/local\s*guide/i.test(t) && t.length < 60) || (/\bago\b/i.test(t) && t.length < 40) || !/[A-Za-z\u00C0-\u017F]/.test(t) || !/\s/.test(t)) return true;
    return false;
  };
  let best = null;
  const stack = [tuple];
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const v of cur) { if (typeof v === "string") { if (!bad(v) && (!best || v.length > best.length)) best = v; } else if (v && typeof v === "object") stack.push(v); }
    } else if (cur && typeof cur === "object") {
      for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v);
    }
  }
  return best ? norm(best) : null;
}

function findFirstString(root, predicate) {
  const stack = [root], seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (const v of cur) { if (typeof v === "string" && predicate(v)) return v; if (v && typeof v === "object") stack.push(v); }
    } else if (cur && typeof cur === "object") {
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function findRatingViaGoogleBlock(root) {
  const stack = [root], seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      if (cur[0] === "Google") {
        const nums = cur.filter((v) => typeof v === "number" && v >= 1 && v <= 5);
        if (nums.length === 1) return nums[0];
        if (nums.length >= 2) { const nonFive = nums.filter((n) => n !== 5); return nonFive.length ? Math.max(...nonFive) : 5; }
      }
      for (const v of cur) if (v && typeof v === "object") stack.push(v);
    } else { for (const v of Object.values(cur)) if (v && typeof v === "object") stack.push(v); }
  }
  return null;
}

function findRelativeTime(root) {
  const s = findFirstString(root, (t) => {
    const x = norm(t).toLowerCase();
    return x && x.length <= 40 && (/(\bago\b|yesterday|today)/i.test(x) || /\b\d+\s+(minute|hour|day|week|month|year)s?\b/i.test(x));
  });
  return s ? norm(s) : null;
}

function parseListUgcReviewEntry(entry, placeHexPairHint) {
  const reviewId = entry?.[0] || null, tuple = entry?.[1], reviewBlock = entry?.[2];
  const placeHexPair = placeHexPairHint || (typeof tuple?.[0] === "string" && tuple[0].includes("0x") ? tuple[0] : null);
  const authorBlock = tuple?.[4]?.[5];
  const authorName = authorBlock?.[0] ? norm(authorBlock[0]) : null;
  const authorLink = toAbsUrl(authorBlock?.[2]?.[0]);
  const meta = parseAuthorMetaString(authorBlock?.[10]?.[0] || authorBlock?.find(v => typeof v === "string" && /local\s*guide/i.test(v)));
  const rating = Number.isFinite(reviewBlock?.[0]?.[0]) ? Number(reviewBlock[0][0]) : findRatingViaGoogleBlock(entry);
  const relativeTime = typeof tuple?.[6] === "string" ? norm(tuple[6]) : findRelativeTime(entry);
  const text = (() => {
    const segs = reviewBlock?.[15];
    if (Array.isArray(segs) && segs.length) return norm(segs.map(s => s?.[0]).filter(Boolean).join("\n"));
    return findLikelyReviewText(entry, authorName);
  })();
  return { reviewId, reviewUrl: toAbsUrl(entry?.[4]?.[3]?.[0]) || buildDeterministicReviewUrl(reviewId, placeHexPair), authorName, ...meta, authorLink, rating, relativeTime, text, likes: 0, ownerResponse: null };
}

function parseListUgcPostsPayload(placeHexPair, payloadText) {
  let data;
  try {
    data = JSON.parse(stripXssiPrefix(payloadText));
  } catch (e) {
    console.error(`[parse] JSON.parse failed: ${e.message}. Payload preview:\n${String(payloadText || '').slice(0,400).replace(/\n/g,' ')}\n`);
    throw e;
  }
  const reviews = collectListUgcReviewEntries(data).map(e => parseListUgcReviewEntry(e, placeHexPair));
  const REVIEW_PREFIXES = ['ChdDSUh', 'ChZDSUh', 'Ci9DQU', 'CioD', 'ChcD', 'ChgD', 'ChYD', 'ChdD', 'ChZD'];
  const isRootCursor = (s) => typeof s === 'string' && s.length >= 20 &&
    /^CA[A-Za-z0-9+/=_:-]{18,}$/.test(s) && !REVIEW_PREFIXES.some(p => s.startsWith(p));
  const rootCursor = Array.isArray(data) && isRootCursor(data[1]) ? data[1] : null;
  const nextCursor = rootCursor || pickNextCursorFromData(data);
  return { reviews, nextCursor };
}

function extractListUgcPayloadFromBatchText(resText) {
  const findListUgcPayloadInNode = (root) => {
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (Array.isArray(cur)) {
        if (
          cur.length >= 3 &&
          cur[0] === 'wrb.fr' &&
          typeof cur[1] === 'string' &&
          cur[1].includes('/MapsUgcPostService.ListUgcPosts') &&
          typeof cur[2] === 'string'
        ) {
          return cur[2];
        }
        for (const v of cur) if (v && typeof v === 'object') stack.push(v);
      } else {
        for (const v of Object.values(cur)) if (v && typeof v === 'object') stack.push(v);
      }
    }
    return null;
  };

  const stripped = stripXssiPrefix(resText).trim();

  try {
    const whole = JSON.parse(stripped);
    const foundWhole = findListUgcPayloadInNode(whole);
    if (foundWhole) return foundWhole;
  } catch { }

  const lines = stripped.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^\d+$/.test(line)) continue;
    if (!line.startsWith('[') && !line.startsWith('{')) continue;
    try {
      const node = JSON.parse(line);
      const found = findListUgcPayloadInNode(node);
      if (found) return found;
    } catch { }
  }
  return null;
}

// ── captureListUgcTemplate ────────────────────────────────────────────────────
// Register the network listener FIRST, then drive scrolling until the XHR fires.
// After a sort-change the feed is already rendered but Google's lazy-loader needs
// real scroll momentum to dispatch a new listugcposts request. We keep scrolling
// every 400 ms (up to 30 s) so the timeout cannot be hit by insufficient motion.
async function captureListUgcTemplate(page, preStartedPromise) {
  // Register listener BEFORE any scroll so we never miss the first XHR.
  const firstWait = preStartedPromise || page.waitForResponse(
    r => (r.url().includes('/maps/rpc/listugcposts') || r.url().includes('/MapsWizUi/data/batchexecute')) && r.status() === 200,
    { timeout: 60000 }
  );
  console.log('[network] captureListUgcTemplate: waiting for /maps/rpc/listugcposts or /MapsWizUi/data/batchexecute response (timeout 60s)');

  // Scroll repeatedly until the promise resolves. We race the two so we stop
  // scrolling the moment the XHR is captured, preventing over-scrolling into page 2.
  let scrollDone = false;
  const scrollLoop = (async () => {
    for (let i = 0; i < 75 && !scrollDone; i++) {
      try {
        // Re-acquire feedEl every iteration — the handle can go stale after sort.
        const feedEl = await getFeedEl(page);
        if (feedEl) {
          await smartScroll(feedEl, page, 0);
        } else {
          // Fallback: click into the panel and use keyboard scroll
          await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"],[data-review-id]');
            if (feed) feed.click();
          });
          await page.keyboard.press('End');
          await page.keyboard.press('PageDown');
        }
      } catch { }
      await sleep(400);
    }
  })();

  const firstRes = await firstWait;
  scrollDone = true;
  await scrollLoop; // let the loop exit cleanly
  const firstText = await firstRes.text();
  const firstReqMethod = firstRes.request()?.method?.() || null;
  const firstReqPostData = firstRes.request()?.postData?.() || null;
  try { console.log(`[network] first response captured: url=${firstRes.url()} status=${firstRes.status()} size=${String(firstText).length}`); } catch (e) { console.log('[network] first response captured (unable to read url/status)'); }

  // Strip any embedded cursor from the template URL.
  // If a cursor is baked in we would skip page 1 on every resumed or repeated call.
  let cleanTemplateUrl = firstRes.url();
  try {
    const u = new URL(cleanTemplateUrl);
    let pb = u.searchParams.get('pb') || '';
    // Zero out the cursor token so setCursorInPb always controls which page we fetch.
    pb = pb.replace(/(!2m2!1i\d{1,4}!2s)[^!]*!/, '$1!');
    u.searchParams.set('pb', pb);
    cleanTemplateUrl = u.toString();
  } catch { }

  // Optional: try to capture a follow-up listugcposts response passively.
  // Important: no extra scroll loop here — first capture ke baad scrolling stop.
  let urlCursor = null;
  let secondListUgcUrl = null;
  // If the first response was a batchexecute payload we may have nested payload
  // text inside the response. Try to extract that now so callers can parse it
  // the same way as a listugcposts template.
  // If batch-execute held the inner listugcposts payload, expose it as the
  // captured "text" so existing parsing code can reuse it.
  const batchInner = firstRes.url().includes('/MapsWizUi/data/batchexecute')
    ? extractListUgcPayloadFromBatchText(firstText)
    : null;
  if (batchInner) console.log(`[network] batchexecute inner payload extracted (len=${batchInner.length})`);
  else console.log(`[network] using direct response payload (len=${String(firstText).length})`);
  const returnedText = batchInner || firstText;
  try {
    const secondRes = await page.waitForResponse(
      r => r.url().includes('/maps/rpc/listugcposts') && r.status() === 200,
      { timeout: 1200 }
    );
    try { console.log(`[network] passive second response captured: url=${secondRes.url()} status=${secondRes.status()}`); } catch (e) { }
    secondListUgcUrl = secondRes.url();
    const pb2 = new URL(secondRes.url()).searchParams.get('pb') || '';
    const m = pb2.match(/!2m2!1i\d{1,4}!2s([^!]{10,})!/);
    if (m?.[1]) urlCursor = m[1];
  } catch { }

  return { url: cleanTemplateUrl, text: returnedText, urlCursor, secondListUgcUrl, firstReqMethod, firstReqPostData };
}

async function fetchListUgcPage(page, templateUrl, cursor, pageSize, opts = {}) {
  const u = new URL(templateUrl);
  let pb = u.searchParams.get("pb") || "";
  pb = setPageSizeInPb(pb, pageSize);
  pb = setCursorInPb(pb, cursor);
  if (opts.allTypes) pb = ensureAllReviewsFilter(pb);
  u.searchParams.set("pb", pb);
  const out = await page.evaluate(async (urlStr) => {
    try { const res = await fetch(urlStr, { credentials: "include" }); return { status: res.status, text: await res.text() }; }
    catch (e) { return { status: 0, text: "", error: String(e?.message || e) }; }
  }, u.toString());
  if (!out || out.status !== 200) throw new Error(`listugcposts fetch failed status=${out?.status} error=${out?.error || ""}`);
  return out.text;
}

async function fetchListUgcPageWithRetry(page, tpl, cur, size, opts = {}) {
  let lastErr;
  for (let i = 1; i <= (opts.maxAttempts || 8); i++) {
    try { return await fetchListUgcPage(page, tpl, cur, size, opts); }
    catch (e) { lastErr = e; await sleep(Math.min(30000, (opts.baseDelayMs || 1500) * i + jitter(0, 1200))); }
  }
  throw lastErr;
}

function setCursorInBatchPostData(postData, cursor) {
  if (!postData) return postData;
  try {
    const params = new URLSearchParams(postData);
    const fReq = params.get('f.req');
    if (!fReq) return postData;
    const cur = String(cursor || '');
    const matches = [...fReq.matchAll(/CA[A-Za-z0-9+/=_:-]{18,}/g)];
    if (!matches.length) return postData;
    const oldToken = matches[matches.length - 1][0];
    const nextFReq = fReq.split(oldToken).join(cur);
    params.set('f.req', nextFReq);
    return params.toString();
  } catch {
    return postData;
  }
}

async function fetchBatchUgcPage(page, batchTemplate, cursor) {
  const body = setCursorInBatchPostData(batchTemplate.postData, cursor);
  const out = await page.evaluate(async (urlStr, bodyStr) => {
    try {
      const res = await fetch(urlStr, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: bodyStr
      });
      return { status: res.status, text: await res.text() };
    } catch (e) {
      return { status: 0, text: '', error: String(e?.message || e) };
    }
  }, batchTemplate.url, body);

  if (!out || out.status !== 200) throw new Error(`batchexecute fetch failed status=${out?.status} error=${out?.error || ''}`);
  const inner = extractListUgcPayloadFromBatchText(out.text);
  if (!inner) throw new Error('batchexecute response missing MapsUgcPostService.ListUgcPosts payload');
  return inner;
}

async function fetchBatchUgcPageWithRetry(page, batchTemplate, cursor, opts = {}) {
  let lastErr;
  for (let i = 1; i <= (opts.maxAttempts || 8); i++) {
    try { return await fetchBatchUgcPage(page, batchTemplate, cursor); }
    catch (e) { lastErr = e; await sleep(Math.min(30000, (opts.baseDelayMs || 1500) * i + jitter(0, 1200))); }
  }
  throw lastErr;
}

// ── FIX 1: setSort ────────────────────────────────────────────────────────────
// KEY CHANGE: Instead of a flat sleep(POST_NAV_WAIT_MS) after clicking Newest,
// we poll the DOM until the first visible review card's ID changes — confirming
// the feed has actually reloaded with new sort order. This prevents
// captureListUgcTemplate from racing ahead and intercepting the pre-sort XHR,
// which was causing "Relevant" order reviews to be scraped instead of "Newest".
async function setSort(page, mode) {
  try {
    // Snapshot the first visible review ID before clicking so we can detect reload.
    const beforeId = await page.evaluate(() =>
      document.querySelector('[data-review-id]')?.getAttribute('data-review-id') || null
    ).catch(() => null);

    await page.evaluate(async (m) => {
      const n = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
      const btn = [...document.querySelectorAll('button,[role="button"]')].find(b => n(b.getAttribute("aria-label")) === "sort reviews");
      if (!btn) return;
      btn.click(); await new Promise(r => setTimeout(r, 600));
      const item = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"],li')].find(el => n(el.textContent).includes("newest"));
      if (item) item.click();
    }, mode);

    // Poll up to 8 s for the feed to reload (first card's ID must change).
    // Only after this do we return — ensuring the next captureListUgcTemplate call
    // intercepts the Newest-sort XHR, not the pre-click Relevant-sort one.
    for (let i = 0; i < 40; i++) {
      await sleep(200);
      const afterId = await page.evaluate(() =>
        document.querySelector('[data-review-id]')?.getAttribute('data-review-id') || null
      ).catch(() => null);
      if (afterId && afterId !== beforeId) break;
    }
    // Brief settle time after the first card appears.
    await sleep(800);
  } catch { }
}

async function getFeedEl(page) {
  try {
    const handle = await page.evaluateHandle(() => {
      const card = document.querySelector("[data-review-id],div.jftiEf");
      if (card) {
        let el = card.parentElement;
        while (el && el !== document.body) {
          const oy = getComputedStyle(el).overflowY;
          if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 10) return el;
          el = el.parentElement;
        }
      }
      return document.querySelector('[role="feed"]') || null;
    });
    return handle?.asElement?.();
  } catch { return null; }
}

async function smartScroll(feedEl, page, collected = 0) {
  try {
    await feedEl.evaluate(el => { el.scrollTop += Math.max(300, Math.floor(el.clientHeight * 0.4)); el.dispatchEvent(new Event("scroll", { bubbles: true })); });
    await sleep(200);
    await feedEl.evaluate((el, mul) => { el.scrollTop += Math.max(1600, Math.floor(el.clientHeight * 2 * mul)); el.dispatchEvent(new Event("scroll", { bubbles: true })); }, Math.min(1 + Math.floor(collected / 500) * 0.3, 3.0));
  } catch { try { await page.keyboard.press("PageDown"); await sleep(150); } catch { } }
}

async function takeScreenshot(page, label) { try { const d = path.join(process.cwd(), "screenshots"); await ensureDir(d); await page.screenshot({ path: path.join(d, `${label}-${Date.now()}.png`) }); } catch { } }

// ── DOM-based review extraction (same as UI scraper) ─────────────────────────
async function extractVisibleReviewsFromDom(page) {
  return page.evaluate(() => {
    const n  = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const pN = (t) => { const m = n(t).replace(/,/g,'').match(/(\d{1,7})/); const v = Number(m?.[1]); return Number.isFinite(v) ? v : null; };
    const parseMeta = (txt) => {
      const meta = n(txt);
      let reviewsCount = null, photosCount = null;
      for (const p of meta.split('·').map(n)) {
        if (/reviews?/i.test(p)) reviewsCount = pN(p);
        if (/photos?/i.test(p))  photosCount  = pN(p);
      }
      return { authorMeta: meta || null, authorReviewsCount: reviewsCount, authorPhotosCount: photosCount, authorIsLocalGuide: /local\s*guide/i.test(meta) };
    };
    const seen = new Map();
    for (const node of document.querySelectorAll('div.jftiEf,[data-review-id]')) {
      const card = node.closest('div.jftiEf') || node;
      const reviewId = card.getAttribute('data-review-id') || card.querySelector('[data-review-id]')?.getAttribute('data-review-id') || null;
      const authorName   = n(card.querySelector('.d4r55')?.textContent) || null;
      const relativeTime = n(card.querySelector('.rsqaWe')?.textContent) || null;
      const text         = n(card.querySelector('.MyEned,.wiI7pd')?.textContent) || null;
      const key = reviewId ? `id:${reviewId}` : `fb:${authorName}|${relativeTime}|${(text||'').slice(0,80)}`;
      if (seen.has(key)) continue;
      let authorLink = card.querySelector('a[href*="/maps/contrib/"]')?.getAttribute('href') || null;
      if (authorLink && authorLink.startsWith('/')) authorLink = new URL(authorLink, location.origin).toString();
      const meta = parseMeta(card.querySelector('.RfnDt')?.textContent || '');
      const ratingEl = card.querySelector('span.kvMYJc[aria-label],span[role="img"][aria-label*="star" i]');
      const ratingM  = n(ratingEl?.getAttribute('aria-label') || '').replace(',','.').match(/(\d+(?:\.\d+)?)/);
      const rating   = ratingM ? Number(ratingM[1]) : null;
      const resp     = card.querySelector('.CDe7pd');
      const ownerResponse = resp ? { relativeTime: n(resp.querySelector('.rsqaWe')?.textContent) || null, text: n((resp.querySelector('.wiI7pd,.MyEned') || resp)?.textContent) || null } : null;
      seen.set(key, { reviewId, reviewUrl: null, authorName, ...meta, authorLink, rating, relativeTime, text, likes: 0, ownerResponse });
    }
    return [...seen.values()];
  });
}

// ── FIX 3: domMopUpPass ───────────────────────────────────────────────────────
// KEY CHANGE: `feedEl` is now declared with `let` at the top of the function.
// Previously it was used inside the while-loop without ever being declared in
// this scope, causing: ReferenceError: feedEl is not defined
// which crashed the entire pass-4 mop-up, leaving up to 30 reviews unscraped.
async function domMopUpPass(page, target, seenKeys, allReviews, byReviewId, saveStateFn) {
  console.log(`\n🖥️  DOM extraction: scrolling browser to collect reviews (target ${target})...`);
  try {
    await openReviews(page);
    let feedEl = null;
    let noNewCount = 0, totalScrolls = 0, domAdded = 0;
    let lastPrunedAt = seenKeys.size;
    
    // For small collections: allow MUCH longer with no new reviews (they load slowly)
    // For large collections: stop faster once API is exhausted
    const isSmall = target <= 100;
    const MAX_NO_NEW = isSmall ? 200 : Math.max(50, Math.floor(target / 5));
    const MAX_SCROLLS = isSmall ? 1200 : 800;
    const PRUNE_EVERY = 200;

    const pruneSeenCardsDom = async (p, keys) => {
      const ids = [...keys].filter(k => k.startsWith('id:')).map(k => k.slice(3)).slice(0, 150);
      if (!ids.length) return;
      await p.evaluate(idList => {
        const set = new Set(idList);
        for (const card of document.querySelectorAll('[data-review-id]')) {
          if (set.has(card.getAttribute('data-review-id'))) {
            const w = card.closest('div.jftiEf') || card;
            w.remove();
          }
        }
      }, ids);
    };

    while (seenKeys.size < target && noNewCount < MAX_NO_NEW && totalScrolls < MAX_SCROLLS) {
      if (seenKeys.size - lastPrunedAt >= PRUNE_EVERY) {
        lastPrunedAt = seenKeys.size;
        await pruneSeenCardsDom(page, seenKeys);
        feedEl = await getFeedEl(page); // re-acquire after DOM mutation
      }

      feedEl = feedEl || await getFeedEl(page);
      if (feedEl) await smartScroll(feedEl, page, seenKeys.size);
      await sleep(jitter(600, 1200));
      const visible = await extractVisibleReviewsFromDom(page);
      let added = 0;
      for (const r of visible) {
        if (seenKeys.size >= target) break;
        const k = r.reviewId ? `id:${r.reviewId}` : `fb:${norm(r.authorName)}|${norm(r.relativeTime)}|${norm(r.text).slice(0,80)}`;
        if (!seenKeys.has(k)) {
          seenKeys.add(k);
          allReviews.push(r);
          if (r.reviewId) byReviewId.set(r.reviewId, r);
          added++; domAdded++;
        }
      }
      noNewCount = added > 0 ? 0 : noNewCount + 1;
      totalScrolls++;
      if (added > 0) process.stdout.write(`\r[DOM] total=${seenKeys.size}/${target} (+${domAdded} new)   `);
      if (allReviews.length % 50 === 0 && added > 0) await saveStateFn();
    }
    console.log(`\n[DOM] pass done. added=${domAdded}, total=${seenKeys.size}/${target}`);
    await saveStateFn();
  } catch (e) { console.warn(`[DOM] mop-up failed: ${e.message}`); }
}

async function main() {
  const args = parseArgs(process.argv);
  const cid = cidFromUrl(args.url), slug = slugify(placeFromUrl(args.url) || "place"), fileId = cid || hashStr(args.url.split("?")[0]);
  const dataPath = args.out === '-' ? '-' : (args.out || path.join(args.outDir, "google", `${slug}-${fileId}.json`));
  const maxProxyAttempts = 2;
  if (dataPath !== '-') await ensureDir(path.dirname(path.resolve(dataPath)));
  if (!args.resume && dataPath !== '-') await fs.rm(dataPath, { force: true }).catch(() => { });

  const prevState = args.resume ? await readJson(dataPath) : null;
  const existingReviews = Array.isArray(prevState) ? prevState : (prevState?.reviews || []);
  const prevCompany = prevState?.company || prevState?.place || null;
  let resumeProgress = prevState?.progress || null;

  const seenKeys = new Set(existingReviews.map(reviewKey));
  const allReviews = [...existingReviews];
  const byReviewId = new Map(allReviews.filter(r => r?.reviewId).map(r => [r.reviewId, r]));

  let target = args.maxReviews > 0 ? args.maxReviews : (prevCompany?.totalReviews || MAX_DEFAULT);
  console.log(`📁 Output : ${dataPath}\n📝 Resumed: ${allReviews.length} reviews\n🎯 Initial target: ${target}`);
  console.log(`[scraper] start ${now()} url=${args.url} resume=${args.resume} headful=${args.headful}`);

  const sortMode = process.env.GMAPS_SORT || resumeProgress?.sortMode || (target >= 200 ? "newest" : "relevant");
  const placeHexPairHint = args.url.match(/0x[0-9a-fA-F]+:0x[0-9a-fA-F]+/)?.[0] || null;

  const saveState = async (opts = {}) => {
    const p = { sourceUrl: args.url, company: opts.company || prevCompany, reviews: allReviews, reviewsCount: allReviews.length, target, done: opts.done || false, reason: opts.reason, updatedAt: now(), progress: opts.progress || resumeProgress, ...opts.extra };
    if (dataPath === '-') { if (opts.done) console.log(JSON.stringify(p)); }
    else await writeAtomic(dataPath, p);
  };

  let place = prevCompany;
  let lastError = null;

  for (let attempt = 1; attempt <= maxProxyAttempts; attempt++) {
    const { browser, page } = await launchBrowser(args);

    try {
      await goto(page, enforceEnglish(args.url));
      await clickConsent(page);
      if (await hasCaptcha(page)) await sleep(30000);
      const raw = await extractPlaceInfo(page);
      place = { ...raw, pageUrl: page.url(), cid: cidFromUrl(page.url()) || cid, scrapedAt: now() };
      if (place.totalReviews) target = args.maxReviews === 0 ? place.totalReviews : Math.min(args.maxReviews, place.totalReviews);
      console.log(`📍 ${place.name}  ⭐ ${place.overallRating}  📊 ${place.totalReviews} total reviews\n🎯 Effective target: ${target}`);

      await saveState({ company: place });
      if (seenKeys.size >= target) { console.log(`✅ Already have ${seenKeys.size} / ${target}`); return; }

      const opened = await openReviews(page);
      if (!opened) { await saveState({ company: place, reason: "reviews_ui_missing" }); return; }

      // For small collections (<= 100 reviews), skip network API and use DOM extraction directly
      const isSmallCollection = target <= 100;
      
      if (!isSmallCollection) {
        // setSort now blocks until the feed actually reloads before returning,
        // so captureListUgcTemplate is guaranteed to intercept the Newest-sort XHR.
        await setSort(page, sortMode);

        let tplUrl, cursor, lastCursor, pageCount = 0, pageSize = 10;
        let fetchMode = "listugcposts";
        let batchTemplate = null;
        if (args.resume && allReviews.length > 0 && (resumeProgress?.mode === "listugcposts" || resumeProgress?.mode === "batchexecute")) {
          ({ templateUrl: tplUrl, cursor, pageSize, pageCount } = resumeProgress);
          fetchMode = resumeProgress.mode || "listugcposts";
          batchTemplate = resumeProgress.batchTemplate || null;
          lastCursor = resumeProgress.lastCursor || cursor;
        } else {
          console.log('[scraper] triggering network capture for reviews (will scroll to provoke XHR)');
          const captured = await captureListUgcTemplate(page);
          tplUrl = captured.url;
          const parsed = parseListUgcPostsPayload(placeHexPairHint, captured.text);
          cursor = captured.urlCursor || parsed.nextCursor;
          // If the first capture came from MapsWizUi batchexecute, prefer a
          // real listugcposts template captured right after scroll.
          try {
            if (tplUrl && tplUrl.includes('/MapsWizUi/data/batchexecute')) {
              if (captured.secondListUgcUrl && captured.secondListUgcUrl.includes('/maps/rpc/listugcposts')) {
                const u2 = new URL(captured.secondListUgcUrl);
                let pb2 = u2.searchParams.get('pb') || '';
                pb2 = pb2.replace(/(!2m2!1i\d{1,4}!2s)[^!]*!/, '$1!');
                u2.searchParams.set('pb', pb2);
                tplUrl = u2.toString();
                fetchMode = 'listugcposts';
                console.log('[network] batch detected; switched template to listugcposts URL for API pagination');
              } else if (captured.firstReqMethod === 'POST' && captured.firstReqPostData) {
                fetchMode = 'batchexecute';
                batchTemplate = { url: tplUrl, postData: captured.firstReqPostData };
                console.log('[network] batch detected; using batchexecute POST pagination');
              } else {
                console.log('[network] batch detected; no listugcposts template found, falling back to DOM for remaining reviews');
                cursor = null;
              }
            }
          } catch (e) { }
          lastCursor = cursor;
          pageSize = (() => { const pb = new URL(tplUrl).searchParams.get("pb") || ""; const m = pb.match(/!2m2!1i(\d{1,4})!2s/); return Number(m?.[1]) || 10; })();
          for (const r of parsed.reviews) { if (seenKeys.size < target) { const k = reviewKey(r); if (!seenKeys.has(k)) { seenKeys.add(k); allReviews.push(r); if (r.reviewId) byReviewId.set(r.reviewId, r); } } }
          pageCount = 1;
          resumeProgress = { mode: fetchMode, templateUrl: tplUrl, cursor, lastCursor, pageSize, pageCount, sortMode, batchTemplate, updatedAt: now() };
          await saveState({ company: place, progress: resumeProgress });
        }

        // Pass 1 main loop — zeroStreak stops us if cursor keeps coming but API returns
        // nothing new (Google silently deduplicates/filters on their side).
        let zeroStreak = 0;
        while (seenKeys.size < target && cursor) {
          pageCount++;
          if (fetchMode === 'batchexecute' && !batchTemplate) {
            console.log('[network] batchexecute mode missing request template; stopping API loop');
            break;
          }
          let txt = fetchMode === 'batchexecute'
            ? await fetchBatchUgcPageWithRetry(page, batchTemplate, cursor)
            : await fetchListUgcPageWithRetry(page, tplUrl, cursor, pageSize);
          const parsed = parseListUgcPostsPayload(placeHexPairHint, txt);
          if (!parsed.reviews.length) break;
          let added = 0;
          for (const r of parsed.reviews) { if (seenKeys.size < target) { const k = reviewKey(r); if (!seenKeys.has(k)) { seenKeys.add(k); allReviews.push(r); if (r.reviewId) byReviewId.set(r.reviewId, r); added++; } } }
          lastCursor = cursor; cursor = parsed.nextCursor;
          console.log(`[page ${pageCount}] addedNow=${added}, total=${seenKeys.size}/${target}, nextCursor=${cursor ? 'found' : 'null'}`);
          if (cursor === lastCursor) break;
          zeroStreak = added === 0 ? zeroStreak + 1 : 0;
          if (zeroStreak >= 3) { console.log(`[API] 3 consecutive zero-add pages, API exhausted.`); break; }
          resumeProgress = { mode: fetchMode, templateUrl: tplUrl, cursor, lastCursor, pageSize, pageCount, sortMode, batchTemplate, updatedAt: now() };
          if (allReviews.length % BATCH_SIZE === 0) await saveState({ company: place, progress: resumeProgress });
        }
      } else {
        // Small collection: skip network API, go straight to DOM extraction
        console.log(`\n⚡ Small collection (${target} reviews): using direct DOM extraction instead of network API...`);
        await setSort(page, "newest");
      }

      // ── DOM pass: Extracts reviews from rendered UI
      // For small collections this is the ONLY method. For large collections
      // this catches API-filtered reviews that browser renders anyway.
      if (seenKeys.size < target) {
        await domMopUpPass(page, target, seenKeys, allReviews, byReviewId,
          () => saveState({ company: place }));
      }

      const done = seenKeys.size >= target;
      await saveState({ company: place, done, reason: done ? null : "exhausted", progress: resumeProgress });
      console.log(`\n🏁 Finished: ${seenKeys.size} / ${target}  done=${done}`);
      return;

    } catch (err) {
      lastError = err;
      const message = String(err?.message || err || '');
      const retryable = /captcha|verify|robot|access denied|forbidden|blocked|challenge|unusual|temporarily unavailable|cloudflare|security/i.test(message);

      if (retryable && attempt < maxProxyAttempts) {
        console.warn(`\n[proxy] ${message}; retrying with next IP (${attempt}/${maxProxyAttempts})...`);
        const delay = 15000 + Math.floor(Math.random() * 10000);
        console.log(`[proxy] Waiting ${delay}ms before retry...`);
        await sleep(delay);
        continue;
      }

      console.error(`\n💥 Fatal: ${message}`);
      await takeScreenshot(page, "error");
      await saveState({ company: place, reason: "error", extra: { error: message } });
      process.exitCode = 1;
    } finally {
      await browser.close();
    }
  }

  if (lastError && !process.exitCode) {
    process.exitCode = 1;
  }
}

await main();