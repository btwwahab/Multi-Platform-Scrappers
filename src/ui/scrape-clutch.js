import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

// ── Constants ─────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const NAV_TIMEOUT = 90_000;
const PAGE_WAIT_MS = 6000;   // wait after navigation for JS to render
const RETRY_LIMIT = 3;
const RETRY_DELAY = 4000;

// ── Tiny helpers ──────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function ensureDir(p) {
    await fs.mkdir(p, { recursive: true });
}

async function readJson(f) {
    try { return JSON.parse(await fs.readFile(f, 'utf8')); }
    catch { return null; }
}

/** Atomic JSON write — prevents corrupt files on crash */
async function writeAtomic(f, data) {
    if (f === '-') {
        console.log(JSON.stringify(data, null, 2));
    } else {
        const tmp = `${f}.${Date.now()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmp, f);
    }
}

function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

/** Extract the company slug from a clutch profile URL */
function slugFromUrl(url) {
    try {
        const parts = new URL(url).pathname.split('/').filter(Boolean);
        const profileIdx = parts.indexOf('profile');
        if (profileIdx >= 0 && parts[profileIdx + 1]) return parts[profileIdx + 1];
        return parts.at(-1) || null;
    } catch { return null; }
}

/** Build the paginated review URL (0-indexed page param) */
function buildPageUrl(baseUrl, pageIndex) {
    // User can pass plain profile URL; we always force reviews section.
    const u = new URL(String(baseUrl || '').split('#')[0]);
    if (pageIndex === 0) u.searchParams.delete('page');
    else u.searchParams.set('page', pageIndex);
    return u.toString() + '#reviews';
}

function normalizeClutchProfileUrl(url) {
    // Accept:
    // - https://clutch.co/profile/<slug>
    // - https://clutch.co/profile/<slug>#reviews
    // - https://clutch.co/profile/<slug>?page=2#reviews
    // Always normalize to the base profile URL (no page/hash) so pagination is reliable.
    const u = new URL(String(url || '').split('#')[0]);
    u.searchParams.delete('page');
    return u.toString();
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
    const a = {
        url: null,
        maxReviews: 500,
        out: null,
        outDir: path.join('outputs', 'clutch'),
        resume: true,
        headful: false,
        blockAssets: true,
    };

    for (let i = 2; i < argv.length; i++) {
        const f = argv[i];
        if (f === '--url') a.url = argv[++i];
        else if (f === '--maxReviews') a.maxReviews = Number(argv[++i]);
        else if (f === '--all') a.maxReviews = 0;
        else if (f === '--out') a.out = argv[++i];
        else if (f === '--outDir') a.outDir = argv[++i];
        else if (f === '--resume') a.resume = true;
        else if (f === '--noResume') a.resume = false;
        else if (f === '--headful') a.headful = true;
        else if (f === '--blockAssets') a.blockAssets = true;
        else if (f === '--noBlockAssets') a.blockAssets = false;
        else if (f === '--help' || f === '-h') {
            console.log(
                `Usage: node src/ui/scrape-clutch.js --url <profileUrl> [options]\n` +
                `   or: node src/ui/scrape-clutch.js <profileUrl> [options]\n\n` +
                `Note: You can pass the plain profile URL; the scraper auto-opens #reviews.\n\n` +
                `  --maxReviews N    Cap reviews (default: 500)\n` +
                `  --all             Scrape all available reviews\n` +
                `  --out <file>      Output file path (default: outputs/<slug>-<hash>.json)\n` +
                `  --outDir <dir>    Output folder (default: outputs/clutch)\n` +
                `  --resume          Continue from existing file (default: on)\n` +
                `  --noResume        Start fresh\n` +
                `  --headful         Show browser window\n` +
                `  --blockAssets     Block images/fonts (default: on)\n` +
                `  --noBlockAssets   Allow all assets`
            );
            process.exit(0);
        }
        // Allow positional URL: node src/ui/scrape-clutch.js https://clutch.co/profile/...#reviews
        else if (!a.url && typeof f === 'string' && /^https?:\/\//i.test(f)) {
            a.url = f;
        }
    }

    if (!a.url) throw new Error('Clutch profile URL is required (use --url <url> or pass it as the first argument).');
    return a;
}

// ── Browser ───────────────────────────────────────────────────────────────────
async function launchBrowser({ headful, blockAssets }) {
    const browser = await puppeteer.launch({
        headless: headful ? false : 'new',
        executablePath: CHROME,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--lang=en-US,en',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
        defaultViewport: { width: 1440, height: 900 },
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

async function gotoWithRetry(page, url, retries = RETRY_LIMIT) {
    for (let i = 0; i < retries; i++) {
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
            return;
        } catch (e) {
            if (i === retries - 1) throw e;
            console.warn(`  ↩ Navigation failed (attempt ${i + 1}): ${e.message} — retrying...`);
            await sleep(RETRY_DELAY * (i + 1));
        }
    }
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

async function takeScreenshot(page, label) {
    try {
        const ssDir = path.join(process.cwd(), 'screenshots');
        await ensureDir(ssDir);
        await page.screenshot({
            path: path.join(ssDir, `clutch-${label}-${Date.now()}.png`),
            fullPage: false,
        });
    } catch { }
}

async function expandSummaryIfNeeded(page) {
    try {
        await page.evaluate(() => {
            const btn = document.querySelector('#summary_section #read_more');
            if (!btn) return;
            try { btn.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch { }
            const s = window.getComputedStyle(btn);
            const visible = s && s.display !== 'none' && s.visibility !== 'hidden' && btn.offsetParent !== null;
            if (visible) btn.click();
        });
        await sleep(800);
    } catch { }
}

// ── Wait for reviews to render ─────────────────────────────────────────────────
async function waitForReviews(page) {
    // Scroll down slowly to trigger lazy-render
    await page.evaluate(() => {
        window.scrollTo({ top: 600, behavior: 'instant' });
    });
    await sleep(1000);
    await page.evaluate(() => {
        window.scrollTo({ top: 1400, behavior: 'instant' });
    });
    await sleep(1000);

    // Wait for at least one article.profile-review to appear (up to 15s)
    try {
        await page.waitForSelector('article.profile-review', { timeout: 15000 });
    } catch { }

    await sleep(1000);
}

// ── Company Info ──────────────────────────────────────────────────────────────
async function extractCompanyInfo(page) {
    return page.evaluate(() => {
        const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const $t = (sel, ctx = document) => {
            const el = ctx.querySelector(sel);
            return el ? n(el.textContent) : null;
        };

        const name = n(document.querySelector('h1')?.textContent) || null;

        // Overall rating
        const ratingEl = document.querySelector(
            '.sg-rating__number, [class*="overall"] .sg-rating__number, ' +
            '[class*="rating__number"]'
        );
        const overallRating = ratingEl ? parseFloat(n(ratingEl.textContent)) || null : null;

        // Total reviews from "X Reviews"
        let totalReviews = null;
        const bodyText = document.body.innerText;
        const sm = bodyText.match(/Showing\s+\d+[-–]\d+\s+of\s+([\d,]+)\s+Reviews?/i);
        if (sm) totalReviews = parseInt(sm[1].replace(/,/g, ''), 10);
        if (!totalReviews) {
            const m = bodyText.match(/([\d,]+)\s+Reviews?/i);
            if (m) totalReviews = parseInt(m[1].replace(/,/g, ''), 10);
        }

        // Company website: Clutch uses a redirect URL (r.clutch.co/redirect?...&u=https://real-site)
        const websiteEl = document.querySelector(
            'a.website-link__item, a[title*="Visit website" i], a[aria-label*="Visit" i][href*="r.clutch.co/redirect"], a[href*="r.clutch.co/redirect"]'
        );
        const websiteHref = websiteEl?.getAttribute('href') || websiteEl?.getAttribute('data-link') || null;
        let website = null;
        if (websiteHref) {
            try {
                const u = new URL(websiteHref, window.location.origin);
                const real = u.searchParams.get('u');
                website = real ? decodeURIComponent(real) : u.toString();
            } catch {
                website = websiteHref;
            }
        }

        // Highlights / Summary section (company-specific, not header)
        const summarySection = document.querySelector('#summary_section');

        let summaryText = null;
        const summaryTextEl = summarySection?.querySelector('#profile-summary-text') || null;
        if (summaryTextEl) {
            // Avoid scraping the "Read more" button text and preserve order without duplicating nested list text.
            const clone = summaryTextEl.cloneNode(true);
            clone.querySelectorAll('button, .read-more, #read_more').forEach((el) => el.remove());

            const blocks = [];
            for (const child of [...clone.children]) {
                const tag = String(child.tagName || '').toLowerCase();
                if (tag === 'p') {
                    const t = n(child.innerText);
                    if (t) blocks.push(t);
                } else if (tag === 'ul' || tag === 'ol') {
                    for (const li of [...child.querySelectorAll(':scope > li')]) {
                        const t = n(li.innerText);
                        if (t) blocks.push(t);
                    }
                }
            }

            summaryText = blocks.length ? blocks.join('\n') : n(clone.innerText);
        }

        const highlights = {
            tagline: summarySection ? $t('.profile-summary__tagline', summarySection) : null,
            summaryText,
            details: {},
            languages: [],
            timezones: [],
            locations: [],
        };

        if (summarySection) {
            for (const li of summarySection.querySelectorAll('ul.profile-summary__details > li.profile-summary__detail')) {
                const label = $t('.profile-summary__detail-label', li);
                const value = $t('.profile-summary__detail-title', li);
                if (label && value) highlights.details[label] = value;
            }
        }

        const langBox = document.querySelector('#profile-language');
        if (langBox) {
            highlights.languages = [...langBox.querySelectorAll('li')].map((x) => n(x.textContent)).filter(Boolean);
        }

        const tzBox = document.querySelector('#profile-timezones');
        if (tzBox) {
            highlights.timezones = [...tzBox.querySelectorAll('dl')]
                .map((dl) => {
                    const code = n(dl.querySelector('dt')?.textContent);
                    const name = n(dl.querySelector('dd')?.textContent);
                    return code || name ? { code: code || null, name: name || null } : null;
                })
                .filter(Boolean);
        }

        const locBox = document.querySelector('#profile-locations');
        if (locBox) {
            highlights.locations = [...locBox.querySelectorAll('li')]
                .map((x) => n(x.textContent).replace(/\s+,/g, ','))
                .filter(Boolean);
        }

        // Company service lines / focus (JS data embedded by Clutch)
        // e.g. window.serviceLines / window.chartPie
        const serviceLinesRaw = Array.isArray(window.serviceLines) ? window.serviceLines : [];
        const serviceLines = serviceLinesRaw
            .map((x) => ({
                name: x?.Name || null,
                percent: typeof x?.Percent === 'number' ? x.Percent : null,
                group: x?.GroupName || null,
                url: x?.MainPageUrl ? new URL(String(x.MainPageUrl), window.location.origin).toString() : null,
            }))
            .filter((x) => x.name);

        const chartPie = window.chartPie || null;

        // Keep legacy top-level fields
        const companyLocation = highlights.details?.Locations || highlights.details?.Location || null;
        const tagline = highlights.tagline || null;

        // IMPORTANT: company.services should be actual service lines, not header menu
        const services = serviceLines.map((s) => s.name);

        return {
            name,
            overallRating,
            totalReviews,
            location: companyLocation,
            website,
            tagline,
            services,
            highlights,
            serviceLines,
            chartPie,
        };
    });
}

// ── Review Extraction (per page) ──────────────────────────────────────────────
async function extractPageReviews(page) {
    await waitForReviews(page);

    return page.evaluate(() => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const text = (el) => (el ? norm(el.textContent) : null);
        const num = (s) => {
            const n = parseFloat(String(s || '').replace(/[^0-9.]+/g, ''));
            return Number.isFinite(n) ? n : null;
        };

        const pickFromTooltipList = (card) => {
            const out = { projectType: null, projectCost: null, projectDates: null };
            const items = card.querySelectorAll('.profile-review__data .data--item');

            for (const li of items) {
                const tooltip = (li.getAttribute('data-tooltip-content') || '').toLowerCase();
                const liText = norm(li.innerText);

                if (!out.projectType && tooltip.includes('services')) {
                    const parts = [...li.querySelectorAll('.profile-review__data-item')]
                        .map((x) => norm(x.textContent))
                        .filter(Boolean);
                    out.projectType = parts.length ? parts.join(', ') : liText;
                } else if (!out.projectCost && tooltip.includes('project size')) {
                    out.projectCost = liText || null;
                } else if (!out.projectDates && tooltip.includes('project length')) {
                    out.projectDates = liText || null;
                }
            }

            // Fallbacks (in case tooltips change)
            if (!out.projectCost) {
                const costLi = [...items].find((li) => /\$/.test(norm(li.innerText)));
                if (costLi) out.projectCost = norm(costLi.innerText);
            }
            if (!out.projectDates) {
                const dateLi = [...items].find((li) => /\b\d{4}\b|present/i.test(norm(li.innerText)));
                if (dateLi) out.projectDates = norm(dateLi.innerText);
            }

            return out;
        };

        const parseReviewerList = (card) => {
            const out = { industry: null, location: null, size: null, reviewType: null };
            const items = card.querySelectorAll('.reviewer_list .reviewer_list--item');

            for (const li of items) {
                const tooltip = (li.getAttribute('data-tooltip-content') || '').toLowerCase();
                const value = norm(li.querySelector('.reviewer_list__details-title')?.textContent || li.innerText);
                if (!value) continue;

                if (!out.industry && tooltip.includes('industry')) out.industry = value;
                else if (!out.location && tooltip.includes('location')) out.location = value;
                else if (!out.size && (tooltip.includes('client size') || tooltip.includes('company size'))) out.size = value;
                else if (!out.reviewType && tooltip.includes('review type')) out.reviewType = value;
            }
            return out;
        };

        const cards = document.querySelectorAll('article.profile-review');
        const reviews = [];

        for (const card of cards) {
            const idAttr = card.getAttribute('id') || '';
            const reviewId =
                (idAttr.match(/^review-(\d+)$/i)?.[1]) ||
                card.getAttribute('data-review-id') ||
                card.querySelector('[data-gtm_review_id]')?.getAttribute('data-gtm_review_id') ||
                card.querySelector('[data-review-id]')?.getAttribute('data-review-id') ||
                null;

            const projectTitle =
                text(card.querySelector('.profile-review__header h2, .profile-review__header h3')) ||
                text(card.querySelector('h2, h3')) ||
                text(card.querySelector('.profile-review__quote p, .profile-review__quote')) ||
                null;

            const overallRating = num(text(card.querySelector('.profile-review__rating .sg-rating__number, .profile-review__content .sg-rating__number')));

            const subRatings = {};
            for (const dl of card.querySelectorAll('.profile-review__rating-metrics dl')) {
                const label = norm(dl.querySelector('dt')?.textContent);
                const val = norm(dl.querySelector('dd')?.textContent);
                if (!label || !val) continue;
                const v = num(val);
                subRatings[label] = v ?? val;
            }

            const reviewQuote =
                text(card.querySelector('.profile-review__quote p, .profile-review__quote')) ||
                text(card.querySelector('blockquote')) ||
                null;

            const reviewDate =
                text(card.querySelector('.profile-review__date')) ||
                text(card.querySelector('time')) ||
                null;

            const projectSummary = (() => {
                const ps = card.querySelector('.profile-review__summary');
                if (!ps) return null;
                const psText = [...ps.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean).join(' ');
                return psText || null;
            })();

            const feedbackSummary = (() => {
                const fs = card.querySelector('.profile-review__feedback');
                if (!fs) return null;
                const fsText = [...fs.querySelectorAll('p')].map((p) => norm(p.textContent)).filter(Boolean).join(' ');
                return fsText || null;
            })();

            const { projectType, projectCost, projectDates } = pickFromTooltipList(card);

            const reviewerPositionRaw = text(card.querySelector('.reviewer_position')) || null;
            let reviewerTitle = null;
            let reviewerCompany = null;
            if (reviewerPositionRaw && reviewerPositionRaw.includes(',')) {
                const [t, ...rest] = reviewerPositionRaw.split(',');
                reviewerTitle = norm(t);
                reviewerCompany = norm(rest.join(', '));
            } else {
                reviewerTitle = reviewerPositionRaw;
            }

            const reviewerName = text(card.querySelector('.reviewer_card--name')) || null;

            const badgeText = norm(card.querySelector('.profile-review__reviewer-verification-badge-title')?.textContent);
            const isVerified = /verified/i.test(badgeText);

            const reviewerList = parseReviewerList(card);

            const shareUrl = card.querySelector('.profile-review__share-button')?.getAttribute('data-url') || null;
            const reviewUrl = shareUrl ? new URL(shareUrl, location.origin).toString() : (reviewId ? new URL(`#review-${reviewId}`, location.href).toString() : null);

            const isFeatured =
                /featured/i.test(card.className || '') ||
                !!card.querySelector('[class*="featured"]') ||
                (!!card.querySelector('.profile-review__header') && /featured/i.test(norm(card.querySelector('.profile-review__header')?.innerText)));

            reviews.push({
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
                subRatings,
                reviewer: {
                    name: reviewerName,
                    position: reviewerPositionRaw,
                    title: reviewerTitle,
                    company: reviewerCompany,
                    industry: reviewerList.industry,
                    location: reviewerList.location,
                    size: reviewerList.size,
                    reviewType: reviewerList.reviewType,
                },
                isFeatured,
                isVerified,
                reviewUrl,
                scrapedAt: new Date().toISOString(),
            });
        }

        return reviews;
    });
}

// ── Full Review Modal Expansion ───────────────────────────────────────────────
/**
 * Click "Read Full Review" for a given card, extract extended text from the
 * modal, then close it. Silently returns null on any failure.
 */
async function expandFullReview(page, reviewId) {
    try {
        // Click the expand button for this specific card
        const clicked = await page.evaluate((id) => {
            // Find card by data-review-id OR by data-gtm_review_id on inner button
            let card = document.querySelector(`article.profile-review[data-review-id="${id}"]`);
            if (!card) {
                // Find by button attribute
                const btn = document.querySelector(`[data-gtm_review_id="${id}"]`);
                card = btn?.closest('article.profile-review');
            }
            if (!card) return false;

            const btn = card.querySelector(
                '.review-card-show-more, [class*="show-more"], ' +
                'button[class*="full-review"], a[class*="full-review"]'
            );
            if (!btn) return false;
            btn.click();
            return true;
        }, reviewId);

        if (!clicked) return null;

        // Wait for modal to appear
        await sleep(3000);

        // Extract from modal
        const result = await page.evaluate(() => {
            const n = (s) => String(s || '').replace(/\s+/g, ' ').trim();
            const modal = document.querySelector(
                '.sg-modal-v2__content, [class*="modal__content"], [class*="modal-content"], ' +
                '[role="dialog"] [class*="content"], [class*="modal__body"]'
            );
            if (!modal) return null;

            // Full narrative text — try common content selectors inside modal
            const textEl = modal.querySelector(
                '[class*="review-text"], [class*="full-text"], ' +
                '[class*="review__body"], [class*="review__content"], ' +
                'p[class*="text"], .profile-review__body'
            );
            const fullText = textEl ? n(textEl.textContent) : null;

            // Extended project summary
            let extProjectSummary = null;
            for (const el of modal.querySelectorAll('h3, h4, h5, strong')) {
                if (/project\s+summary/i.test(n(el.textContent))) {
                    const next = el.nextElementSibling;
                    if (next) { extProjectSummary = n(next.textContent); break; }
                }
            }

            // Extended feedback summary
            let extFeedback = null;
            for (const el of modal.querySelectorAll('h3, h4, h5, strong')) {
                if (/feedback\s+summary/i.test(n(el.textContent))) {
                    const next = el.nextElementSibling;
                    if (next) { extFeedback = n(next.textContent); break; }
                }
            }

            return { fullText, extProjectSummary, extFeedback };
        });

        // Close modal
        await page.evaluate(() => {
            const closeBtn = document.querySelector(
                'button.sg-modal-v2__close, [class*="modal__close"], ' +
                '[aria-label*="close" i][class*="modal"], button[class*="modal-close"]'
            );
            if (closeBtn) closeBtn.click();
        });
        await sleep(600);

        return result;
    } catch {
        return null;
    }
}

// ── Pagination ─────────────────────────────────────────────────────────────────
async function getTotalReviews(page) {
    return page.evaluate(() => {
        const text = document.body.innerText;
        const m = text.match(/Showing\s+\d+[-–]\d+\s+of\s+([\d,]+)\s+Reviews?/i);
        if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        const m2 = text.match(/([\d,]+)\s+Reviews?/i);
        if (m2) return parseInt(m2[1].replace(/,/g, ''), 10);
        return null;
    });
}

async function getNextPageIndex(page) {
    return page.evaluate(() => {
        const next = document.querySelector('nav#pagination-nav a.sg-pagination-v2-next, a.sg-pagination-v2-next');
        if (!next) return null;

        // IMPORTANT: Clutch sometimes renders `disabled="true"` even when Next is usable.
        // Trust aria-disabled and the explicit disabled class instead.
        const cls = `${next.className || ''} ${next.parentElement?.className || ''}`;
        const ariaDisabled = (next.getAttribute('aria-disabled') || '').toLowerCase() === 'true';
        if (/sg-pagination-v2-disabled|inactive/i.test(cls)) return null;
        if (ariaDisabled) return null;

        const href = next.getAttribute('href') || '';
        const dataPage = next.getAttribute('data-page');

        let idx = null;
        if (dataPage != null && dataPage !== '') {
            const n = parseInt(dataPage, 10);
            if (!Number.isNaN(n)) idx = n;
        }
        if (idx == null && href) {
            try {
                const u = new URL(href, location.origin);
                const p = u.searchParams.get('page');
                if (p != null) {
                    const n = parseInt(p, 10);
                    if (!Number.isNaN(n)) idx = n;
                } else {
                    idx = 0;
                }
            } catch {
                // ignore
            }
        }

        if (idx == null) return null;

        // If we can read current active page, ensure it's actually moving forward
        const active = document.querySelector('nav#pagination-nav a.sg-pagination-v2-page-active');
        const activePage = active?.getAttribute('data-page');
        if (activePage != null && activePage !== '') {
            const cur = parseInt(activePage, 10);
            if (!Number.isNaN(cur) && idx <= cur) return null;
        }

        return idx;
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const args = parseArgs(process.argv);
    const compSlug = slugFromUrl(args.url) || 'company';
    const fileId = hashStr(args.url.split('?')[0].split('#')[0]);

    const dataPath = args.out === '-'
        ? '-'
        : args.out
            ? args.out
            : path.join(args.outDir, `${compSlug}-${fileId}.json`);

    if (dataPath !== '-') {
        await ensureDir(path.dirname(path.resolve(dataPath)));
        if (!args.resume) {
            await fs.rm(dataPath, { force: true }).catch(() => { });
        }
    }

    let existingReviews = [];
    let prevCompany = null;
    const seenIds = new Set();

    if (args.resume) {
        const prev = await readJson(dataPath);
        if (Array.isArray(prev)) {
            // Back-compat: old format wrote just an array
            existingReviews = prev;
        } else if (prev && Array.isArray(prev.reviews)) {
            existingReviews = prev.reviews;
            prevCompany = prev.company || null;
        }

        for (const r of existingReviews) {
            if (r?.reviewId) seenIds.add(String(r.reviewId));
        }

        if (existingReviews.length) {
            console.log(`📝 Resumed: ${seenIds.size} reviews already collected`);
        }
    }

    console.log(`📁 Output: ${dataPath}`);

    // ── Launch browser ────────────────────────────────────────────────────────────
    const { browser, page } = await launchBrowser(args);

    let baseProfileUrl = null;

    try {
        // ── Navigate to first page ──────────────────────────────────────────────────
        baseProfileUrl = normalizeClutchProfileUrl(args.url);
        const firstUrl = buildPageUrl(baseProfileUrl, 0);
        console.log(`🌐 Input URL     : ${args.url}`);
        console.log(`🌐 Reviews URL   : ${firstUrl}`);
        await gotoWithRetry(page, firstUrl);
        await dismissCookieBanner(page);
        await sleep(PAGE_WAIT_MS);
        await expandSummaryIfNeeded(page);

        // ── Extract company metadata ────────────────────────────────────────────────
        console.log('🏢 Extracting company info...');
        const rawCompany = await extractCompanyInfo(page);
        const company = {
            name: rawCompany.name || prevCompany?.name || null,
            overallRating: rawCompany.overallRating ?? prevCompany?.overallRating ?? null,
            totalReviews: rawCompany.totalReviews ?? prevCompany?.totalReviews ?? null,
            location: rawCompany.location || prevCompany?.location || null,
            website: rawCompany.website || prevCompany?.website || null,
            tagline: rawCompany.tagline || prevCompany?.tagline || null,
            services: rawCompany.services?.length
                ? rawCompany.services
                : (prevCompany?.services || []),
            highlights: rawCompany.highlights || prevCompany?.highlights || null,
            serviceLines: rawCompany.serviceLines || prevCompany?.serviceLines || null,
            chartPie: rawCompany.chartPie || prevCompany?.chartPie || null,
            profileUrl: baseProfileUrl,
            scrapedAt: now(),
        };

        const totalFromPage = await getTotalReviews(page);
        if (totalFromPage) company.totalReviews = totalFromPage;

        // Resolve effective target
        let target = args.maxReviews > 0
            ? args.maxReviews
            : (company.totalReviews || 9999);
        if (company.totalReviews) {
            target = args.maxReviews === 0
                ? company.totalReviews
                : Math.min(args.maxReviews, company.totalReviews);
        }

        console.log(`📍 ${company.name}  ⭐ ${company.overallRating}  📊 ${company.totalReviews ?? '?'} total`);
        console.log(`🎯 Target: ${target}  Already have: ${seenIds.size}`);

        if (seenIds.size >= target) {
            console.log(`✅ Already have ${seenIds.size} / ${target} — nothing to do`);
            await writeAtomic(dataPath, {
                sourceUrl: buildPageUrl(baseProfileUrl, 0),
                company,
                reviews: existingReviews,
                reviewsCount: existingReviews.length,
                target,
                done: true,
                updatedAt: now(),
            });
            return;
        }

        // ── Pagination loop ────────────────────────────────────────────────────────
        const allReviews = [...existingReviews];
        let pageIndex = 0;
        let retries = 0;

        while (allReviews.length < target) {
            const url = buildPageUrl(baseProfileUrl, pageIndex);

            if (pageIndex > 0) {
                console.log(`\n📄 Page ${pageIndex + 1} → ${url}`);
                try {
                    await gotoWithRetry(page, url);
                    await sleep(PAGE_WAIT_MS);
                    retries = 0;
                } catch (e) {
                    retries++;
                    if (retries > RETRY_LIMIT) {
                        console.warn(`\n⛔ Failed to load page ${pageIndex + 1} after ${RETRY_LIMIT} retries`);
                        break;
                    }
                    console.warn(`  ↩ Retry ${retries}/${RETRY_LIMIT} for page ${pageIndex + 1}...`);
                    await sleep(RETRY_DELAY * retries);
                    continue;
                }
            } else {
                console.log(`\n📄 Page 1 (already loaded)`);
            }

            // ── Extract cards on this page ───────────────────────────────────────────
            const pageReviews = await extractPageReviews(page);
            console.log(`  Found ${pageReviews.length} review cards on this page`);

            if (pageReviews.length === 0) {
                retries++;
                if (retries > RETRY_LIMIT) {
                    console.warn('  ⛔ No reviews found after retries — stopping');
                    await takeScreenshot(page, `no-reviews-p${pageIndex + 1}`);
                    break;
                }
                console.warn(`  ↩ No reviews found, retry ${retries}...`);
                await sleep(RETRY_DELAY);
                continue;
            }

            for (const review of pageReviews) {
                if (allReviews.length >= target) break;
                const rid = String(review.reviewId || '');
                if (rid && seenIds.has(rid)) continue;

                if (rid) seenIds.add(rid);
                allReviews.push(review);
            }

            process.stdout.write(`\r✅ Collected: ${allReviews.length} / ${target}   `);

            // ── Save progress after each page (single JSON file) ───────────────────
            await writeAtomic(dataPath, {
                sourceUrl: buildPageUrl(baseProfileUrl, 0),
                company,
                reviews: allReviews,
                reviewsCount: allReviews.length,
                target,
                done: allReviews.length >= target,
                updatedAt: now(),
            });

            // ── Check for next page ────────────────────────────────────────────────
            if (allReviews.length >= target) break;

            const nextIndex = await getNextPageIndex(page);
            if (nextIndex == null) {
                console.log('\n  📌 No more pages found');
                break;
            }

            pageIndex = nextIndex;
            retries = 0;
            await sleep(1500 + Math.floor(Math.random() * 1000));
        }

        // ── Final save (single JSON file) ─────────────────────────────────────────
        const done = allReviews.length >= target;
        await writeAtomic(dataPath, {
            sourceUrl: buildPageUrl(baseProfileUrl, 0),
            company,
            reviews: allReviews,
            reviewsCount: allReviews.length,
            target,
            done,
            reason: done ? null : 'stopped_early',
            updatedAt: now(),
        });

        console.log(`\n🏁 Done: ${allReviews.length} reviews saved → ${dataPath}`);
        if (allReviews.length > 0) {
            console.log('\n📋 Sample first review:');
            console.log(JSON.stringify(allReviews[0], null, 2));
        }

    } catch (err) {
        console.error(`\n💥 Fatal: ${err.message}`);
        await takeScreenshot(page, 'error');
        await writeAtomic(dataPath, {
            sourceUrl: buildPageUrl(baseProfileUrl, 0),
            company: prevCompany,
            reviews: existingReviews,
            reviewsCount: existingReviews.length,
            done: false,
            reason: 'fatal_error',
            error: err.message,
            updatedAt: now(),
        });
        process.exitCode = 1;

    } finally {
        await browser.close();
    }
}

await main();
