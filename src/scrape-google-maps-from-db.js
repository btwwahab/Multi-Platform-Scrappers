import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import minimist from 'minimist';
import pool from '../db.js';

function parseArgs(argv) {
  const a = minimist(argv.slice(2), {
    boolean: ['headful', 'dryRun', 'help'],
    string: ['platforms'],
    default: {
      limit: 0,
      fromId: 0,
      maxReviews: 0,
      platforms: 'google,clutch,trustpilot,g2,goodfirms,yelp',
      headful: false,
      dryRun: false,
    },
  });

  if (a.help) {
    console.log(
      'Usage: node src/scrape-google-maps-from-db.js [options]\n' +
      '  --limit N          Process at most N companies (default: all)\n' +
      '  --fromId N         Start from company id >= N\n' +
      '  --companyId N      Process only one company id\n' +
      '  --platforms P      Comma list: google,clutch,trustpilot,g2,goodfirms,yelp\n' +
      '  --maxReviews N     Per-platform cap (default: all)\n' +
      '  --headful          Open browser in visible mode\n' +
      '  --dryRun           Do not write reviews table\n'
    );
    process.exit(0);
  }

  a.limit = Number(a.limit) || 0;
  a.fromId = Number(a.fromId) || 0;
  a.maxReviews = Number(a.maxReviews) || 0;
  a.companyId = a.companyId ? Number(a.companyId) : null;
  a.platforms = String(a.platforms || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const allowed = new Set(['google', 'clutch', 'trustpilot', 'g2', 'goodfirms', 'yelp']);
  a.platforms = a.platforms.filter((p) => allowed.has(p));
  if (!a.platforms.length) a.platforms = ['google', 'clutch', 'trustpilot', 'g2', 'goodfirms', 'yelp'];

  return a;
}

function hashText(s) {
  return createHash('sha1').update(String(s || '')).digest('hex');
}

function safeUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function extractGoogleCid(value) {
  try {
    const hits = [...String(value || '').matchAll(/:0x([0-9a-fA-F]{8,})/g)];
    if (!hits.length) return null;
    return BigInt(`0x${hits.at(-1)[1]}`).toString(10);
  } catch {
    return null;
  }
}

function normalizeGoogleSource(url, payload) {
  const cid = payload?.company?.cid || extractGoogleCid(payload?.company?.pageUrl || url);
  if (cid) {
    return {
      key: `cid:${cid}`,
      url: payload?.company?.pageUrl || url || null,
    };
  }

  const u = safeUrl(payload?.company?.pageUrl || url);
  if (!u) return { key: null, url: null };
  u.search = '';
  u.hash = '';
  return { key: `url:${u.origin}${u.pathname}`, url: u.toString() };
}

function normalizeClutchSource(url) {
  const u = safeUrl(url);
  if (!u) return { key: null, url: null };

  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('profile');
  const slug = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts.at(-1);
  if (slug) {
    return {
      key: `slug:${slug.toLowerCase()}`,
      url: `${u.origin}/profile/${slug}`,
    };
  }

  u.search = '';
  u.hash = '';
  return { key: `url:${u.origin}${u.pathname}`, url: u.toString() };
}

function normalizeTrustpilotSource(url) {
  const u = safeUrl(url);
  if (!u) return { key: null, url: null };

  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('review');
  const domain = (idx >= 0 && parts[idx + 1]) ? parts[idx + 1] : parts.at(-1);
  if (domain) {
    const slug = String(domain).toLowerCase();
    return {
      key: `domain:${slug}`,
      url: `${u.origin}/review/${slug}`,
    };
  }

  u.search = '';
  u.hash = '';
  return { key: `url:${u.origin}${u.pathname}`, url: u.toString() };
}

function normalizeG2Source(url) {
  const u = safeUrl(url);
  if (!u) return { key: null, url: null };

  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('products');
  const slug = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts.at(-1);
  if (slug) {
    return {
      key: `slug:${slug.toLowerCase()}`,
      url: `${u.origin}/products/${slug}`,
    };
  }

  u.search = '';
  u.hash = '';
  return { key: `url:${u.origin}${u.pathname}`, url: u.toString() };
}

function normalizeGoodFirmsSource(url) {
  const u = safeUrl(url);
  if (!u) return { key: null, url: null };

  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('company');
  const slug = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts.at(-1);
  if (slug) {
    return {
      key: `slug:${slug.toLowerCase()}`,
      url: `${u.origin}/company/${slug}`,
    };
  }

  u.search = '';
  u.hash = '';
  return { key: `url:${u.origin}${u.pathname}`, url: u.toString() };
}

function normalizeYelpSource(url) {
  const u = safeUrl(url);
  if (!u) return { key: null, url: null };

  const parts = u.pathname.split('/').filter(Boolean);
  const idx = parts.indexOf('biz');
  const slug = idx >= 0 && parts[idx + 1] ? parts[idx + 1] : parts.at(-1);
  if (slug) {
    return {
      key: `slug:${slug.toLowerCase()}`,
      url: `${u.origin}/biz/${slug}`,
    };
  }

  u.search = '';
  u.hash = '';
  return { key: `url:${u.origin}${u.pathname}`, url: u.toString() };
}

function buildSourceInfo(platform, url, payload) {
  if (platform === 'google') return normalizeGoogleSource(url, payload);
  if (platform === 'clutch') return normalizeClutchSource(url);
  if (platform === 'trustpilot') return normalizeTrustpilotSource(url);
  if (platform === 'g2') return normalizeG2Source(url);
  if (platform === 'goodfirms') return normalizeGoodFirmsSource(url);
  if (platform === 'yelp') return normalizeYelpSource(url);
  return { key: null, url: null };
}

function cleanQuoteTitle(value) {
  const t = String(value || '').trim();
  if (!t) return null;
  return t.replace(/^['"“”‘’]+|['"“”‘’]+$/g, '').trim() || null;
}

const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "Sep 23, 2025" / "September 23, 2025" / "23 Sep 2025" → "2025-09-23" without any timezone shift.
// (new Date("Sep 23, 2025") is local-midnight, so toISOString() moves it a day back in UTC+ zones.)
function parseWrittenDate(v) {
  const s = String(v).replace(/^posted on\s*/i, '').replace(/\./g, '').replace(/\s+/g, ' ').trim();
  let m = s.match(/^([A-Za-z]{3,9}) (\d{1,2}),? (\d{4})$/);
  let mon, day, year;
  if (m) { mon = m[1]; day = m[2]; year = m[3]; }
  else if ((m = s.match(/^(\d{1,2}) ([A-Za-z]{3,9}),? (\d{4})$/))) { day = m[1]; mon = m[2]; year = m[3]; }
  else return null;
  const mi = MONTHS_SHORT.indexOf(mon.slice(0, 3).toLowerCase());
  if (mi < 0) return null;
  const d = new Date(Date.UTC(Number(year), mi, Number(day)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toDateOnly(...values) {
  for (const v of values) {
    if (!v) continue;
    if (typeof v === 'string') {
      const written = parseWrittenDate(v);
      if (written) return written;
    }
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return null;
}

function toDateOnlyFromDate(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function parseGoogleRelativeDate(relativeTime, fallbackIso = null) {
  const raw = String(relativeTime || '').trim().toLowerCase();
  if (!raw) return toDateOnly(fallbackIso, new Date().toISOString());

  const cleaned = raw
    .replace(/^edited\s+/i, '')
    .replace(/^updated\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const base = new Date(fallbackIso || new Date().toISOString());
  if (Number.isNaN(base.getTime())) return null;

  if (cleaned === 'today') return toDateOnlyFromDate(base);
  if (cleaned === 'yesterday') {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - 1);
    return toDateOnlyFromDate(d);
  }

  const m = cleaned.match(/^(a|an|\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (!m) return toDateOnly(fallbackIso, new Date().toISOString());

  const qty = /^(a|an)$/i.test(m[1]) ? 1 : Number(m[1]);
  const unit = m[2].toLowerCase();
  if (!Number.isFinite(qty) || qty <= 0) return toDateOnly(fallbackIso, new Date().toISOString());

  const d = new Date(base);
  if (unit === 'minute') d.setUTCMinutes(d.getUTCMinutes() - qty);
  else if (unit === 'hour') d.setUTCHours(d.getUTCHours() - qty);
  else if (unit === 'day') d.setUTCDate(d.getUTCDate() - qty);
  else if (unit === 'week') d.setUTCDate(d.getUTCDate() - qty * 7);
  else if (unit === 'month') d.setUTCMonth(d.getUTCMonth() - qty);
  else if (unit === 'year') d.setUTCFullYear(d.getUTCFullYear() - qty);

  return toDateOnlyFromDate(d);
}

function toPlatformId(platform, review) {
  const rid = review?.reviewId ? String(review.reviewId) : '';
  if (rid) return rid.slice(0, 255);

  const raw = [
    platform,
    review?.reviewUrl || review?.url || '',
    review?.authorName || review?.author || review?.reviewer?.name || '',
    review?.dateTime || review?.date || review?.relativeTime || '',
    review?.title || review?.projectTitle || review?.reviewQuote || '',
    review?.text || review?.feedbackSummary || '',
  ].join('|');

  return hashText(raw);
}

function toOneDecimalRating(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 10) / 10;
}

function isGoogleUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    const host = String(u.hostname || '').toLowerCase();
    const isGoogleMapsPlace = /(^|\.)google\.com$/i.test(host) && u.pathname.includes('/maps/place/');
    const isShortGoogleMaps = host === 'maps.app.goo.gl' || host === 'goo.gl' || host === 'www.goo.gl';
    return isGoogleMapsPlace || isShortGoogleMaps;
  } catch {
    return false;
  }
}

function isClutchUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    return /(^|\.)clutch\.co$/i.test(u.hostname) && u.pathname.includes('/profile/');
  } catch {
    return false;
  }
}

function isTrustpilotUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    return /(^|\.)trustpilot\.com$/i.test(u.hostname) && u.pathname.includes('/review/');
  } catch {
    return false;
  }
}

function isG2Url(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    return /(^|\.)g2\.com$/i.test(u.hostname) && u.pathname.includes('/products/');
  } catch {
    return false;
  }
}

function isGoodFirmsUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    return /(^|\.)goodfirms\.co$/i.test(u.hostname) && u.pathname.includes('/company/');
  } catch {
    return false;
  }
}

function isYelpUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(String(url).trim());
    return /(^|\.)yelp\.com$/i.test(u.hostname) && u.pathname.includes('/biz/');
  } catch {
    return false;
  }
}

const PLATFORM_CONFIG = {
  google: {
    companyUrlField: 'google_review_url',
    scriptPath: 'src/network/scrape-google-maps-network.js',
    outputSubdir: 'google',
    isSupported: isGoogleUrl,
    mapReview: (r, payload) => ({
      author: r?.authorName ? String(r.authorName).slice(0, 255) : null,
      authorImage: null,
      title: null,
      text: r?.text ? String(r.text) : null,
      rating: toOneDecimalRating(r?.rating),
      date: parseGoogleRelativeDate(r?.relativeTime, payload?.updatedAt || payload?.company?.scrapedAt || null),
      platformResponse: {
        reviewUrl: r?.reviewUrl || null,
        relativeTime: r?.relativeTime || null,
        authorMeta: r?.authorMeta || null,
        authorReviewsCount: r?.authorReviewsCount ?? null,
        authorPhotosCount: r?.authorPhotosCount ?? null,
        authorIsLocalGuide: r?.authorIsLocalGuide ?? null,
        ownerResponse: r?.ownerResponse ?? null,
        likes: r?.likes ?? null,
      },
    }),
    updateCompany: async (companyId, payload) => {
      const company = payload?.company || null;
      const cid = company?.cid ? String(company.cid) : null;
      if (!cid) return;
      await pool.query(
        `
        update companies
        set
          google_review_cid = coalesce($2::varchar, google_review_cid),
          updated_at = now()
        where id = $1
        `,
        [companyId, cid]
      );
    },
  },
  clutch: {
    companyUrlField: 'clutch_review_url',
    scriptPath: 'src/network/scrape-clutch-network.js',
    outputSubdir: 'clutch',
    isSupported: isClutchUrl,
    mapReview: (r) => ({
      author: r?.reviewer?.name ? String(r.reviewer.name).slice(0, 255) : null,
      authorImage: null,
      title: r?.projectTitle ? String(r.projectTitle).slice(0, 500) : null,
      text: r?.reviewQuote ? String(r.reviewQuote) : null,
      rating: toOneDecimalRating(r?.overallRating),
      date: toDateOnly(r?.reviewDate),
      platformResponse: {
        reviewUrl: r?.reviewUrl || null,
        subRatings: r?.subRatings || null,
        reviewer: r?.reviewer || null,
        projectType: r?.projectType || null,
        projectCost: r?.projectCost || null,
        projectDates: r?.projectDates || null,
        isFeatured: r?.isFeatured ?? null,
        isVerified: r?.isVerified ?? null,
      },
    }),
    updateCompany: async () => { },
  },
  trustpilot: {
    companyUrlField: 'trustpilot_review_url',
    scriptPath: 'src/network/scrape-trustpilot-network.js',
    outputSubdir: 'trustpilot',
    isSupported: isTrustpilotUrl,
    mapReview: (r) => ({
      author: r?.reviewer?.name ? String(r.reviewer.name).slice(0, 255) : null,
      authorImage: null,
      title: r?.title ? String(r.title).slice(0, 500) : null,
      text: r?.text ? String(r.text) : null,
      rating: toOneDecimalRating(r?.rating),
      date: toDateOnly(r?.dateTime, r?.date),
      platformResponse: {
        reviewUrl: r?.reviewUrl || null,
        badges: r?.badges || null,
        usefulCount: r?.usefulCount ?? null,
        reviewer: r?.reviewer || null,
        companyReply: r?.companyReply || null,
      },
    }),
    updateCompany: async () => { },
  },
  g2: {
    companyUrlField: 'g2_review_url',
    scriptPath: 'src/scrape-g2.js',
    outputSubdir: 'g2',
    isSupported: isG2Url,
    mapReview: (r) => ({
      author: r?.reviewer?.name ? String(r.reviewer.name).slice(0, 255) : null,
      authorImage: null,
      title: r?.title ? String(r.title).slice(0, 500) : null,
      text: r?.text ? String(r.text) : null,
      rating: toOneDecimalRating(r?.rating),
      date: toDateOnly(r?.dateTime, r?.date),
      platformResponse: {
        reviewUrl: r?.reviewUrl || null,
        badges: r?.badges || null,
        reviewer: r?.reviewer || null,
      },
    }),
    updateCompany: async () => { },
  },
  goodfirms: {
    companyUrlField: 'goodfirms_review_url',
    scriptPath: 'src/network/scrape-goodfirms-network.js',
    outputSubdir: 'goodfirms',
    isSupported: isGoodFirmsUrl,
    mapReview: (r) => ({
      author: r?.reviewer?.name ? String(r.reviewer.name).slice(0, 255) : null,
      authorImage: null,
      title: (r?.title ? String(r.title).slice(0, 500) : null) || null,
      text: (r?.summary ? String(r.summary) : null) || null,
      rating: toOneDecimalRating(r?.ratingBreakdown?.['Overall Rating']),
      date: toDateOnly(r?.date),
      platformResponse: {
        reviewUrl: r?.reviewUrl || null,
        raw: r || null,
        ratingBreakdown: r?.ratingBreakdown || null,
        projectDetails: r?.projectDetails || null,
        projectInformation: r?.projectInformation || null,
      },
    }),
    updateCompany: async () => { },
  },
  yelp: {
    companyUrlField: 'yelp_review_url',
    scriptPath: 'src/network/scrape-yelp-network.js',
    outputSubdir: 'yelp',
    isSupported: isYelpUrl,
    mapReview: (r) => {
      const avatar = r?.reviewer?.avatarUrl ? String(r.reviewer.avatarUrl) : null;
      // Yelp's generic default avatar — treat as no photo (null)
      const isYelpFallback = avatar && /default_user_avatar/i.test(avatar);
      return {
        author: r?.reviewer?.name ? String(r.reviewer.name).slice(0, 255) : null,
        authorImage: isYelpFallback ? null : avatar,
        title: null,
        text: r?.text ? String(r.text) : null,
        rating: toOneDecimalRating(r?.rating),
        date: toDateOnly(r?.date, r?.dateRaw),
        platformResponse: {
          reviewUrl: r?.reviewUrl || null,
          dateRaw: r?.dateRaw || null,
          reviewer: r?.reviewer || null,
          reactions: r?.reactions || null,
          raw: r || null,
        },
      };
    },
    updateCompany: async () => { },
  },
};

async function ensurePlatformSourceTable() {
  try {
    await pool.query(
      `
      create table if not exists company_platform_sources (
        company_id bigint not null,
        platform varchar(32) not null,
        source_key text not null,
        source_url text,
        updated_at timestamptz not null default now(),
        primary key (company_id, platform)
      )
      `
    );
    return true;
  } catch (e) {
    console.warn(`WARN: failed to init company_platform_sources table: ${e?.message || e}`);
    return false;
  }
}

async function getPlatformSource(companyId, platform) {
  const q = await pool.query(
    `
    select source_key, source_url
    from company_platform_sources
    where company_id = $1 and platform = $2
    `,
    [companyId, platform]
  );
  if (!q.rows.length) return null;
  return {
    sourceKey: q.rows[0].source_key || null,
    sourceUrl: q.rows[0].source_url || null,
  };
}

async function setPlatformSource(companyId, platform, sourceKey, sourceUrl) {
  if (!sourceKey) return;
  await pool.query(
    `
    insert into company_platform_sources (
      company_id, platform, source_key, source_url, updated_at
    ) values ($1, $2, $3, $4, now())
    on conflict (company_id, platform)
    do update set
      source_key = excluded.source_key,
      source_url = excluded.source_url,
      updated_at = now()
    `,
    [companyId, platform, sourceKey, sourceUrl || null]
  );
}

async function countPlatformReviews(companyId, platform) {
  const q = await pool.query(
    `
    select count(*)::int as count
    from reviews
    where company_id = $1 and platform = $2
    `,
    [companyId, platform]
  );
  return Number(q.rows[0]?.count) || 0;
}

function decideReplaceExisting({ storedKey, newKey, existingCount, hasNewReviews, allowUnknownReplace, scrapedCount = 0, complete = true }) {
  if (!newKey || !hasNewReviews) return { replace: false, reason: null };
  if (storedKey && storedKey !== newKey) return { replace: true, reason: 'source_changed' };
  if (!storedKey && existingCount > 0 && allowUnknownReplace) {
    // Replacing = "delete every stored review for this platform, then insert the scraped ones".
    // Never trade a bigger stored set for a smaller, incomplete scrape (Google's anonymous "limited view"
    // returns 5 reviews, blocked/partial runs, ...) — that silently wipes the company's reviews.
    if (!complete && scrapedCount < existingCount) return { replace: false, reason: 'protected_incomplete_scrape' };
    return { replace: true, reason: 'source_unknown' };
  }
  return { replace: false, reason: null };
}

async function runScraper({ scriptPath, url, headful, maxReviews, userDataDir, extraArgs = [] }) {
  // Use a temp file instead of --out - to avoid stdout being polluted by log
  // messages (intermediate saves, sample reviews, progress lines, etc.).
  const tmpFile = path.join(
    os.tmpdir(),
    `scraper-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );

  return new Promise((resolve, reject) => {
    const args = [scriptPath, '--url', url, '--noResume', '--out', tmpFile];
    if (userDataDir) args.push('--userDataDir', userDataDir);
    if (Array.isArray(extraArgs) && extraArgs.length) args.push(...extraArgs);
    if (maxReviews > 0) args.push('--maxReviews', String(maxReviews));
    else args.push('--all');
    if (headful) args.push('--headful');

    // All I/O inherited → scraper logs stream live to this process's terminal
    const cp = spawn(process.execPath, args, { stdio: 'inherit' });

    cp.on('error', reject);
    cp.on('close', async (code) => {
      try {
        if (code !== 0) throw new Error(`scraper exited with code ${code}`);
        const raw = await fs.readFile(tmpFile, 'utf8');
        const payload = JSON.parse(raw);
        resolve(payload);
      } catch (e) {
        reject(e);
      } finally {
        // Clean up temp file (best-effort)
        fs.unlink(tmpFile).catch(() => { });
      }
    });
  });
}

async function fetchCompaniesToProcess({ companyId, fromId, limit }) {
  if (companyId) {
    const q = await pool.query(
      `
      select id, name, google_review_url, clutch_review_url, trustpilot_review_url, g2_review_url, goodfirms_review_url, yelp_review_url
      from companies
      where id = $1
      `,
      [companyId]
    );
    return q.rows;
  }

  const q = await pool.query(
    `
    select id, name, google_review_url, clutch_review_url, trustpilot_review_url, g2_review_url, goodfirms_review_url, yelp_review_url
    from companies
    where deleted_at is null
      and ($1::bigint = 0 or id >= $1::bigint)
      and (
        (google_review_url is not null and btrim(google_review_url) <> '')
        or (clutch_review_url is not null and btrim(clutch_review_url) <> '')
        or (trustpilot_review_url is not null and btrim(trustpilot_review_url) <> '')
        or (g2_review_url is not null and btrim(g2_review_url) <> '')
        or (goodfirms_review_url is not null and btrim(goodfirms_review_url) <> '')
        or (yelp_review_url is not null and btrim(yelp_review_url) <> '')
      )
    order by id asc
    `,
    [fromId || 0]
  );

  if (limit > 0) return q.rows.slice(0, limit);
  return q.rows;
}

async function upsertPlatformReviews(companyId, platform, payload, mapper, { replaceExisting = false } = {}) {
  const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];

  await pool.query('begin');
  try {
    if (replaceExisting) {
      await pool.query(
        'delete from reviews where company_id = $1 and platform = $2',
        [companyId, platform]
      );
    }

    for (const r of reviews) {
      const platformId = toPlatformId(platform, r).slice(0, 255);
      const mapped = mapper(r, payload);
      const resolvedAuthorImage =
        mapped.authorImage ||
        mapped?.platformResponse?.reviewer?.avatarUrl ||
        mapped?.platformResponse?.raw?.reviewer?.avatarUrl ||
        null;

      await pool.query(
        `
        insert into reviews (
          company_id, platform, platform_id, author, author_image, title, text, rating, date, platform_response, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::jsonb, now(), now())
        on conflict (company_id, platform, platform_id)
        do update set
          author = coalesce(excluded.author, reviews.author),
          author_image = coalesce(excluded.author_image, reviews.author_image),
          title = excluded.title,
          text = excluded.text,
          rating = excluded.rating,
          date = excluded.date,
          platform_response = excluded.platform_response,
          updated_at = now()
        `,
        [
          companyId,
          platform,
          platformId,
          mapped.author,
          resolvedAuthorImage,
          mapped.title,
          mapped.text,
          mapped.rating,
          mapped.date,
          mapped.platformResponse == null ? null : JSON.stringify(mapped.platformResponse),
        ]
      );
    }

    await pool.query('commit');
    return reviews.length;
  } catch (e) {
    await pool.query('rollback');
    throw e;
  }
}

async function updateCompanyRatingSummary(companyId, { stage = 'final' } = {}) {
  // Use two separate aggregates:
  //   - average_rating  → avg over reviews that HAVE a numeric rating
  //   - reviews_count   → total number of stored reviews (with OR without a rating)
  // This ensures reviews_count is never under-counted due to null ratings.
  const stats = await pool.query(
    `
    select
      round(avg(rating)::numeric, 1)          as average_rating,
      count(*)::int                            as total_count,
      count(*) filter (where rating is not null)::int as rated_count
    from reviews
    where company_id = $1
    `,
    [companyId]
  );

  const row = stats.rows[0] || {};
  const totalCount  = Number(row.total_count)  || 0;  // ALL reviews (for reviews_count)
  const ratedCount  = Number(row.rated_count)  || 0;  // reviews that have a rating
  const averageRating = ratedCount > 0 ? Number(row.average_rating) : null;

  await pool.query(
    `
    update companies
    set
      rating        = $2,
      reviews_count = $3,
      updated_at    = now()
    where id = $1
    `,
    [companyId, averageRating, totalCount]
  );

  if (totalCount === 0) {
    console.log(`[${stage}] Reset company rating (no reviews in DB) company_id=${companyId}`);
    return;
  }

  console.log(
    `[${stage}] Updated company rating company_id=${companyId}` +
    ` rating=${averageRating} reviews_count=${totalCount} (rated=${ratedCount})`
  );
}

async function resetCompanyRatingSummary(companyId) {
  await pool.query(
    `
    update companies
    set
      rating = null,
      reviews_count = 0,
      updated_at = now()
    where id = $1
    `,
    [companyId]
  );

  console.log(`[init] Reset company rating company_id=${companyId} rating=null reviews_count=0`);
}

async function main() {
  const args = parseArgs(process.argv);
  const platformSourceEnabled = await ensurePlatformSourceTable();
  const companies = await fetchCompaniesToProcess(args);

  console.log(`Found ${companies.length} company candidates`);
  console.log(`Platforms: ${args.platforms.join(', ')}`);

  let processedCompanies = 0;
  let failedCompanies = 0;
  let processedJobs = 0;
  let skippedJobs = 0;
  let failedJobs = 0;
  let savedReviews = 0;

  for (const c of companies) {
    const companyJobs = [];
    for (const platform of args.platforms) {
      const cfg = PLATFORM_CONFIG[platform];
      if (!cfg) continue;

      const urlRaw = c[cfg.companyUrlField];
      const url = urlRaw ? String(urlRaw).trim() : '';
      if (!url) continue;

      companyJobs.push({ platform, cfg, url });
    }

    if (!companyJobs.length) continue;

    console.log(`\n=== COMPANY ${c.id} (${c.name}) ===`);
    let companyHadFailure = false;
    let companySavedAnyReviews = false;

    // NOTE: the company's rating/reviews_count is intentionally NOT reset up-front any more.
    // It used to be zeroed before scraping and only restored if this run saved ≥1 review, so any
    // failed/blocked/empty scrape left a company with stored reviews but rating=null & reviews_count=0
    // (looks like "reviews stopped"). The summary is recomputed from the `reviews` table after the run.

    for (const job of companyJobs) {
      const { platform, cfg, url } = job;

      if (!cfg.isSupported(url)) {
        skippedJobs++;
        console.log(`SKIP ${platform}: URL pattern unsupported`);
        continue;
      }

      console.log(`SCRAPE ${platform}: ${url}`);
      try {
        const payload = await runScraper({
          scriptPath: cfg.scriptPath,
          url,
          headful: args.headful,
          maxReviews: args.maxReviews,
          userDataDir: path.join(os.tmpdir(), `va-scrapper-${platform}-${c.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`),
        });

        const scrapedCount = Array.isArray(payload?.reviews) ? payload.reviews.length : 0;
        console.log(`Scraped ${scrapedCount} reviews (${platform})`);
        if (payload?.done === false && payload?.reason) {
          console.warn(`⚠️  ${platform}: incomplete scrape — reason=${payload.reason}`);
        }

        const sourceInfo = buildSourceInfo(platform, url, payload);
        const storedSource = platformSourceEnabled
          ? await getPlatformSource(c.id, platform)
          : null;
        const existingCount = await countPlatformReviews(c.id, platform);
        const hasNewReviews = scrapedCount > 0;
        const allowUnknownReplace = args.maxReviews === 0 || payload?.done === true;
        const replaceDecision = decideReplaceExisting({
          storedKey: storedSource?.sourceKey || null,
          newKey: sourceInfo.key || null,
          existingCount,
          hasNewReviews,
          allowUnknownReplace,
          scrapedCount,
          complete: payload?.done === true,
        });

        if (replaceDecision.reason === 'protected_incomplete_scrape') {
          console.warn(
            `🛡️  Keeping ${existingCount} existing ${platform} reviews: this scrape was incomplete ` +
            `(${scrapedCount} reviews, done=${payload?.done === true}) so it must not replace them.`
          );
        }

        if (replaceDecision.replace) {
          console.log(
            `🧹 Clearing ${existingCount} existing ${platform} reviews (${replaceDecision.reason})`
          );
        }

        if (!args.dryRun) {
          const written = await upsertPlatformReviews(
            c.id,
            platform,
            payload,
            cfg.mapReview,
            { replaceExisting: replaceDecision.replace }
          );
          await cfg.updateCompany(c.id, payload);
          if (platformSourceEnabled && hasNewReviews && sourceInfo.key) {
            await setPlatformSource(c.id, platform, sourceInfo.key, sourceInfo.url);
          }
          savedReviews += written;
          if (written > 0) companySavedAnyReviews = true;
          console.log(`Saved/upserted ${written} reviews (${platform})`);

          // Step-by-step summary update after each successful platform write.
          if (companySavedAnyReviews) {
            try {
              await updateCompanyRatingSummary(c.id, { stage: `after_${platform}` });
            } catch (e) {
              console.error(
                `WARN: failed step summary update for company_id=${c.id} platform=${platform}: ${e.message}`
              );
            }
          }
        } else {
          console.log('dryRun=true, DB write skipped');
        }

        processedJobs++;
      } catch (e) {
        failedJobs++;
        companyHadFailure = true;
        console.error(`FAILED ${platform}: ${e.message}`);
      }
    }

    // Final authoritative recompute after all platforms for this company.
    // Always recompute from what is actually stored (also when the scrape failed or found nothing new).
    if (!args.dryRun) {
      try {
        await updateCompanyRatingSummary(c.id, { stage: 'final' });
      } catch (e) {
        console.error(`WARN: failed to update rating summary for company_id=${c.id}: ${e.message}`);
      }
    }

    if (companyHadFailure) failedCompanies++;
    else processedCompanies++;
  }

  console.log('\nDone');
  console.log(`Processed companies: ${processedCompanies}`);
  console.log(`Failed companies:    ${failedCompanies}`);
  console.log(`Processed jobs:      ${processedJobs}`);
  console.log(`Skipped jobs:        ${skippedJobs}`);
  console.log(`Failed jobs:         ${failedJobs}`);
  console.log(`Saved reviews:       ${savedReviews}`);

  // Keep partial-success runs green: only fail the process if nothing succeeded.
  if (processedJobs === 0 && failedJobs > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => { });
  });
