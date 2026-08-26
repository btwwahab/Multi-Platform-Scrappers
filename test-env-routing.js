import 'dotenv/config';
import assert from 'node:assert/strict';
import { chooseDbEnvForRequest } from './src/request-db-env.js';

function mockReq(headers = {}) {
  return { headers };
}

function expectEnv(name, req, expectedEnv) {
  const info = chooseDbEnvForRequest(req);
  assert.equal(
    info.env,
    expectedEnv,
    `${name}: expected env=${expectedEnv} but got env=${info.env} (source=${info.source}, host=${info.host})`
  );
  return info;
}

function run() {
  const cases = [
    {
      name: 'dev via host',
      req: mockReq({ host: 'dev.virtualassistants.help' }),
      expected: 'development',
    },
    {
      name: 'staging via host',
      req: mockReq({ host: 'stage.virtualassistants.help' }),
      expected: 'staging',
    },
    {
      name: 'prod via host',
      req: mockReq({ host: 'virtualassistant.market' }),
      expected: 'production',
    },
    {
      name: 'local via host with port',
      req: mockReq({ host: '127.0.0.1:7500' }),
      expected: 'local',
    },
    {
      name: 'x-forwarded-host wins over host',
      req: mockReq({ host: 'virtualassistant.market', 'x-forwarded-host': 'dev.virtualassistants.help' }),
      expected: 'development',
    },
    {
      name: 'origin url',
      req: mockReq({ origin: 'https://stage.virtualassistants.help' }),
      expected: 'staging',
    },
    {
      name: 'referer url',
      req: mockReq({ referer: 'https://dev.virtualassistants.help/some/page' }),
      expected: 'development',
    },
    {
      name: 'unknown domain is unmatched',
      req: mockReq({ host: 'unknown.example.com' }),
      expected: null,
    },
  ];

  const results = [];
  for (const c of cases) {
    const info = expectEnv(c.name, c.req, c.expected);
    results.push({ name: c.name, env: info.env, source: info.source, host: info.host });
  }

  console.log('OK: env routing test passed');
  for (const r of results) {
    console.log(`- ${r.name}: env=${r.env} source=${r.source} host=${r.host || ''}`);
  }
}

try {
  run();
} catch (e) {
  console.error('FAILED: env routing test failed');
  console.error(e?.stack || e?.message || String(e));
  process.exitCode = 1;
}
