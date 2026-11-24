import 'dotenv/config';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { getPoolForRequest } from './db.js';

const HOST = process.env.SCRAPE_HOST || '127.0.0.1';
const PORT = Number(process.env.SCRAPE_PORT || 8787);

// ── Active jobs tracker (in-memory) ──────────────────────────────────────────
const activeJobs = new Map(); // jobId -> { startedAt, args, status }

function normalizePlatformsValue(platforms) {
  if (!platforms) return 'all';
  return String(platforms)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',');
}

function buildJobKey({ companyId = null, platforms = null, dbEnv = 'local' } = {}) {
  const cid = companyId == null ? 'all' : String(companyId);
  const p = normalizePlatformsValue(platforms);
  const env = String(dbEnv || 'local').toLowerCase();
  return `${env}|${cid}|${p}`;
}

function findRunningJobByKey(jobKey) {
  for (const job of activeJobs.values()) {
    if (job.status === 'running' && job.jobKey === jobKey) return job;
  }
  return null;
}

function json(res, statusCode, data) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function parseBool(v, fallback = false) {
  if (v == null || v === '') return fallback;
  const t = String(v).trim().toLowerCase();
  return t === '1' || t === 'true' || t === 'yes' || t === 'y';
}

function parsePositiveInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function slugifyText(v) {
  return String(v || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Fire-and-forget scraper ───────────────────────────────────────────────────
/**
 * Spawns scrape-google-maps-from-db.js in the background.
 * stdio is inherited so all logs stream to the server terminal live.
 * Returns immediately with a jobId.
 */
function fireAndForget({ companyId = null, platforms = null, maxReviews = 0, headful = false, limit = 0, fromId = 0, dryRun = false, dbEnv = 'local' } = {}) {
  const args = ['src/scrape-google-maps-from-db.js'];

  if (companyId != null) args.push('--companyId', String(companyId));
  if (platforms) args.push('--platforms', platforms);
  // When maxReviews is 0 the intention is to request "all" reviews.
  // Some scraper entrypoints expect an explicit `--all` flag rather than
  // a numeric maxReviews=0, so forward `--all` in that case.
  if (maxReviews > 0) {
    args.push('--maxReviews', String(maxReviews));
  } else {
    args.push('--all');
  }
  if (headful) args.push('--headful');
  if (limit > 0) args.push('--limit', String(limit));
  if (fromId > 0) args.push('--fromId', String(fromId));
  if (dryRun) args.push('--dryRun');

  const jobKey = buildJobKey({ companyId, platforms, dbEnv });
  const existing = findRunningJobByKey(jobKey);
  if (existing) {
    return { jobId: existing.jobId, startedAt: existing.startedAt, deduped: true };
  }

  const jobId = `job-${Date.now()}`;
  const started = new Date().toISOString();

  // stdio: 'inherit' → child process logs flow directly to this server's terminal
  const cp = spawn(process.execPath, args, {
    stdio: 'inherit',
    env: { ...process.env, DB_ENV: dbEnv },
  });

  activeJobs.set(jobId, { jobId, startedAt: started, platforms, companyId, dbEnv, jobKey, status: 'running' });

  cp.on('error', (err) => {
    console.error(`[${jobId}] ❌ Scraper process error: ${err.message}`);
    const job = activeJobs.get(jobId);
    if (job) job.status = 'error';
  });

  cp.on('close', (code) => {
    const job = activeJobs.get(jobId);
    if (job) {
      job.status = code === 0 ? 'done' : `failed(exit=${code})`;
      job.finishedAt = new Date().toISOString();
    }
    if (code === 0) {
      console.log(`[${jobId}] ✅ Scraper finished successfully`);
    } else {
      console.error(`[${jobId}] ❌ Scraper exited with code ${code}`);
    }
  });

  return { jobId, startedAt: started };
}

// ── Fire-and-forget discovery scraper ─────────────────────────────────────────
/**
 * Spawns discovery scraper (google, clutch, trustpilot, goodfirms) in the background.
 * stdio is inherited so all logs stream to the server terminal live.
 * Returns immediately with a jobId.
 */
function fireAndForgetDiscovery({ companyId = null, platforms = null, headful = false, limit = 0, fromId = 0, dryRun = false, dbEnv = 'local' } = {}) {
  // Validate platforms
  const allowedPlatforms = ['google', 'clutch', 'trustpilot', 'goodfirms'];
  const platformList = String(platforms || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (platformList.length === 0) {
    platformList.push(...allowedPlatforms);
  }

  const jobKey = buildJobKey({ companyId, platforms: platformList.join(','), dbEnv });
  const existing = findRunningJobByKey(jobKey);
  if (existing) {
    return { jobId: existing.jobId, startedAt: existing.startedAt, deduped: true };
  }

  const jobId = `discovery-job-${Date.now()}`;
  const started = new Date().toISOString();

  // Spawn discovery scraper for each platform
  const jobs = [];
  // Track completion: without this the job stayed "running" forever, and the dedupe check
  // (findRunningJobByKey) then swallowed every later discovery request for the same company.
  let remaining = platformList.length;
  let anyFailed = false;
  const markFinished = (failed) => {
    if (failed) anyFailed = true;
    remaining -= 1;
    if (remaining > 0) return;
    const job = activeJobs.get(jobId);
    if (job) {
      job.status = anyFailed ? 'failed' : 'done';
      job.finishedAt = new Date().toISOString();
    }
  };
  for (const platform of platformList) {
    let finished = false;
    const finishOnce = (failed) => { if (finished) return; finished = true; markFinished(failed); };
    const scriptPath = `src/discovery/scrape-${platform}-discovery.js`;
    const args = [scriptPath];

    if (companyId != null) args.push('--companyId', String(companyId));
    if (limit > 0) args.push('--limit', String(limit));
    if (fromId > 0) args.push('--fromId', String(fromId));
    if (headful) args.push('--headful');
    if (dryRun) args.push('--dryRun');

    const cp = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, DB_ENV: dbEnv },
    });

    jobs.push({ platform, childProcess: cp });

    cp.on('error', (err) => {
      console.error(`[${jobId}] ❌ ${platform} discovery process error: ${err.message}`);
      finishOnce(true);
    });

    cp.on('close', (code) => {
      if (code === 0) {
        console.log(`[${jobId}] ✅ ${platform} discovery finished successfully`);
      } else {
        console.error(`[${jobId}] ❌ ${platform} discovery exited with code ${code}`);
      }
      finishOnce(code !== 0);
    });
  }

  activeJobs.set(jobId, {
    jobId,
    startedAt: started,
    platforms: platformList,
    companyId,
    dbEnv,
    jobKey,
    status: 'running',
    platformJobs: jobs.map((j) => j.platform),
  });

  return { jobId, startedAt: started };
}

// ── DB helpers ────────────────────────────────────────────────────────────────
function countAvailablePlatforms(companyRow) {
  let count = 0;
  if (hasPlatformUrl(companyRow, 'google')) count++;
  if (hasPlatformUrl(companyRow, 'clutch')) count++;
  if (hasPlatformUrl(companyRow, 'trustpilot')) count++;
  if (hasPlatformUrl(companyRow, 'g2')) count++;
  if (hasPlatformUrl(companyRow, 'goodfirms')) count++;
  if (hasPlatformUrl(companyRow, 'yelp')) count++;
  return count;
}


async function findCompanyBySlug(pool, slug, preferredPlatform = null) {

  const q = await pool.query(
    `
      SELECT
        id,
        name,
        google_review_url,
        clutch_review_url,
        trustpilot_review_url,
        g2_review_url,
        goodfirms_review_url,
        yelp_review_url
      FROM companies
      WHERE deleted_at IS NULL
        AND slug = $1
      ORDER BY id ASC
    `,
    [slug]
  );


  if (!q.rows.length) {
    return null;
  }

  const ranked = [...q.rows].sort((a, b) => {
    const aPref =
      preferredPlatform && hasPlatformUrl(a, preferredPlatform) ? 1 : 0;

    const bPref =
      preferredPlatform && hasPlatformUrl(b, preferredPlatform) ? 1 : 0;

    if (aPref !== bPref) {
      return bPref - aPref;
    }

    const aCount = countAvailablePlatforms(a);
    const bCount = countAvailablePlatforms(b);

    if (aCount !== bCount) {
      return bCount - aCount;
    }

    return Number(a.id) - Number(b.id);
  });

  return ranked[0] || null;
}

function hasPlatformUrl(companyRow, platform) {
  if (!companyRow) return false;
  if (platform === 'google') return !!String(companyRow.google_review_url || '').trim();
  if (platform === 'clutch') return !!String(companyRow.clutch_review_url || '').trim();
  if (platform === 'trustpilot') return !!String(companyRow.trustpilot_review_url || '').trim();
  if (platform === 'g2') return !!String(companyRow.g2_review_url || '').trim();
  if (platform === 'goodfirms') return !!String(companyRow.goodfirms_review_url || '').trim();
  if (platform === 'yelp') return !!String(companyRow.yelp_review_url || '').trim();
  return false;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const { pool, dbConfig } = getPoolForRequest(req);
    const envInfo = { env: dbConfig._env, source: dbConfig._source, host: dbConfig._host };
    const requestDbEnv = envInfo.env;

    console.log(
      `[request] ${req.method} ${reqUrl.pathname}${reqUrl.search} ` +
      `host=${req.headers.host || '-'} ` +
      `env=${requestDbEnv || '-'} source=${envInfo.source || '-'} matchedHost=${envInfo.host || '-'}`
    );

    // Block requests from domains not matching any configured environment.
    // Only applies when DEFAULT_DB_ENV=automatic — meaning no static fallback
    // is intended and every request must be matched by domain.
    if (envInfo.source === 'fallback' && process.env.DEFAULT_DB_ENV === 'automatic') {
      return json(res, 400, {
        ok: false,
        error: 'Request domain did not match any configured DB environment',
        configuredDomains: {
          local: process.env.LOCAL_DOMAINS || 'localhost,127.0.0.1',
          development: process.env.DEV_DOMAINS || '',
          staging: process.env.STAGING_DOMAINS || '',
          production: process.env.PROD_DOMAINS || '',
        },
      });
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (reqUrl.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'scrape-url-server', time: new Date().toISOString() });
    }

    // ── Job status ────────────────────────────────────────────────────────────
    if (reqUrl.pathname === '/jobs') {
      const jobs = [...activeJobs.values()];
      return json(res, 200, { ok: true, count: jobs.length, jobs });
    }

    if (reqUrl.pathname.startsWith('/jobs/')) {
      const jobId = reqUrl.pathname.slice('/jobs/'.length);
      const job = activeJobs.get(jobId);
      if (!job) return json(res, 404, { ok: false, error: 'Job not found', jobId });
      return json(res, 200, { ok: true, ...job });
    }

    // ── Scrape routes ─────────────────────────────────────────────────────────
    const parts = reqUrl.pathname.split('/').filter(Boolean);
    if (parts[0] === 'scrape') {
      const maxReviews = parsePositiveInt(reqUrl.searchParams.get('maxReviews'), 0);
      const headful = parseBool(reqUrl.searchParams.get('headful'), false);
      const limit = parsePositiveInt(reqUrl.searchParams.get('limit'), 0);
      const fromId = parsePositiveInt(reqUrl.searchParams.get('fromId'), 0);
      const dryRun = parseBool(reqUrl.searchParams.get('dryRun'), false);

      // /scrape/all
      if (parts.length === 2 && parts[1] === 'all') {
        const { jobId, startedAt } = fireAndForget({
          companyId: null,
          platforms: 'google,clutch,trustpilot,g2,goodfirms,yelp',
          maxReviews, headful, limit, fromId, dryRun,
          dbEnv: requestDbEnv,
        });

        console.log(`[${jobId}] 🚀 Started /scrape/all  platforms=all env=${requestDbEnv}`);
        return json(res, 202, {
          ok: true,
          message: 'Scraping started in background. Logs are streaming in the server terminal.',
          route: '/scrape/all',
          jobId,
          startedAt,
          statusUrl: `/jobs/${jobId}`,
        });
      }

      // /scrape/:company/all
      if (parts.length === 3 && parts[2] === 'all') {
        const companySlug = decodeURIComponent(parts[1] || '');
        const company = await findCompanyBySlug(pool, companySlug, null);
        if (!company) {
          return json(res, 404, { ok: false, error: 'Company not found', companySlug });
        }

        if (countAvailablePlatforms(company) === 0) {
          return json(res, 400, {
            ok: false,
            error: 'Matched company has no platform URLs configured',
            company: { id: company.id, name: company.name, slug: company.slug },
          });
        }

        const { jobId, startedAt } = fireAndForget({
          companyId: company.id,
          platforms: 'google,clutch,trustpilot,g2,goodfirms,yelp',
          maxReviews, headful, dryRun,
          dbEnv: requestDbEnv,
        });

        console.log(`[${jobId}] 🚀 Started /scrape/${companySlug}/all  company_id=${company.id} env=${requestDbEnv}`);
        return json(res, 202, {
          ok: true,
          message: 'Scraping started in background. Logs are streaming in the server terminal.',
          route: '/scrape/:company/all',
          company: { id: company.id, name: company.name, slug: company.slug },
          jobId,
          startedAt,
          statusUrl: `/jobs/${jobId}`,
        });
      }

      // /scrape/:company/:platform
      if (parts.length === 3) {
        const companySlug = decodeURIComponent(parts[1] || '');
        const platform = String(parts[2] || '').toLowerCase();
        const allowedPlatforms = ['google', 'clutch', 'trustpilot', 'g2', 'goodfirms', 'yelp'];
        if (!allowedPlatforms.includes(platform)) {
          return json(res, 400, { ok: false, error: 'Invalid platform', allowedPlatforms });
        }

        const company = await findCompanyBySlug(pool, companySlug, platform);
        if (!company) {
          return json(res, 404, { ok: false, error: 'Company not found', companySlug });
        }

        if (!hasPlatformUrl(company, platform)) {
          return json(res, 400, {
            ok: false,
            error: 'Company has no URL for requested platform',
            company: { id: company.id, name: company.name, slug: slugifyText(company.name) },
            platform,
          });
        }

        const { jobId, startedAt } = fireAndForget({
          companyId: company.id,
          platforms: platform,
          maxReviews, headful, dryRun,
          dbEnv: requestDbEnv,
        });

        console.log(`[${jobId}] 🚀 Started /scrape/${companySlug}/${platform}  company_id=${company.id} env=${requestDbEnv}`);
        return json(res, 202, {
          ok: true,
          message: 'Scraping started in background. Logs are streaming in the server terminal.',
          route: '/scrape/:company/:platform',
          company: { id: company.id, name: company.name, slug: company.slug },
          platform,
          jobId,
          startedAt,
          statusUrl: `/jobs/${jobId}`,
        });
      }

      return json(res, 404, {
        ok: false,
        message: 'Routes: /scrape/all | /scrape/:company/all | /scrape/:company/:platform',
      });
    }

    // ── Discovery routes ──────────────────────────────────────────────────────
    if (parts[0] === 'discover') {
      const headful = parseBool(reqUrl.searchParams.get('headful'), false);
      const limit = parsePositiveInt(reqUrl.searchParams.get('limit'), 50);
      const fromId = parsePositiveInt(reqUrl.searchParams.get('fromId'), 0);
      const dryRun = parseBool(reqUrl.searchParams.get('dryRun'), false);

      // /discover/all
      if (parts.length === 2 && parts[1] === 'all') {
        const { jobId, startedAt } = fireAndForgetDiscovery({
          companyId: null,
          platforms: 'google,clutch,trustpilot,goodfirms',
          headful, limit, fromId, dryRun,
          dbEnv: requestDbEnv,
        });

        console.log(`[${jobId}] 🚀 Started /discover/all  platforms=all env=${requestDbEnv}`);
        return json(res, 202, {
          ok: true,
          message: 'Discovery started in background. Logs are streaming in the server terminal.',
          route: '/discover/all',
          jobId,
          startedAt,
          statusUrl: `/jobs/${jobId}`,
        });
      }

      // /discover/:company/all
      if (parts.length === 3 && parts[2] === 'all') {
        const companySlug = decodeURIComponent(parts[1] || '');
        const company = await findCompanyBySlug(pool, companySlug);
        if (!company) {
          return json(res, 404, { ok: false, error: 'Company not found', companySlug });
        }

        const { jobId, startedAt } = fireAndForgetDiscovery({
          companyId: company.id,
          platforms: 'google,clutch,trustpilot,goodfirms',
          headful, dryRun,
          dbEnv: requestDbEnv,
        });

        console.log(`[${jobId}] 🚀 Started /discover/${companySlug}/all  company_id=${company.id} env=${requestDbEnv}`);
        return json(res, 202, {
          ok: true,
          message: 'Discovery started in background. Logs are streaming in the server terminal.',
          route: '/discover/:company/all',
          company: { id: company.id, name: company.name, slug: company.slug },
          jobId,
          startedAt,
          statusUrl: `/jobs/${jobId}`,
        });
      }

      // /discover/:company/:platform
      if (parts.length === 3) {
        const companySlug = decodeURIComponent(parts[1] || '');
        const platform = String(parts[2] || '').toLowerCase();
        const allowedPlatforms = ['google', 'clutch', 'trustpilot', 'goodfirms'];
        if (!allowedPlatforms.includes(platform)) {
          return json(res, 400, { ok: false, error: 'Invalid platform', allowedPlatforms });
        }

        const company = await findCompanyBySlug(pool, companySlug);
        if (!company) {
          return json(res, 404, { ok: false, error: 'Company not found', companySlug });
        }

        const { jobId, startedAt } = fireAndForgetDiscovery({
          companyId: company.id,
          platforms: platform,
          headful, dryRun,
          dbEnv: requestDbEnv,
        });

        console.log(`[${jobId}] 🚀 Started /discover/${companySlug}/${platform}  company_id=${company.id} env=${requestDbEnv}`);
        return json(res, 202, {
          ok: true,
          message: 'Discovery started in background. Logs are streaming in the server terminal.',
          route: '/discover/:company/:platform',
          company: { id: company.id, name: company.name, slug: company.slug },
          platform,
          jobId,
          startedAt,
          statusUrl: `/jobs/${jobId}`,
        });
      }

      return json(res, 404, {
        ok: false,
        message: 'Routes: /discover/all | /discover/:company/all | /discover/:company/:platform',
      });
    }

    return json(res, 404, { ok: false, error: 'Not found' });


  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🚀 Scrape URL server running at http://${HOST}:${PORT}`);
  console.log('   /health                           → server health');
  console.log('   /jobs                             → list active jobs');
  console.log('   /jobs/:jobId                      → job status');
  console.log('');
  console.log('   SCRAPING:');
  console.log('   /scrape/all                       → scrape all companies, all platforms');
  console.log('   /scrape/:company/all              → scrape one company, all platforms');
  console.log('   /scrape/:company/:platform        → scrape one company, one platform');
  console.log('');
  console.log('   DISCOVERY:');
  console.log('   /discover/all                     → discover all companies, all platforms');
  console.log('   /discover/:company/all            → discover one company, all platforms');
  console.log('   /discover/:company/:platform      → discover one company, one platform');
  console.log('\n   All endpoints respond immediately (202) — logs stream here.\n');
});
