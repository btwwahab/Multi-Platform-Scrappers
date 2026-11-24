import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import 'dotenv/config';
import puppeteer from 'puppeteer-core';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 4000;
const REVIEWS_PER_PAGE = 10;
const USE_PROXY = /^(1|true|yes|on)$/i.test(String(process.env.CLUTCH_USE_PROXY || ''));

// ── Residential proxy pool (round-robin) ───────────────────────────────────
function parseProxyPool(raw) {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		const pool = parsed.map((entry) => {
			if (!Array.isArray(entry) || entry.length < 4) return null;
			const [host, port, username, password] = entry;
			return [String(host || '').trim(), String(port || '').trim(), String(username || '').trim(), String(password || '').trim()];
		}).filter((entry) => entry && entry.every(Boolean));
		return pool.length ? pool : null;
	} catch { return null; }
}

const PROXY_POOL = parseProxyPool(process.env.GMAPS_PROXY_POOL || process.env.CLUTCH_PROXY_POOL);
if (USE_PROXY && !PROXY_POOL?.length) {
	throw new Error('CLUTCH_USE_PROXY is enabled but no proxy pool was found. Set CLUTCH_PROXY_POOL (or GMAPS_PROXY_POOL) as JSON [[host,port,user,pass], ...]');
}
let _proxyIdx = PROXY_POOL?.length ? Math.floor(Math.random() * PROXY_POOL.length) : 0;
function nextProxy() {
	if (!USE_PROXY || !PROXY_POOL?.length) return null;
	const entry = PROXY_POOL[_proxyIdx % PROXY_POOL.length];
	_proxyIdx++;
	return { host: entry[0], port: entry[1], username: entry[2], password: entry[3] };
}

// ── Proxy health check ─────────────────────────────────────────────────────────
// Some static proxies expire / lose auth (HTTP 407). Handing one to Chrome only produces a useless
// "This page isn't working" error, so verify a proxy answers before using it and skip dead ones.
const _deadProxies = new Set();

function proxyIsAlive(proxy, timeoutMs = 8000) {
	return new Promise((resolve) => {
		const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
		const req = http.request({
			host: proxy.host,
			port: Number(proxy.port),
			method: 'GET',
			path: 'http://ipv4.webshare.io/',
			headers: { Host: 'ipv4.webshare.io', 'Proxy-Authorization': `Basic ${auth}` },
		}, (res) => {
			res.resume();
			resolve(res.statusCode >= 200 && res.statusCode < 300);
		});
		req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
		req.on('error', () => resolve(false));
		req.end();
	});
}

// Rotating Webshare gateway (PROXY_* vars) — used only if every static proxy in the pool is dead.
function rotatingGatewayProxy() {
	const host = process.env.PROXY_HOST;
	const prefix = process.env.PROXY_USER_PREFIX;
	const password = process.env.PROXY_PASSWORD;
	if (!host || !prefix || !password) return null;
	return { host, port: String(process.env.PROXY_PORT || 80), username: `${prefix}-rotate`, password };
}

async function pickHealthyProxy() {
	if (!USE_PROXY || !PROXY_POOL?.length) return null;
	for (let i = 0; i < PROXY_POOL.length; i++) {
		const p = nextProxy();
		const key = `${p.host}:${p.port}`;
		if (_deadProxies.has(key)) continue;
		if (await proxyIsAlive(p)) return p;
		_deadProxies.add(key);
		console.warn(`[proxy] ${key} is dead (auth/connect failed) — skipping`);
	}
	const gw = rotatingGatewayProxy();
	if (gw && await proxyIsAlive(gw)) {
		console.warn('[proxy] All static proxies are dead — falling back to the rotating gateway');
		return gw;
	}
	throw new Error('No working proxy available (all static proxies failed their health check)');
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function ensureDir(p) {
	await fs.mkdir(p, { recursive: true });
}

// Best-effort debug screenshot. (This helper was referenced by the error handler but never defined, so any
// scraper error crashed the process with "ReferenceError: takeScreenshot is not defined".)
async function takeScreenshot(page, label) {
	try {
		const dir = path.join(os.tmpdir(), 'va-scrapper-screenshots');
		await ensureDir(dir);
		await page.screenshot({ path: path.join(dir, `clutch-${label}-${Date.now()}.png`) });
	} catch { /* never let a screenshot failure mask the real error */ }
}

async function readJson(f) {
	try { return JSON.parse(await fs.readFile(f, 'utf8')); }
	catch { return null; }
}

async function writeAtomic(f, data) {
	if (f === '-') {
		console.log(JSON.stringify(data, null, 2));
		return;
	}
	const tmp = `${f}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
	await fs.rename(tmp, f);
}

function hashStr(s) {
	let h = 2166136261;
	const text = String(s || '');
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0).toString(36);
}

function slugify(s) {
	return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'company';
}

function slugFromUrl(url) {
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean);
		const idx = parts.indexOf('profile');
		if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
		return parts.at(-1) || null;
	} catch { return null; }
}

function normalizeClutchUrl(url) {
	const u = new URL(String(url || '').split('#')[0]);
	u.searchParams.delete('page');
	return u.toString();
}

function parseNum(s) {
	const n = parseFloat(String(s || '').replace(/[^0-9.]+/g, ''));
	return Number.isFinite(n) ? n : null;
}

function parseIntLoose(s) {
	const m = String(s || '').replace(/,/g, '').match(/(\d{1,12})/);
	return m ? Number(m[1]) : null;
}

// ── Facets API URL builder ────────────────────────────────────────────────────
function buildFacetsUrl(slug, nonce, page, sortBy = 'date_desc') {
	const params = new URLSearchParams({
		industry: '',
		location: '',
		project_cost: '',
		sort_by: sortBy,
		verified: 'false',
		path: `/profile/${slug}`,
		nonce,
		page: String(page),
		mask: 'false',
	});
	return `https://clutch.co/profile/${slug}/review/facets?${params.toString()}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const a = {
		url: null,
		maxReviews: 500,
		maxPages: 500,
		out: null,
		outDir: path.join('outputs', 'clutch'),
		resume: true,
		headful: true,
		blockAssets: true,
		sortBy: 'date_desc',
		userDataDir: path.join(
			process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
			'.cache', 'va-scrapper', 'clutch-profile',
		),
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
		else if (f === '--sortBy') a.sortBy = argv[++i];
		else if (f === '--userDataDir') a.userDataDir = argv[++i];
		else if ((f === '--help' || f === '-h')) {
			console.log(
				`Usage: node src/network/scrape-clutch-network.js --url <clutchProfileUrl> [options]\n\n` +
				`  --maxReviews N   Cap reviews (default: 500)\n` +
				`  --all            Scrape all available reviews\n` +
				`  --maxPages N     Safety page cap (default: 500)\n` +
				`  --out <file>     Output file (default: outputs/clutch/<slug>-<hash>.json)\n` +
				`  --outDir <dir>   Output folder (default: outputs/clutch)\n` +
				`  --resume         Continue from existing file (default: on)\n` +
				`  --noResume       Start fresh\n` +
				`  --headful        Show browser window\n` +
				`  --blockAssets    Block images/fonts (default: on)\n` +
				`  --sortBy         Sort order: date_desc|relevance_desc (default: date_desc)\n` +
				`  --userDataDir D  Chrome profile dir`
			);
			process.exit(0);
		} else if (!a.url && /^https?:\/\//i.test(String(f))) {
			a.url = f;
		}
	}

	if (!a.url) throw new Error('--url is required (Clutch profile URL)');
	return a;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser({ headful, blockAssets, userDataDir }) {
	const proxy = await pickHealthyProxy();
	const userAgents = [
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
		'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
	];
	const selectedUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

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
			'--disable-device-emulation',
			'--enable-automation=false',
			'--disable-sync',
			'--metrics-recording-only',
			'--mute-audio',
			'--no-first-run',
			'--no-default-browser-check',
			...(proxy ? [`--proxy-server=${proxy.host}:${proxy.port}`] : []),
		],
		defaultViewport: { width: 1440, height: 900 },
	});

	const page = await browser.newPage();
	if (proxy) {
		await page.authenticate({ username: proxy.username, password: proxy.password });
		console.log(`[proxy] Using ${proxy.host}:${proxy.port} (user: ${proxy.username})`);
	} else {
		console.log('[proxy] Disabled (set CLUTCH_USE_PROXY=1 to enable)');
	}
	page.setDefaultTimeout(NAV_TIMEOUT);
	page.setDefaultNavigationTimeout(NAV_TIMEOUT);

	// ── Anti-detection: Hide automation signals
	await page.evaluateOnNewDocument(() => {
		// Hide webdriver property
		Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
		
		// Hide chrome object
		const originalQuery = window.chrome;
		delete window.chrome;
		window.chrome = { runtime: {} };
		
		// Spoof plugins
		Object.defineProperty(navigator, 'plugins', {
			get: () => [
				{ name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
				{ name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
				{ name: 'Native Client Executable', filename: 'internal-nacl-plugin' },
			],
		});
		
		// Spoof languages
		Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
		Object.defineProperty(navigator, 'language', { get: () => 'en-US' });
		
		// Override permissions
		window.Notification = { permission: 'denied' };
		
		// Prevent headless detection via screen dimensions
		Object.defineProperty(screen, 'height', { get: () => 900 });
		Object.defineProperty(screen, 'width', { get: () => 1440 });
	});

	await page.setUserAgent(selectedUserAgent);

	// ── Request interception for Cloudflare headers
	await page.setRequestInterception(true);
	page.on('request', (req) => {
		const headers = req.headers();
		// Add headers that make requests look more legitimate
		headers['Accept-Language'] = 'en-US,en;q=0.9';
		headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
		headers['Accept-Encoding'] = 'gzip, deflate, br';
		headers['Upgrade-Insecure-Requests'] = '1';
		headers['Sec-Fetch-Dest'] = 'document';
		headers['Sec-Fetch-Mode'] = 'navigate';
		headers['Sec-Fetch-Site'] = 'none';
		headers['Sec-Fetch-User'] = '?1';
		headers['Sec-Ch-Ua'] = '"Not A(Brand";v="99", "Google Chrome";v="126", "Chromium";v="126"';
		headers['Sec-Ch-Ua-Mobile'] = '?0';
		headers['Sec-Ch-Ua-Platform'] = '"Linux"';
		
		const t = req.resourceType();
		if (blockAssets && (t === 'image' || t === 'media' || t === 'font')) {
			return req.abort();
		}
		req.continue({ headers });
	});

	// ── Simulate user activity (mouse movements)
	page.on('framenavigated', async () => {
		try {
			await page.evaluate(() => {
				if (typeof window !== 'undefined') {
					const ev = new MouseEvent('mousemove', {
						bubbles: true,
						cancelable: true,
						clientX: Math.random() * 1440,
						clientY: Math.random() * 900,
					});
					document.dispatchEvent(ev);
				}
			}).catch(() => {});
		} catch { }
	});

	return { browser, page };
}

async function goto(page, url) {
	// Navigate with longer wait for Cloudflare challenge
	try {
		await page.goto(url, { waitUntil: 'networkidle0', timeout: NAV_TIMEOUT });
	} catch (e) {
		// If networkidle0 times out, try domcontentloaded
		if (e?.name === 'TimeoutError') {
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
		} else {
			throw e;
		}
	}
	
	// Wait for Cloudflare challenge to complete (if present)
	// This gives the JS challenge time to execute
	await sleep(3000);
	
	// Check if we're on a Cloudflare challenge page and wait for it to pass
	const isChallengePage = await page.evaluate(() => {
		const text = (document.body?.innerText || '') + (document.title || '');
		return /cloudflare|just a moment|checking your browser|performing security/i.test(text);
	}).catch(() => false);
	
	if (isChallengePage) {
		console.log('[cf] Cloudflare challenge detected, waiting for auto-solve (up to 15s)...');
		// Wait for challenge page to disappear (Cloudflare JS auto-solve)
		const maxWait = 15000;
		const startTime = Date.now();
		while (Date.now() - startTime < maxWait) {
			await sleep(1000);
			const stillOnChallenge = await page.evaluate(() => {
				const text = (document.body?.innerText || '') + (document.title || '');
				return /cloudflare|just a moment|checking your browser|performing security/i.test(text);
			}).catch(() => true);
			
			if (!stillOnChallenge) {
				console.log('[cf] Challenge passed!');
				break;
			}
		}
	}
	
	await sleep(POST_NAV_WAIT_MS);
}

async function dismissCookieBanner(page) {
	try {
		await page.evaluate(() => {
			const want = ['accept', 'accept all', 'i agree', 'agree', 'ok'];
			const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
			const btn = [...document.querySelectorAll('button,[role="button"]')]
				.find((b) => want.some((w) => n(b.textContent).includes(w)));
			if (btn) btn.click();
		});
	} catch { }
}

async function detectBlock(page) {
	try {
		return await page.evaluate(() => {
			const body = document.body?.innerText || '';
			const t = body.toLowerCase();
			const title = (document.title || '').toLowerCase();
			// Chrome's own error page (dead proxy, tunnel failure, 4xx/5xx with empty body ...)
			const chromeError = /this page isn.t working|this site can.t be reached|err_[a-z_]+|proxy server/i.test(`${title}\n${t.slice(0, 600)}`)
				&& body.length < 1500;
			// Real profile pages are long and contain review text that can legitimately include words like
			// "blocked"/"forbidden"; only scan the *start* of short / challenge-like pages.
			const looksLikeRealPage = body.length > 3000 && !!document.querySelector('h1');
			const blocked = chromeError || (!looksLikeRealPage && (
				/captcha|verify you are human|access denied|forbidden|blocked|cloudflare|security check|robot check/i.test(t.slice(0, 1500)) ||
				/attention required|just a moment|cloudflare/i.test(title)));
			return { blocked, chromeError, title: document.title, snippet: body.slice(0, 300) };
		});
	} catch {
		return { blocked: false, title: null, snippet: null };
	}
}

function isVerificationBlock(result) {
	if (!result) return false;
	if (result.blocked) return true;
	const txt = `${result.title || ''}\n${result.snippet || ''}`.toLowerCase();
	return /captcha|verify you are human|access denied|forbidden|blocked|cloudflare|attention required|just a moment|security check|robot check/i.test(txt);
}

// ── Company info from DOM ────────────────────────────────────────────────────
async function extractCompanyInfo(page, profileUrl) {
	return page.evaluate((pUrl) => {
		const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
		const pFloat = (s) => { const m = n(s).replace(/[^0-9.]+/g, '').match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
		const pInt = (s) => { const m = n(s).replace(/,/g, '').match(/(\d{1,12})/); return m ? Number(m[1]) : null; };

		const name = n(document.querySelector('h1')?.textContent) || null;

		const ratingEl = document.querySelector('.sg-rating__number, [class*="overall"] .sg-rating__number, [class*="rating__number"]');
		const overallRating = ratingEl ? pFloat(n(ratingEl.textContent)) : null;

		let totalReviews = null;
		const body = document.body.innerText;
		const sm = body.match(/Showing\s+\d+[-–]\d+\s+of\s+([\d,]+)\s+Reviews?/i);
		if (sm) totalReviews = pInt(sm[1]);
		if (!totalReviews) {
			const m = body.match(/([\d,]+)\s+Reviews?/i);
			if (m) totalReviews = pInt(m[1]);
		}

		const websiteEl = document.querySelector('a[href*="r.clutch.co/redirect"], a.website-link__item');
		const websiteHref = websiteEl?.getAttribute('href') || null;
		let website = null;
		if (websiteHref) {
			try {
				const real = new URL(websiteHref, window.location.origin).searchParams.get('u');
				website = real ? decodeURIComponent(real) : websiteHref;
			} catch { website = websiteHref; }
		}

		const serviceLinesRaw = Array.isArray(window.serviceLines) ? window.serviceLines : [];
		const services = serviceLinesRaw.map((x) => x?.Name).filter(Boolean);
		const location = n(document.querySelector('.province')?.textContent) ||
			n(document.querySelector('[class*="location"]')?.textContent) || null;

		return { name, overallRating, totalReviews, location, website, services, profileUrl: pUrl, scrapedAt: new Date().toISOString() };
	}, profileUrl);
}

// ── Extract page-1 reviews from DOM (SSR rendered) ───────────────────────────
async function extractPage1ReviewsFromDom(page) {
	return page.evaluate(() => {
		const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
		const txt = (el) => el ? norm(el.textContent) : null;
		const num = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.]+/g, '')); return Number.isFinite(n) ? n : null; };

		const cards = document.querySelectorAll('article.profile-review');
		const out = [];

		for (const card of cards) {
			const idAttr = card.getAttribute('id') || '';
			const reviewId =
				(idAttr.match(/^review-(\d+)$/i)?.[1]) ||
				card.getAttribute('data-review-id') ||
				card.querySelector('[data-gtm_review_id]')?.getAttribute('data-gtm_review_id') ||
				null;

			const projectTitle =
				txt(card.querySelector('.profile-review__header h2, .profile-review__header h3')) ||
				txt(card.querySelector('h2, h3')) || null;

			const overallRating = num(txt(card.querySelector('.profile-review__rating .sg-rating__number, .profile-review__content .sg-rating__number')));

			const subRatings = {};
			for (const dl of card.querySelectorAll('.profile-review__rating-metrics dl')) {
				const label = norm(dl.querySelector('dt')?.textContent);
				const val = norm(dl.querySelector('dd')?.textContent);
				if (label && val) { const v = num(val); subRatings[label] = v ?? val; }
			}

			const reviewQuote = txt(card.querySelector('.profile-review__quote p, .profile-review__quote, blockquote')) || null;
			const reviewDate = txt(card.querySelector('.profile-review__date, time')) || null;
			const feedbackSummary = (() => { const el = card.querySelector('.profile-review__feedback'); return el ? [...el.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean).join(' ') || null : null; })();
			const projectSummary = (() => { const el = card.querySelector('.profile-review__summary'); return el ? [...el.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean).join(' ') || null : null; })();

			let projectType = null, projectCost = null, projectDates = null;
			for (const li of card.querySelectorAll('.profile-review__data .data--item')) {
				const tooltip = (li.getAttribute('data-tooltip-content') || '').toLowerCase();
				const liText = norm(li.innerText);
				if (!projectType && tooltip.includes('services')) projectType = liText;
				else if (!projectCost && tooltip.includes('project size')) projectCost = liText;
				else if (!projectDates && tooltip.includes('project length')) projectDates = liText;
			}

			const reviewerPositionRaw = txt(card.querySelector('.reviewer_position')) || null;
			let reviewerTitle = reviewerPositionRaw, reviewerCompany = null;
			if (reviewerPositionRaw && reviewerPositionRaw.includes(',')) {
				const [t, ...rest] = reviewerPositionRaw.split(',');
				reviewerTitle = norm(t); reviewerCompany = norm(rest.join(', '));
			}

			const reviewerName = txt(card.querySelector('.reviewer_card--name')) || null;
			const isVerified = /verified/i.test(norm(card.querySelector('.profile-review__reviewer-verification-badge-title')?.textContent));
			const isFeatured = /featured/i.test(card.className || '');

			let industry = null, location = null, size = null, reviewType = null;
			for (const li of card.querySelectorAll('.reviewer_list .reviewer_list--item')) {
				const tooltip = (li.getAttribute('data-tooltip-content') || '').toLowerCase();
				const value = norm(li.querySelector('.reviewer_list__details-title')?.textContent || li.innerText);
				if (!value) continue;
				if (!industry && tooltip.includes('industry')) industry = value;
				else if (!location && tooltip.includes('location')) location = value;
				else if (!size && (tooltip.includes('client size') || tooltip.includes('company size'))) size = value;
				else if (!reviewType && tooltip.includes('review type')) reviewType = value;
			}

			const shareUrl = card.querySelector('.profile-review__share-button')?.getAttribute('data-url') || null;
			const reviewUrl = shareUrl
				? new URL(shareUrl, location?.href || window.location.href).toString()
				: (reviewId ? `${window.location.href.split('#')[0]}#review-${reviewId}` : null);

			out.push({
				reviewId,
				projectTitle,
				overallRating,
				reviewDate,
				reviewQuote,
				feedbackSummary,
				projectSummary,
				projectType,
				projectCost,
				projectDates,
				subRatings: Object.keys(subRatings).length ? subRatings : null,
				reviewer: { name: reviewerName, position: reviewerPositionRaw, title: reviewerTitle, company: reviewerCompany, industry, location, size, reviewType },
				isFeatured,
				isVerified,
				reviewUrl,
				scrapedAt: new Date().toISOString(),
			});
		}
		return out;
	});
}

// ── Nonce capture via response interception ──────────────────────────────────
async function captureNonceFromPage(page, slug, timeoutMs = 30_000) {
	let nonce = null;

	// First try: extract from __NEXT_DATA__ or inline scripts
	try {
		nonce = await page.evaluate((s) => {
			// Check __NEXT_DATA__
			const nd = document.getElementById('__NEXT_DATA__');
			if (nd) {
				try {
					const data = JSON.parse(nd.textContent);
					const n = JSON.stringify(data).match(/"nonce"\s*:\s*"([^"]{8,30})"/);
					if (n) return n[1];
				} catch { }
			}
			// Check inline scripts for nonce variable
			for (const script of document.querySelectorAll('script:not([src])')) {
				const m = script.textContent.match(/['"](nonce)['"]\s*:\s*['"]([^'"]{8,30})['"]/);
				if (m) return m[2];
				const m2 = script.textContent.match(/nonce\s*=\s*['"]([A-Za-z0-9+/=_-]{8,30})['"]/);
				if (m2) return m2[1];
			}
			// Check meta tags
			const meta = document.querySelector('meta[name="nonce"], meta[property="nonce"]');
			if (meta) return meta.getAttribute('content');
			return null;
		}, slug);
	} catch { }

	if (nonce) return nonce;

	// Second try: scroll down to trigger lazy API call and intercept response
	console.log('  🔍 Scrolling to trigger facets API request...');
	const startWait = Date.now();

	const responsePromise = new Promise((resolve) => {
		const handler = async (response) => {
			const url = response.url();
			if (url.includes(`/profile/${slug}/review/facets`)) {
				page.off('response', handler);
				try {
					const parsed = new URL(url);
					const n = parsed.searchParams.get('nonce');
					if (n) resolve(n);
				} catch { }
			}
		};
		page.on('response', handler);
		setTimeout(() => { page.off('response', handler); resolve(null); }, timeoutMs);
	});

	// Scroll to reviews section to trigger the lazy load
	try {
		await page.evaluate(() => {
			const anchor = document.querySelector('#reviews, [id*="review"]');
			if (anchor) anchor.scrollIntoView({ behavior: 'instant' });
			else window.scrollTo({ top: 800, behavior: 'instant' });
		});
		await sleep(2000);
		await page.evaluate(() => window.scrollTo({ top: 1600, behavior: 'instant' }));
		await sleep(2000);
	} catch { }

	nonce = await responsePromise;
	return nonce;
}

// ── Fetch reviews via facets API (via browser fetch — carries cookies) ───────
async function fetchFacetsPage(page, slug, nonce, pageNum, sortBy) {
	const url = buildFacetsUrl(slug, nonce, pageNum, sortBy);

	return page.evaluate(async (reqUrl) => {
		try {
			const res = await fetch(reqUrl, {
				credentials: 'include',
				headers: { 'accept': '*/*', 'content-type': 'application/json' },
			});
			const text = await res.text();
			return { status: res.status, url: res.url, text };
		} catch (e) {
			return { status: 0, url: reqUrl, text: '', error: String(e?.message || e) };
		}
	}, url);
}

// ── Normalize a review from the facets API response ──────────────────────────


// ── Extract reviews from facets API HTML-in-JSON response ──────────────────
// Clutch’s /review/facets endpoint returns JSON where the
// `Providers` key contains a full HTML string of rendered review cards.
async function extractReviewsFromApiResponse(page, responseText) {
	// 1. Parse JSON and pull the Providers HTML string
	let providersHtml;
	try {
		const data = JSON.parse(responseText);
		providersHtml = data?.Providers || data?.providers || null;
		if (!providersHtml || typeof providersHtml !== 'string') return [];
	} catch {
		return [];
	}

	// 2. Inject HTML into a temp div in the page, extract reviews, then clean up
	return page.evaluate((html) => {
		const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
		const txt = (el) => el ? norm(el.textContent) : null;
		const num = (s) => { const n = parseFloat(String(s || '').replace(/[^0-9.]+/g, '')); return Number.isFinite(n) ? n : null; };

		const wrapper = document.createElement('div');
		wrapper.style.display = 'none';
		wrapper.innerHTML = html;
		document.body.appendChild(wrapper);

		const out = [];
		try {
			const cards = wrapper.querySelectorAll('article.profile-review');
			for (const card of cards) {
				const idAttr = card.getAttribute('id') || '';
				const reviewId =
					(idAttr.match(/^review-(\d+)$/i)?.[1]) ||
					card.getAttribute('data-review-id') ||
					card.querySelector('[data-gtm_review_id]')?.getAttribute('data-gtm_review_id') ||
					null;

				const projectTitle =
					txt(card.querySelector('.profile-review__header h2, .profile-review__header h3')) ||
					txt(card.querySelector('h2, h3')) || null;

				const overallRating = num(txt(card.querySelector(
					'.profile-review__rating .sg-rating__number, .profile-review__content .sg-rating__number'
				)));

				const subRatings = {};
				for (const dl of card.querySelectorAll('.profile-review__rating-metrics dl')) {
					const label = norm(dl.querySelector('dt')?.textContent);
					const val = norm(dl.querySelector('dd')?.textContent);
					if (label && val) { const v = num(val); subRatings[label] = v ?? val; }
				}

				const reviewQuote = txt(card.querySelector('.profile-review__quote p, .profile-review__quote, blockquote')) || null;
				const reviewDate = txt(card.querySelector('.profile-review__date, time')) || null;
				const feedbackSummary = (() => { const el = card.querySelector('.profile-review__feedback'); return el ? [...el.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean).join(' ') || null : null; })();
				const projectSummary = (() => { const el = card.querySelector('.profile-review__summary'); return el ? [...el.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean).join(' ') || null : null; })();

				let projectType = null, projectCost = null, projectDates = null;
				for (const li of card.querySelectorAll('.profile-review__data .data--item')) {
					const tooltip = (li.getAttribute('data-tooltip-content') || '').toLowerCase();
					const liText = norm(li.innerText);
					if (!projectType && tooltip.includes('services')) projectType = liText;
					else if (!projectCost && tooltip.includes('project size')) projectCost = liText;
					else if (!projectDates && tooltip.includes('project length')) projectDates = liText;
				}

				const reviewerPositionRaw = txt(card.querySelector('.reviewer_position')) || null;
				let reviewerTitle = reviewerPositionRaw, reviewerCompany = null;
				if (reviewerPositionRaw && reviewerPositionRaw.includes(',')) {
					const [t, ...rest] = reviewerPositionRaw.split(',');
					reviewerTitle = norm(t); reviewerCompany = norm(rest.join(', '));
				}

				const reviewerName = txt(card.querySelector('.reviewer_card--name')) || null;
				const isVerified = /verified/i.test(norm(card.querySelector('.profile-review__reviewer-verification-badge-title')?.textContent));
				const isFeatured = /featured/i.test(card.className || '');

				let industry = null, revLocation = null, size = null, reviewType = null;
				for (const li of card.querySelectorAll('.reviewer_list .reviewer_list--item')) {
					const tooltip = (li.getAttribute('data-tooltip-content') || '').toLowerCase();
					const value = norm(li.querySelector('.reviewer_list__details-title')?.textContent || li.innerText);
					if (!value) continue;
					if (!industry && tooltip.includes('industry')) industry = value;
					else if (!revLocation && tooltip.includes('location')) revLocation = value;
					else if (!size && (tooltip.includes('client size') || tooltip.includes('company size'))) size = value;
					else if (!reviewType && tooltip.includes('review type')) reviewType = value;
				}

				const shareUrl = card.querySelector('.profile-review__share-button')?.getAttribute('data-url') || null;
				const reviewUrl = shareUrl
					? new URL(shareUrl, window.location.href).toString()
					: (reviewId ? `${window.location.href.split('#')[0]}#review-${reviewId}` : null);

				out.push({
					reviewId,
					projectTitle,
					overallRating,
					reviewDate,
					reviewQuote,
					feedbackSummary,
					projectSummary,
					projectType,
					projectCost,
					projectDates,
					subRatings: Object.keys(subRatings).length ? subRatings : null,
					reviewer: { name: reviewerName, position: reviewerPositionRaw, title: reviewerTitle, company: reviewerCompany, industry, location: revLocation, size, reviewType },
					isFeatured,
					isVerified,
					reviewUrl,
					scrapedAt: new Date().toISOString(),
				});
			}
		} finally {
			wrapper.remove();
		}
		return out;
	}, providersHtml);
}

function parseTotalFromPayload(text) {
	try {
		const data = JSON.parse(text);
		const v = data?.total ?? data?.totalReviews ?? data?.total_reviews ??
			data?.count ?? data?.meta?.total ?? data?.pagination?.total ??
			data?.data?.total ?? null;
		return v != null ? Number(v) : null;
	} catch { return null; }
}

function parsePageCountFromPayload(text) {
	try {
		const data = JSON.parse(text);
		const v = data?.pages ?? data?.total_pages ?? data?.pageCount ??
			data?.pagination?.pages ?? data?.meta?.pages ?? null;
		return v != null ? Number(v) : null;
	} catch { return null; }
}

function reviewKey(r) {
	if (r?.reviewId) return `id:${r.reviewId}`;
	return `fb:${norm(r?.reviewer?.name)}|${norm(r?.reviewDate)}|${norm(r?.reviewQuote).slice(0, 80)}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	const args = parseArgs(process.argv);
	const baseUrl = normalizeClutchUrl(args.url);
	const slug = slugFromUrl(baseUrl) || 'company';
	const fileId = hashStr(baseUrl);

	const outPath = args.out === '-'
		? '-'
		: args.out
			? args.out
			: path.join(args.outDir, `${slugify(slug)}-${fileId}.json`);

	if (outPath !== '-') {
		await ensureDir(path.dirname(path.resolve(outPath)));
		if (!args.resume) await fs.rm(outPath, { force: true }).catch(() => { });
	}

	const prev = args.resume && outPath !== '-' ? await readJson(outPath) : null;
	const reviews = Array.isArray(prev?.reviews) ? [...prev.reviews] : [];
	const seen = new Set(reviews.map((r) => reviewKey(r)).filter(Boolean));
	const prevCompany = prev?.company || null;
	const prevProgress = prev?.progress || null;
	const target = args.maxReviews === 0 ? Infinity : args.maxReviews;

	console.log(`\n🚀 Scraper  : scrape-clutch-network.js  [network-based]`);
	console.log(`📁 Output   : ${outPath}`);
	console.log(`📝 Resumed  : ${reviews.length} reviews`);
	console.log(`🌐 URL      : ${baseUrl}`);

	let company = prevCompany;
	let lastError = null;
	const maxProxyAttempts = 4;

	for (let proxyAttempt = 1; proxyAttempt <= maxProxyAttempts; proxyAttempt++) {
		let browser;
		let page;
		const attemptUserDataDir = proxyAttempt === 1
			? args.userDataDir
			: path.join(os.tmpdir(), `clutch-profile-${slugify(slug)}-${Date.now()}-${proxyAttempt}`);
		let nonce = prevProgress?.nonce || null;
		let startPage = Number(prevProgress?.nextPage || 1) || 1;
		let totalReviews = prevCompany?.totalReviews || null;
		let totalPages = prevProgress?.totalPages || null;
		let stopReason = null;
		let progress = prevProgress || null;
		company = prevCompany;

		try {
			({ browser, page } = await launchBrowser({ ...args, userDataDir: attemptUserDataDir }));
		// ── Step 1: Navigate to profile page ─────────────────────────────────────
		const firstPageUrl = `${baseUrl}#reviews`;
		console.log(`\n🌐 Loading profile page...`);
		await goto(page, firstPageUrl);
		await dismissCookieBanner(page);

		const block = await detectBlock(page);
		if (isVerificationBlock(block)) {
			const err = new Error(`Blocked on page load: ${block.title} — ${block.snippet}`);
			err.retryWithNextProxy = true;
			err.chromeError = !!block.chromeError;
			throw err;
		}

		// A wrong/removed profile URL is not fixable by switching IP — fail fast instead of retrying 4×.
		const notFound = await page.evaluate(() => {
			const title = document.title || '';
			const h1 = (document.querySelector('h1')?.textContent || '').trim();
			return /^404\b|page not found|not found/i.test(title) || /^404$/.test(h1) || /^page not found/i.test(h1);
		}).catch(() => false);
		if (notFound) {
			const e = new Error(`Clutch profile not found (404): ${baseUrl}`);
			e.noRetry = true;
			throw e;
		}

		// ── Step 2: Extract company info ──────────────────────────────────────────
		if (!company) {
			company = await extractCompanyInfo(page, baseUrl);
			console.log(`🏢 Company  : ${company?.name || '(unknown)'}  ⭐ ${company?.overallRating ?? '?'}  (${company?.totalReviews ?? '?'} reviews)`);
		}
		if (company?.totalReviews) totalReviews = company.totalReviews;

		const effectiveTarget = args.maxReviews === 0
			? (totalReviews ?? Infinity)
			: args.maxReviews;

		if (totalReviews && !totalPages) {
			totalPages = Math.ceil(totalReviews / 10);
		}

		// ── Step 3: Capture nonce ─────────────────────────────────────────────────
		if (!nonce) {
			console.log(`\n🔑 Capturing nonce...`);
			nonce = await captureNonceFromPage(page, slug);
			if (!nonce) throw new Error('Could not capture nonce from Clutch page. The page may have changed or is blocking the request.');
			console.log(`✅ Nonce    : ${nonce}`);
		} else {
			console.log(`♻️  Reusing nonce: ${nonce}`);
		}

		// ── Step 4: Extract page 1 from DOM (Clutch SSR — no API for page 1) ──────
		if (startPage === 1 && reviews.length === 0) {
			console.log(`\n📄 Page 1 — extracting from DOM (SSR)...`);

			// Scroll to trigger render
			await page.evaluate(() => { window.scrollTo({ top: 800, behavior: 'instant' }); });
			await sleep(1500);
			await page.evaluate(() => { window.scrollTo({ top: 1800, behavior: 'instant' }); });
			await sleep(1500);

			const domReviews = await extractPage1ReviewsFromDom(page);
			console.log(`  Found ${domReviews.length} review cards in DOM`);

			let added = 0;
			for (const r of domReviews) {
				if (reviews.length >= effectiveTarget) break;
				const key = reviewKey(r);
				if (seen.has(key)) continue;
				seen.add(key);
				reviews.push(r);
				added++;
			}
			console.log(`  ✅ Added ${added} (total ${reviews.length})`);

			if (reviews.length >= effectiveTarget) {
				startPage = 999; // skip API loop
			} else {
				startPage = 1; // API starts from page 1 too — dedup handles overlaps
			}

			progress = { nonce, nextPage: startPage, totalPages, updatedAt: now() };
			await writeAtomic(outPath, {
				sourceUrl: baseUrl, company, reviews,
				reviewsCount: reviews.length,
				target: args.maxReviews === 0 ? (totalReviews ?? null) : args.maxReviews,
				done: false, reason: null, updatedAt: now(), progress,
			});
		}

		// ── Step 5: API pagination loop (page 1 onwards with pre-delay) ───────────
		if (startPage === 1) {
			console.log(`  ⏳ Waiting before API calls...`);
			await sleep(3000 + Math.floor(Math.random() * 2000));
		}

		for (let pageNum = startPage; pageNum <= args.maxPages && reviews.length < effectiveTarget; pageNum++) {
			console.log(`\n📄 Page ${pageNum} — fetching via API...`);

			let response = await fetchFacetsPage(page, slug, nonce, pageNum, args.sortBy);

			// Retry on 503 / 429
			if (response.status === 503 || response.status === 429) {
				console.warn(`  ⚠️  API returned ${response.status} — rate limited, retrying after delay...`);
				await sleep(8000 + Math.floor(Math.random() * 4000));
				response = await fetchFacetsPage(page, slug, nonce, pageNum, args.sortBy);
				if (response.status !== 200 || !response.text) {
					stopReason = `api_error_${response.status}_after_retry`;
					console.warn(`  ❌ Retry also failed with ${response.status} — stopping`);
					break;
				}
			}

			if (response.status === 401 || response.status === 403) {
				stopReason = 'nonce_expired_or_blocked';
				console.warn(`  ⚠️  API returned ${response.status} — nonce may have expired`);
				break;
			}

			if (response.status !== 200 || !response.text) {
				stopReason = `api_error_${response.status}`;
				console.warn(`  ⚠️  API returned status ${response.status}`);
				break;
			}

			// Parse totals from first API response
			if (pageNum === startPage) {
				const tp = parsePageCountFromPayload(response.text);
				const tot = parseTotalFromPayload(response.text);
				if (tp) { totalPages = tp; console.log(`  📊 Total pages : ${tp}`); }
				if (tot && !totalReviews) { totalReviews = tot; console.log(`  📊 Total reviews: ${tot}`); }
			}

			const rawReviews = await extractReviewsFromApiResponse(page, response.text);

			if (!rawReviews.length) {
				console.log(`  ℹ️  No reviews on page ${pageNum} — stopping`);
				console.log(`  🔎 Raw response snippet: ${String(response.text || '').slice(0, 400)}`);
				stopReason = 'empty_page';
				break;
			}

			let added = 0;
			for (const review of rawReviews) {
				if (reviews.length >= effectiveTarget) break;
				if (!review) continue;
				const key = reviewKey(review);
				if (seen.has(key)) continue;
				seen.add(key);
				reviews.push(review);
				added++;
			}

			console.log(`  ✅ Added ${added} (total ${reviews.length})`);

			progress = { nonce, nextPage: pageNum + 1, totalPages, updatedAt: now() };

			await writeAtomic(outPath, {
				sourceUrl: baseUrl,
				company,
				reviews,
				reviewsCount: reviews.length,
				target: args.maxReviews === 0 ? (totalReviews ?? null) : args.maxReviews,
				done: false,
				reason: null,
				updatedAt: now(),
				progress,
			});

			if (reviews.length >= effectiveTarget) break;

			// Polite delay between API calls
			await sleep(1200 + Math.floor(Math.random() * 800));
		}

		const done = args.maxReviews === 0
			? (totalReviews ? reviews.length >= totalReviews : false)
			: reviews.length >= args.maxReviews;

		await writeAtomic(outPath, {
			sourceUrl: baseUrl,
			company,
			reviews,
			reviewsCount: reviews.length,
			target: args.maxReviews === 0 ? (totalReviews ?? null) : args.maxReviews,
			done,
			reason: done ? null : (stopReason || 'no_more_pages'),
			updatedAt: now(),
			progress,
		});

		console.log(`\n🏁 Finished : ${reviews.length} reviews  done=${done}`);
		return;

		} catch (err) {
			const message = String(err?.message || err || '');
			// Anything that can be cured by switching IP: Cloudflare challenge, dead/slow proxy, Chrome error page,
			// missing nonce (page didn't render properly through that IP), navigation/socket failures.
			const proxyProblem = /no working proxy|net::|ERR_|proxy|tunnel|ECONN|ETIMEDOUT|socket|isn.t working|can.t be reached|detached frame|target closed|session closed|protocol error/i.test(message);
			const retryable = !err?.noRetry && (err?.retryWithNextProxy || proxyProblem || /blocked on page load|just a moment|cloudflare|performing security verification|security verification|challenge|verify|check|nonce|timeout|timed out|navigation/i.test(message));

			if (retryable && proxyAttempt < maxProxyAttempts) {
				console.warn(`\n[proxy] ${message}; retrying with next IP (${proxyAttempt}/${maxProxyAttempts})...`);
				lastError = err;
				// Cloudflare needs a long cool-down for the IP; a dead proxy / error page doesn't.
				const delay = proxyProblem || err?.chromeError ? 2000 : 15000 + Math.floor(Math.random() * 10000);
				console.log(`[proxy] Waiting ${delay}ms before retry...`);
				await sleep(delay);
				continue;
			}

			if (retryable) {
				console.warn(`\n[proxy] Verification persisted after ${proxyAttempt}/${maxProxyAttempts} attempts.`);
			}

			console.error(`\n💥 Error: ${message}`);
			if (page) await takeScreenshot(page, 'error');
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
			if (browser) await browser.close();
		}
	}

	if (lastError && !process.exitCode) {
		process.exitCode = 1;
	}
}

await main();
