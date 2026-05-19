/**
 * API Probe — Endpoint Discovery & Response Shape Finder
 *
 * PURPOSE: Instead of hitting /days/{fid}.json 240 times/min and getting
 * rate-limited, this script discovers if the site exposes ANY alternative
 * endpoints that return availability data in a richer format — like:
 *   - Monthly availability calendars
 *   - Availability windows / ranges
 *   - Bulk facility availability
 *   - Different query params that change response shape
 *
 * It logs in once, extracts session info, then systematically probes
 * every plausible endpoint variation and records what comes back.
 *
 * Usage: node api-probe.js
 *        node api-probe.js --headless    (run headless)
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
    credentials: {
        email: process.env.VISA_EMAIL,
        password: process.env.VISA_PASSWORD
    },
    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
        city: process.env.PREFERRED_CITY || 'Toronto'
    },
    proxy: {
        enabled: process.env.PROXY_ENABLED !== 'false',
        server: process.env.PROXY_SERVER || 'pr.oxylabs.io:7777',
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
    },
    headless: process.argv.includes('--headless')
};

// ============================================================================
// LOGGING
// ============================================================================
function log(msg, level = 'INFO') {
    const ts = new Date().toISOString().substring(11, 23);
    const c = { INFO: '\x1b[36m', OK: '\x1b[32m', WARN: '\x1b[33m', ERR: '\x1b[31m', PROBE: '\x1b[35m', HIT: '\x1b[42m\x1b[30m', MISS: '\x1b[90m' };
    console.log(`${c[level] || ''}[${ts}] [${level}] ${msg}\x1b[0m`);
}

// ============================================================================
// RESULTS STORE
// ============================================================================
const results = {
    meta: { startedAt: new Date().toISOString(), baseUrl: CONFIG.preferences.baseUrl },
    session: {},
    probes: [],       // every endpoint we tried
    hits: [],         // endpoints that returned useful data (non-404, non-redirect)
    goldmine: []      // endpoints with availability/calendar/date data we didn't know about
};

// ============================================================================
// LOGIN (from nothang.js — with quote-stripped password fix)
// ============================================================================
async function login(page) {
    log('Logging in...');
    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#user_email', { timeout: 30000 });

    const bodyText = await page.innerText('body').catch(() => '');
    if (bodyText.toLowerCase().includes('system is busy')) throw new Error('SYSTEM_BUSY');
    if (bodyText.includes('account is locked')) throw new Error('ACCOUNT_LOCKED');

    await page.fill('#user_email', CONFIG.credentials.email);
    await page.fill('#user_password', CONFIG.credentials.password);

    try { await page.click('label[for="policy_confirmed"]', { timeout: 2000 }); }
    catch { await page.click('#policy_confirmed', { force: true }).catch(() => {}); }

    await page.click('input[type="submit"]');

    try {
        const okBtn = page.locator('button:has-text("OK"), a:has-text("OK")');
        if (await okBtn.isVisible({ timeout: 3000 })) {
            await okBtn.click();
            await page.click('.icheckbox', { force: true }).catch(() => {});
            await page.click('input[type="submit"]');
        }
    } catch {}

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    if (page.url().includes('sign_in')) throw new Error('LOGIN_FAILED');
    log('Login OK', 'OK');
}

// ============================================================================
// NAVIGATE & EXTRACT SESSION IDs
// ============================================================================
async function extractSession(page) {
    log('Navigating to appointment page to extract session...');

    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 20000 });
    await page.click(continueBtn);
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    // Get all facilities (not just preferred city)
    const allFacilities = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.filter(o => o.value).map(o => ({ text: o.innerText.trim(), value: o.value }))
    );

    // Select preferred city
    const target = allFacilities.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
    if (target) await page.selectOption(facilitySelector, target.value);

    const ids = await page.evaluate(() => {
        const url = window.location.href;
        const scheduleMatch = url.match(/schedule\/(\d+)/);
        const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        return {
            scheduleId: scheduleMatch ? scheduleMatch[1] : null,
            facilityId: facilitySelect ? facilitySelect.value : null,
            csrf: csrf
        };
    });

    // Also scrape the full page HTML for hidden endpoints/JS routes
    const pageHtml = await page.content();
    const hiddenEndpoints = extractEndpointsFromHtml(pageHtml);

    // Get all link hrefs and form actions on the page
    const pageLinks = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a[href]')].map(a => a.href);
        const forms = [...document.querySelectorAll('form[action]')].map(f => f.action);
        const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src);
        return { links, forms, scripts };
    });

    results.session = {
        scheduleId: ids.scheduleId,
        facilityId: ids.facilityId,
        csrfToken: ids.csrf,
        allFacilities: allFacilities,
        currentUrl: page.url(),
        hiddenEndpoints: hiddenEndpoints,
        pageLinks: pageLinks.links.filter(l => l.includes('usvisa')),
        pageForms: pageLinks.forms
    };

    log(`Session → schedule: ${ids.scheduleId}, facility: ${ids.facilityId}`, 'OK');
    log(`Found ${allFacilities.length} facilities, ${hiddenEndpoints.length} hidden endpoints`, 'INFO');

    return ids;
}

function extractEndpointsFromHtml(html) {
    const patterns = [
        /["'](\/en-ca\/niv\/[^"'?\s]+)/g,
        /["'](\/schedule\/[^"'?\s]+)/g,
        /["'](\/api\/[^"'?\s]+)/g,
        /url:\s*["']([^"']+)/g,
        /href:\s*["']([^"']+)/g,
        /action:\s*["']([^"']+)/g,
        /\.ajax\(\s*\{[^}]*url:\s*["']([^"']+)/g,
        /fetch\(["']([^"']+)/g
    ];
    const found = new Set();
    for (const p of patterns) {
        let m;
        while ((m = p.exec(html)) !== null) {
            found.add(m[1]);
        }
    }
    return [...found];
}

// ============================================================================
// THE PROBE ENGINE — tries every plausible endpoint variation
// ============================================================================
async function probeEndpoint(page, label, urlPath, queryParams = {}, method = 'GET', postBody = null) {
    const baseUrl = CONFIG.preferences.baseUrl;
    const sid = results.session.scheduleId;
    const fid = results.session.facilityId;
    const csrf = results.session.csrfToken;

    // Replace placeholders
    let url = urlPath
        .replace('{sid}', sid)
        .replace('{fid}', fid);

    // If relative, prepend base
    if (!url.startsWith('http')) {
        url = baseUrl + (url.startsWith('/') ? '' : '/') + url;
    }

    // Add query params
    const qs = new URLSearchParams(queryParams).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;

    const probe = {
        label,
        url,
        method,
        queryParams,
        postBody,
        status: null,
        contentType: null,
        responseShape: null,
        body: null,
        isHit: false,
        isGoldmine: false,
        error: null,
        latencyMs: null
    };

    const start = Date.now();

    try {
        const result = await page.evaluate(async ({ url, method, csrf, postBody }) => {
            try {
                const opts = {
                    method,
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json, text/html, */*',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-Token': csrf || ''
                    }
                };
                if (postBody) {
                    opts.body = typeof postBody === 'string' ? postBody : JSON.stringify(postBody);
                    opts.headers['Content-Type'] = 'application/json';
                }

                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);
                opts.signal = controller.signal;

                const resp = await fetch(url, opts);
                clearTimeout(timeout);

                const ct = resp.headers.get('content-type') || '';
                let body;
                if (ct.includes('json')) {
                    body = await resp.json();
                } else {
                    const text = await resp.text();
                    body = text.substring(0, 3000);
                }

                return {
                    status: resp.status,
                    statusText: resp.statusText,
                    contentType: ct,
                    body,
                    redirected: resp.redirected,
                    finalUrl: resp.url
                };
            } catch (e) {
                return { error: e.message };
            }
        }, { url, method, csrf, postBody });

        probe.latencyMs = Date.now() - start;

        if (result.error) {
            probe.error = result.error;
            probe.status = 'ERROR';
        } else {
            probe.status = result.status;
            probe.contentType = result.contentType;
            probe.body = result.body;
            probe.redirected = result.redirected;
            probe.finalUrl = result.finalUrl;

            // Analyze what we got back
            probe.responseShape = analyzeShape(result.body, result.contentType);

            // Is it a hit? (non-404, non-redirect-to-login, non-error)
            const isUseful = result.status >= 200 && result.status < 400
                && !result.finalUrl?.includes('sign_in')
                && !(typeof result.body === 'string' && result.body.includes('sign_in'));

            probe.isHit = isUseful;

            // Is it a GOLDMINE? (contains date/availability/calendar data we can use)
            if (isUseful) {
                probe.isGoldmine = isGoldmineResponse(result.body, result.contentType);
            }
        }

    } catch (e) {
        probe.error = e.message;
        probe.latencyMs = Date.now() - start;
    }

    // Log it
    if (probe.isGoldmine) {
        log(`★ GOLDMINE: ${label} → ${probe.status} | ${probe.responseShape}`, 'HIT');
    } else if (probe.isHit) {
        log(`✓ HIT: ${label} → ${probe.status} | ${probe.responseShape}`, 'OK');
    } else {
        log(`✗ ${label} → ${probe.status || 'ERR'} ${probe.error || ''}`, 'MISS');
    }

    results.probes.push(probe);
    if (probe.isHit) results.hits.push(probe);
    if (probe.isGoldmine) results.goldmine.push(probe);

    return probe;
}

function analyzeShape(body, contentType) {
    if (!body) return 'empty';
    if (typeof body === 'string') {
        if (contentType?.includes('html')) {
            const titleMatch = body.match(/<title[^>]*>([^<]+)/i);
            return `HTML: "${titleMatch?.[1]?.trim() || 'unknown'}"`;
        }
        return `text(${body.length} chars)`;
    }
    if (Array.isArray(body)) {
        if (body.length === 0) return 'Array[0] (empty)';
        const keys = typeof body[0] === 'object' ? Object.keys(body[0]).join(',') : typeof body[0];
        return `Array[${body.length}] of {${keys}}`;
    }
    if (typeof body === 'object') {
        const keys = Object.keys(body);
        return `Object{${keys.join(',')}}`;
    }
    return typeof body;
}

function isGoldmineResponse(body, contentType) {
    if (!body || typeof body === 'string') return false;

    const json = JSON.stringify(body).toLowerCase();

    // Look for date/availability/calendar signals in the response
    const goldSignals = [
        'date', 'available', 'appointment', 'slot', 'calendar',
        'open', 'booked', 'capacity', 'remaining', 'facility',
        'time', 'schedule', 'consulate', 'business_day'
    ];

    let hits = 0;
    for (const signal of goldSignals) {
        if (json.includes(signal)) hits++;
    }

    // If we see multiple date/availability signals, it's gold
    return hits >= 2;
}

// ============================================================================
// PROBE DEFINITIONS — Every plausible endpoint variation
// ============================================================================
async function runAllProbes(page) {
    const sid = results.session.scheduleId;
    const fid = results.session.facilityId;
    const allFacilities = results.session.allFacilities;

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 1: Known endpoints with different params', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // 1a. The known days endpoint (baseline)
    await probeEndpoint(page, 'BASELINE: days.json (known)', `/schedule/{sid}/appointment/days/{fid}.json`, { 'appointments[expedite]': 'false' });

    // 1b. Days WITHOUT expedite param — does it change response?
    await probeEndpoint(page, 'days.json (no expedite)', `/schedule/{sid}/appointment/days/{fid}.json`);

    // 1c. Days WITH expedite=true — different availability?
    await probeEndpoint(page, 'days.json (expedite=true)', `/schedule/{sid}/appointment/days/{fid}.json`, { 'appointments[expedite]': 'true' });

    // 1d. Days with date range params — can we ask for a window?
    const today = new Date().toISOString().split('T')[0];
    const twoMonths = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await probeEndpoint(page, 'days.json (start_date param)', `/schedule/{sid}/appointment/days/{fid}.json`, { start_date: today, end_date: twoMonths });
    await probeEndpoint(page, 'days.json (from/to params)', `/schedule/{sid}/appointment/days/{fid}.json`, { from: today, to: twoMonths });
    await probeEndpoint(page, 'days.json (month param)', `/schedule/{sid}/appointment/days/{fid}.json`, { month: new Date().getMonth() + 1, year: new Date().getFullYear() });
    await probeEndpoint(page, 'days.json (date range)', `/schedule/{sid}/appointment/days/{fid}.json`, { 'date_range[start]': today, 'date_range[end]': twoMonths });

    // 1e. The known times endpoint (baseline)
    await probeEndpoint(page, 'BASELINE: times.json', `/schedule/{sid}/appointment/times/{fid}.json`, { date: today, 'appointments[expedite]': 'false' });

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 2: Alternative endpoint patterns (Rails conventions)', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // 2a. Appointment resource as JSON — might return full availability
    await probeEndpoint(page, 'appointment.json (full resource)', `/schedule/{sid}/appointment.json`);

    // 2b. Schedule resource as JSON
    await probeEndpoint(page, 'schedule.json', `/schedule/{sid}.json`);

    // 2c. Availability-specific endpoints
    await probeEndpoint(page, 'appointment/availability.json', `/schedule/{sid}/appointment/availability.json`);
    await probeEndpoint(page, 'appointment/available.json', `/schedule/{sid}/appointment/available.json`);
    await probeEndpoint(page, 'appointment/calendar.json', `/schedule/{sid}/appointment/calendar.json`);
    await probeEndpoint(page, 'appointment/slots.json', `/schedule/{sid}/appointment/slots.json`);
    await probeEndpoint(page, 'appointment/openings.json', `/schedule/{sid}/appointment/openings.json`);

    // 2d. Facility-level availability
    await probeEndpoint(page, 'facilities.json', `/schedule/{sid}/appointment/facilities.json`);
    await probeEndpoint(page, 'facilities/{fid}.json', `/schedule/{sid}/appointment/facilities/{fid}.json`);
    await probeEndpoint(page, 'facility_availability.json', `/schedule/{sid}/appointment/facility_availability.json`);

    // 2e. Without /appointment/ prefix
    await probeEndpoint(page, 'schedule/days.json', `/schedule/{sid}/days.json`);
    await probeEndpoint(page, 'schedule/times.json', `/schedule/{sid}/times.json`);
    await probeEndpoint(page, 'schedule/availability.json', `/schedule/{sid}/availability.json`);
    await probeEndpoint(page, 'schedule/calendar.json', `/schedule/{sid}/calendar.json`);
    await probeEndpoint(page, 'schedule/slots.json', `/schedule/{sid}/slots.json`);

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 3: Bulk / multi-facility endpoints', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // 3a. Days without facility ID — maybe returns all facilities?
    await probeEndpoint(page, 'days.json (no facility)', `/schedule/{sid}/appointment/days.json`, { 'appointments[expedite]': 'false' });
    await probeEndpoint(page, 'times.json (no facility)', `/schedule/{sid}/appointment/times.json`, { date: today });

    // 3b. All facilities in one call
    if (allFacilities.length > 1) {
        const facilityIds = allFacilities.map(f => f.value).join(',');
        await probeEndpoint(page, 'days.json (multiple facilities)', `/schedule/{sid}/appointment/days/{fid}.json`, { facility_ids: facilityIds, 'appointments[expedite]': 'false' });
        await probeEndpoint(page, 'days.json (facilities[] param)', `/schedule/{sid}/appointment/days.json`, { 'facilities[]': allFacilities[0]?.value, 'appointments[expedite]': 'false' });
    }

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 4: Accept header variations (same URL, different format)', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // 4a. Appointment page WITHOUT .json — does the HTML embed availability data?
    await probeEndpoint(page, 'appointment page (HTML)', `/schedule/{sid}/appointment`);

    // 4b. XML format?
    await probeEndpoint(page, 'days.xml', `/schedule/{sid}/appointment/days/{fid}.xml`, { 'appointments[expedite]': 'false' });

    // 4c. CSV format?
    await probeEndpoint(page, 'days.csv', `/schedule/{sid}/appointment/days/{fid}.csv`);

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 5: API-style and REST variations', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // 5a. /api/ prefix pattern
    await probeEndpoint(page, '/api/appointments', `/api/appointments`);
    await probeEndpoint(page, '/api/schedule/{sid}', `/api/schedule/{sid}`);
    await probeEndpoint(page, '/api/availability', `/api/availability`);

    // 5b. Nested REST patterns
    await probeEndpoint(page, 'appointment/days (no ext)', `/schedule/{sid}/appointment/days/{fid}`);
    await probeEndpoint(page, 'continue_actions.json', `/schedule/{sid}/continue_actions.json`);
    await probeEndpoint(page, 'payment.json', `/schedule/{sid}/payment.json`);

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 6: POST-based queries (some Rails apps use POST for search)', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // 6a. POST to days endpoint with body
    await probeEndpoint(page, 'POST days.json (date range body)', `/schedule/{sid}/appointment/days/{fid}.json`, {},
        'POST', { start_date: today, end_date: twoMonths, expedite: false });

    await probeEndpoint(page, 'POST appointment.json (search)', `/schedule/{sid}/appointment.json`, {},
        'POST', { facility_id: fid, start_date: today, end_date: twoMonths });

    // 6b. POST availability query
    await probeEndpoint(page, 'POST availability.json', `/schedule/{sid}/appointment/availability.json`, {},
        'POST', { facility_id: fid, months: 2 });

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 7: Probing hidden endpoints found in page HTML/JS', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    // Probe any endpoints we extracted from the HTML
    const hiddenEps = results.session.hiddenEndpoints || [];
    const probed = new Set();
    for (const ep of hiddenEps) {
        // Skip if already probed or if it's a static asset
        if (probed.has(ep)) continue;
        if (/\.(css|js|png|jpg|svg|woff|ico)/.test(ep)) continue;
        probed.add(ep);

        // Try both raw and .json version
        await probeEndpoint(page, `hidden: ${ep}`, ep);

        if (!ep.endsWith('.json') && !ep.includes('.')) {
            await probeEndpoint(page, `hidden+json: ${ep}.json`, `${ep}.json`);
        }
    }

    log('\n══════════════════════════════════════════════════════════════', 'INFO');
    log('PHASE 8: Each facility — probe availability across all cities', 'PROBE');
    log('══════════════════════════════════════════════════════════════', 'INFO');

    for (const facility of allFacilities) {
        if (facility.value === fid) continue; // already probed
        await probeEndpoint(page, `days.json → ${facility.text}`,
            `/schedule/{sid}/appointment/days/${facility.value}.json`,
            { 'appointments[expedite]': 'false' });
    }
}

// ============================================================================
// EXPORT RESULTS
// ============================================================================
function exportResults() {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `api-probe-${ts}.json`;
    const outputPath = path.join(__dirname, filename);
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

    // Console report
    console.log('\n' + '█'.repeat(70));
    console.log('  API PROBE — FINAL REPORT');
    console.log('█'.repeat(70));
    console.log(`\n  Total probed:    ${results.probes.length}`);
    console.log(`  Hits (200-3xx):  ${results.hits.length}`);
    console.log(`  ★ GOLDMINES:     ${results.goldmine.length}`);

    if (results.goldmine.length > 0) {
        console.log('\n  ★★★ GOLDMINE ENDPOINTS (contain availability/date data) ★★★');
        console.log('  ' + '─'.repeat(66));
        for (const g of results.goldmine) {
            console.log(`\n  ${g.label}`);
            console.log(`    URL:      ${g.url}`);
            console.log(`    Method:   ${g.method}`);
            console.log(`    Status:   ${g.status}`);
            console.log(`    Shape:    ${g.responseShape}`);
            console.log(`    Latency:  ${g.latencyMs}ms`);
            if (g.queryParams && Object.keys(g.queryParams).length) {
                console.log(`    Params:   ${JSON.stringify(g.queryParams)}`);
            }
            // Print first 500 chars of body for inspection
            const preview = typeof g.body === 'string' ? g.body.substring(0, 500) : JSON.stringify(g.body).substring(0, 500);
            console.log(`    Body:     ${preview}`);
        }
    }

    if (results.hits.length > 0) {
        console.log('\n  All Hits:');
        console.log('  ' + '─'.repeat(66));
        for (const h of results.hits) {
            const gold = h.isGoldmine ? ' ★' : '';
            console.log(`    ${h.method.padEnd(5)} ${String(h.status).padEnd(4)} ${h.label}${gold}`);
            console.log(`           ${h.responseShape}`);
        }
    }

    console.log(`\n  Full results → ${filename}`);
    console.log('█'.repeat(70) + '\n');

    return outputPath;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    log('API Probe — Endpoint Discovery Starting...', 'OK');

    let browser;
    try {
        const launchOpts = {
            headless: CONFIG.headless,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
        };
        if (!CONFIG.headless) launchOpts.channel = 'chrome';

        if (CONFIG.proxy.enabled && CONFIG.proxy.username) {
            launchOpts.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            };
        }

        browser = await chromium.launch(launchOpts);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 },
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });
        const page = await context.newPage();

        // Login
        await login(page);

        // Extract session (navigate to appointment page, get IDs, scrape hidden endpoints)
        await extractSession(page);

        // Run all probes
        await runAllProbes(page);

        // Export
        exportResults();

    } catch (err) {
        log(`Fatal: ${err.message}`, 'ERR');
        console.error(err.stack);
        if (results.probes.length > 0) {
            log('Exporting partial results...', 'WARN');
            exportResults();
        }
    } finally {
        if (browser) await browser.close();
    }
}

main();
