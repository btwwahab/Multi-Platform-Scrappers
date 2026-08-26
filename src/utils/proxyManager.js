/**
 * src/utils/proxyManager.js
 *
 * Simple Webshare proxy manager.
 * Set PROXY_MODE in .env:
 *   rotate  -> uses virtualassistants-rotate (Webshare auto-rotates IP)  [default]
 *   list    -> cycles through virtualassistants-1 to virtualassistants-10 one by one
 *   none    -> no proxy
 */
import 'dotenv/config';
import http from 'node:http';

const MODE = (process.env.PROXY_MODE || 'rotate').toLowerCase();
const PASSWORD = process.env.PROXY_PASSWORD;
const HOST = process.env.PROXY_HOST;
const PORT = Number(process.env.PROXY_PORT || 80);
const PREFIX = process.env.PROXY_USER_PREFIX;
const COUNT = Number(process.env.PROXY_COUNT || 10);

let index = 0; // used only in "list" mode

// Returns the next proxy object, or null if MODE is "none"
function getNextProxy() {
    if (MODE === 'none') return null;

    const username = MODE === 'list'
        ? `${PREFIX}-${(index++ % COUNT) + 1}`   // virtualassistants-1 ... -10 (round-robin)
        : `${PREFIX}-rotate`;                     // virtualassistants-rotate (Webshare rotates)

    return {
        username,
        password: PASSWORD,
        host: HOST,
        port: PORT,
        proxyUrl: `http://${username}:${PASSWORD}@${HOST}:${PORT}`,
        proxyArg: `${HOST}:${PORT}`,              // format Chrome expects
    };
}

// Spread the result into puppeteer.launch({ args })
function getBrowserProxyArgs(proxy) {
    return proxy ? [`--proxy-server=${proxy.proxyArg}`] : [];
}

// Call right after browser.newPage()
async function applyProxyToPage(page, proxy) {
    if (proxy) await page.authenticate({ username: proxy.username, password: proxy.password });
}

// Logs the proxy URL + fetches and logs the actual outgoing IP via the proxy
async function logCurrentProxy(proxy) {
    if (!proxy) { console.log('[Proxy] disabled'); return; }

    const masked = proxy.proxyUrl.replace(/:([^@]+)@/, ':***@');
    console.log(`[Proxy] ${masked}  (mode: ${MODE})`);

    // Fetch real outgoing IP through the proxy
    const ip = await new Promise((resolve) => {
        const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
        const req = http.request({
            host: HOST,
            port: PORT,
            method: 'GET',
            path: 'http://ipv4.webshare.io/',
            headers: { 'Host': 'ipv4.webshare.io', 'Proxy-Authorization': `Basic ${auth}` },
        }, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(d.trim() || null));
        });
        req.setTimeout(8000, () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.end();
    });

    console.log(`[Proxy] IP -> ${ip ?? '(could not fetch)'}`);
}

export { getNextProxy, getBrowserProxyArgs, applyProxyToPage, logCurrentProxy };
