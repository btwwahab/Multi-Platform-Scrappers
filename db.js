import 'dotenv/config';
import pg from 'pg';
import { getDbConfig } from './src/request-db-env.js';
const { Pool } = pg;

function normalizeDbEnv(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  if (['local', 'localhost'].includes(v)) return 'local';
  if (['stage', 'staging', 'uat', 'preprod', 'pre-prod', 'preproduction'].includes(v)) return 'staging';
  if (['prod', 'production', 'live'].includes(v)) return 'production';
  if (['dev', 'development'].includes(v)) return 'development';
  return null;
}

function buildPgConfig(prefix = '') {
  const p = prefix ? `${prefix}_` : '';
  return {
    host: process.env[`${p}DB_HOST`] || '127.0.0.1',
    port: Number(process.env[`${p}DB_PORT`] || 5432),
    user: process.env[`${p}DB_USER`] || 'postgres',
    password: process.env[`${p}DB_PASSWORD`] || 'admin123',
    database: process.env[`${p}DB_NAME`] || 'mydb',
  };
}

function hasExplicitConfig(prefix) {
  return Boolean(
    process.env[`${prefix}_DB_HOST`] ||
    process.env[`${prefix}_DB_PORT`] ||
    process.env[`${prefix}_DB_USER`] ||
    process.env[`${prefix}_DB_PASSWORD`] ||
    process.env[`${prefix}_DB_NAME`]
  );
}

const pools = {
  local: new Pool(buildPgConfig('')),
  development: hasExplicitConfig('DEV') ? new Pool(buildPgConfig('DEV')) : null,
  staging: hasExplicitConfig('STAGING') ? new Pool(buildPgConfig('STAGING')) : null,
  production: hasExplicitConfig('PROD') ? new Pool(buildPgConfig('PROD')) : null,
};
const requestPools = new Map();

export function getPoolByEnv(envName = null) {
  const env = normalizeDbEnv(envName) || 'local';

  if (env === 'local') return pools.local;

  if (env === 'development') {
    if (!pools.development) {
      throw new Error(
        'Development DB is not configured. Set DEV_DB_HOST/DEV_DB_PORT/DEV_DB_USER/DEV_DB_PASSWORD/DEV_DB_NAME.'
      );
    }
    return pools.development;
  }

  if (env === 'production') {
    if (!pools.production) {
      throw new Error(
        'Production DB is not configured. Set PROD_DB_HOST/PROD_DB_PORT/PROD_DB_USER/PROD_DB_PASSWORD/PROD_DB_NAME.'
      );
    }
    return pools.production;
  }

  if (env === 'staging') {
    if (!pools.staging) {
      throw new Error(
        'Staging DB is not configured. Set STAGING_DB_HOST/STAGING_DB_PORT/STAGING_DB_USER/STAGING_DB_PASSWORD/STAGING_DB_NAME.'
      );
    }
    return pools.staging;
  }

  return pools.local;
}

export function getDefaultDbEnv() {
  return (
    normalizeDbEnv(process.env.DB_ENV) ||
    normalizeDbEnv(process.env.SCRAPER_DB_ENV) ||
    normalizeDbEnv(process.env.DEFAULT_DB_ENV) ||
    'local'
  );
}

export { pools };

export function getPoolForRequest(req) {
  const dbConfig = getDbConfig(req);
  const { _env, _source, _host, ...pgConfig } = dbConfig;
  const cacheKey = `${_env}:${pgConfig.host}:${pgConfig.port}:${pgConfig.database}:${pgConfig.user}`;

  if (!requestPools.has(cacheKey)) {
    requestPools.set(cacheKey, new Pool(pgConfig));
  }

  return {
    pool: requestPools.get(cacheKey),
    dbConfig: { ...pgConfig, _env, _source, _host },
  };
}

// Backward-compatible default export: existing scripts importing default `pool`
// will route to the environment selected by DB_ENV (or default to development).
export default getPoolByEnv(getDefaultDbEnv());
