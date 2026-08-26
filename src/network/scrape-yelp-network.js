import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import 'dotenv/config';
import puppeteer from 'puppeteer-core';
import { getNextProxy, getBrowserProxyArgs, applyProxyToPage, logCurrentProxy } from '../utils/proxyManager.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const POST_NAV_WAIT_MS = 4000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function ensureDir(dirPath) {
	await fs.mkdir(dirPath, { recursive: true });
}
async function readJson(filePath) {
	try { return JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return null; }
}
async function writeAtomic(filePath, data) {
	if (filePath === '-') { console.log(JSON.stringify(data, null, 2)); return; }
	const tmp = `${filePath}.${Date.now()}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
	await fs.rename(tmp, filePath);
}
function hashStr(s) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
	return (h >>> 0).toString(36);
}
function slugify(s) {
	return norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'company';
}
function companySlugFromUrl(url) {
	try {
		const parts = new URL(url).pathname.split('/').filter(Boolean);
		const i = parts.indexOf('biz');
		if (i >= 0 && parts[i + 1]) return parts[i + 1];
		return parts.at(-1) || null;
	} catch { return null; }
}
function normalizeYelpUrl(input) {
	const u = new URL(String(input || ''));
	if (!/(^|\.)yelp\.com$/i.test(u.hostname)) throw new Error('URL must be a yelp.com business page');
	if (!u.pathname.includes('/biz/')) throw new Error('URL must include /biz/');
	u.search = '';
	u.hash = '';
	return u.toString();
}
function reviewKey(r) {
	if (r?.reviewId) return `id:${r.reviewId}`;
	return `fb:${norm(r?.reviewer?.name)}|${norm(r?.date)}|${norm(r?.text).slice(0, 80)}`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
	const a = {
		url: null,
		maxReviews: 50000,
		maxPages: 200000,
		out: null,
		outDir: path.join('outputs', 'yelp'),
		resume: true,
		headful: true,
		blockAssets: true,
		userDataDir: path.join(
			process.env.HOME || process.env.USERPROFILE || os.tmpdir(),
			'.cache', 'va-scrapper', 'yelp-profile',
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
		else if (f === '--headless') a.headful = false;
		else if (f === '--blockAssets') a.blockAssets = true;
		else if (f === '--noBlockAssets') a.blockAssets = false;
		else if (f === '--userDataDir') a.userDataDir = argv[++i];
		else if (!a.url && /^https?:\/\//i.test(f)) a.url = f;
	}
	if (!a.url) throw new Error('--url is required. Example: node src/network/scrape-yelp-network.js --url https://www.yelp.com/biz/example');
	return a;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser({ headful, userDataDir, proxy }) {
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
		defaultViewport: { width: 1440, height: 900 },
	});

	const page = await browser.newPage();
	await applyProxyToPage(page, proxy);
	page.setDefaultTimeout(NAV_TIMEOUT);
	page.setDefaultNavigationTimeout(NAV_TIMEOUT);

	const ver = (await browser.version()).split('/')[1] || '126.0.0.0';
	await page.setUserAgent(
		`Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ver} Safari/537.36`,
	);
	await page.evaluateOnNewDocument(() => {
		Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
	});

	return { browser, page };
}

async function goto(page, url) {
	await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
	await sleep(POST_NAV_WAIT_MS);
}

async function dismissCookieBanner(page) {
	try {
		await page.evaluate(() => {
			const want = ['accept all', 'accept', 'i agree', 'agree', 'allow all', 'got it', 'ok'];
			const n = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
			const btn = [...document.querySelectorAll('button,[role="button"]')]
				.find((b) => want.some((w) => n(b.textContent).includes(w)));
			if (btn) btn.click();
		});
		await sleep(800);
	} catch { /* ignore */ }
}

async function detectBlock(page) {
	return page.evaluate(() => {
		const text = String(document.body?.innerText || '').toLowerCase();
		const title = String(document.title || '').toLowerCase();
		const blocked = /captcha|verify you.?re a human|unusual traffic|security check|access denied|temporarily blocked|press and hold|datadome/i.test(`${title} ${text}`);
		return { blocked, snippet: text.slice(0, 200), title };
	});
}

// ── Company info ──────────────────────────────────────────────────────────────
async function extractCompanyInfo(page, profileUrl) {
	return page.evaluate((pUrl) => {
		const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
		const pFloat = (s) => { const m = n(s).match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : null; };
		const pInt = (s) => { const m = n(s).replace(/,/g, '').match(/(\d{1,12})/); return m ? Number(m[1]) : null; };

		let name = n(document.querySelector('h1')?.textContent) || null;
		let overallRating = null, totalReviews = null;

		for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
			try {
				const obj = JSON.parse(el.textContent || 'null');
				const objs = Array.isArray(obj) ? obj : [obj];
				for (const o of objs) {
					if (!o || typeof o !== 'object') continue;
					if (!name && o.name) name = n(o.name);
					const agg = o.aggregateRating;
					if (agg && typeof agg === 'object') {
						if (overallRating == null) overallRating = pFloat(agg.ratingValue);
						if (totalReviews == null) totalReviews = pInt(agg.reviewCount);
					}
				}
			} catch { /* ignore */ }
		}
		if (!overallRating) {
			const ratingEl = [...document.querySelectorAll('[role="img"][aria-label*="star" i]')].find((el) => !el.closest('li'));
			if (ratingEl) overallRating = pFloat(ratingEl.getAttribute('aria-label'));
		}
		if (!totalReviews) {
			const m = n(document.body?.innerText).match(/(\d[\d,]*)\s+reviews?/i);
			if (m) totalReviews = pInt(m[1]);
		}
		return { name, overallRating, totalReviews, profileUrl: pUrl, scrapedAt: new Date().toISOString() };
	}, profileUrl);
}

// ── Capture the real GQL request Yelp fires on page load ─────────────────────
// Returns a promise that resolves with {query, variables, extensions} when captured.
// The CALLER must set up request interception — this function just returns the resolve fn.
function makeGqlCaptureHandler(resolve, reject) {
	return (req) => {
		if (!req.url().includes('/gql/batch') || req.method() !== 'POST') return;
		const raw = req.postData() || '';
		try {
			const arr = JSON.parse(raw);
			const gql = (Array.isArray(arr) ? arr : [arr]).find(
				(op) => op?.operationName === 'GetBusinessReviewFeed',
			);
			if (!gql) return;
			resolve({
				query: gql.query,
				variables: gql.variables,
				extensions: gql.extensions || null,
			});
		} catch { /* not our request */ }
	};
}

// ── Parse reviews from a GQL batch response text ──────────────────────────────
function parseGqlResponse(text, profileUrl) {
	try {
		const arr = JSON.parse(text);
		const data = arr?.[0]?.data?.business?.reviews
			?? arr?.[0]?.data?.reviews
			?? arr?.[0]?.data?.reviewFeed
			?? arr?.[0]?.data;

		if (!data) {
			// Try to find reviews in any nested path
			const str = JSON.stringify(arr?.[0] || {});
			const hasReviews = str.includes('"reviews"');
			return { reviews: [], hasNextPage: false, endCursor: null, totalCount: null, raw: text.slice(0, 300), hasReviews };
		}

		// Handle different response shapes
		const reviewList = Array.isArray(data?.edges)
			? data.edges.map((e) => e?.node).filter(Boolean)
			: Array.isArray(data?.reviews?.edges)
				? data.reviews.edges.map((e) => e?.node).filter(Boolean)
				: Array.isArray(data)
					? data
					: [];

		const pageInfo = data?.pageInfo ?? data?.reviews?.pageInfo ?? {};
		const hasNextPage = pageInfo?.hasNextPage ?? false;
		const endCursor = pageInfo?.endCursor ?? null;
		const totalCount = data?.totalCount ?? data?.reviews?.totalCount ?? null;

		const reviews = reviewList.map((node) => {
			if (!node) return null;
			const text = norm(
				node.text?.full ?? node.text?.displayText ?? node.comment?.text?.full ?? node.body ?? ''
			);
			if (!text) return null;

			// dateRaw can be a string OR a Yelp DateTime object
			const rawDate = node.createdAt ?? node.publishedAt ?? node.date ?? null;
			let dateStr = null;
			if (typeof rawDate === 'string') {
				dateStr = rawDate;
			} else if (rawDate && typeof rawDate === 'object') {
				// Yelp returns {__typename:"DateTime", localDateTimeForBusiness:"2018-10-12T...", ...}
				dateStr = rawDate.localDateTimeForBusiness
					?? rawDate.utcDateTime
					?? rawDate.iso8601
					?? null;
			}
			const date = dateStr ? String(dateStr).slice(0, 10) : null;
			const dateRaw = dateStr ?? rawDate ?? null;

			// Yelp user fields — try multiple known paths
			const userObj = node.user ?? node.author ?? node.reviewer ?? null;
			const reviewerName = norm(
				userObj?.displayName
					?? userObj?.markupDisplayName
					?? userObj?.firstName
					?? userObj?.name
					?? ''
			) || null;
			let avatarUrl = userObj?.profilePhotoUrl ?? userObj?.profilePhoto ?? userObj?.photo?.src ?? null;
			if (avatarUrl && typeof avatarUrl === 'object') {
				avatarUrl = avatarUrl.photoUrl?.userSrc ?? avatarUrl.photoUrl?.mediaItemSrcUrl ?? avatarUrl.src ?? null;
			}
			const isDefaultAvatar = avatarUrl && /default_user_avatar|defaultSrc/i.test(avatarUrl);
			const reviewerLocation = norm(
				userObj?.displayLocation ?? userObj?.location ?? userObj?.city ?? ''
			) || null;
			let reviewerProfileUrl = userObj?.userUrl ?? userObj?.link ?? userObj?.url ?? null;
			if (!reviewerProfileUrl && userObj?.encid) reviewerProfileUrl = `/user_details?userid=${userObj.encid}`;
			else if (!reviewerProfileUrl && userObj?.id) reviewerProfileUrl = `/user_details?userid=${userObj.id}`;
			if (reviewerProfileUrl && reviewerProfileUrl.startsWith('/')) {
				reviewerProfileUrl = `https://www.yelp.com${reviewerProfileUrl}`;
			}

			const rating = typeof node.rating === 'number' ? node.rating
				: typeof node.stars === 'number' ? node.stars : null;

			const rxRaw = node.reactions?.availableReactions ?? node.availableReactionsContainer?.availableReactions ?? [];
			const rxHelpful = rxRaw.find((r) => r.reactionType === 'HELPFUL')?.count ?? node.reactions?.helpfulCount ?? null;
			const rxThanks = rxRaw.find((r) => r.reactionType === 'THANKS')?.count ?? node.reactions?.thanksCount ?? null;
			const rxLoveThis = rxRaw.find((r) => r.reactionType === 'LOVE_THIS')?.count ?? node.reactions?.loveThisCount ?? null;
			const rxOhNo = rxRaw.find((r) => r.reactionType === 'OH_NO')?.count ?? node.reactions?.ohNoCount ?? null;

			const idBase = [reviewerName || '', dateStr || '', text.slice(0, 120)].join('|');
			let h = 0;
			for (let i = 0; i < idBase.length; i++) h = ((h << 5) - h) + idBase.charCodeAt(i);
			const reviewId = node.id ? `yelp-${node.id}` : `yelp-gql-${Math.abs(h)}`;

			if (!parseGqlResponse._debuggedNode) {
				parseGqlResponse._debuggedNode = true;
				const nodeSample = JSON.stringify({
					author: node.author,
					reactions: node.availableReactionsContainer,
				}).slice(0, 1000);
				console.log(`  🔬 Author sample: ${nodeSample}`);
			}

			return {
				reviewId,
				reviewUrl: profileUrl,
				text,
				date,
				dateRaw,
				rating,
				reviewer: {
					name: reviewerName,
					profileUrl: reviewerProfileUrl,
					avatarUrl: isDefaultAvatar ? null : avatarUrl,
					location: reviewerLocation,
				},
				reactions: {
					helpful: rxHelpful,
					thanks: rxThanks,
					loveThis: rxLoveThis,
					ohNo: rxOhNo,
				},
				scrapedAt: now(),
			};
		}).filter(Boolean);

		return { reviews, hasNextPage, endCursor, totalCount };
	} catch (err) {
		return { reviews: [], hasNextPage: false, endCursor: null, totalCount: null, error: err.message };
	}
}

// ── Replay a GQL request with an updated cursor ───────────────────────────────
async function fetchNextPage(page, gqlSession, cursor, bizUrl) {
	return page.evaluate(async (session, nextCursor, refUrl) => {
		const payload = JSON.stringify([{
			operationName: session.operationName || 'GetBusinessReviewFeed',
			variables: { ...session.variables, after: nextCursor },
			query: session.query,
			...(session.extensions ? { extensions: session.extensions } : {}),
		}]);

		try {
			const res = await fetch('https://www.yelp.com/gql/batch', {
				method: 'POST',
				credentials: 'include',
				headers: {
					'content-type': 'application/json',
					'x-apollo-operation-name': 'GetBusinessReviewFeed',
					'accept': '*/*',
					'origin': 'https://www.yelp.com',
					'referer': refUrl,
				},
				body: payload,
			});
			const text = await res.text();
			return { status: res.status, text };
		} catch (err) {
			return { status: 0, text: '', error: String(err?.message || err) };
		}
	}, { ...gqlSession, operationName: 'GetBusinessReviewFeed' }, cursor, bizUrl);
}

// ── Wait for Yelp page to fully load ─────────────────────────────────────────
async function waitForYelpPage(page, timeoutMs = 25_000) {
	try {
		await page.waitForFunction(() =>
			document.querySelector('h1') || document.querySelector('[class*="businessName"]') || document.querySelector('[data-testid="biz-photo"]'),
			{ timeout: timeoutMs });
	} catch { /* may still be usable */ }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
	const args = parseArgs(process.argv);
	const baseUrl = normalizeYelpUrl(args.url);
	const bizAlias = companySlugFromUrl(baseUrl) || 'company';
	const fileId = hashStr(baseUrl);

	const outPath = args.out === '-'
		? '-'
		: args.out
			? args.out
			: path.join(args.outDir, `${slugify(bizAlias)}-${fileId}.json`);

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

	const proxy = getNextProxy();

	console.log(`\n🚀 Scraper  : scrape-yelp-network.js  [network-based]`);
	console.log(`📁 Output   : ${outPath}`);
	console.log(`📝 Resumed  : ${reviews.length} reviews`);
	console.log(`🌐 URL      : ${baseUrl}`);
	await logCurrentProxy(proxy);

	const { browser, page } = await launchBrowser({ ...args, proxy });

	let company = prevCompany;
	let gqlSession = prevProgress?.gqlSession || null; // saved query + variables
	let cursor = prevProgress?.cursor || null;
	let pageNum = Number(prevProgress?.nextPage || 1) || 1;
	let totalReviews = prevCompany?.totalReviews || null;
	let stopReason = null;
	let progress = prevProgress || null;

	try {
		// ── Step 1: Navigate ──────────────────────────────────────────────────────
		console.log(`\n🌐 Loading Yelp page...`);

		// Enable request interception FIRST with a SINGLE unified handler.
		// This handler both: (1) captures the GQL payload, (2) continues all requests.
		let gqlCaptureResolve = null;
		const gqlSessionPromise = gqlSession
			? Promise.resolve(null)
			: new Promise((resolve) => { gqlCaptureResolve = resolve; });

		await page.setRequestInterception(true);
		const captureHandler = makeGqlCaptureHandler(
			gqlCaptureResolve || (() => {}),
			() => {},
		);
		page.on('request', (req) => {
			captureHandler(req);
			req.continue().catch(() => {});
		});

		// Start the deadline timer for capture
		const captureDeadline = gqlCaptureResolve
			? setTimeout(() => gqlCaptureResolve(null), 35_000)
			: null;

		await goto(page, baseUrl);
		await dismissCookieBanner(page);
		await waitForYelpPage(page);

		const block = await detectBlock(page);
		if (block?.blocked) throw new Error(`Blocked by Yelp/DataDome: ${block.snippet}`);

		// ── Step 2: Company info ──────────────────────────────────────────────────
		if (!company) {
			company = await extractCompanyInfo(page, baseUrl);
			console.log(`🏢 Company  : ${company?.name || '(unknown)'}  ⭐ ${company?.overallRating ?? '?'}  (${company?.totalReviews ?? '?'} reviews)`);
		}
		if (company?.totalReviews) totalReviews = company.totalReviews;

		const effectiveTarget = args.maxReviews === 0 ? (totalReviews ?? Infinity) : args.maxReviews;

		// ── Step 3: Capture the GQL session fired by the page ────────────────────
		if (!gqlSession) {
			console.log(`\n🔑 Waiting for Yelp GQL request to be captured...`);

			// Scroll to trigger review section loading
			await page.evaluate(() => window.scrollTo({ top: 1500, behavior: 'instant' }));
			await sleep(2000);

			const captured = await gqlSessionPromise;
			if (!captured) {
				console.warn(`  ⚠️  Could not capture GQL session — page may not have fired GetBusinessReviewFeed`);
				console.warn(`  ℹ️  Company may have 0 reviews or Yelp layout changed`);
				stopReason = 'no_gql_session';
			} else {
			gqlSession = captured;
				clearTimeout(captureDeadline);
				console.log(`  ✅ GQL session captured`);
				console.log(`  📋 Variables: ${gqlSession.variables ? JSON.stringify(gqlSession.variables).slice(0, 150) : 'unknown'}`);

				// The page-load GQL response is also the first page of reviews
				// Let's fetch it explicitly so we can parse reviews from it
				console.log(`\n📄 Page 1 — replaying captured GQL request...`);
				const firstPage = await fetchNextPage(page, gqlSession, null, baseUrl);

				if (firstPage.status !== 200) {
					console.warn(`  ⚠️  Page 1 API status: ${firstPage.status}`);
					console.log(`  🔎 Response: ${String(firstPage.text || '').slice(0, 300)}`);
					stopReason = `api_error_${firstPage.status}`;
				} else {
					const parsed = parseGqlResponse(firstPage.text, baseUrl);
					console.log(`  Found ${parsed.reviews.length} reviews`);

					let added = 0;
					for (const r of parsed.reviews) {
						if (reviews.length >= effectiveTarget) break;
						const key = reviewKey(r);
						if (seen.has(key)) continue;
						seen.add(key); reviews.push(r); added++;
					}
					console.log(`  ✅ Added ${added} (total ${reviews.length})`);

					cursor = parsed.endCursor;
					pageNum = 2;

					if (!parsed.hasNextPage || !cursor) {
						console.log(`  ℹ️  No more pages after page 1`);
						stopReason = 'no_more_pages';
					}

					progress = { gqlSession, cursor, nextPage: pageNum, updatedAt: now() };
					await writeAtomic(outPath, {
						sourceUrl: baseUrl, company, reviews, reviewsCount: reviews.length,
						target: args.maxReviews === 0 ? (totalReviews ?? null) : args.maxReviews,
						done: false, reason: null, updatedAt: now(), progress,
					});
				}
			}
		}

		// ── Step 4: Paginate via GQL API ──────────────────────────────────────────
		if (gqlSession && !stopReason) {
			while (pageNum <= args.maxPages && reviews.length < effectiveTarget) {
				console.log(`\n📄 Page ${pageNum} — fetching via GQL API...`);

				const response = await fetchNextPage(page, gqlSession, cursor, baseUrl);

				if (response.status !== 200 || !response.text) {
					stopReason = `api_error_${response.status}`;
					console.warn(`  ⚠️  API returned status ${response.status}`);
					console.log(`  🔎 Response: ${String(response.text || '').slice(0, 300)}`);
					break;
				}

				const parsed = parseGqlResponse(response.text, baseUrl);

				if (parsed.error) console.warn(`  ⚠️  Parse error: ${parsed.error}`);

				if (!parsed.reviews.length) {
					console.log(`  ℹ️  No reviews returned — stopping`);
					console.log(`  🔎 Raw snippet: ${String(response.text || '').slice(0, 300)}`);
					stopReason = 'empty_page';
					break;
				}

				let added = 0, duplicates = 0;
				for (const r of parsed.reviews) {
					if (reviews.length >= effectiveTarget) break;
					const key = reviewKey(r);
					if (seen.has(key)) { duplicates++; continue; }
					seen.add(key); reviews.push(r); added++;
				}
				console.log(`  ✅ Added ${added} (duplicates: ${duplicates}, total ${reviews.length})`);

				cursor = parsed.endCursor;
				pageNum++;

				progress = { gqlSession, cursor, nextPage: pageNum, updatedAt: now() };
				await writeAtomic(outPath, {
					sourceUrl: baseUrl, company, reviews, reviewsCount: reviews.length,
					target: args.maxReviews === 0 ? (totalReviews ?? null) : args.maxReviews,
					done: false, reason: null, updatedAt: now(), progress,
				});

				if (reviews.length >= effectiveTarget) break;

				if (!parsed.hasNextPage || !cursor) {
					console.log(`  ℹ️  No more pages (hasNextPage=${parsed.hasNextPage})`);
					stopReason = 'no_more_pages';
					break;
				}

				await sleep(1200 + Math.floor(Math.random() * 800));
			}
		}

		const done = args.maxReviews === 0
			? (totalReviews ? reviews.length >= totalReviews : stopReason === 'no_more_pages')
			: reviews.length >= args.maxReviews;

		await writeAtomic(outPath, {
			sourceUrl: baseUrl, company, reviews, reviewsCount: reviews.length,
			target: args.maxReviews === 0 ? (totalReviews ?? null) : args.maxReviews,
			done,
			reason: done ? null : (stopReason || 'no_more_pages'),
			updatedAt: now(),
			progress,
		});

		console.log(`\n🏁 Finished : ${reviews.length} reviews  done=${done}`);

	} catch (err) {
		console.error(`\n💥 Error: ${err.message}`);
		await writeAtomic(outPath, {
			sourceUrl: baseUrl, company, reviews, reviewsCount: reviews.length,
			done: false, reason: 'error', updatedAt: now(),
			extra: { error: err.message }, progress,
		}).catch(() => { });
		process.exitCode = 1;
	} finally {
		await browser.close();
	}
}

await main();
