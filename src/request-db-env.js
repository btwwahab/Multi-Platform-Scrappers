// ─────────────────────────────────────────────────────────────────────────────
// Domain → Environment Detection (Hardened Version)
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHost(host) {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw) return null;
  const first = raw.split(',')[0].trim();
  return first.replace(/:\d+$/, '') || null;
}

function hostFromMaybeUrl(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  try {
    if (v.includes('://')) return normalizeHost(new URL(v).hostname);
  } catch { /* ignore */ }
  return normalizeHost(v);
}

function parseDomainList(value) {
  return String(value || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .map((d) => d.replace(/^https?:\/\//, ''))
      .map((d) => d.replace(/\/$/, ''))
      .map((d) => d.replace(/:\d+$/, ''));
}

function matchesDomain(host, domain) {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeDbEnv(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'automatic') return null;
  if (['local', 'localhost'].includes(v)) return 'local';
  if (['stage', 'staging', 'uat', 'preprod', 'pre-prod', 'preproduction'].includes(v)) return 'staging';
  if (['prod', 'production', 'live'].includes(v)) return 'production';
  if (['dev', 'development'].includes(v)) return 'development';
  return null;
}

function inferEnvFromHostHeuristics(req) {
  const candidates = [
    req?.headers?.['x-forwarded-host'],
    req?.headers?.host,
    req?.headers?.origin,
    req?.headers?.referer || req?.headers?.referrer,
  ];

  for (const value of candidates) {
    const host = hostFromMaybeUrl(value);
    if (!host) continue;

    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return { env: 'local', source: 'hostname-heuristic', host };
    }

    const labels = host.split('.');
    const first = labels[0] || '';
    if (['dev', 'development'].includes(first)) {
      return { env: 'development', source: 'hostname-heuristic', host };
    }
    if (['stage', 'staging', 'uat', 'preprod', 'pre-production', 'preproduction'].includes(first)) {
      return { env: 'staging', source: 'hostname-heuristic', host };
    }
    if (['prod', 'production', 'live'].includes(first)) {
      return { env: 'production', source: 'hostname-heuristic', host };
    }
  }

  return null;
}

export function detectDbEnvFromRequest(req, { devDomains, prodDomains } = {}) {
  const dev     = Array.isArray(devDomains)  ? devDomains  : parseDomainList(devDomains);
  const prod    = Array.isArray(prodDomains) ? prodDomains : parseDomainList(prodDomains);
  const staging = parseDomainList(process.env.STAGING_DOMAINS || process.env.STAGING_DOMAIN || '');
  const local   = parseDomainList(process.env.LOCAL_DOMAINS  || process.env.LOCAL_DOMAIN   || 'localhost,127.0.0.1');

  const candidates = [];

  const xfHost = req?.headers?.['x-forwarded-host'];
  if (xfHost)   candidates.push({ source: 'x-forwarded-host', host: hostFromMaybeUrl(xfHost) });

  const host = req?.headers?.host;
  if (host)     candidates.push({ source: 'host',    host: hostFromMaybeUrl(host) });

  const origin = req?.headers?.origin;
  if (origin)   candidates.push({ source: 'origin',  host: hostFromMaybeUrl(origin) });

  const referer = req?.headers?.referer || req?.headers?.referrer;
  if (referer)  candidates.push({ source: 'referer', host: hostFromMaybeUrl(referer) });

  for (const c of candidates) {
    if (!c.host) continue;
    if (local.some((d)   => matchesDomain(c.host, d))) return { env: 'local',       ...c };
    if (prod.some((d)    => matchesDomain(c.host, d))) return { env: 'production',  ...c };
    if (staging.some((d) => matchesDomain(c.host, d))) return { env: 'staging',     ...c };
    if (dev.some((d)     => matchesDomain(c.host, d))) return { env: 'development', ...c };
  }

  return { env: null, source: null, host: null };
}

export function chooseDbEnvForRequest(req) {
  const devDomains  = process.env.DEV_DOMAINS  || process.env.DEV_DOMAIN  || '';
  const prodDomains = process.env.PROD_DOMAINS || process.env.PROD_DOMAIN || '';

  const detected = detectDbEnvFromRequest(req, { devDomains, prodDomains });
  if (detected.env) return detected;

  const inferred = inferEnvFromHostHeuristics(req);
  if (inferred?.env) return inferred;

  // 'automatic' means: rely purely on request-based detection above.
  // If nothing matched and DEFAULT_DB_ENV is 'automatic', fall back to 'local'.
  const fallback =
      normalizeDbEnv(process.env.DEFAULT_DB_ENV) ||
      normalizeDbEnv(process.env.DB_ENV) ||
      'local';

  return { env: fallback, source: 'fallback', host: null };
}

/**
 * Returns the DB connection config for the current request.
 * Usage:  const db = getDbConfig(req);
 *         const pool = new Pool(db);
 */
export function getDbConfig(req) {
  const { env, source, host } = chooseDbEnvForRequest(req);

  const configs = {
    local: {
      host:     process.env.DEV_DB_HOST     || process.env.DB_HOST     || '127.0.0.1',
      port:     Number(process.env.DEV_DB_PORT || process.env.DB_PORT  || 5432),
      user:     process.env.DEV_DB_USER     || process.env.DB_USER     || 'postgres',
      password: process.env.DEV_DB_PASSWORD || process.env.DB_PASSWORD || '',
      database: process.env.DEV_DB_NAME     || process.env.DB_NAME     || '',
    },
    development: {
      host:     process.env.DEV_DB_HOST,
      port:     Number(process.env.DEV_DB_PORT     || 5432),
      user:     process.env.DEV_DB_USER,
      password: process.env.DEV_DB_PASSWORD,
      database: process.env.DEV_DB_NAME,
    },
    staging: {
      host:     process.env.STAGING_DB_HOST,
      port:     Number(process.env.STAGING_DB_PORT || 5432),
      user:     process.env.STAGING_DB_USER,
      password: process.env.STAGING_DB_PASSWORD,
      database: process.env.STAGING_DB_NAME,
    },
    production: {
      host:     process.env.PROD_DB_HOST,
      port:     Number(process.env.PROD_DB_PORT    || 5432),
      user:     process.env.PROD_DB_USER,
      password: process.env.PROD_DB_PASSWORD,
      database: process.env.PROD_DB_NAME,
    },
  };

  const config = configs[env] ?? configs.local;

  if (!config.host) {
    throw new Error(`[db-env] No DB_HOST configured for env="${env}" (detected from ${source}/${host})`);
  }

  return { ...config, _env: env, _source: source, _host: host };
}
