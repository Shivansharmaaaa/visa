/**
 * US Visa Appointment Bot — HYBRID ETL Architecture
 *
 * Combines nothang.js speed (240 CPM) with ETL intelligence:
 *
 *   EXTRACT  → Pull raw {date, business_day}[] at 240 CPM (fire-and-forget,
 *              same non-blocking pattern as nothang.js)
 *   TRANSFORM → Every response gets molded into availability windows,
 *               change detection, volatility scoring, gap analysis, trends
 *   LOAD     → Decision engine triggers instant booking on match.
 *              ETL intelligence provides real-time dashboarding & alerts
 *              but NEVER slows down the poll rate.
 *
 * Speed of nothang.js + brain of ETL. No missed slots.
 *
 * Usage:  node nothang-etl.js
 *         (uses .env for config, same as nothang.js)
 */

const { launchBrowser, authenticateProxy } = require('./bot headless/src/browser');
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

// ============================================================================
// CONFIGURATION (same .env as nothang.js)
// ============================================================================
const CONFIG = {
    credentials: {
        email: process.env.VISA_EMAIL,
        password: process.env.VISA_PASSWORD
    },
    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
        city: process.env.PREFERRED_CITY || 'Toronto',
        startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
        endDate: new Date(process.env.END_DATE || '2026-05-30')
    },
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    },
    proxy: {
        enabled: process.env.PROXY_ENABLED !== 'false',
        server: process.env.PROXY_SERVER || 'pr.oxylabs.io:7777',
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
    },
    bot: {
        headless: process.env.HEADLESS === 'true',
        targetCPM: parseInt(process.env.TARGET_CPM) || 240  // same speed as nothang.js
    }
};

// ============================================================================
// GLOBAL SESSION STATE
// ============================================================================
let scheduleId = null;
let facilityId = null;
let csrfToken = null;

// ============================================================================
// LOGGING
// ============================================================================
function log(msg, level = 'INFO') {
    const ts = new Date().toISOString();
    const c = {
        'INFO': '\x1b[36m', 'OK': '\x1b[32m', 'WARN': '\x1b[33m',
        'ERR': '\x1b[31m', 'ETL': '\x1b[35m', 'BOOK': '\x1b[42m\x1b[30m',
        'ADAPT': '\x1b[44m'
    };
    console.log(`${c[level] || ''}[${ts}] [${level}] ${msg}\x1b[0m`);
}

// ============================================================================
// TELEGRAM (same as nothang.js)
// ============================================================================
class ProxyHttpClient {
    constructor(proxyConfig) {
        this.proxyHost = proxyConfig.server?.split(':')[0];
        this.proxyPort = parseInt(proxyConfig.server?.split(':')[1]);
        this.proxyAuth = proxyConfig.username
            ? Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64')
            : null;
        this.enabled = proxyConfig.enabled;
    }
    async request(url, options = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const client = parsedUrl.protocol === 'https:' ? https : http;
            const req = client.request(url, {
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: 5000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            if (options.body) req.write(options.body);
            req.end();
        });
    }
}

const httpClient = new ProxyHttpClient(CONFIG.proxy);

async function sendTelegram(message) {
    if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;
    try {
        const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
        await httpClient.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CONFIG.telegram.chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });
    } catch {}
}

// ============================================================================
// ██████████████████████████████████████████████████████████████████████████████
// ██  E X T R A C T   L A Y E R                                            ██
// ██████████████████████████████████████████████████████████████████████████████
// ============================================================================

/**
 * Extract: Fire-and-forget fetch with ETag + Periodic Cache-Bust
 *
 * TWO API-LEVEL TECHNIQUES (working together, not against each other):
 *
 * 1) ETag / Conditional Requests (default — 49 out of 50 requests)
 *    - Stable URL so server can match ETag → returns 304 (free)
 *    - ~95% of requests become near-zero cost
 *
 * 2) Cache-Bust (every 50th request)
 *    - Unique URL with &_=timestamp to bypass any CDN/proxy cache
 *    - Verifies we're not getting stale data from an intermediary
 *    - Forces a fresh 200 which gives us a new ETag baseline
 */
let lastRequestTime = 0;
let lastLatency = 0;
let extractCycle = 0;
const CACHE_BUST_EVERY = 500;  // bust cache every 500th request (~2 min at 250 CPM)

// ETag tracking
let etlStats = {
    total: 0,
    hits304: 0,       // 304 Not Modified (no change, near-zero server cost)
    full200: 0,       // 200 with new data (availability changed)
    errors: 0,
    busts: 0          // cache-bust requests sent
};

// Rolling window for accurate current 304 rate (last 200 requests)
const ROLLING_WINDOW = 200;
let rollingResults = [];  // circular buffer of 1 (304) or 0 (not 304)

// ── ETag captured from Node side (Puppeteer response interception) ──
// Browser fetch can't read ETag header (not CORS-exposed).
// We capture it via Puppeteer's response listener and inject it
// back into the page before each request.
let capturedETag = null;

function setupETagInterceptor(page) {
    page.on('response', (resp) => {
        try {
            const url = resp.url();
            if (url.includes('/days/') && url.includes('.json')) {
                const etag = resp.headers()['etag'];
                const status = resp.status();
                if (extractCycle <= 5 || extractCycle % 500 === 0) {
                    log(`[ETag-Interceptor] status=${status} etag=${etag ? etag.substring(0, 20) + '...' : 'null'}`, 'DEBUG');
                }
                if (etag) {
                    capturedETag = etag;
                    // No page.evaluate injection needed — capturedETag is passed
                    // directly as a parameter to fireExtract's page.evaluate.
                    // This eliminates the race condition that was causing 304 decline.
                }
            }
        } catch {}
    });
}

function fireExtract(page) {
    lastRequestTime = Date.now();
    extractCycle++;

    const shouldBust = extractCycle % CACHE_BUST_EVERY === 0;

    if (shouldBust) {
        capturedETag = null;
    }

    // Pass Node-side capturedETag directly as a parameter instead of
    // reading window.__etlETag inside the browser. This eliminates the
    // race condition where the async interceptor hasn't finished injecting
    // the ETag back into the page before the next fire-and-forget fires.
    const etagToSend = (!shouldBust && capturedETag) ? capturedETag : null;

    page.evaluate(({ baseUrl, sid, fid, shouldBust, etag }) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

        // ── URL: stable for ETag, busted every Nth request ────
        let url = `${baseUrl}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false`;
        if (shouldBust) {
            url += `&_=${Date.now()}`;
        }

        // ── Headers: send If-None-Match when we have an ETag ──
        const headers = {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'X-CSRF-Token': csrf
        };
        if (etag) {
            headers['If-None-Match'] = etag;
        }

        fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers
        }).then(async (resp) => {
            if (resp.status === 304) {
                window.__etlStatus = 304;
                window.__etlTime = Date.now();
            } else if (resp.ok) {
                const data = await resp.json();
                window.__etlRaw = data;
                window.__etlStatus = 200;
                window.__etlTime = Date.now();
                // ETag is captured by Puppeteer response listener (Node side)
                // — no need to read it here (browser can't see it anyway)
            } else {
                window.__etlStatus = resp.status;
                window.__etlTime = Date.now();
            }
        }).catch(() => {
            window.__etlStatus = -1;
            window.__etlTime = Date.now();
        });
    }, { baseUrl: CONFIG.preferences.baseUrl, sid: scheduleId, fid: facilityId, shouldBust, etag: etagToSend }).catch(() => {});

    if (shouldBust) etlStats.busts++;
}

/**
 * Read the latest extract result from browser (non-blocking).
 * Includes ETag status so the transform layer knows if data is fresh or cached.
 */
async function readExtract(page) {
    try {
        const result = await page.evaluate(() => {
            return {
                data: window.__etlRaw,
                time: window.__etlTime,
                status: window.__etlStatus
            };
        });

        if (result.time && lastRequestTime > 0) {
            lastLatency = Date.now() - lastRequestTime;
        }

        // Track ETag stats
        etlStats.total++;
        if (result.status === 304) etlStats.hits304++;
        else if (result.status === 200) etlStats.full200++;
        else if (result.status === -1) etlStats.errors++;

        // Rolling window: push 1 for 304, 0 for anything else
        rollingResults.push(result.status === 304 ? 1 : 0);
        if (rollingResults.length > ROLLING_WINDOW) rollingResults.shift();

        return {
            raw: result.data,
            extractedAt: result.time || Date.now(),
            latencyMs: lastLatency,
            count: result.data ? result.data.length : 0,
            // ETag metadata — transform layer uses this
            httpStatus: result.status,    // 304 = cached, 200 = fresh data
            wasCached: result.status === 304
        };
    } catch {
        etlStats.errors++;
        return { raw: null, extractedAt: Date.now(), latencyMs: 0, count: 0, httpStatus: -1, wasCached: false };
    }
}

/**
 * CPM delay calculator (same as nothang.js)
 */
function getDelay(targetCPM) {
    const overhead = 5;
    const idealCycle = 60000 / targetCPM;
    return Math.max(0, Math.floor(idealCycle - overhead));
}

/**
 * Extract times for a specific date (used during booking — no ETag needed here).
 */
async function extractTimes(page, date) {
    const result = await page.evaluate(({ baseUrl, sid, fid, date }) => {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        return fetch(`${baseUrl}/schedule/${sid}/appointment/times/${fid}.json?date=${date}&appointments[expedite]=false`, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            }
        })
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);
    }, { baseUrl: CONFIG.preferences.baseUrl, sid: scheduleId, fid: facilityId, date });

    return result;
}

// ============================================================================
// ██████████████████████████████████████████████████████████████████████████████
// ██  T R A N S F O R M   L A Y E R                                        ██
// ██████████████████████████████████████████████████████████████████████████████
// ============================================================================

/**
 * The Transform Store — holds historical snapshots for diff/trend analysis.
 * This is the "molded" view of the data the bot actually reasons about.
 */
const store = {
    snapshots: [],           // last N raw extractions for trend analysis
    maxSnapshots: 60,        // keep ~60 snapshots in memory
    lastTransformed: null,   // most recent transformed output
    volatility: 0,           // 0.0 (dead calm) to 1.0 (rapid changes)
    trendDirection: 'stable' // 'improving' | 'worsening' | 'stable'
};

/**
 * Transform: Convert raw extraction into a rich availability model.
 *
 * INPUT:  { raw: [{date, business_day}, ...], extractedAt, latencyMs, count }
 * OUTPUT: A "molded" availability object the decision engine consumes
 */
function transform(extraction) {
    // ── 304 short-circuit: data unchanged, return last transform ──
    // When the server returns 304, the raw data is the same as before.
    // No need to re-parse, re-diff, or store a new snapshot.
    // This keeps volatility/trend calculations clean.
    if (extraction.wasCached && store.lastTransformed) {
        return {
            ...store.lastTransformed,
            extractedAt: extraction.extractedAt,
            latencyMs: extraction.latencyMs,
            changeDetected: false,
            diff: null,
            httpStatus: 304
        };
    }

    if (!extraction.raw || extraction.raw.length === 0) {
        return {
            status: 'no_availability',
            extractedAt: extraction.extractedAt,
            latencyMs: extraction.latencyMs,
            totalSlots: 0,
            earliest: null,
            inRange: [],
            windows: [],
            volatility: store.volatility,
            trend: store.trendDirection,
            changeDetected: false,
            diff: null,
            httpStatus: extraction.httpStatus
        };
    }

    const raw = extraction.raw;
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    // ── 1. Basic date parsing ─────────────────────────────────────
    const dates = raw.map(d => ({
        date: d.date,
        ts: new Date(d.date).getTime(),
        businessDay: d.business_day,
        daysFromNow: Math.floor((new Date(d.date) - now) / 86400000)
    })).sort((a, b) => a.ts - b.ts);

    const earliest = dates[0];

    // ── 2. Target range filtering ─────────────────────────────────
    const rangeStart = CONFIG.preferences.startDate.getTime();
    const rangeEnd = CONFIG.preferences.endDate.getTime();
    const inRange = dates.filter(d => d.ts >= rangeStart && d.ts <= rangeEnd);

    // ── 3. Availability windows (contiguous date ranges) ──────────
    const windows = buildWindows(dates);

    // ── 4. Monthly density ────────────────────────────────────────
    const monthlyDensity = {};
    for (const d of dates) {
        const key = d.date.substring(0, 7); // "2027-08"
        monthlyDensity[key] = (monthlyDensity[key] || 0) + 1;
    }

    // ── 5. Gap analysis (gaps between available dates) ────────────
    const gaps = [];
    for (let i = 1; i < dates.length; i++) {
        const gapDays = (dates[i].ts - dates[i - 1].ts) / 86400000;
        if (gapDays > 3) { // Only report gaps > 3 days (weekends are normal)
            gaps.push({
                after: dates[i - 1].date,
                before: dates[i].date,
                gapDays: gapDays
            });
        }
    }

    // ── 6. Change detection (diff against last snapshot) ──────────
    const prevSnapshot = store.snapshots.length > 0
        ? store.snapshots[store.snapshots.length - 1]
        : null;

    const diff = computeDiff(prevSnapshot, raw);

    // ── 7. Volatility scoring ─────────────────────────────────────
    updateVolatility(diff);

    // ── 8. Trend analysis (is earliest date moving closer or further?) ──
    updateTrend(earliest);

    // ── 9. Store this snapshot ────────────────────────────────────
    store.snapshots.push({
        extractedAt: extraction.extractedAt,
        dates: raw.map(d => d.date),
        earliest: earliest.date,
        count: raw.length
    });
    if (store.snapshots.length > store.maxSnapshots) {
        store.snapshots.shift();
    }

    // ── Build the final transformed output ────────────────────────
    const transformed = {
        status: inRange.length > 0 ? 'TARGET_IN_RANGE' : 'monitoring',
        extractedAt: extraction.extractedAt,
        latencyMs: extraction.latencyMs,

        // Core availability data
        totalSlots: dates.length,
        earliest: {
            date: earliest.date,
            businessDay: earliest.businessDay,
            daysFromNow: earliest.daysFromNow
        },

        // Target range matches — THE TRIGGER
        inRange: inRange.map(d => ({
            date: d.date,
            businessDay: d.businessDay,
            daysFromNow: d.daysFromNow
        })),

        // Availability windows (contiguous blocks)
        windows,

        // Density: slots per month
        monthlyDensity,

        // Gaps: where availability drops out
        gaps,

        // Change detection
        changeDetected: diff.hasChanges,
        diff: diff.hasChanges ? diff : null,

        // Adaptive signals
        volatility: store.volatility,
        trend: store.trendDirection
    };

    store.lastTransformed = transformed;
    return transformed;
}

/**
 * Build contiguous windows from sorted dates.
 * e.g. Aug 12-17 (4 slots), Aug 19-27 (7 slots), etc.
 */
function buildWindows(sortedDates) {
    if (sortedDates.length === 0) return [];

    const windows = [];
    let windowStart = sortedDates[0];
    let windowEnd = sortedDates[0];
    let windowCount = 1;

    for (let i = 1; i < sortedDates.length; i++) {
        const gapDays = (sortedDates[i].ts - windowEnd.ts) / 86400000;
        // Allow up to 3-day gap (covers weekends) within same window
        if (gapDays <= 3) {
            windowEnd = sortedDates[i];
            windowCount++;
        } else {
            windows.push({
                start: windowStart.date,
                end: windowEnd.date,
                slots: windowCount,
                spanDays: Math.floor((windowEnd.ts - windowStart.ts) / 86400000) + 1
            });
            windowStart = sortedDates[i];
            windowEnd = sortedDates[i];
            windowCount = 1;
        }
    }
    windows.push({
        start: windowStart.date,
        end: windowEnd.date,
        slots: windowCount,
        spanDays: Math.floor((windowEnd.ts - windowStart.ts) / 86400000) + 1
    });

    return windows;
}

/**
 * Compute diff between two snapshots.
 * Detects: new dates appearing (cancellations), dates disappearing (bookings).
 */
function computeDiff(prevSnapshot, currentRaw) {
    if (!prevSnapshot) {
        return { hasChanges: false, appeared: [], disappeared: [], earliestMoved: null };
    }

    const prevDates = new Set(prevSnapshot.dates);
    const currDates = new Set(currentRaw.map(d => d.date));

    const appeared = [...currDates].filter(d => !prevDates.has(d)).sort();
    const disappeared = [...prevDates].filter(d => !currDates.has(d)).sort();

    const earliestMoved = currentRaw[0]?.date !== prevSnapshot.earliest
        ? { from: prevSnapshot.earliest, to: currentRaw[0]?.date }
        : null;

    return {
        hasChanges: appeared.length > 0 || disappeared.length > 0,
        appeared,       // NEW dates = cancellations happened
        disappeared,    // GONE dates = someone booked them
        earliestMoved,
        appearedCount: appeared.length,
        disappearedCount: disappeared.length
    };
}

/**
 * Update rolling volatility score (0.0 – 1.0).
 * High volatility = dates changing frequently = cancellations happening = poll faster.
 */
function updateVolatility(diff) {
    const changeScore = diff.hasChanges
        ? Math.min(1.0, (diff.appearedCount + diff.disappearedCount) / 5)
        : 0;

    // Exponential moving average: 70% old, 30% new
    store.volatility = store.volatility * 0.7 + changeScore * 0.3;
}

/**
 * Track trend: is the earliest available date getting closer (improving)
 * or further away (worsening)?
 */
function updateTrend(earliest) {
    if (store.snapshots.length < 3) {
        store.trendDirection = 'stable';
        return;
    }

    const recent = store.snapshots.slice(-5);
    const earliestDates = recent.map(s => new Date(s.earliest).getTime());

    // Simple linear trend
    const first = earliestDates[0];
    const last = earliestDates[earliestDates.length - 1];

    if (last < first - 86400000) {
        store.trendDirection = 'improving';  // earliest date moving closer
    } else if (last > first + 86400000) {
        store.trendDirection = 'worsening';  // earliest date moving further
    } else {
        store.trendDirection = 'stable';
    }
}

// ============================================================================
// ██████████████████████████████████████████████████████████████████████████████
// ██  L O A D   L A Y E R  (Adaptive Decision Engine)                      ██
// ██████████████████████████████████████████████████████████████████████████████
// ============================================================================

/**
 * Load: Consume transformed data and decide what to do.
 * HYBRID MODE: Never adjusts poll speed — always runs at target CPM.
 * The ETL intelligence is used for decisions and alerts, not throttling.
 *
 * Returns: { action, reason }
 *   action: 'book' | 'monitor' | 'alert'
 */
function load(transformed) {
    // ── TRIGGER: Date in target range → BOOK IMMEDIATELY ──────────
    if (transformed.status === 'TARGET_IN_RANGE' && transformed.inRange.length > 0) {
        return {
            action: 'book',
            target: transformed.inRange[0],
            reason: `🎯 ${transformed.inRange.length} slot(s) in target range! Earliest: ${transformed.inRange[0].date}`
        };
    }

    // ── CHANGE DETECTED → alert (but keep polling at full speed) ──
    if (transformed.changeDetected) {
        const diff = transformed.diff;
        let reason = '';

        if (diff.appeared.length > 0) {
            reason = `🔥 ${diff.appeared.length} NEW dates appeared (cancellations!): ${diff.appeared.slice(0, 5).join(', ')}`;
        }
        if (diff.disappeared.length > 0) {
            reason += `${reason ? ' | ' : ''}${diff.disappeared.length} dates gone (booked)`;
        }
        if (diff.earliestMoved) {
            reason += `${reason ? ' | ' : ''}Earliest moved: ${diff.earliestMoved.from} → ${diff.earliestMoved.to}`;
        }

        return { action: 'alert', reason };
    }

    // ── Default: keep monitoring at full speed ────────────────────
    return {
        action: 'monitor',
        reason: `Vol: ${transformed.volatility.toFixed(2)} | Trend: ${transformed.trend} | Earliest: ${transformed.earliest?.date || 'none'} (${transformed.earliest?.daysFromNow || '?'}d)`
    };
}

// ============================================================================
// BOOKING (from nothang.js)
// ============================================================================
async function performBooking(page, targetDate) {
    const startTime = Date.now();

    sendTelegram(`🚀 <b>BOOKING STARTED!</b>\n📅 ${targetDate}\n📍 ${CONFIG.preferences.city}\n📧 ${CONFIG.credentials.email}`);

    try {
        // Fetch times
        const timesData = await extractTimes(page, targetDate);
        if (!timesData || !timesData.available_times || timesData.available_times.length === 0) {
            log(`No times available for ${targetDate}`, 'ERR');
            return false;
        }

        const selectedTime = timesData.available_times[0];
        log(`Time: ${selectedTime}`, 'BOOK');

        // Set date + time + submit
        try {
            await page.evaluate(({ date, time }) => {
                const dateInput = document.querySelector('#appointments_consulate_appointment_date');
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(dateInput).trigger('change');

                const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
                if (!timeSelect.querySelector(`option[value="${time}"]`)) {
                    const opt = document.createElement('option');
                    opt.value = time;
                    opt.text = time;
                    timeSelect.appendChild(opt);
                }
                timeSelect.value = time;
                timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(timeSelect).trigger('change');

                const form = document.querySelector('form#appointment-form') ||
                             document.querySelector('form[action*="appointment"]') ||
                             dateInput.closest('form');
                if (form) form.submit();
                else document.querySelector('#appointments_submit').click();
            }, { date: targetDate, time: selectedTime });
        } catch (e) {
            if (!e.message.includes('context') && !e.message.includes('destroyed')) throw e;
            log('Navigation detected (submit worked)', 'OK');
        }

        // Click confirm
        try {
            await page.waitForSelector('a.button.alert', { timeout: 3000 });
            const confirmBtn = await page.$('a.button.alert') || await page.$('input[value="Confirm"]');
            if (confirmBtn) await confirmBtn.click();
            log('Confirm clicked', 'OK');
        } catch (e) {
            if (!e.message.includes('context') && !e.message.includes('destroyed')) {
                log(`Confirm wait issue: ${e.message}`, 'WARN');
            }
        }

        const elapsed = Date.now() - startTime;
        log(`🎉 BOOKED in ${elapsed}ms!`, 'BOOK');
        sendTelegram(`🎉 <b>BOOKED!</b>\n📅 ${targetDate}\n⏰ ${selectedTime}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
        return true;

    } catch (error) {
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            const elapsed = Date.now() - startTime;
            log(`Likely BOOKED in ${elapsed}ms (context destroyed)`, 'BOOK');
            sendTelegram(`🎉 <b>LIKELY BOOKED!</b>\n📅 ${targetDate}\n⏱ ${elapsed}ms`);
            return true;
        }
        log(`Booking error: ${error.message}`, 'ERR');
        return false;
    }
}

// ============================================================================
// LOGIN (from nothang.js)
// ============================================================================
async function login(page) {
    log('Logging in...');
    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#user_email', { timeout: 30000 });

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (bodyText.toLowerCase().includes('system is busy')) throw new Error('SYSTEM_BUSY');
    if (bodyText.includes('account is locked')) throw new Error('ACCOUNT_LOCKED');

    if (!CONFIG.credentials.email || !CONFIG.credentials.password) {
        log('VISA_EMAIL or VISA_PASSWORD not set in .env — check your .env file', 'ERR');
        throw new Error('MISSING_CREDENTIALS');
    }

    // Puppeteer: clear + type (no page.fill)
    await page.click('#user_email');
    await page.evaluate(() => { document.querySelector('#user_email').value = ''; });
    await page.type('#user_email', CONFIG.credentials.email);

    await page.click('#user_password');
    await page.evaluate(() => { document.querySelector('#user_password').value = ''; });
    await page.type('#user_password', CONFIG.credentials.password);

    try {
        await page.waitForSelector('label[for="policy_confirmed"]', { timeout: 2000 });
        await page.click('label[for="policy_confirmed"]');
    } catch {
        await page.evaluate(() => {
            const cb = document.querySelector('#policy_confirmed');
            if (cb) cb.click();
        }).catch(() => {});
    }

    // Click submit and wait for navigation together (Promise.all prevents race condition)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
        page.click('input[type="submit"]')
    ]);

    // Handle error modal (wrong password, etc.)
    try {
        await new Promise(r => setTimeout(r, 3000));
        const hasOkBtn = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, a')];
            return btns.some(b => b.textContent.trim() === 'OK');
        });
        if (hasOkBtn) {
            await page.evaluate(() => {
                const btns = [...document.querySelectorAll('button, a')];
                const okBtn = btns.find(b => b.textContent.trim() === 'OK');
                if (okBtn) okBtn.click();
            });
            await new Promise(r => setTimeout(r, 1000));
            await page.evaluate(() => {
                const cb = document.querySelector('.icheckbox');
                if (cb) cb.click();
            }).catch(() => {});
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
                page.click('input[type="submit"]')
            ]);
        }
    } catch {}

    // Wait for URL to actually change away from sign_in
    // (sometimes the redirect takes a moment after domcontentloaded)
    let retries = 0;
    while (page.url().includes('sign_in') && retries < 10) {
        await new Promise(r => setTimeout(r, 1000));
        retries++;
    }

    if (page.url().includes('sign_in')) throw new Error('LOGIN_FAILED');
    log('Login OK', 'OK');
}

// ============================================================================
// NAVIGATE TO APPOINTMENT PAGE (from nothang.js)
// ============================================================================
async function navigateToAppointmentPage(page) {
    log('Navigating to appointment page...');

    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 20000 });
    await page.click(continueBtn);
    await new Promise(r => setTimeout(r, 2000));

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    const options = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
    );
    const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
    if (target) {
        await page.select(facilitySelector, target.value);
        log(`City: ${target.text}`, 'OK');
    }

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

    scheduleId = ids.scheduleId;
    facilityId = ids.facilityId;
    csrfToken = ids.csrf;
    log(`IDs → schedule: ${scheduleId}, facility: ${facilityId}`, 'INFO');
}

// ============================================================================
// STATUS LINE (compact one-liner for the monitoring loop)
// ============================================================================
function printStatus(cycle, transformed, decision, cpm) {
    const v = transformed.volatility?.toFixed(2) || '0.00';
    const trend = transformed.trend || 'stable';
    const trendIcon = trend === 'improving' ? '📈' : trend === 'worsening' ? '📉' : '➡️';
    const earliest = transformed.earliest?.date || '---';
    const daysOut = transformed.earliest?.daysFromNow || '---';
    const slots = transformed.totalSlots || 0;
    const inRange = transformed.inRange?.length || 0;
    const latMs = lastLatency > 0 ? lastLatency + 'ms' : '--';
    const changed = transformed.changeDetected ? '🔥CHANGE' : '';

    // ETag efficiency: rolling window of last 200 requests
    const etagPct = rollingResults.length > 0
        ? Math.round((rollingResults.reduce((a, b) => a + b, 0) / rollingResults.length) * 100)
        : 0;

    console.log(
        `\x1b[44m[${cpm} CPM]\x1b[0m ` +
        `#${cycle} | ` +
        `Lat: ${latMs} | ` +
        `Earliest: ${earliest} (${daysOut}d) | ` +
        `Slots: ${slots} | ` +
        `InRange: ${inRange} | ` +
        `${trendIcon} ${trend} | ` +
        `Vol: ${v} | ` +
        `304: ${etagPct}% ` +
        `${changed}`
    );
}

// ============================================================================
// ██████████████████████████████████████████████████████████████████████████████
// ██  M A I N   E T L   L O O P                                            ██
// ██████████████████████████████████████████████████████████████████████████████
// ============================================================================
async function runETL() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  VISA BOT — ETL ARCHITECTURE (Puppeteer)\x1b[0m');
    console.log('\x1b[36m  City: ' + CONFIG.preferences.city + '\x1b[0m');
    console.log('\x1b[33m  Range: ' + CONFIG.preferences.startDate.toISOString().split('T')[0] +
        ' → ' + CONFIG.preferences.endDate.toISOString().split('T')[0] + '\x1b[0m');
    console.log('\x1b[35m  Target: ' + CONFIG.bot.targetCPM + ' CPM (constant speed + ETL brain)\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    let browser;
    let page;

    try {
        // Launch browser via shared bot headless launcher
        const proxyServer = (CONFIG.proxy.enabled && CONFIG.proxy.username)
            ? `http://${CONFIG.proxy.server}`
            : null;

        if (proxyServer) {
            log(`Proxy: ${CONFIG.proxy.server}`, 'INFO');
        }

        const launched = await launchBrowser({
            headless: CONFIG.bot.headless,
            proxyServer,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });
        browser = launched.browser;
        page = launched.page;

        // Authenticate proxy if credentials provided
        if (CONFIG.proxy.enabled && CONFIG.proxy.username) {
            await authenticateProxy(page, CONFIG.proxy.username, CONFIG.proxy.password);
        }

        // ── Set up ETag interceptor (Node-side capture) ──────
        // Browser fetch can't read ETag header (not CORS-exposed).
        // Puppeteer captures it from the actual HTTP response and
        // stores it in capturedETag (Node-side). fireExtract passes
        // it directly as a parameter — no async injection race.
        setupETagInterceptor(page);

        // Login & navigate
        await login(page);
        await navigateToAppointmentPage(page);

        // ── Prime ETag at startup ─────────────────────────────
        // One blocking fetch to seed capturedETag BEFORE the
        // fire-and-forget loop starts. The response interceptor
        // will capture the ETag automatically on the Node side.
        log('Priming ETag...', 'INFO');
        try {
            await new Promise(r => setTimeout(r, 2000)); // let page context settle after navigation
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
                }).then(resp => resp.json())
                .then(data => {
                    window.__etlRaw = data;
                    window.__etlStatus = 200;
                    window.__etlTime = Date.now();
                });
            }, { baseUrl: CONFIG.preferences.baseUrl, sid: scheduleId, fid: facilityId });
            // ETag was captured by the response interceptor on Node side
            log(`ETag primed${capturedETag ? ' (' + capturedETag.substring(0, 20) + '...)' : ''} — 304 chain ready`, 'OK');
        } catch (e) {
            log(`ETag prime failed (${e.message}) — will acquire ETag naturally from first 200 response`, 'WARN');
        }

        sendTelegram(
            `🚀 <b>ETL Bot Started</b>\n` +
            `📧 ${CONFIG.credentials.email}\n` +
            `📍 ${CONFIG.preferences.city}\n` +
            `📅 Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} → ${CONFIG.preferences.endDate.toISOString().split('T')[0]}\n` +
            `⚡ Target: ${CONFIG.bot.targetCPM} CPM (constant + ETL brain)`
        );

        // ── ETL LOOP ──────────────────────────────────────────────
        let cycle = 0;
        let bookingInProgress = false;
        const startTime = Date.now();
        let lastTelegramUpdate = Date.now();
        let lastCookieReset = Date.now();
        let cyclesSinceReset = 0;
        const cookieResetInterval = 5 * 60 * 1000;   // time-based: every 5 min
        const COOKIE_RESET_CYCLES = 1000;             // cycle-based: before 1200-cycle degradation window

        while (true) {
            try {
                cycle++;

                cyclesSinceReset++;

                // ── Cookie/session reset — time OR cycle based ───
                // Server stops honoring ETags after ~1200 requests
                // from the same session. Reset before that window.
                if (!bookingInProgress && (
                    Date.now() - lastCookieReset > cookieResetInterval ||
                    cyclesSinceReset >= COOKIE_RESET_CYCLES
                )) {
                    log('Cookie reset...', 'INFO');
                    try {
                        // Puppeteer: delete all cookies (no context.clearCookies)
                        const cookies = await page.cookies();
                        if (cookies.length > 0) {
                            await page.deleteCookie(...cookies);
                        }
                        await login(page);
                        await navigateToAppointmentPage(page);

                        // ── Prime ETag immediately after re-login ─────
                        // The old capturedETag was invalidated with the cookie reset.
                        // Do one blocking fetch so the response interceptor captures
                        // a fresh ETag on the Node side before the loop resumes.
                        capturedETag = null;
                        try {
                            await new Promise(r => setTimeout(r, 2000));
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
                                }).then(resp => resp.json())
                                .then(data => {
                                    window.__etlRaw = data;
                                    window.__etlStatus = 200;
                                    window.__etlTime = Date.now();
                                });
                            }, { baseUrl: CONFIG.preferences.baseUrl, sid: scheduleId, fid: facilityId });
                            log(`ETag primed after cookie reset${capturedETag ? ' (' + capturedETag.substring(0, 20) + '...)' : ''}`, 'OK');
                        } catch (e) {
                            log(`ETag prime after reset failed (${e.message}) — will acquire naturally`, 'WARN');
                        }

                        lastCookieReset = Date.now();
                        cyclesSinceReset = 0;
                        log('Cookie reset done', 'OK');
                    } catch (e) {
                        log(`Cookie reset failed: ${e.message} — restarting`, 'ERR');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runETL();
                    }
                }

                // Periodic ETag reset no longer needed — full cookie/session
                // reset at COOKIE_RESET_CYCLES handles this before degradation.

                // ── Session health check (every 100 cycles) ──────
                if (cycle % 100 === 0) {
                    try { await page.evaluate(() => true); }
                    catch {
                        log('Page dead — restarting', 'ERR');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        return runETL();
                    }

                    // Check for logout
                    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
                    if (bodyText.toLowerCase().includes('sign in')) {
                        log('Session expired — restarting', 'WARN');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runETL();
                    }
                }

                // ══════════════════════════════════════════════════
                // E T L   C Y C L E  (fire-and-forget + read)
                // ══════════════════════════════════════════════════

                // EXTRACT: fire next request (non-blocking)
                fireExtract(page);

                // READ: grab result of previous request
                const extraction = await readExtract(page);

                // TRANSFORM: mold raw data into rich availability model
                const transformed = transform(extraction);

                // LOAD: decide what to do
                const decision = load(transformed);

                // ── CPM calculation ───────────────────────────────
                const elapsedMin = (Date.now() - startTime) / 60000;
                const cpm = (cycle / elapsedMin).toFixed(1);

                // ── Status line (every ~1 second) ─────────────────
                if (cycle % Math.ceil(CONFIG.bot.targetCPM / 60) === 0) {
                    printStatus(cycle, transformed, decision, cpm);
                }

                // ── ACT on decision ───────────────────────────────
                if (decision.action === 'book' && !bookingInProgress) {
                    log(`\n🎯 ${decision.reason}`, 'BOOK');
                    bookingInProgress = true;

                    for (let attempt = 1; attempt <= 3; attempt++) {
                        log(`Booking attempt ${attempt}/3...`, 'BOOK');
                        const booked = await performBooking(page, decision.target.date);
                        if (booked) {
                            log('🎉🎉🎉 BOOKED! Stopping bot.', 'BOOK');
                            sendTelegram(`🛑 <b>Bot Stopped — BOOKING COMPLETE!</b>`);
                            if (browser) await browser.close().catch(() => {});
                            process.exit(0);
                        }
                        await new Promise(r => setTimeout(r, 100));
                    }
                    bookingInProgress = false;
                    log('Booking attempts exhausted — resuming monitoring', 'WARN');
                }

                if (decision.action === 'alert') {
                    log(`⚡ ${decision.reason}`, 'ETL');
                }

                // ── Telegram update every 2 min ───────────────────
                if (Date.now() - lastTelegramUpdate > 120000) {
                    sendTelegram(
                        `📊 <b>ETL Status</b>\n` +
                        `📧 ${CONFIG.credentials.email}\n` +
                        `📍 ${CONFIG.preferences.city}\n` +
                        `⚡ ${cpm} CPM\n` +
                        `🔄 Cycle: ${cycle}\n` +
                        `📅 Earliest: ${transformed.earliest?.date || 'none'}\n` +
                        `📊 Slots: ${transformed.totalSlots} | InRange: ${transformed.inRange?.length || 0}\n` +
                        `📈 Volatility: ${transformed.volatility?.toFixed(2)} | Trend: ${transformed.trend}\n` +
                        `📈 Vol: ${transformed.volatility?.toFixed(2)} | Trend: ${transformed.trend}\n` +
                        `🏷 ETag 304s: ${rollingResults.length > 0 ? Math.round((rollingResults.reduce((a,b)=>a+b,0)/rollingResults.length)*100) : 0}% (last ${rollingResults.length} reqs)`
                    );
                    lastTelegramUpdate = Date.now();
                }

                // ── Wait (constant CPM — same speed as nothang.js) ─
                await new Promise(r => setTimeout(r, getDelay(CONFIG.bot.targetCPM)));

            } catch (loopErr) {
                log(`Loop error: ${loopErr.message}`, 'ERR');
                await new Promise(r => setTimeout(r, 1000));

                if (loopErr.message.includes('closed') || loopErr.message.includes('Target')) {
                    log('Browser crashed — restarting', 'ERR');
                    sendTelegram(`⚠️ <b>Crash — Restarting</b>`);
                    if (browser) await browser.close().catch(() => {});
                    await new Promise(r => setTimeout(r, 5000));
                    return runETL();
                }
            }
        }

    } catch (error) {
        log(`Fatal: ${error.message}`, 'ERR');
        sendTelegram(`🛑 <b>Fatal Error</b>\n${error.message}`);
        if (browser) await browser.close().catch(() => {});
        log('Restarting in 10s...', 'INFO');
        await new Promise(r => setTimeout(r, 10000));
        return runETL();
    }
}

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    sendTelegram('🛑 <b>ETL Bot Stopped</b>');
    setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Crash — Auto Restarting</b>\n${err.message}`);
    setTimeout(() => runETL(), 10000);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

// ============================================================================
// START
// ============================================================================
runETL();