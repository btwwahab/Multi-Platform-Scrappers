import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import puppeteer from 'puppeteer-core';
import { getNextProxy, getBrowserProxyArgs, applyProxyToPage, logCurrentProxy } from '../utils/proxyManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 2500;

// ── Tiny helpers ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

function hashStr(value) {
	let hash = 2166136261;
	const text = String(value || '');
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(36);
}

function slugify(value) {
	return norm(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 60) || 'company';
}

function companySlugFromUrl(url) {
	try {
		const parsed = new URL(url);
		const parts = parsed.pathname.split('/').filter(Boolean);
		const idx = parts.indexOf('review');
		if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
		return parts.at(-1) || null;
	} catch {
		return null;
	}
}

function normalizeTrustpilotUrl(url) {
	const parsed = new URL(String(url || ''));
	if (!parsed.pathname.includes('/review/')) {
		const parts = parsed.pathname.split('/').filter(Boolean);
		const last = parts.at(-1);
		parsed.pathname = `/review/${last}`;
	}
	return parsed.toString();
}

function parseIntLoose(value) {
	const text = norm(value).replace(/,/g, '');
	const match = text.match(/(\d{1,12})/);
	return match ? Number(match[1]) : null;
}

function parseFloatLoose(value) {
	const text = norm(value).replace(',', '.');
	const match = text.match(/(\d+(?:\.\d+)?)/);
	return match ? Number(match[1]) : null;
}

function firstText(...values) {
	for (const value of values) {
		if (value == null) continue;
		const text = norm(value);
		if (text) return text;
	}
	return null;
}

function firstObject(...values) {
	for (const value of values) {
		if (value && typeof value === 'object' && !Array.isArray(value)) return value;
	}
	return null;
}

function reviewKey(review) {
	if (review?.reviewId) return `id:${review.reviewId}`;
	return `fb:${norm(review?.reviewer?.name)}|${norm(review?.dateTime || review?.date)}|${norm(review?.text).slice(0, 120)}`;
}

function isPlainObject(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detectBlockText(text) {
	const body = norm(text).slice(0, 4000).toLowerCase();
	return {
		blocked: /captcha|verify|robot|access denied|forbidden|blocked|challenge|temporarily unavailable|unusual/i.test(body),
		snippet: norm(text).slice(0, 300),
	};
}

function buildReviewPageUrl(baseUrl, pageNumber) {
	const parsed = new URL(baseUrl);
	if (pageNumber > 1) parsed.searchParams.set('page', String(pageNumber));
	else parsed.searchParams.delete('page');
	return parsed.toString();
}

function parseTotalPagesFromTitle(title) {
	const match = String(title || '').match(/\|\s*(\d+)\s+of\s+(\d+)\s*$/i);
	return match ? Number(match[2]) : null;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const a = {
		url: null,
		maxReviews: 500000,
		maxPages: 2000000,
		out: null,
		outDir: path.join('outputs', 'trustpilot'),
		resume: true,
		headful: true,
		blockAssets: true,
		captchaWaitMs: 600_000,
		userDataDir: path.join(
			process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
			'.cache',
			'va-scrapper',
			'trustpilot-profile',
		),
	};

	for (let i = 2; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === '--url') a.url = argv[++i];
		else if (flag === '--maxReviews') a.maxReviews = Number(argv[++i]);
		else if (flag === '--all') a.maxReviews = 0;
		else if (flag === '--maxPages') a.maxPages = Number(argv[++i]);
		else if (flag === '--out') a.out = argv[++i];
		else if (flag === '--outDir') a.outDir = argv[++i];
		else if (flag === '--resume') a.resume = true;
		else if (flag === '--noResume') a.resume = false;
		else if (flag === '--headful') a.headful = true;
		else if (flag === '--blockAssets') a.blockAssets = true;
		else if (flag === '--noBlockAssets') a.blockAssets = false;
		else if (flag === '--captchaWaitMs') a.captchaWaitMs = Number(argv[++i]);
		else if (flag === '--userDataDir') a.userDataDir = argv[++i];
		else if (flag === '--help' || flag === '-h') {
			console.log(
				`Usage: node src/network/scrape-trustpilot-network.js --url <companyReviewUrl> [options]\n\n` +
				`  --maxReviews N     Cap reviews (default: 500)\n` +
				`  --all              Scrape all available reviews\n` +
				`  --maxPages N       Safety cap on pages (default: 2000)\n` +
				`  --out <file>       Output file path (default: outputs/trustpilot/<slug>-<hash>.json)\n` +
				`  --outDir <dir>     Output folder (default: outputs/trustpilot)\n` +
				`  --resume           Continue from existing file (default: on)\n` +
				`  --noResume         Start fresh\n` +
				`  --headful          Show browser window\n` +
				`  --blockAssets      Block images/fonts (default: on)\n` +
				`  --noBlockAssets    Allow all assets\n` +
				`  --captchaWaitMs N  Wait for manual solve in headful mode (default: 600000)\n` +
				`  --userDataDir D    Chrome profile dir (default: ~/.cache/va-scrapper/trustpilot-profile)`
			);
			process.exit(0);
		} else if (!a.url && /^https?:\/\//i.test(String(flag))) {
			a.url = flag;
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
		defaultViewport: { width: 1280, height: 900 },
	});

	const page = await browser.newPage();
	page.setDefaultTimeout(NAV_TIMEOUT);
	page.setDefaultNavigationTimeout(NAV_TIMEOUT);

	await applyProxyToPage(page, proxy);

	const version = (await browser.version()).split('/')[1] || '126.0.0.0';
	await page.setUserAgent(
		`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ` +
		`(KHTML, like Gecko) Chrome/${version} Safari/537.36`,
	);

	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
	});

	if (blockAssets) {
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			const type = request.resourceType();
			if (type === 'image' || type === 'media' || type === 'font') return request.abort();
			request.continue();
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
		const clicked = await page.evaluate(() => {
			const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
			const byId = document.querySelector('#onetrust-accept-btn-handler');
			if (byId) {
				try {
					byId.click();
					return true;
				} catch {
					// ignore
				}
			}

			for (const button of document.querySelectorAll('button,[role="button"]')) {
				const text = n(button.textContent);
				const aria = n(button.getAttribute('aria-label'));
				if (text === 'accept' || text.includes('accept all') || text.includes('agree') || aria.includes('accept')) {
					try {
						button.click();
						return true;
					} catch {
						// ignore
					}
				}
			}
			return false;
		});

		if (clicked) await sleep(1200);
	} catch {
		// ignore
	}
}

async function detectBlockState(page) {
	try {
		return await page.evaluate(() => {
			const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').trim();
			const title = String(document.title || '').replace(/\s+/g, ' ').trim();
			const combined = `${title} ${text}`.toLowerCase();
			const blocked = /captcha|verify|robot|access denied|forbidden|blocked|challenge|unusual|temporarily unavailable/i.test(combined);
			return {
				blocked,
				title,
				snippet: text.slice(0, 300),
			};
		});
	} catch {
		return { blocked: false, title: null, snippet: null };
	}
}

// ── Payload helpers ───────────────────────────────────────────────────────────
function parseJsonPayload(text) {
	const raw = String(text || '').trim();
	if (!raw) return null;
	try {
		return JSON.parse(raw);
	} catch {
		const stripped = raw.replace(/^\)\]\}'\s*/, '');
		try {
			return JSON.parse(stripped);
		} catch {
			return null;
		}
	}
}

function collectObjects(root, predicate) {
	const out = [];
	const stack = [root];
	const seen = new WeakSet();

	while (stack.length) {
		const current = stack.pop();
		if (Array.isArray(current)) {
			for (const value of current) {
				if (value && typeof value === 'object') stack.push(value);
			}
			continue;
		}

		if (!isPlainObject(current) || seen.has(current)) continue;
		seen.add(current);

		if (predicate(current)) out.push(current);
		for (const value of Object.values(current)) {
			if (value && typeof value === 'object') stack.push(value);
		}
	}

	return out;
}

function looksLikeReviewObject(obj) {
	if (!isPlainObject(obj)) return false;
	const keys = Object.keys(obj).map((key) => key.toLowerCase());
	let score = 0;

	if (keys.some((key) => ['rating', 'stars', 'score', 'ratingvalue'].includes(key))) score += 1;
	if (keys.some((key) => ['text', 'content', 'message', 'comment', 'reviewtext', 'body'].includes(key))) score += 1;
	if (keys.some((key) => ['date', 'datetime', 'createdat', 'publisheddate', 'created', 'submittedat'].includes(key))) score += 1;
	if (keys.some((key) => ['id', 'reviewid', '_id', 'uuid'].includes(key))) score += 1;
	if (keys.some((key) => ['consumer', 'reviewer', 'author', 'customer', 'user'].includes(key))) score += 1;
	if (keys.some((key) => ['reply', 'response', 'businessreply', 'ownerresponse'].includes(key))) score += 1;

	return score >= 2;
}

function normalizeReviewer(source, fallback = {}) {
	const reviewer = firstObject(source?.consumer, source?.reviewer, source?.author, source?.customer, source?.user, fallback.reviewer);
	const reviewerId = firstText(
		reviewer?.id,
		reviewer?.consumerId,
		reviewer?.userId,
		source?.consumerId,
		source?.reviewerId,
	);
	const trustpilotProfileUrl = reviewerId ? `https://www.trustpilot.com/users/${reviewerId}` : null;
	const country = firstText(
		reviewer?.country,
		reviewer?.countryCode,
		reviewer?.location,
		reviewer?.address?.country,
		reviewer?.address?.countryCode,
		source?.consumerCountry,
		source?.consumerCountryCode,
		fallback.country,
	);

	return {
		name: firstText(
			reviewer?.name,
			reviewer?.displayName,
			reviewer?.fullName,
			reviewer?.username,
			reviewer?.nickname,
			source?.consumerName,
			source?.reviewerName,
			source?.authorName,
			source?.customerName,
			fallback.name,
		),
		profileUrl: firstText(
			reviewer?.profileUrl,
			reviewer?.url,
			reviewer?.href,
			reviewer?.link,
			reviewer?.profile,
			trustpilotProfileUrl,
			source?.consumerProfileUrl,
			source?.reviewerProfileUrl,
			fallback.profileUrl,
		),
		country,
		reviewsCount: parseIntLoose(
			reviewer?.reviewsCount ?? reviewer?.reviewCount ?? reviewer?.totalReviews ?? reviewer?.numberOfReviews ?? source?.consumerReviewsCount ?? fallback.reviewsCount,
		),
	};
}

function normalizeReply(source) {
	const reply = firstObject(source?.businessReply, source?.companyReply, source?.response, source?.ownerResponse, source?.reply, source?.reviewReply);
	if (!reply) return null;

	const text = firstText(reply.text, reply.content, reply.message, reply.body, reply.replyText);
	if (!text) return null;

	return {
		from: firstText(reply.from, reply.name, reply.author, reply.respondedBy, reply.respondedByName),
		date: firstText(reply.date, reply.createdAt, reply.publishedAt, reply.dateTime),
		dateTime: firstText(reply.dateTime, reply.createdAt, reply.publishedAt, reply.date),
		text,
	};
}

function normalizeReviewObject(source, context = {}) {
	const reviewId = firstText(
		source?.reviewId,
		source?.id,
		source?._id,
		source?.uuid,
		source?.publicId,
		source?.reviewUuid,
	);

	const reviewer = normalizeReviewer(source, context);
	const rating = parseFloatLoose(
		source?.rating ?? source?.stars ?? source?.score ?? source?.ratingValue ?? source?.reviewRating,
	);
	const title = firstText(source?.title, source?.headline, source?.subject, source?.summary);
	const text = firstText(source?.text, source?.content, source?.message, source?.comment, source?.reviewText, source?.body);
	const dateTime = firstText(
		source?.dateTime,
		source?.dates?.publishedDate,
		source?.dates?.createdDateTime,
		source?.createdAt,
		source?.publishedDate,
		source?.submittedAt,
		source?.date,
		source?.created,
	);
	const date = dateTime ? dateTime.slice(0, 10) : firstText(source?.dateOnly);
	const reviewUrl = firstText(
		source?.reviewUrl,
		source?.url,
		source?.href,
		reviewId ? `https://www.trustpilot.com/reviews/${reviewId}` : null,
	);

	const usefulCount = parseIntLoose(
		source?.usefulCount ?? source?.helpfulVotes ?? source?.likes ?? source?.votes ?? source?.voteCount,
	);

	const badges = (() => {
		const values = [source?.badges, source?.tags, source?.labels, source?.categoryTags];
		for (const value of values) {
			if (Array.isArray(value)) {
				const out = value.map((item) => norm(item)).filter(Boolean);
				if (out.length) return out;
			}
			if (typeof value === 'string' && norm(value)) return [norm(value)];
		}
		return null;
	})();

	return {
		reviewId: reviewId || null,
		reviewUrl: reviewUrl || null,
		rating: Number.isFinite(rating) ? rating : null,
		title: title || null,
		text: text || null,
		date: date || null,
		dateTime: dateTime || null,
		badges,
		usefulCount: Number.isFinite(usefulCount) ? usefulCount : null,
		reviewer: {
			name: reviewer.name || null,
			profileUrl: reviewer.profileUrl || null,
			country: reviewer.country || null,
			reviewsCount: Number.isFinite(reviewer.reviewsCount) ? reviewer.reviewsCount : null,
		},
		companyReply: normalizeReply(source),
		scrapedAt: now(),
	};
}

function findBestCompanyCandidate(root) {
	const candidates = collectObjects(root, (obj) => {
		const keys = Object.keys(obj).map((key) => key.toLowerCase());
		return keys.includes('name') && (
			keys.includes('trustscore') ||
			keys.includes('reviewcount') ||
			keys.includes('totalreviews') ||
			keys.includes('aggregaterating') ||
			keys.includes('ratingvalue') ||
			keys.includes('businessunit')
		);
	});

	return candidates[0] || null;
}

function extractCompanyInfo(payload, pageUrl, reviewSlug) {
	const businessUnit = firstObject(
		payload?.pageProps?.businessUnit,
		payload?.pageProps?.businessunit,
		payload?.props?.pageProps?.businessUnit,
		payload?.props?.pageProps?.businessunit,
		payload?.businessUnit,
		payload?.businessunit,
	);

	const candidate = businessUnit || findBestCompanyCandidate(payload) || {};
	const aggregateRating = firstObject(candidate.aggregateRating, candidate.rating, payload?.pageProps?.aggregateRating);

	const trustScore = parseFloatLoose(
		candidate.trustScore ?? candidate.trustscore ?? aggregateRating?.ratingValue ?? candidate.ratingValue ?? candidate.score,
	);
	const totalReviews = parseIntLoose(
		candidate.totalReviews ?? candidate.reviewCount ?? candidate.reviewsCount ?? aggregateRating?.reviewCount ?? candidate.numberOfReviews,
	);

	const categories = (() => {
		const values = [candidate.categories, candidate.category, candidate.tags];
		for (const value of values) {
			if (Array.isArray(value)) {
				const out = value.map((item) => norm(item)).filter(Boolean);
				if (out.length) return out;
			}
			if (typeof value === 'string' && norm(value)) return [norm(value)];
		}
		return null;
	})();

	const address = firstObject(candidate.address, candidate.location);

	return {
		name: firstText(candidate.name, candidate.displayName, candidate.businessName, reviewSlug) || reviewSlug || null,
		trustScore: Number.isFinite(trustScore) ? trustScore : null,
		totalReviews: Number.isFinite(totalReviews) ? totalReviews : null,
		ratingDistribution: null,
		categories,
		description: firstText(candidate.description, candidate.about, candidate.summary, candidate.tagline),
		country: firstText(candidate.country, candidate.address?.addressCountry, address?.country, address?.addressCountry),
		website: firstText(candidate.website, candidate.url, candidate.homepage, candidate.domain),
		pageUrl,
		scrapedAt: now(),
		businessUnit: reviewSlug,
	};
}

function extractReviewRecords(payload, context = {}) {
	const candidates = collectObjects(payload, looksLikeReviewObject);
	const reviews = [];
	const seen = new Set();

	for (const candidate of candidates) {
		const review = normalizeReviewObject(candidate, context);
		const key = reviewKey(review);
		if (seen.has(key)) continue;
		seen.add(key);

		if (!review.reviewId) {
			review.reviewId = hashStr(`${context.slug || ''}|${review.reviewer?.name || ''}|${review.dateTime || review.date || ''}|${review.text || ''}`);
		}

		reviews.push(review);
	}

	return reviews;
}

async function fetchDataJson(page, dataUrl) {
	return page.evaluate(async (urlStr) => {
		try {
			const response = await fetch(urlStr, { credentials: 'include' });
			const text = await response.text();
			return {
				status: response.status,
				url: response.url,
				text,
			};
		} catch (error) {
			return {
				status: 0,
				url: urlStr,
				text: '',
				error: String(error?.message || error),
			};
		}
	}, dataUrl);
}

async function waitForRealTrustpilotPage(page, timeoutMs = 120_000) {
	await page.waitForFunction(() => {
		const title = String(document.title || '').toLowerCase();
		const body = String(document.body?.innerText || '').toLowerCase();
		const isCloudflare = title.includes('verifying connection') || body.includes('verifying connection');
		const isLoaded = document.querySelector('article[data-service-review-card-paper="true"]') || document.querySelector('#__NEXT_DATA__') || document.querySelector('[data-business-unit-profile-wrapper]');
		return !isCloudflare && isLoaded;
	}, { timeout: timeoutMs });
}

async function captureBusinessUnitId(page, timeoutMs = 90_000) {
	const startedAt = Date.now();

	const fromText = (text) => {
		const source = String(text || '');
		const requestMatch = source.match(/\/api\/businessunitprofile\/businessunit\/([^/]+)\/service-reviews\/topics/);
		if (requestMatch) return requestMatch[1];
		const idMatch = source.match(/businessUnitId[^0-9a-f]{0,20}([0-9a-f]{12,32})/i);
		if (idMatch) return idMatch[1];
		const keyedMatch = source.match(/"businessUnitId"\s*:\s*"?([0-9a-f]{12,32})"?/i);
		if (keyedMatch) return keyedMatch[1];
		return null;
	};

	const onRequest = (request) => {
		const match = request.url().match(/\/api\/businessunitprofile\/businessunit\/([^/]+)\/service-reviews\/topics/);
		if (match) {
			page.off('request', onRequest);
		}
	};

	page.on('request', onRequest);
	try {
		while (Date.now() - startedAt < timeoutMs) {
			const direct = await page.evaluate(() => {
				const entries = performance.getEntriesByType('resource').map((entry) => entry.name || '');
				const html = document.documentElement?.outerHTML || '';
				return `${entries.join('\n')}\n${html}`;
			}).catch(() => '');

			const id = fromText(direct);
			if (id) return id;

			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		throw new Error('timed out waiting for Trustpilot businessUnitId');
	} finally {
		page.off('request', onRequest);
	}
}

async function extractCompanyInfoFromDom(page) {
	return page.evaluate(() => {
		const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
		const pInt = (s) => {
			const m = n(s).replace(/,/g, '').match(/(\d{1,12})/);
			return m ? Number(m[1]) : null;
		};
		const pFloat = (s) => {
			const m = n(s).replace(',', '.').match(/(\d+(?:\.\d+)?)/);
			return m ? Number(m[1]) : null;
		};

		const h1 = n(document.querySelector('h1')?.textContent) || null;
		const name = h1 ? h1.replace(/\bReviews\b.*$/i, '').trim() || h1 : null;
		const trustScoreBtn = document.querySelector('button[aria-label*="Trustscore" i]');
		const trustScore = (() => {
			const span = trustScoreBtn?.previousElementSibling;
			const ui = span ? pFloat(span.textContent) : null;
			if (ui != null && ui > 0 && ui <= 5) return ui;
			const root = document.querySelector('[data-reviews-overview-paper="true"]')?.closest('div') || document.body;
			for (const el of root.querySelectorAll('span')) {
				const num = pFloat(el.textContent);
				if (num != null && num > 0 && num <= 5 && String(el.textContent || '').length <= 4) return num;
			}
			return null;
		})();

		const totalReviews = (() => {
			const el = document.querySelector('[data-reviews-count-typography]');
			if (el) return pInt(el.textContent);
			const body = n(document.body?.innerText);
			const m = body.match(/Reviews\s+([\d,]+)/i);
			return m ? pInt(m[1]) : null;
		})();

		const categories = [...document.querySelectorAll('[data-business-unit-info-category-typography] a')]
			.map((a) => n(a.textContent))
			.filter(Boolean);

		const website = document.querySelector('[data-business-unit-about-section="true"] a[href*="utm_source=trustpilot"], [data-business-unit-about-section="true"] a[target="_blank"]')?.getAttribute('href') || null;

		return {
			name,
			trustScore,
			totalReviews,
			ratingDistribution: null,
			categories: categories.length ? categories : null,
			description: null,
			country: null,
			website,
			pageUrl: location.href,
			scrapedAt: new Date().toISOString(),
		};
	});
}

async function collectReviewIds(page) {
	return page.evaluate(() => {
		const ids = [];
		for (const article of document.querySelectorAll('article[data-service-review-card-paper="true"]')) {
			const link = article.querySelector('a[href*="/reviews/"]');
			if (!link) continue;
			const href = link.getAttribute('href') || '';
			const id = href.split('/').filter(Boolean).at(-1) || null;
			if (id) ids.push(id);
		}
		return ids;
	});
}

async function fetchServiceReviews(page, businessUnitId, reviewIds) {
	const url = `https://www.trustpilot.com/api/businessunitprofile/service-reviews?businessUnitId=${encodeURIComponent(businessUnitId)}&${reviewIds.map((id) => `reviewIds=${encodeURIComponent(id)}`).join('&')}`;
	return page.evaluate(async (requestUrl) => {
		const res = await fetch(requestUrl, { credentials: 'include' });
		const text = await res.text();
		return { status: res.status, url: res.url, text };
	}, url);
}

function normalizeServiceReviewsPayload(payloadText) {
	const data = parseJsonPayload(payloadText);
	if (Array.isArray(data)) return data;
	if (Array.isArray(data?.reviews)) return data.reviews;
	if (Array.isArray(data?.data)) return data.data;
	return [];
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
	const args = parseArgs(process.argv);

	const baseUrl = normalizeTrustpilotUrl(args.url);
	const reviewSlug = companySlugFromUrl(baseUrl) || 'company';
	const fileId = hashStr(baseUrl.split('?')[0]);

	const outPath = args.out === '-'
		? '-'
		: args.out
			? args.out
			: path.join(args.outDir, `${slugify(reviewSlug)}-${fileId}.json`);

	if (outPath !== '-') {
		await ensureDir(path.dirname(path.resolve(outPath)));
		if (!args.resume) {
			await fs.rm(outPath, { force: true }).catch(() => {});
		}
	}

	const maxProxyAttempts = 2;

	const prev = args.resume && outPath !== '-' ? await readJson(outPath) : null;
	const reviews = Array.isArray(prev?.reviews) ? [...prev.reviews] : [];
	const seen = new Set(reviews.map((review) => reviewKey(review)).filter(Boolean));
	const prevCompany = prev?.company || null;
	const prevProgress = prev?.progress || null;
	const target = args.maxReviews === 0 ? Infinity : args.maxReviews;

	console.log(`\n🚀 Scraper  : scrape-trustpilot-network.js  [network-based]`);
	console.log(`📁 Output : ${outPath}`);
	console.log(`📝 Resumed: ${reviews.length} reviews`);

	let company = prevCompany;
	let businessUnitId = typeof prevProgress?.businessUnitId === 'string' ? prevProgress.businessUnitId : null;
	let pageNumber = Number(prevProgress?.pageNumber || 1) || 1;
	let stopReason = null;
	let stopExtra = null;
	let progress = prevProgress || null;
	const targetReviewCount = args.maxReviews === 0 ? Infinity : args.maxReviews;
	let lastError = null;

	for (let attempt = 1; attempt <= maxProxyAttempts; attempt++) {
		let browser;
		let page;

		try {
			({ browser, page } = await launchBrowser(args));
			pageNumber = Number(progress?.pageNumber || prevProgress?.pageNumber || 1) || 1;

			for (pageNumber = pageNumber; pageNumber <= args.maxPages && reviews.length < targetReviewCount; pageNumber++) {
			const reviewPageUrl = buildReviewPageUrl(baseUrl, pageNumber);
			console.log(`🌐 Page ${pageNumber}: ${reviewPageUrl}`);

			await goto(page, reviewPageUrl);
			await clickConsent(page);

			try {
				await waitForRealTrustpilotPage(page, 120_000);
			} catch (error) {
				throw new Error(`failed to load real Trustpilot page: ${error?.message || error}`);
			}

			if (!businessUnitId) {
				businessUnitId = await captureBusinessUnitId(page);
				if (!businessUnitId) throw new Error('could not capture Trustpilot businessUnitId from network requests');
			}

			company = company || await extractCompanyInfoFromDom(page);
		console.log(`🏷️  Company: ${company?.name || '(unknown)'}`);

			const ids = await collectReviewIds(page);
			if (!ids.length) {
				stopReason = 'empty_page_no_reviews';
				break;
			}

			let batchIndex = 0;
			for (let i = 0; i < ids.length && reviews.length < targetReviewCount; i += 25) {
				const batch = ids.slice(i, i + 25);
				batchIndex++;
				const response = await fetchServiceReviews(page, businessUnitId, batch);
				if (response.status !== 200) {
					const block = detectBlockText(response.text || '');
					stopReason = block.blocked ? 'blocked_or_captcha' : 'api_error';
					stopExtra = { status: response.status, url: response.url, snippet: block.snippet };
					break;
				}

				const apiReviews = normalizeServiceReviewsPayload(response.text);
				if (!apiReviews.length) continue;

				const normalizedReviews = apiReviews.map((review) => normalizeReviewObject(review, { slug: reviewSlug }));
				let added = 0;
				for (const review of normalizedReviews) {
					if (reviews.length >= targetReviewCount) break;
					const key = reviewKey(review);
					if (seen.has(key)) continue;
					seen.add(key);
					reviews.push(review);
					added++;
				}
				console.log(`✅ Page ${pageNumber} batch ${batchIndex}: added ${added} (total ${reviews.length})`);
			}

			const title = await page.title();
			let totalPages = parseTotalPagesFromTitle(title);
			if (!totalPages && company?.totalReviews) {
				totalPages = Math.ceil(company.totalReviews / 20);
			}
			totalPages = totalPages || 1;

			progress = {
				businessUnitId,
				pageNumber,
				totalPages,
				updatedAt: now(),
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

			if (reviews.length >= targetReviewCount || stopReason) break;
			if (totalPages && pageNumber >= totalPages) break;
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
				reason: done ? null : (stopReason || 'no_more_pages_or_blocked'),
				updatedAt: now(),
				extra: done ? null : stopExtra,
				progress,
			});

			console.log(`\n🏁 Finished: ${reviews.length}  done=${done}`);
			// An earlier attempt (blocked IP, page-load timeout ...) may have set exitCode=1 before this attempt
			// succeeded. The run is good now — don't let the orchestrator discard the reviews as "failed".
			process.exitCode = 0;
			return;

		} catch (error) {
			lastError = error;
			const message = String(error?.message || error || '');
			const retryable = /blocked|captcha|challenge|verifying|access denied|forbidden|unusual|temporarily unavailable|cloudflare|robot|waiting failed|failed to load|timeout|timed out|exceeded|net::|ERR_|detached frame|target closed|protocol error/i.test(message);

			if (retryable && attempt < maxProxyAttempts) {
				console.warn(`\n[proxy] ${message}; retrying with next IP (${attempt}/${maxProxyAttempts})...`);
				const delay = 15000 + Math.floor(Math.random() * 10000);
				console.log(`[proxy] Waiting ${delay}ms before retry...`);
				await sleep(delay);
				continue;
			}

			console.error(`\n💥 Error: ${message}`);
			if (args.headful) {
				const block = await detectBlockState(page).catch(() => ({ blocked: false }));
				if (block?.blocked) {
					console.error(`⚠️  Browser block detected: ${block.snippet || block.title || 'blocked'}`);
				}
			}
			await writeAtomic(outPath, {
				sourceUrl: args.url,
				company,
				reviews,
				reviewsCount: reviews.length,
				target: args.maxReviews === 0 ? (company?.totalReviews ?? null) : args.maxReviews,
				done: false,
				reason: 'error',
				updatedAt: now(),
				extra: { error: message },
				progress,
			}).catch(() => {});
			process.exitCode = 1;
		} finally {
			await browser?.close();
		}
	}

	if (lastError && !process.exitCode) {
		process.exitCode = 1;
}
}

await main();
