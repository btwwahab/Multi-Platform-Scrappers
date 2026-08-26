#!/usr/bin/env python3
"""
G2 scraper — Camoufox + smart session rotation + 403 backoff
"""

import json, time, random, re, hashlib, argparse, os
from pathlib import Path
from datetime import datetime
from camoufox.sync_api import Camoufox
from dotenv import load_dotenv

load_dotenv()

try:
    import psycopg
    HAS_PSYCOPG = True
except ImportError:
    HAS_PSYCOPG = False

# ── Config ─────────────────────────────────────────────────────────────────
MAX_PAGES_PER_SESSION = 40    # rotate browser+proxy after this many pages
BACKOFF_ON_403        = 45    # seconds to wait after 403
BACKOFF_ON_CAPTCHA    = 20    # seconds before trying next proxy
MAX_RETRIES_PER_PAGE  = 3     # 403 retries before rotating proxy

# ── Proxy pool ─────────────────────────────────────────────────────────────
def load_proxies():
    raw = os.getenv('GMAPS_PROXY_POOL', '')
    if not raw: return []
    try:
        pool = json.loads(raw)
        return [
            {'server': f'http://{e[0]}:{e[1]}', 'username': e[2], 'password': e[3]}
            for e in pool if len(e) >= 4
        ]
    except Exception as ex:
        print(f'⚠️  Proxy parse error: {ex}'); return []

PROXY_POOL  = load_proxies()
BURNED      = set()
PROXY_STATS = {}   # server -> {'requests': N, 'errors': N, 'last_used': T}

def get_proxy(exclude=None):
    """Pick least-used non-burned proxy."""
    candidates = [
        p for p in PROXY_POOL
        if p['server'] not in BURNED
        and p['server'] != (exclude or '')
    ]
    if not candidates:
        print('⚠️  All proxies burned — resetting')
        BURNED.clear()
        candidates = [p for p in PROXY_POOL if p['server'] != (exclude or '')]
    if not candidates:
        return PROXY_POOL[0] if PROXY_POOL else None

    # Pick proxy with fewest total requests (load balance)
    candidates.sort(key=lambda p: PROXY_STATS.get(p['server'], {}).get('requests', 0))
    proxy = candidates[0]
    if proxy['server'] not in PROXY_STATS:
        PROXY_STATS[proxy['server']] = {'requests': 0, 'errors': 0}
    return proxy

def record_request(proxy):
    if proxy:
        PROXY_STATS.setdefault(proxy['server'], {'requests': 0, 'errors': 0})
        PROXY_STATS[proxy['server']]['requests'] += 1

def record_error(proxy):
    if proxy:
        PROXY_STATS.setdefault(proxy['server'], {'requests': 0, 'errors': 0})
        PROXY_STATS[proxy['server']]['errors'] += 1

def burn(proxy, reason=''):
    if proxy:
        BURNED.add(proxy['server'])
        print(f"  🔥 Burned {proxy['server']} ({reason})")

def print_proxy_stats():
    print('\n📊 Proxy Stats:')
    for server, s in sorted(PROXY_STATS.items(), key=lambda x: -x[1]['requests']):
        status = '🔥 burned' if server in BURNED else '✅'
        print(f"  {status} {server}: {s['requests']} req, {s['errors']} errors")

# ── Helpers ────────────────────────────────────────────────────────────────
def now(): return datetime.utcnow().isoformat()

def rand_sleep(base, variance=0.3):
    t = max(0.3, base + random.uniform(-base * variance, base * variance))
    time.sleep(t)

def human_scroll(page):
    try:
        for _ in range(random.randint(2, 4)):
            page.mouse.wheel(0, random.randint(200, 700))
            time.sleep(random.uniform(0.3, 1.0))
        page.mouse.wheel(0, -9999)
        time.sleep(0.4)
    except: pass

def human_move(page):
    try:
        vp = page.viewport_size or {'width': 1440, 'height': 900}
        for _ in range(random.randint(3, 6)):
            page.mouse.move(
                random.randint(80, vp['width']  - 80),
                random.randint(80, vp['height'] - 80)
            )
            time.sleep(random.uniform(0.05, 0.2))
    except: pass

def save_screenshot(page, label):
    try:
        Path('screenshots').mkdir(exist_ok=True)
        p = f'screenshots/{label}-{int(time.time()*1000)}.png'
        page.screenshot(path=p, full_page=True)
        print(f'  📸 Screenshot: {p}')
    except: pass

# ── Page state ─────────────────────────────────────────────────────────────
def detect_state(page):
    try:
        t = page.inner_text('body').lower()
        if 'accès temporairement restreint' in t or \
           'access is temporarily restricted' in t: return 'hard_block'
        if 'verification required' in t or \
           'verify you are human' in t or \
           'captcha' in t: return 'captcha'
        if 'slide right' in t or 'secure your access' in t: return 'slider'
        if 'what do you like best' in t or \
           'search reviews' in t or \
           'reviews (' in t: return 'reviews'
        return 'loading'
    except: return 'loading'

def wait_for_reviews(page, timeout=90):
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = detect_state(page)
        if s == 'reviews':    return 'ok'
        if s == 'hard_block': return 'hard_block'
        if s == 'captcha':    return 'captcha'
        time.sleep(1.5)
    return 'timeout'

# ── HTML parsing ───────────────────────────────────────────────────────────
def inner_text(html):
    html = re.sub(r'<script[\s\S]*?</script>', '', html, flags=re.I)
    html = re.sub(r'<style[\s\S]*?</style>',  '', html, flags=re.I)
    html = re.sub(r'<[^>]+>', ' ', html)
    for e, r in [('&amp;','&'),('&lt;','<'),('&gt;','>'),
                 ('&quot;','"'),('&#39;',"'"),('&nbsp;',' ')]:
        html = html.replace(e, r)
    return re.sub(r'\s+', ' ', html).strip()

def parse_reviews(html):
    reviews, pat = [], re.compile(
        r'<[a-z][^>]+itemprop="review"[^>]*>([\s\S]*?)(?=<[a-z][^>]+itemprop="review"|$)', re.I)
    for m in pat.finditer(html):
        card   = m.group(0)
        id_m   = re.search(r'[-\s]review-(\d+)"', card)
        url_m  = re.search(r'href="(/reviews/[^"#?]+)"', card)
        rat_m  = re.search(r'<meta[^>]+content="([\d.]+)"[^>]+itemprop="ratingValue"', card)
        date_m = re.search(r'<meta[^>]+content="([^"]+)"[^>]+itemprop="datePublished"', card)
        disp_m = re.search(r'status-badge__label[^>]*>([^<]+)</label>', card)
        name_m = re.search(r'itemprop="author"[\s\S]*?<meta[^>]+content="([^"]+)"[^>]+itemprop="name"', card)
        subtle = re.findall(r'elv-text-subtle[^>]*>([^<]{2,100})</div>', card)

        def extract(label):
            mm = re.search(re.escape(label) + r'[^<]*</[^>]+>\s*<p[^>]*>([\s\S]*?)</p>', card, re.I)
            return inner_text(mm.group(1)) if mm else None

        like    = extract('What do you like best about')
        dislike = extract('What do you dislike about')
        rec     = extract('What problems is') or extract('Recommendations to others')
        text    = '\n\n'.join(filter(None, [like, dislike, rec]))
        h       = hashlib.md5(f"{name_m and name_m.group(1)}{date_m and date_m.group(1)}{text}".encode()).hexdigest()[:8]
        rid     = (id_m and id_m.group(1)) or (url_m and url_m.group(1).split('/')[-1]) or h

        badges = []
        if re.search(r'verified user',      card, re.I): badges.append('Verified User')
        if re.search(r'validated reviewer', card, re.I): badges.append('Validated Reviewer')

        reviews.append({
            'reviewId'       : rid,
            'reviewUrl'      : f"https://www.g2.com{url_m.group(1)}" if url_m else None,
            'rating'         : float(rat_m.group(1)) if rat_m else None,
            'text'           : text,
            'likeBest'       : like,
            'dislike'        : dislike,
            'recommendations': rec,
            'date'           : disp_m.group(1).strip() if disp_m else (date_m and date_m.group(1)),
            'badges'         : badges,
            'reviewer'       : {
                'name'       : name_m.group(1) if name_m else None,
                'role'       : subtle[0].strip() if subtle else None,
                'companySize': subtle[1].strip() if len(subtle) > 1 else None,
            },
            'scrapedAt': now(),
        })
    return reviews

def parse_company(html, slug):
    r_m = re.search(r'itemprop="ratingValue"[^>]*content="([\d.]+)"', html)
    c_m = re.search(r'itemprop="reviewCount"[^>]*content="(\d+)"', html) or \
          re.search(r'Reviews\s*\(\s*([\d,]+)\s*\)', html, re.I)
    n_m = re.search(r'<h1[^>]*>([\s\S]*?)</h1>', html, re.I)
    return {
        'name'         : inner_text(n_m.group(1)).replace('Reviews','').strip() if n_m else slug,
        'overallRating': float(r_m.group(1)) if r_m else None,
        'totalReviews' : int(c_m.group(1).replace(',','')) if c_m else None,
    }

# ── Warm-up ────────────────────────────────────────────────────────────────
def warm_up(page):
    print('🔥 Warming up...')
    warm_pages = [
        'https://www.g2.com/',
        'https://www.g2.com/categories/accounting',
    ]
    for url in warm_pages:
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=40000)
            rand_sleep(3, 0.4)
            human_move(page)
            human_scroll(page)
            rand_sleep(2, 0.3)
        except Exception as e:
            print(f'  ⚠️  Warm-up skip: {e}')
    print('✅ Warm-up done')

# ── In-browser fetch with retry ────────────────────────────────────────────
def fetch_page(page, api_url, referer, proxy, delay, retries=MAX_RETRIES_PER_PAGE):
    """
    Fetch a page via in-browser fetch().
    Returns (html, status) or raises on unrecoverable error.
    """
    for attempt in range(retries):
        try:
            result = page.evaluate("""
                async ({url, ref}) => {
                    try {
                        const r = await fetch(url, {
                            credentials: 'include',
                            headers: {
                                'Accept'          : 'text/html',
                                'Accept-Language' : 'en-US,en;q=0.9',
                                'turbo-frame'     : 'reviews-and-filters',
                                'Sec-Fetch-Dest'  : 'empty',
                                'Sec-Fetch-Mode'  : 'cors',
                                'Sec-Fetch-Site'  : 'same-origin',
                                'Referer'         : ref,
                            }
                        });
                        return { status: r.status, html: await r.text() };
                    } catch(e) {
                        return { status: 0, html: '', error: e.message };
                    }
                }
            """, {'url': api_url, 'ref': referer})
        except Exception as e:
            print(f'    ⚠️  evaluate error: {e}')
            return None, 0

        record_request(proxy)
        status = result.get('status', 0)

        if status == 200:
            return result['html'], 200

        if status == 403:
            record_error(proxy)
            print(f'    ⚠️  403 — attempt {attempt+1}/{retries} — waiting {BACKOFF_ON_403}s')
            time.sleep(BACKOFF_ON_403 + random.uniform(0, 15))
            continue

        if status == 404:
            return None, 404

        if status == 429:
            wait = 60 + random.uniform(0, 30)
            print(f'    ⚠️  429 rate limit — waiting {wait:.0f}s')
            time.sleep(wait)
            continue

        print(f'    ⚠️  HTTP {status}')
        return None, status

    # All retries exhausted
    return None, 403

# ── Single scrape session ──────────────────────────────────────────────────
def scrape_session(proxy, slug, base_url, start_page,
                   reviews, seen, target, max_pages, delay, out_path, company,
                   session_num=1, db_conn=None, batch_save_enabled=False, company_id=None):
    batch_count = 0

    server = proxy['server'] if proxy else 'direct'
    reqs   = PROXY_STATS.get(server, {}).get('requests', 0)
    print(f'\n[session {session_num}] proxy={server} ({reqs} prev requests)')

    with Camoufox(
        headless=False,
        os='windows',
        proxy=proxy,
        geoip=True,
        humanize=True,
    ) as browser:

        page = browser.new_page()
        page.set_default_timeout(90000)

        warm_up(page)

        nav_url = f'{base_url}?page={start_page}' if start_page > 1 else base_url
        print(f'🚀 Navigating to: {nav_url}')

        try:
            page.goto(nav_url, wait_until='domcontentloaded', timeout=90000)
        except Exception as e:
            print(f'  ⚠️  Navigation error: {e}')
            return {'result': 'rotate', 'page': start_page, 'company': company}

        rand_sleep(3)
        status = wait_for_reviews(page, timeout=90)
        print(f'  → State: {status}')

        if status in ('captcha', 'hard_block'):
            save_screenshot(page, status)
            burn(proxy, status)
            time.sleep(BACKOFF_ON_CAPTCHA)
            return {'result': 'rotate', 'page': start_page, 'company': company}

        if status == 'timeout':
            save_screenshot(page, 'timeout')
            return {'result': 'rotate', 'page': start_page, 'company': company}

        print('✅ Reviews page loaded!\n')
        human_move(page)
        rand_sleep(1.5)

        cur_page     = start_page
        no_new       = 0
        stop         = None
        pages_this_session = 0

        while len(reviews) < target and cur_page <= max_pages:

            # ── Session rotation trigger ───────────────────────────────
            if pages_this_session >= MAX_PAGES_PER_SESSION:
                print(f'  🔄 Session limit ({MAX_PAGES_PER_SESSION} pages) — rotating browser+proxy')
                return {'result': 'rotate_session', 'page': cur_page, 'company': company}

            api_url = ('https://www.g2.com/products/' + slug + '/reviews_and_filters'
                       + (f'?page={cur_page}' if cur_page > 1 else ''))
            referer = base_url + (f'?page={cur_page}' if cur_page > 1 else '')

            print(f'📄 Page {cur_page}  [session page {pages_this_session+1}/{MAX_PAGES_PER_SESSION}]')

            # ── Get HTML ───────────────────────────────────────────────
            if cur_page == start_page:
                html   = page.content()
                status = 200
                record_request(proxy)
            else:
                html, status = fetch_page(page, api_url, referer, proxy, delay)

            if status == 404:
                stop = 'no_more_pages'; break

            if html is None:
                # fetch_page exhausted retries (403/other)
                print(f'  ❌ Unrecoverable after retries on page {cur_page} — rotating proxy')
                burn(proxy, f'exhausted retries page {cur_page}')
                return {'result': 'rotate', 'page': cur_page, 'company': company}

            # ── Parse ──────────────────────────────────────────────────
            if not company:
                company = parse_company(html, slug)
                print(f"🏷️  {company['name']}  ⭐ {company['overallRating']}  ({company['totalReviews']} total)")

            page_reviews = parse_reviews(html)
            print(f'  📥 {len(page_reviews)} reviews found')

            if not page_reviews:
                no_new += 1
                if no_new >= 3: stop = 'no_reviews'; break
                cur_page += 1; rand_sleep(delay); pages_this_session += 1; continue
            no_new = 0

            added = 0
            for r in page_reviews:
                rid = str(r['reviewId'])
                if rid not in seen:
                    reviews.append(r); seen.add(rid); added += 1
                    if len(reviews) >= target:
                        stop = 'target_reached'; break

            print(f'  ✅ +{added} new  (total: {len(reviews)})')

            batch_count += added
            if batch_save_enabled and batch_count >= 50 and db_conn and company_id:
                batch_to_save = reviews[-batch_count:]
                saved_count = batch_save_reviews_to_db(db_conn, company_id, 'g2', batch_to_save)
                if saved_count > 0:
                    print(f'  💾 Saved {saved_count} reviews to DB (batch)')
                    batch_count = 0
                else:
                    print(f'  ⚠️  Batch DB save failed, continuing with file-based progress')
                    batch_save_enabled = False

            if out_path != '-':
                Path(out_path).write_text(json.dumps({
                    'reviews': reviews, 'reviewsCount': len(reviews),
                    'company': company, 'updatedAt': now(),
                    'progress': {'lastPage': cur_page, 'nextPage': cur_page + 1},
                }, indent=2, ensure_ascii=False))

            pages_this_session += 1
            if stop: break

            cur_page += 1
            d = delay + random.uniform(0, delay * 0.5)
            print(f'  ⏱️  {d:.1f}s...')
            rand_sleep(d)

        done = stop in ('target_reached', 'no_more_pages', 'no_reviews')
        return {
            'result' : 'done' if done else 'continue',
            'page'   : cur_page + 1,
            'stop'   : stop,
            'company': company,
            'batch_count': batch_count,
        }

# ── CLI ────────────────────────────────────────────────────────────────────
def get_slug(url):
    parts = [p for p in url.rstrip('/').split('/') if p]
    try: i = parts.index('products'); return parts[i + 1]
    except: return parts[-1]

def get_db_connection():
    if not HAS_PSYCOPG:
        return None
    try:
        conn = psycopg.connect(
            host=os.getenv('DB_HOST', 'localhost'),
            port=int(os.getenv('DB_PORT', 5432)),
            database=os.getenv('DB_NAME', 'postgres'),
            user=os.getenv('DB_USER', 'postgres'),
            password=os.getenv('DB_PASSWORD', ''),
        )
        return conn
    except Exception as e:
        print(f'⚠️  DB connection failed: {e}')
        return None

def batch_save_reviews_to_db(conn, company_id, platform, reviews_to_save):
    if not conn or not company_id or not reviews_to_save:
        return 0
    
    try:
        cur = conn.cursor()
        saved = 0
        
        for r in reviews_to_save:
            platform_id = str(r.get('reviewId', ''))[:255] or hashlib.md5(
                f"{r.get('reviewer', {}).get('name', '')}{r.get('date', '')}{r.get('text', '')}".encode()
            ).hexdigest()[:8]
            
            author = r.get('reviewer', {}).get('name')
            if author:
                author = str(author)[:255]
            
            title = r.get('title')
            if title:
                title = str(title)[:500]
            
            text = r.get('text')
            if text:
                text = str(text)
            
            rating = r.get('rating')
            if rating is not None:
                try:
                    rating = float(rating)
                    rating = round(rating * 10) / 10
                except (ValueError, TypeError):
                    rating = None
            
            date = r.get('date')
            platform_response = {
                'reviewUrl': r.get('reviewUrl'),
                'badges': r.get('badges'),
                'reviewer': r.get('reviewer'),
            }
            
            cur.execute(
                '''
                insert into reviews (company_id, platform, platform_id, author, author_image, title, text, rating, date, platform_response, created_at, updated_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                on conflict (company_id, platform, platform_id)
                do update set
                  author = coalesce(excluded.author, reviews.author),
                  title = excluded.title,
                  text = excluded.text,
                  rating = excluded.rating,
                  date = excluded.date,
                  platform_response = excluded.platform_response,
                  updated_at = now()
                ''',
                (
                    company_id, platform, platform_id, author, None, title, text, rating, date,
                    json.dumps(platform_response)
                )
            )
            saved += 1
        
        conn.commit()
        return saved
    except Exception as e:
        print(f'⚠️  Batch save error: {e}')
        try:
            conn.rollback()
        except:
            pass
        return 0

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url',         required=True)
    ap.add_argument('--max-reviews', type=int,   default=50)
    ap.add_argument('--max-pages',   type=int,   default=9999)
    ap.add_argument('--delay',       type=float, default=5.0)
    ap.add_argument('--all',         action='store_true')
    ap.add_argument('--out',         default=None)
    ap.add_argument('--outDir',      default='outputs/g2')
    ap.add_argument('--noResume',    action='store_true')
    ap.add_argument('--userDataDir', default=None)
    ap.add_argument('--companyId',   type=int,   default=None)
    ap.add_argument('--noBatchSave', action='store_true')
    args = ap.parse_args()

    if args.all:
        args.max_reviews = 10**9
        args.max_pages   = 9999

    db_conn = None
    batch_save_enabled = not args.noBatchSave
    if batch_save_enabled:
        db_conn = get_db_connection()
        if not db_conn:
            print('⚠️  Database not available, batch save disabled')
            batch_save_enabled = False

    slug     = get_slug(args.url)
    base_url = f'https://www.g2.com/products/{slug}/reviews'

    h        = hashlib.md5(args.url.encode()).hexdigest()[:7]
    out_path = args.out or str(Path(args.outDir) / f'{slug}-{h}.json')
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path('screenshots').mkdir(exist_ok=True)

    prev    = {} if args.noResume else (json.loads(Path(out_path).read_text()) if Path(out_path).exists() else {})
    reviews = prev.get('reviews', [])
    company = prev.get('company')
    pg_num  = prev.get('progress', {}).get('nextPage', 1)
    seen    = set(str(r['reviewId']) for r in reviews)
    target  = args.max_reviews

    print('═' * 60)
    print('G2 Scraper — Camoufox + Smart Session Rotation')
    print('═' * 60)
    print(f'📁 Output           : {out_path}')
    print(f'🌐 Product          : {slug}')
    print(f'📝 Resumed          : {len(reviews)} reviews')
    print(f'🎯 Target           : {target}')
    print(f'🔀 Proxies          : {len(PROXY_POOL)} in pool')
    print(f'🔁 Session rotate   : every {MAX_PAGES_PER_SESSION} pages')
    print(f'⏱️  403 backoff      : {BACKOFF_ON_403}s')
    if batch_save_enabled and args.companyId:
        print(f'💾 Batch DB save    : enabled (company_id={args.companyId})')
    print()

    session_num  = 1
    retries      = 0
    max_ret      = max(len(PROXY_POOL) * 2, 10)
    last_proxy   = None
    batch_count  = 0

    while len(reviews) < target and pg_num <= args.max_pages and retries < max_ret:
        proxy = get_proxy(exclude=last_proxy['server'] if last_proxy else None)
        last_proxy = proxy

        r = scrape_session(
            proxy, slug, base_url, pg_num,
            reviews, seen, target, args.max_pages,
            args.delay, out_path, company, session_num,
            db_conn=db_conn, batch_save_enabled=batch_save_enabled, company_id=args.companyId
        )
        company     = r.get('company') or company
        batch_count = r.get('batch_count', 0)
        session_num += 1

        if r['result'] == 'done':
            break

        if r['result'] == 'continue':
            pg_num  = r['page']
            retries = 0
            continue

        if r['result'] == 'rotate_session':
            # Clean rotation — no retry count increment
            pg_num = r['page']
            print(f'  🔄 Clean session rotation at page {pg_num}')
            time.sleep(random.uniform(3, 7))
            continue

        if r['result'] == 'rotate':
            retries += 1
            pg_num   = r['page']
            wait     = random.uniform(8, 20)
            print(f'  🔄 Retry {retries}/{max_ret} in {wait:.0f}s…')
            time.sleep(wait)

    # Final save: any remaining reviews (< 50)
    if batch_save_enabled and batch_count > 0 and db_conn and args.companyId:
        batch_to_save = reviews[-batch_count:]
        saved_count = batch_save_reviews_to_db(db_conn, args.companyId, 'g2', batch_to_save)
        if saved_count > 0:
            print(f'💾 Saved final {saved_count} reviews to DB (batch)')
    
    Path(out_path).write_text(json.dumps({
        'sourceUrl'   : args.url,
        'company'     : company,
        'reviews'     : reviews,
        'reviewsCount': len(reviews),
        'updatedAt'   : now(),
    }, indent=2, ensure_ascii=False))

    if db_conn:
        try:
            db_conn.close()
        except:
            pass

    print_proxy_stats()
    print('\n' + '═' * 60)
    print(f'🏁 Done: {len(reviews)} reviews → {out_path}')
    print('═' * 60)

if __name__ == '__main__':
    main()