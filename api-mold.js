/**
 * API Mold - Full Network Recon & API Catalog Builder
 *
 * Instead of fetching dates directly, this script:
 * 1. Logs in (same pattern as nothang.js)
 * 2. Navigates through the appointment flow
 * 3. Intercepts EVERY network request/response
 * 4. Builds a full API catalog with: payload, headers, response, preview, timing, cookies
 * 5. Exports the catalog to a JSON file so you can "mold" your own fetches later
 *
 * Usage:
 *   node api-mold.js                  # Full recon (login → navigate → capture all)
 *   node api-mold.js --pages          # Also visit extra pages (groups, payments, etc.)
 *   node api-mold.js --trigger-dates  # Also trigger date/time fetches to capture those APIs
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// CONFIGURATION (mirrors nothang.js)
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
    bot: {
        headless: process.env.HEADLESS === 'true'
    }
};

// ============================================================================
// CLI FLAGS
// ============================================================================
const ARGS = {
    visitExtraPages: process.argv.includes('--pages'),
    triggerDates:    process.argv.includes('--trigger-dates'),
    verbose:         process.argv.includes('--verbose') || process.argv.includes('-v')
};

// ============================================================================
// LOGGING
// ============================================================================
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const colors = {
        'INFO':    '\x1b[36m',
        'SUCCESS': '\x1b[32m',
        'WARN':    '\x1b[33m',
        'ERROR':   '\x1b[31m',
        'API':     '\x1b[35m',
        'CAPTURE': '\x1b[44m'
    };
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${message}\x1b[0m`);
}

// ============================================================================
// API CATALOG - The core data structure
// ============================================================================
const apiCatalog = {
    meta: {
        capturedAt: new Date().toISOString(),
        baseUrl: CONFIG.preferences.baseUrl,
        account: CONFIG.credentials.email,
        city: CONFIG.preferences.city,
        totalCaptured: 0
    },
    session: {
        cookies: [],
        csrfToken: null,
        scheduleId: null,
        facilityId: null,
        userAgent: null
    },
    apis: []       // Each entry is a full request/response record
};

// Dedup tracker — avoid logging the same endpoint pattern repeatedly
const seenPatterns = new Map();

// ============================================================================
// REQUEST/RESPONSE INTERCEPTOR
// ============================================================================
function setupFullInterceptor(page) {
    // ---- Capture REQUESTS ----
    page.on('request', (request) => {
        const url = request.url();
        // Skip noise: images, fonts, analytics, static assets
        if (shouldSkipUrl(url)) return;

        const entry = {
            id: apiCatalog.apis.length + 1,
            timestamp: new Date().toISOString(),
            // Request details
            request: {
                method: request.method(),
                url: url,
                urlPattern: extractPattern(url),
                headers: request.headers(),
                postData: request.postData() || null,
                resourceType: request.resourceType()
            },
            // Will be filled when response arrives
            response: null,
            timing: {
                requestedAt: Date.now(),
                respondedAt: null,
                latencyMs: null
            },
            // Human-readable preview (filled on response)
            preview: null,
            // Tags for easy filtering
            tags: classifyRequest(url, request.method())
        };

        // Store temporarily keyed by URL so we can match the response
        page.__pendingRequests = page.__pendingRequests || new Map();
        page.__pendingRequests.set(url, entry);
    });

    // ---- Capture RESPONSES ----
    page.on('response', async (response) => {
        const url = response.url();
        if (shouldSkipUrl(url)) return;

        const pending = page.__pendingRequests?.get(url);
        if (!pending) return;
        page.__pendingRequests.delete(url);

        try {
            const status = response.status();
            const responseHeaders = response.headers();
            const contentType = responseHeaders['content-type'] || '';
            let body = null;
            let preview = null;

            // Try to read body
            try {
                if (contentType.includes('json')) {
                    body = await response.json();
                    preview = generateJsonPreview(body);
                } else if (contentType.includes('html')) {
                    const text = await response.text();
                    body = text.substring(0, 2000) + (text.length > 2000 ? '... [TRUNCATED]' : '');
                    preview = generateHtmlPreview(text);
                } else if (contentType.includes('text')) {
                    body = await response.text();
                    preview = body.substring(0, 300);
                } else {
                    body = `[Binary: ${contentType}, size unknown]`;
                    preview = body;
                }
            } catch (e) {
                body = `[Could not read body: ${e.message}]`;
                preview = body;
            }

            // Fill in response data
            pending.response = {
                status: status,
                statusText: response.statusText(),
                headers: responseHeaders,
                contentType: contentType,
                body: body
            };
            pending.timing.respondedAt = Date.now();
            pending.timing.latencyMs = pending.timing.respondedAt - pending.timing.requestedAt;
            pending.preview = preview;

            // Dedup: only log unique patterns
            const pattern = `${pending.request.method} ${pending.request.urlPattern}`;
            const count = (seenPatterns.get(pattern) || 0) + 1;
            seenPatterns.set(pattern, count);

            apiCatalog.apis.push(pending);
            apiCatalog.meta.totalCaptured = apiCatalog.apis.length;

            if (count <= 2 || ARGS.verbose) {
                log(`[#${pending.id}] ${pending.request.method} ${status} ${shortenUrl(url)} (${pending.timing.latencyMs}ms)`, 'API');
                if (ARGS.verbose && preview) {
                    log(`  └─ Preview: ${preview.substring(0, 120)}`, 'CAPTURE');
                }
            } else if (count === 3) {
                log(`  ... suppressing further logs for: ${pattern} (seen ${count}x)`, 'INFO');
            }
        } catch (e) {
            // Non-critical, just skip
        }
    });

    log('Full network interceptor attached', 'SUCCESS');
}

// ============================================================================
// URL FILTERING & CLASSIFICATION
// ============================================================================
function shouldSkipUrl(url) {
    const skipPatterns = [
        /\.(png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)(\?|$)/i,
        /google-analytics|googletagmanager|facebook\.net|doubleclick/i,
        /fonts\.googleapis|cdn\.jsdelivr|cloudflare/i,
        /favicon/i,
        /hot-update/i
    ];
    return skipPatterns.some(p => p.test(url));
}

function extractPattern(url) {
    // Replace numeric IDs with {id} placeholders for pattern matching
    return url
        .replace(/\/\d{5,}\//g, '/{id}/')
        .replace(/\/\d{5,}\./g, '/{id}.')
        .replace(/\/\d{5,}$/g, '/{id}')
        .replace(/\?.*$/, '');  // Strip query params for pattern
}

function classifyRequest(url, method) {
    const tags = [];
    if (url.includes('sign_in'))              tags.push('auth', 'login');
    if (url.includes('sign_out'))             tags.push('auth', 'logout');
    if (url.includes('appointment'))          tags.push('appointment');
    if (url.includes('days'))                 tags.push('dates', 'availability');
    if (url.includes('times'))               tags.push('times', 'availability');
    if (url.includes('.json'))                tags.push('api', 'json');
    if (url.includes('schedule'))             tags.push('schedule');
    if (url.includes('payment'))              tags.push('payment');
    if (url.includes('group'))               tags.push('group');
    if (url.includes('csrf') || url.includes('token'))  tags.push('security');
    if (url.includes('user'))                tags.push('user');
    if (url.includes('facility'))            tags.push('facility');
    if (url.includes('niv'))                 tags.push('niv');
    if (method === 'POST')                   tags.push('mutation');
    if (method === 'GET' && url.includes('.json')) tags.push('data-fetch');
    if (url.includes('expedite'))            tags.push('expedite');
    return [...new Set(tags)];
}

function shortenUrl(url) {
    try {
        const u = new URL(url);
        return u.pathname + (u.search ? u.search.substring(0, 60) : '');
    } catch {
        return url.substring(0, 100);
    }
}

// ============================================================================
// PREVIEW GENERATORS
// ============================================================================
function generateJsonPreview(data) {
    if (Array.isArray(data)) {
        if (data.length === 0) return '[] (empty array)';
        const first = JSON.stringify(data[0]).substring(0, 200);
        return `Array[${data.length}] → first: ${first}`;
    }
    if (typeof data === 'object' && data !== null) {
        const keys = Object.keys(data);
        const sample = JSON.stringify(data).substring(0, 300);
        return `Object{${keys.length} keys: ${keys.slice(0, 8).join(', ')}} → ${sample}`;
    }
    return String(data).substring(0, 200);
}

function generateHtmlPreview(html) {
    // Pull page title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'No title';
    // Pull any flash messages or form elements
    const formCount = (html.match(/<form/gi) || []).length;
    const inputCount = (html.match(/<input/gi) || []).length;
    return `HTML Page: "${title}" | ${formCount} forms, ${inputCount} inputs`;
}

// ============================================================================
// LOGIN (same as nothang.js)
// ============================================================================
async function login(page) {
    log('Logging in...');

    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });

    const pageText = await page.innerText('body').catch(() => '');
    if (pageText.toLowerCase().includes('system is busy') || pageText.toLowerCase().includes('too many requests')) {
        throw new Error('SYSTEM_BUSY');
    }
    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    await page.fill('#user_email', CONFIG.credentials.email);
    await page.fill('#user_password', CONFIG.credentials.password);

    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await page.click('input[type="submit"]');

    // Handle error modal (nothang.js pattern)
    try {
        const okButton = page.locator('button:has-text("OK"), a:has-text("OK")');
        if (await okButton.isVisible({ timeout: 3000 })) {
            await okButton.click();
            await page.click('.icheckbox', { force: true }).catch(() => {});
            await page.click('input[type="submit"]');
        }
    } catch {}

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (page.url().includes('sign_in')) {
        throw new Error('LOGIN_FAILED');
    }

    log('Login successful!', 'SUCCESS');
}

// ============================================================================
// NAVIGATE TO APPOINTMENT PAGE & EXTRACT IDs (same as nothang.js)
// ============================================================================
async function navigateToAppointmentPage(page) {
    log('Navigating to appointment page...');

    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 20000 });
    await page.click(continueBtn);
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Select city
    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    const options = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
    );
    const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
    if (target) {
        await page.selectOption(facilitySelector, target.value);
        log(`Selected city: ${target.text}`, 'SUCCESS');
    }

    // Extract IDs
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

    apiCatalog.session.scheduleId = ids.scheduleId;
    apiCatalog.session.facilityId = ids.facilityId;
    apiCatalog.session.csrfToken = ids.csrf;

    log(`Extracted → schedule: ${ids.scheduleId}, facility: ${ids.facilityId}, csrf: ${ids.csrf ? ids.csrf.substring(0, 20) + '...' : 'N/A'}`, 'INFO');
    return ids;
}

// ============================================================================
// TRIGGER DATE/TIME FETCHES (so we capture those APIs in the catalog)
// ============================================================================
async function triggerDateFetches(page) {
    log('Triggering date/time API calls for capture...');

    const { scheduleId: sid, facilityId: fid, csrfToken: csrf } = apiCatalog.session;
    if (!sid || !fid) {
        log('Missing scheduleId or facilityId — skipping date triggers', 'WARN');
        return;
    }

    // Fire days endpoint
    log('Fetching available days...', 'API');
    await page.evaluate(({ baseUrl, sid, fid }) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        return fetch(`${baseUrl}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false`, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            }
        }).then(r => r.json());
    }, { baseUrl: CONFIG.preferences.baseUrl, sid, fid });

    await page.waitForTimeout(1000);

    // Fire times endpoint with a sample date
    const sampleDate = new Date().toISOString().split('T')[0];
    log(`Fetching available times (sample date: ${sampleDate})...`, 'API');
    await page.evaluate(({ baseUrl, sid, fid, date }) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        return fetch(`${baseUrl}/schedule/${sid}/appointment/times/${fid}.json?date=${date}&appointments[expedite]=false`, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            }
        }).then(r => r.json());
    }, { baseUrl: CONFIG.preferences.baseUrl, sid, fid, date: sampleDate });

    await page.waitForTimeout(1000);
    log('Date/time API calls captured', 'SUCCESS');
}

// ============================================================================
// VISIT EXTRA PAGES (to discover more APIs)
// ============================================================================
async function visitExtraPages(page) {
    log('Visiting extra pages to discover more APIs...');

    const sid = apiCatalog.session.scheduleId;
    if (!sid) return;

    const baseUrl = CONFIG.preferences.baseUrl;
    const extraUrls = [
        `${baseUrl}/schedule/${sid}/appointment`,
        `${baseUrl}/schedule/${sid}/payment`,
        `${baseUrl}/groups`,
        `${baseUrl}/account`,
        `${baseUrl}/schedule/${sid}/continue_actions`
    ];

    for (const url of extraUrls) {
        try {
            log(`  Visiting: ${shortenUrl(url)}`, 'INFO');
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);
        } catch (e) {
            log(`  Skipped (${e.message})`, 'WARN');
        }
    }

    log('Extra page discovery complete', 'SUCCESS');
}

// ============================================================================
// CAPTURE SESSION STATE (cookies, UA, etc.)
// ============================================================================
async function captureSessionState(context, page) {
    log('Capturing session state...');

    apiCatalog.session.cookies = await context.cookies();
    apiCatalog.session.userAgent = await page.evaluate(() => navigator.userAgent);

    // Also capture any interesting meta tags
    const metas = await page.evaluate(() => {
        const results = {};
        document.querySelectorAll('meta[name]').forEach(m => {
            results[m.getAttribute('name')] = m.getAttribute('content');
        });
        return results;
    });
    apiCatalog.session.metaTags = metas;

    log(`Captured ${apiCatalog.session.cookies.length} cookies, UA, and ${Object.keys(metas).length} meta tags`, 'SUCCESS');
}

// ============================================================================
// EXPORT CATALOG
// ============================================================================
function exportCatalog() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `api-catalog-${timestamp}.json`;
    const outputPath = path.join(__dirname, filename);

    // Build summary
    const summary = buildSummary();

    const output = {
        ...apiCatalog,
        summary: summary
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    log(`\nCatalog exported → ${filename}`, 'SUCCESS');
    log(`Total APIs captured: ${apiCatalog.apis.length}`, 'INFO');

    // Also print the summary to console
    printSummary(summary);

    return outputPath;
}

function buildSummary() {
    const byMethod = {};
    const byTag = {};
    const byPattern = {};
    const byStatus = {};

    for (const api of apiCatalog.apis) {
        // By method
        const m = api.request.method;
        byMethod[m] = (byMethod[m] || 0) + 1;

        // By status
        if (api.response) {
            const s = api.response.status;
            byStatus[s] = (byStatus[s] || 0) + 1;
        }

        // By tag
        for (const tag of api.tags) {
            byTag[tag] = (byTag[tag] || 0) + 1;
        }

        // By URL pattern
        const p = api.request.urlPattern;
        byPattern[p] = (byPattern[p] || 0) + 1;
    }

    // Unique API endpoints (deduplicated by method + pattern)
    const uniqueEndpoints = [...new Set(
        apiCatalog.apis.map(a => `${a.request.method} ${a.request.urlPattern}`)
    )].sort();

    // Moldable APIs — the JSON endpoints you can replicate with fetch()
    const moldableApis = apiCatalog.apis
        .filter(a => a.tags.includes('json') || a.tags.includes('api'))
        .reduce((acc, a) => {
            const key = `${a.request.method} ${a.request.urlPattern}`;
            if (!acc.has(key)) {
                acc.set(key, {
                    method: a.request.method,
                    urlPattern: a.request.urlPattern,
                    exampleUrl: a.request.url,
                    requiredHeaders: extractRequiredHeaders(a.request.headers),
                    payload: a.request.postData,
                    responseShape: a.preview,
                    status: a.response?.status,
                    tags: a.tags,
                    latencyMs: a.timing.latencyMs
                });
            }
            return acc;
        }, new Map());

    return {
        byMethod,
        byStatus,
        byTag,
        uniqueEndpoints,
        moldableApis: Object.fromEntries(moldableApis),
        totalUnique: uniqueEndpoints.length,
        totalMoldable: moldableApis.size
    };
}

function extractRequiredHeaders(headers) {
    // Only keep the headers that matter for replication
    const important = ['accept', 'x-requested-with', 'x-csrf-token', 'content-type', 'cookie'];
    const result = {};
    for (const key of important) {
        if (headers[key]) {
            result[key] = key === 'cookie' ? '[SESSION_COOKIES]' : headers[key];
        }
    }
    return result;
}

function printSummary(summary) {
    console.log('\n' + '='.repeat(70));
    console.log('  API MOLD — RECON SUMMARY');
    console.log('='.repeat(70));

    console.log(`\n  Total captured:  ${apiCatalog.apis.length}`);
    console.log(`  Unique endpoints: ${summary.totalUnique}`);
    console.log(`  Moldable (JSON):  ${summary.totalMoldable}`);

    console.log('\n  By Method:');
    for (const [m, c] of Object.entries(summary.byMethod)) {
        console.log(`    ${m.padEnd(8)} → ${c}`);
    }

    console.log('\n  By Status:');
    for (const [s, c] of Object.entries(summary.byStatus).sort()) {
        console.log(`    ${String(s).padEnd(8)} → ${c}`);
    }

    console.log('\n  Moldable APIs (JSON endpoints you can replicate):');
    console.log('  ' + '-'.repeat(66));
    for (const [key, api] of Object.entries(summary.moldableApis)) {
        console.log(`    ${key}`);
        console.log(`      Headers: ${Object.keys(api.requiredHeaders).join(', ')}`);
        if (api.payload) console.log(`      Payload: ${api.payload.substring(0, 80)}`);
        console.log(`      Response: ${api.responseShape?.substring(0, 100) || 'N/A'}`);
        console.log(`      Latency: ${api.latencyMs}ms  Status: ${api.status}`);
        console.log(`      Tags: [${api.tags.join(', ')}]`);
        console.log('');
    }

    console.log('  All Unique Endpoints:');
    console.log('  ' + '-'.repeat(66));
    for (const ep of summary.uniqueEndpoints) {
        console.log(`    ${ep}`);
    }

    console.log('\n' + '='.repeat(70));
    console.log('  Use the exported JSON to build your own fetch() calls.');
    console.log('  Look at summary.moldableApis for ready-to-use templates.');
    console.log('='.repeat(70) + '\n');
}

// ============================================================================
// MAIN
// ============================================================================
async function runRecon() {
    log('API Mold — Full Network Recon Starting...', 'SUCCESS');
    log(`Mode: ${ARGS.visitExtraPages ? '+extra pages ' : ''}${ARGS.triggerDates ? '+trigger dates ' : ''}${ARGS.verbose ? '+verbose' : ''}`, 'INFO');

    let browser;
    try {
        // Launch browser (same config as nothang.js)
        const launchOptions = {
            headless: CONFIG.bot.headless,
            args: [
                '--no-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security'
            ]
        };

        if (CONFIG.proxy.enabled && CONFIG.proxy.username) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            };
            log(`Proxy: ${CONFIG.proxy.server}`, 'INFO');
        }

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        // Attach the full interceptor BEFORE any navigation
        setupFullInterceptor(page);

        // Step 1: Login
        await login(page);

        // Step 2: Navigate to appointment page (captures nav APIs)
        await navigateToAppointmentPage(page);

        // Step 3: Optionally trigger date/time fetches
        if (ARGS.triggerDates) {
            await triggerDateFetches(page);
        }

        // Step 4: Optionally visit extra pages
        if (ARGS.visitExtraPages) {
            await visitExtraPages(page);
        }

        // Step 5: Capture session state
        await captureSessionState(context, page);

        // Step 6: Export the full catalog
        const outputPath = exportCatalog();

        log('Recon complete. You now have a full API map to mold your fetches from.', 'SUCCESS');

    } catch (error) {
        log(`Fatal error: ${error.message}`, 'ERROR');
        console.error(error.stack);

        // Still export what we captured
        if (apiCatalog.apis.length > 0) {
            log('Exporting partial catalog...', 'WARN');
            exportCatalog();
        }
    } finally {
        if (browser) await browser.close();
    }
}

// ============================================================================
// RUN
// ============================================================================
runRecon();
