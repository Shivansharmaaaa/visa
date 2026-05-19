/**
 * Quick probe: Check if /days.json returns ETag / Last-Modified headers.
 * Logs in, hits the endpoint twice, dumps ALL response headers.
 * If ETag exists, tests conditional request (If-None-Match → expect 304).
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
require('dotenv').config();
chromium.use(stealth);

const BASE = process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv';

async function main() {
    const browser = await chromium.launch({
        headless: false,
        channel: 'chrome',
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    });
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await ctx.newPage();

    // Login
    console.log('Logging in...');
    await page.goto(`${BASE}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#user_email', { timeout: 30000 });
    await page.fill('#user_email', process.env.VISA_EMAIL);
    await page.fill('#user_password', process.env.VISA_PASSWORD);
    try { await page.click('label[for="policy_confirmed"]', { timeout: 2000 }); }
    catch { await page.click('#policy_confirmed', { force: true }).catch(() => {}); }
    await page.click('input[type="submit"]');
    try {
        const ok = page.locator('button:has-text("OK"), a:has-text("OK")');
        if (await ok.isVisible({ timeout: 3000 })) { await ok.click(); await page.click('.icheckbox', { force: true }).catch(() => {}); await page.click('input[type="submit"]'); }
    } catch {}
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (page.url().includes('sign_in')) { console.log('LOGIN FAILED'); process.exit(1); }
    console.log('Login OK\n');

    // Navigate to appointment page to get IDs
    const btn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(btn, { timeout: 20000 });
    await page.click(btn);
    await page.waitForTimeout(2000);
    const apptUrl = page.url().replace(/\/[^\/]+$/, '/appointment');
    await page.goto(apptUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });

    // Select city
    const opts = await page.$$eval('#appointments_consulate_appointment_facility_id option', o => o.map(x => ({ t: x.innerText.trim(), v: x.value })));
    const city = opts.find(o => o.t.toLowerCase().includes((process.env.PREFERRED_CITY || 'toronto').toLowerCase()));
    if (city) await page.selectOption('#appointments_consulate_appointment_facility_id', city.v);

    const ids = await page.evaluate(() => {
        const m = window.location.href.match(/schedule\/(\d+)/);
        const f = document.querySelector('#appointments_consulate_appointment_facility_id');
        return { sid: m?.[1], fid: f?.value };
    });
    console.log(`Schedule: ${ids.sid}, Facility: ${ids.fid}\n`);

    // ════════════════════════════════════════════════════════════
    // PROBE 1: Normal request — dump ALL response headers
    // ════════════════════════════════════════════════════════════
    console.log('═'.repeat(60));
    console.log('PROBE 1: Normal GET /days.json — ALL response headers');
    console.log('═'.repeat(60));

    const probe1 = await page.evaluate(async ({ base, sid, fid }) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        const resp = await fetch(`${base}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false`, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            }
        });
        // Collect ALL response headers
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        const body = await resp.json();
        return { status: resp.status, headers, bodyCount: body?.length || 0 };
    }, { base: BASE, sid: ids.sid, fid: ids.fid });

    console.log(`Status: ${probe1.status}`);
    console.log(`Body: Array[${probe1.bodyCount}]`);
    console.log('\nAll Response Headers:');
    for (const [k, v] of Object.entries(probe1.headers).sort()) {
        const highlight = ['etag', 'last-modified', 'cache-control', 'expires', 'vary', 'x-rate', 'x-ratelimit', 'retry-after']
            .some(h => k.toLowerCase().includes(h));
        const prefix = highlight ? '\x1b[42m\x1b[30m ★ \x1b[0m' : '   ';
        console.log(`${prefix} ${k}: ${v}`);
    }

    const etag = probe1.headers['etag'] || probe1.headers['ETag'] || null;
    const lastMod = probe1.headers['last-modified'] || probe1.headers['Last-Modified'] || null;

    console.log('\n' + '─'.repeat(60));
    console.log(`ETag present:          ${etag ? '✅ YES → ' + etag : '❌ NO'}`);
    console.log(`Last-Modified present:  ${lastMod ? '✅ YES → ' + lastMod : '❌ NO'}`);
    console.log('─'.repeat(60));

    // ════════════════════════════════════════════════════════════
    // PROBE 2: If ETag exists, test conditional request (If-None-Match)
    // ════════════════════════════════════════════════════════════
    if (etag) {
        console.log('\n' + '═'.repeat(60));
        console.log('PROBE 2: Conditional request with If-None-Match');
        console.log('═'.repeat(60));

        const probe2 = await page.evaluate(async ({ base, sid, fid, etag }) => {
            const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
            const resp = await fetch(`${base}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false`, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': csrf,
                    'If-None-Match': etag
                }
            });
            const headers = {};
            resp.headers.forEach((v, k) => { headers[k] = v; });
            let body = null;
            try { body = await resp.text(); } catch {}
            return { status: resp.status, statusText: resp.statusText, headers, bodyLength: body?.length || 0 };
        }, { base: BASE, sid: ids.sid, fid: ids.fid, etag });

        console.log(`Status: ${probe2.status} ${probe2.statusText}`);
        console.log(`Body length: ${probe2.bodyLength} bytes`);
        if (probe2.status === 304) {
            console.log('\n\x1b[42m\x1b[30m ★★★ 304 NOT MODIFIED — ETag conditional requests WORK! ★★★ \x1b[0m');
            console.log('This means: send If-None-Match → get 304 (no body) when nothing changed.');
            console.log('Only get a full 200 response when availability actually changes.');
        } else {
            console.log(`\nServer returned ${probe2.status} instead of 304.`);
            console.log('ETag header exists but conditional requests may not be honored.');
        }
    }

    // ════════════════════════════════════════════════════════════
    // PROBE 3: If Last-Modified exists, test If-Modified-Since
    // ════════════════════════════════════════════════════════════
    if (lastMod) {
        console.log('\n' + '═'.repeat(60));
        console.log('PROBE 3: Conditional request with If-Modified-Since');
        console.log('═'.repeat(60));

        const probe3 = await page.evaluate(async ({ base, sid, fid, lastMod }) => {
            const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
            const resp = await fetch(`${base}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false`, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': csrf,
                    'If-Modified-Since': lastMod
                }
            });
            let body = null;
            try { body = await resp.text(); } catch {}
            return { status: resp.status, bodyLength: body?.length || 0 };
        }, { base: BASE, sid: ids.sid, fid: ids.fid, lastMod });

        console.log(`Status: ${probe3.status}`);
        console.log(`Body length: ${probe3.bodyLength} bytes`);
        if (probe3.status === 304) {
            console.log('\n\x1b[42m\x1b[30m ★★★ 304 — If-Modified-Since also works! ★★★ \x1b[0m');
        }
    }

    // ════════════════════════════════════════════════════════════
    // PROBE 4: Cache-buster query param — does server still respond?
    // ════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(60));
    console.log('PROBE 4: Cache-buster param (&_=timestamp)');
    console.log('═'.repeat(60));

    const probe4 = await page.evaluate(async ({ base, sid, fid }) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        const ts = Date.now();
        const resp = await fetch(`${base}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false&_=${ts}`, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            }
        });
        const body = await resp.json();
        const headers = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        return { status: resp.status, bodyCount: body?.length || 0, url: `...&_=${ts}`, headers };
    }, { base: BASE, sid: ids.sid, fid: ids.fid });

    console.log(`Status: ${probe4.status}`);
    console.log(`Body: Array[${probe4.bodyCount}]`);
    console.log(`URL used: ${probe4.url}`);
    if (probe4.status === 200 && probe4.bodyCount > 0) {
        console.log('\x1b[32m✅ Cache-buster accepted — server ignores the extra param\x1b[0m');
    } else {
        console.log('\x1b[31m❌ Cache-buster broke the request\x1b[0m');
    }

    // ════════════════════════════════════════════════════════════
    // PROBE 5: Random param noise — multiple variations
    // ════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(60));
    console.log('PROBE 5: Random param noise variations');
    console.log('═'.repeat(60));

    const noiseParams = [
        `&r=${Math.random().toString(36).substring(7)}`,
        `&cb=${Date.now()}&v=1`,
        `&nocache=${Math.floor(Math.random() * 999999)}`,
        `&_t=${Date.now()}&_r=${Math.random()}`
    ];

    for (const noise of noiseParams) {
        const result = await page.evaluate(async ({ base, sid, fid, noise }) => {
            const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
            const resp = await fetch(`${base}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false${noise}`, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'X-Requested-With': 'XMLHttpRequest',
                    'X-CSRF-Token': csrf
                }
            });
            const body = await resp.json();
            return { status: resp.status, count: body?.length || 0 };
        }, { base: BASE, sid: ids.sid, fid: ids.fid, noise });

        const ok = result.status === 200 && result.count > 0;
        console.log(`  ${ok ? '✅' : '❌'} ${noise.padEnd(40)} → ${result.status}, Array[${result.count}]`);
    }

    // ════════════════════════════════════════════════════════════
    // SUMMARY
    // ════════════════════════════════════════════════════════════
    console.log('\n' + '█'.repeat(60));
    console.log('  HEADER PROBE SUMMARY');
    console.log('█'.repeat(60));
    console.log(`  ETag:             ${etag || 'NOT PRESENT'}`);
    console.log(`  Last-Modified:    ${lastMod || 'NOT PRESENT'}`);
    console.log(`  Cache-Control:    ${probe1.headers['cache-control'] || 'NOT PRESENT'}`);
    console.log(`  Vary:             ${probe1.headers['vary'] || 'NOT PRESENT'}`);
    console.log(`  Rate-Limit hdrs:  ${Object.keys(probe1.headers).filter(k => k.toLowerCase().includes('rate') || k.toLowerCase().includes('retry')).join(', ') || 'NONE'}`);
    console.log(`  Cache-buster:     ${probe4.status === 200 ? '✅ WORKS' : '❌ BROKEN'}`);
    console.log('█'.repeat(60) + '\n');

    await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
