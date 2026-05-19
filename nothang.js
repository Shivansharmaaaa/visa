/**
 * US Visa Appointment Bot v3.0 - TELEGRAM INTERACTIVE MULTI-ACCOUNT
 *
 * - Start the bot, then send /start in Telegram to interactively add IDs
 * - Asks: how many IDs, verification account, then for each ID: email, password, city, cpm
 * - Each ID runs in its own browser in PARALLEL
 * - While running, use /add to add a new ID and /close to stop an existing one
 * - .env credentials (VISA_EMAIL/VISA_PASSWORD) still work as a fallback
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// SHARED CONFIGURATION
// ============================================================================
console.log('Loading VERIFY_EMAIL:', process.env.VERIFY_EMAIL);
console.log('Loading VERIFY_PASSWORD:', process.env.VERIFY_PASSWORD ? '****' : 'NOT SET');

const CONFIG = {
    // Verification account (shared across all IDs) - can be set via Telegram /start
    verifyCredentials: {
        email: process.env.VERIFY_EMAIL || '',
        password: process.env.VERIFY_PASSWORD || '',
        intervalMins: parseInt(process.env.VERIFY_INTERVAL_MINS) || 5
    },
    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
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
        defaultCPM: parseInt(process.env.TARGET_CPM) || 240,
        headless: process.env.HEADLESS === 'true'
    }
};

console.log('HEADLESS env:', process.env.HEADLESS);
console.log('CONFIG.bot.headless:', CONFIG.bot.headless);

// ============================================================================
// LOGGING
// ============================================================================
function log(message, level = 'INFO', tag = '') {
    const timestamp = new Date().toISOString();
    const colors = {
        'INFO': '\x1b[36m',
        'SUCCESS': '\x1b[32m',
        'WARN': '\x1b[33m',
        'ERROR': '\x1b[31m',
        'FATAL': '\x1b[35m',
        'SECURITY': '\x1b[45m'
    };
    const prefix = tag ? `[${tag}] ` : '';
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${prefix}${message}\x1b[0m`);
}

// ============================================================================
// PROXY HTTP CLIENT (for Telegram only)
// ============================================================================
class ProxyHttpClient {
    constructor(proxyConfig) {
        this.proxyHost = proxyConfig.server.split(':')[0];
        this.proxyPort = parseInt(proxyConfig.server.split(':')[1]);
        this.proxyAuth = Buffer.from(`${proxyConfig.username}:${proxyConfig.password}`).toString('base64');
        this.enabled = proxyConfig.enabled;
    }

    async request(url, options = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const isHttps = parsedUrl.protocol === 'https:';

            if (!this.enabled) {
                const client = isHttps ? https : http;
                const req = client.request(url, {
                    method: options.method || 'GET',
                    headers: options.headers || {},
                    timeout: 5000
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                req.on('error', reject);
                if (options.body) req.write(options.body);
                req.end();
                return;
            }

            const connectReq = http.request({
                host: this.proxyHost,
                port: this.proxyPort,
                method: 'CONNECT',
                path: `${parsedUrl.hostname}:443`,
                headers: {
                    'Proxy-Authorization': `Basic ${this.proxyAuth}`,
                    'Host': `${parsedUrl.hostname}:443`
                },
                timeout: 15000
            });

            connectReq.on('connect', (res, socket) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Proxy failed: ${res.statusCode}`));
                    return;
                }

                const req = https.request({
                    hostname: parsedUrl.hostname,
                    path: parsedUrl.pathname + parsedUrl.search,
                    method: options.method || 'GET',
                    headers: { 'Host': parsedUrl.hostname, ...(options.headers || {}) },
                    socket: socket,
                    agent: false,
                    timeout: 5000
                }, (response) => {
                    let data = '';
                    response.on('data', chunk => data += chunk);
                    response.on('end', () => resolve({ status: response.statusCode, data }));
                });

                req.on('error', reject);
                if (options.body) req.write(options.body);
                req.end();
            });

            connectReq.on('error', reject);
            connectReq.end();
        });
    }
}

const proxyClient = new ProxyHttpClient(CONFIG.proxy);

// ============================================================================
// TELEGRAM SEND
// ============================================================================
// ----------------------------------------------------------------------------
// Rate-limited Telegram queue.
// Telegram's per-chat limit is roughly 1 msg/sec sustained (and ~20/min for
// the same chat). With many accounts firing notifications concurrently the
// fire-and-forget version silently lost most messages. This queue drains at
// ~1 msg/sec and logs API errors so we can see what's going on.
// ----------------------------------------------------------------------------
const TG_QUEUE = [];
const TG_MAX_QUEUE = 200;        // drop oldest if backlog exceeds this
const TG_INTERVAL_MS = 1100;     // ~55 messages/minute, safely under same-chat limit
let TG_ACTIVE = false;

function sendTelegram(message, chatId) {
    if (!CONFIG.telegram.botToken) return;
    const targetChat = chatId || CONFIG.telegram.chatId;
    if (!targetChat) return;
    if (TG_QUEUE.length >= TG_MAX_QUEUE) {
        TG_QUEUE.shift(); // drop oldest to keep memory bounded
    }
    TG_QUEUE.push({ chatId: targetChat, text: message });
    pumpTgQueue();
}

async function pumpTgQueue() {
    if (TG_ACTIVE) return;
    TG_ACTIVE = true;
    try {
        while (TG_QUEUE.length > 0) {
            const item = TG_QUEUE.shift();
            await sendTgOne(item.chatId, item.text);
            if (TG_QUEUE.length > 0) await new Promise(r => setTimeout(r, TG_INTERVAL_MS));
        }
    } finally {
        TG_ACTIVE = false;
    }
}

function sendTgOne(chatId, message) {
    return new Promise((resolve) => {
        const postData = JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${CONFIG.telegram.botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: 10000
        }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    log(`Telegram API ${res.statusCode}: ${data.substring(0, 300)}`, 'WARN');
                    // If HTML parse failed, retry once as plain text (strip tags)
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed && parsed.description &&
                            parsed.description.toLowerCase().includes('parse')) {
                            const plain = message.replace(/<[^>]+>/g, '');
                            TG_QUEUE.unshift({ chatId, text: plain }); // re-queue
                        } else if (res.statusCode === 429 && parsed.parameters &&
                                   parsed.parameters.retry_after) {
                            // Honor Telegram's rate limit hint
                            const wait = (parsed.parameters.retry_after + 1) * 1000;
                            log(`Telegram 429, sleeping ${wait}ms`, 'WARN');
                            TG_QUEUE.unshift({ chatId, text: message });
                            setTimeout(resolve, wait);
                            return;
                        }
                    } catch (e) { /* ignore parse */ }
                }
                resolve();
            });
        });
        req.on('error', (err) => {
            log(`Telegram send error: ${err.message}`, 'WARN');
            resolve();
        });
        req.on('timeout', () => {
            req.destroy();
            log(`Telegram timeout`, 'WARN');
            resolve();
        });
        req.write(postData);
        req.end();
    });
}

// ============================================================================
// IP VERIFICATION
// ============================================================================
async function verifyProxyIP() {
    log('Verifying proxy IP...', 'SECURITY');
    try {
        const response = await proxyClient.request('https://api.ipify.org?format=json');
        const data = JSON.parse(response.data);
        log(`Proxy IP verified: ${data.ip}`, 'SECURITY');
        return data.ip;
    } catch (error) {
        log(`IP verification failed: ${error.message}`, 'ERROR');
        return null;
    }
}

// ============================================================================
// UTILITIES
// ============================================================================
function isDateInRange(dateStr, startDate, endDate) {
    const date = new Date(dateStr);
    return date >= startDate && date <= endDate;
}

const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getDelay(targetCPM) {
    const overhead = 5;
    const idealCycle = 60000 / targetCPM;
    return Math.max(0, Math.floor(idealCycle - overhead));
}

// ============================================================================
// ACCOUNT STATE FACTORY (one per ID)
// ============================================================================
function createAccount({ email, password, city, cpm, isMonitor, startDate, endDate, proxy }) {
    return {
        id: email,                         // unique key
        email,
        password,
        city,
        cpm: cpm || CONFIG.bot.defaultCPM,
        isMonitor: !!isMonitor,            // true = polls for dates; false = idle until broadcast
        startDate: startDate || CONFIG.preferences.startDate,
        endDate: endDate || CONFIG.preferences.endDate,
        proxy: proxy || null,              // per-account proxy {server, username, password}; null = use global
        latencyAlertActive: false,         // true while we've already alerted on a high-latency streak
        lastLatencyAlertAt: 0,             // throttle: don't re-alert for same condition more than once per N ms
        loginAttempts: 0,                  // counter of consecutive failed logins
        loginError: null,                  // last login failure reason (kept visible in /list)
        actualCpm: '0',                    // monitor's measured CPM (mirrored from runAccountBot loop)
        checkCount: 0,                     // monitor's iteration count
        nextVerifyIn: 0,                   // minutes until next stale-data check
        // per-account live state
        availableDate: null,
        availableTime: null,
        lastResponseTime: 0,
        closestSlotFound: null,
        lastRequestTime: 0,
        lastLatency: 0,
        scheduleId: null,
        facilityId: null,
        csrfToken: null,
        bookingInProgress: false,
        page: null,                        // playwright page kept ready for booking
        context: null,                     // playwright context
        pageRef: null,
        browser: null,
        verifyBrowser: null,
        lastVerifyTime: Date.now(),
        stopFlag: false,
        startedAt: Date.now(),
        status: 'starting',                // starting | ready | running | booked | stopped | error
        bookingAttempted: false            // set true after broadcast triggers a booking attempt
    };
}

// Map of running accounts: email -> account
const ACCOUNTS = new Map();

// Pool of proxies that startAccount() round-robins through.
// Format per entry: { server: 'host:port', username, password }
const PROXY_POOL = [];
let _proxyCursor = 0;

function nextProxyFromPool() {
    if (PROXY_POOL.length === 0) return null;
    const p = PROXY_POOL[_proxyCursor % PROXY_POOL.length];
    _proxyCursor++;
    return p;
}

// Parse a proxy list paste. Accepts "host:port:user:pass" per line.
// Also tolerates "host:port" (no auth) or "host:port@user:pass" forms.
function applyProxyList(text, chatId) {
    const parsed = parseProxyList(text);
    if (parsed.errors.length > 0) {
        sendTelegram(`⚠️ Errors in proxy list:\n${parsed.errors.join('\n')}`, chatId);
        if (parsed.proxies.length === 0) return false;
    }
    PROXY_POOL.length = 0;
    _proxyCursor = 0;
    for (const p of parsed.proxies) PROXY_POOL.push(p);
    sendTelegram(
        `✅ <b>Proxy pool loaded</b>: ${PROXY_POOL.length} proxies\n` +
        PROXY_POOL.map((p, i) => `  ${i + 1}. ${p.server}`).join('\n') +
        `\n\nNew accounts will round-robin through these. Already-running accounts keep their current proxy.`,
        chatId
    );
    return true;
}

function parseProxyList(text) {
    const proxies = [];
    const errors = [];
    if (!text) return { proxies, errors };
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        // host:port@user:pass form
        let main = line, auth = '';
        if (line.includes('@')) {
            const at = line.indexOf('@');
            main = line.slice(0, at);
            auth = line.slice(at + 1);
        }
        const parts = line.split(':');
        if (auth) {
            // main = host:port, auth = user:pass
            const [host, port] = main.split(':');
            const aParts = auth.split(':');
            const user = aParts[0] || '';
            const pass = aParts.slice(1).join(':');
            if (!host || !port) { errors.push(`Bad proxy: ${line}`); continue; }
            proxies.push({ server: `${host}:${port}`, username: user, password: pass });
            continue;
        }
        if (parts.length === 2) {
            // host:port, no auth
            proxies.push({ server: `${parts[0]}:${parts[1]}`, username: '', password: '' });
            continue;
        }
        if (parts.length >= 4) {
            // host:port:user:pass (pass may include ":")
            const host = parts[0];
            const port = parts[1];
            const user = parts[2];
            const pass = parts.slice(3).join(':');
            proxies.push({ server: `${host}:${port}`, username: user, password: pass });
            continue;
        }
        errors.push(`Bad proxy: ${line}`);
    }
    return { proxies, errors };
}

// ============================================================================
// BOOKING BROADCAST — when a monitor finds a slot, ALL accounts attempt booking
// ============================================================================
const BOOKING_BROADCAST = {
    inProgress: false,
    slot: null,         // { date, city }
    triggeredBy: null,  // monitor email that found it
    triggeredAt: 0
};

async function switchFacility(account, page, cityName) {
    try {
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        const opts = await page.$$eval(`${facilitySelector} option`, all =>
            all.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );
        const target = opts.find(o => o.text.toLowerCase().includes(cityName.toLowerCase()));
        if (!target) {
            log(`City "${cityName}" not found in facility dropdown`, 'WARN', account.email);
            return false;
        }
        if (account.facilityId === target.value) return true; // already there
        await page.selectOption(facilitySelector, target.value);
        account.facilityId = target.value;
        log(`Switched facility to ${cityName} (${target.value})`, 'INFO', account.email);
        await page.waitForTimeout(300);
        return true;
    } catch (e) {
        log(`Facility switch failed: ${e.message}`, 'ERROR', account.email);
        return false;
    }
}

async function attemptBookingOnAccount(account, slot) {
    if (account.bookingAttempted) return false;
    account.bookingAttempted = true;
    account.bookingInProgress = true;

    const page = account.page;
    if (!page) {
        log('No page ref - cannot book', 'WARN', account.email);
        account.bookingInProgress = false;
        return false;
    }

    try {
        // Switch facility to the detected city if needed (safety net; matching-city filter should make this a no-op)
        if (slot.city && account.city.toLowerCase() !== slot.city.toLowerCase()) {
            log(`Switching from ${account.city} -> ${slot.city} to book`, 'INFO', account.email);
            await switchFacility(account, page, slot.city);
            await page.waitForTimeout(500);
        }

        for (let attempt = 1; attempt <= 3; attempt++) {
            log(`🚀 Booking attempt ${attempt}/3 for ${slot.date} in ${slot.city}`, 'INFO', account.email);
            try {
                const booked = await performBooking(account, page, slot);
                if (booked) {
                    account.status = 'booked';
                    account.stopFlag = true;
                    sendTelegram(`🎉 <b>${account.email} BOOKED!</b>\n📅 ${slot.date}\n📍 ${slot.city}`);
                    if (account.browser) await account.browser.close().catch(() => {});
                    if (account.verifyBrowser) await account.verifyBrowser.close().catch(() => {});
                    ACCOUNTS.delete(account.id);
                    return true;
                }
            } catch (bookErr) {
                log(`Booking attempt failed: ${bookErr.message}`, 'ERROR', account.email);
            }
            await page.waitForTimeout(50);
        }
        return false;
    } finally {
        account.bookingInProgress = false;
    }
}

// Ask a logged-in account's page for the current closest date.
// Resets the in-page cache, fires a fresh fetch, polls for the result up to ~3s.
async function fetchNextClosestSlot(account) {
    if (!account.page || !account.facilityId || !account.scheduleId) return null;
    try {
        await account.page.evaluate(() => {
            window.__latestDates = null;
            window.__lastFetchTime = 0;
        });
    } catch (e) {
        return null;
    }
    const fetchStart = Date.now();
    fireDirectFetch(account, account.page);

    for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
            const result = await account.page.evaluate(() => ({
                data: window.__latestDates,
                time: window.__lastFetchTime
            }));
            if (result && result.time && result.time >= fetchStart - 50) {
                if (Array.isArray(result.data) && result.data.length > 0) {
                    return result.data[0]; // { date, ... }
                }
                return null; // confirmed empty
            }
        } catch (e) {
            // page navigating mid-fetch — bail
            return null;
        }
    }
    return null;
}

// Fetch the available time slots for a given date, using a logged-in account's page
async function fetchTimesForDate(account, dateStr) {
    if (!account.page || !account.scheduleId || !account.facilityId) return [];
    const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${account.scheduleId}/appointment/times/${account.facilityId}.json?date=${dateStr}&appointments[expedite]=false`;
    try {
        const result = await Promise.race([
            account.page.evaluate(async ({ url }) => {
                try {
                    const r = await fetch(url, {
                        method: 'GET',
                        credentials: 'include',
                        headers: {
                            'Accept': 'application/json',
                            'X-Requested-With': 'XMLHttpRequest',
                            'X-CSRF-Token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                        }
                    });
                    if (!r.ok) return null;
                    const d = await r.json();
                    return d.available_times || [];
                } catch (e) {
                    return null;
                }
            }, { url: timesUrl }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('times fetch timeout')), 4000))
        ]).catch(() => null);
        return Array.isArray(result) ? result : [];
    } catch (e) {
        return [];
    }
}

// Build a queue of unique (date, time) pairs ordered by closest in-range date.
// Out-of-range dates are NEVER queued — if every in-range date has been taken,
// the queue returns empty and the broadcast bails without booking anything.
// For each in-range date, all its available times are queued so two IDs can't
// race on the same (date, time) slot.
// Stops once we have enough pairs for `neededCount` IDs.
async function buildBookingQueue(scout, neededCount, fallbackDate, city, rangeStart, rangeEnd) {
    // rangeStart/rangeEnd default to the scout's own range, then to global config
    rangeStart = rangeStart || scout.startDate || CONFIG.preferences.startDate;
    rangeEnd = rangeEnd || scout.endDate || CONFIG.preferences.endDate;
    const queue = []; // each: { date, time, city, inRange }
    const seen = new Set(); // de-dupe date/time pairs

    // 1) Fetch the dates list (closest dates with availability)
    let datesList = null;
    try {
        await scout.page.evaluate(() => {
            window.__latestDates = null;
            window.__lastFetchTime = 0;
        }).catch(() => {});
        const fetchStart = Date.now();
        fireDirectFetch(scout, scout.page);
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 100));
            const r = await scout.page.evaluate(() => ({
                data: window.__latestDates, time: window.__lastFetchTime
            })).catch(() => null);
            if (r && r.time && r.time >= fetchStart - 50) {
                datesList = Array.isArray(r.data) ? r.data : [];
                break;
            }
        }
    } catch (e) {
        log(`Dates fetch error: ${e.message}`, 'WARN', scout.email);
    }

    // 2) If we got nothing, fall back to the originally-detected date
    let dates;
    if (!datesList || datesList.length === 0) {
        log('No dates list returned by scout - falling back to detected date', 'WARN');
        dates = [{ date: fallbackDate }];
    } else {
        dates = datesList.slice();
    }

    // 3) Sort by closest first, then keep only in-range dates
    dates.sort((a, b) => new Date(a.date) - new Date(b.date));
    // ONLY book in-range dates. Out-of-range dates are NEVER queued — if the
    // detected slot has been taken and only later dates remain, we bail rather
    // than book a date the user doesn't actually want.
    const ordered = dates.filter(d => isDateInRange(d.date, rangeStart, rangeEnd));

    // 4) For each date, fetch times until we have enough unique pairs
    for (const d of ordered) {
        if (queue.length >= neededCount) break;
        const times = await fetchTimesForDate(scout, d.date);
        if (!times || times.length === 0) {
            log(`${d.date}: no times returned`, 'INFO', scout.email);
            continue;
        }
        const isIn = isDateInRange(d.date, rangeStart, rangeEnd);
        for (const t of times) {
            const key = `${d.date}|${t}`;
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push({ date: d.date, time: t, city, inRange: isIn });
            if (queue.length >= neededCount) break;
        }
    }
    return queue;
}

async function broadcastBooking(slot, triggeredBy) {
    if (BOOKING_BROADCAST.inProgress) {
        log(`Broadcast already in progress - ignoring`, 'WARN', triggeredBy);
        return;
    }
    BOOKING_BROADCAST.inProgress = true;
    BOOKING_BROADCAST.slot = slot;
    BOOKING_BROADCAST.triggeredBy = triggeredBy;
    BOOKING_BROADCAST.triggeredAt = Date.now();

    // Only book on accounts whose city matches the detected city
    const cityLower = (slot.city || '').toLowerCase();
    const all = Array.from(ACCOUNTS.values());
    // Order: monitors first (more likely to have fresh state), then standby; alphabetic within
    const matching = all
        .filter(a => (a.city || '').toLowerCase() === cityLower)
        .sort((a, b) => {
            if (a.isMonitor !== b.isMonitor) return a.isMonitor ? -1 : 1;
            return a.email.localeCompare(b.email);
        });
    const skipped = all.length - matching.length;

    if (matching.length === 0) {
        log(`No IDs configured for ${slot.city} - nothing to book`, 'WARN');
        sendTelegram(`⚠️ Slot detected for ${slot.city} but no IDs configured for that city.`);
        BOOKING_BROADCAST.inProgress = false;
        return;
    }

    log(`🎯 BROADCAST: ${slot.date} in ${slot.city} — building queue for ${matching.length} ID(s) (${skipped} skipped)`, 'SUCCESS');
    sendTelegram(
        `🚨 <b>SLOT DETECTED!</b>\n📅 ${slot.date}\n📍 ${slot.city}\n` +
        `Detected by: ${triggeredBy}\nBuilding unique (date, time) queue for ${matching.length} ID(s)` +
        (skipped > 0 ? ` (${skipped} other-city ID(s) skipped)` : '') + '...'
    );

    // Reset per-broadcast flag
    for (const acc of matching) acc.bookingAttempted = false;

    // Pick a scout: prefer a monitor; any matching account works
    const scout = matching.find(a => a.isMonitor && a.page) || matching.find(a => a.page);
    if (!scout) {
        log('No scout with an active page - aborting', 'ERROR');
        BOOKING_BROADCAST.inProgress = false;
        return;
    }

    const queue = await buildBookingQueue(scout, matching.length, slot.date, slot.city, slot.rangeStart, slot.rangeEnd);
    log(`Queue built: ${queue.length} unique (date, time) pair(s)`, 'SUCCESS');

    if (queue.length === 0) {
        sendTelegram(
            `⚠️ <b>No in-range slots left</b>\n📍 ${slot.city}\n` +
            `The detected date was already taken before our refetch landed, ` +
            `and every remaining open date is outside your configured range. ` +
            `Standing down — no out-of-range booking made.`
        );
        BOOKING_BROADCAST.inProgress = false;
        return;
    }

    // Summarize the queue (first few entries)
    const summaryLines = queue.slice(0, 6).map((p, i) => `  ${i + 1}. ${p.date} ⏰ ${p.time}`).join('\n');
    const extra = queue.length > 6 ? `\n  …and ${queue.length - 6} more` : '';
    sendTelegram(`📋 <b>Queue (${queue.length})</b>\n${summaryLines}${extra}\n\n🔥 Firing ${Math.min(matching.length, queue.length)} parallel booking(s)...`);

    // Pair each ID with one queue item (1:1, in order). Extra IDs without a slot get no work.
    const pairs = matching.slice(0, queue.length).map((acc, i) => ({ acc, target: queue[i] }));
    const idle = matching.slice(queue.length);
    for (const acc of idle) {
        log(`No remaining slot for ${acc.email} - skipping this broadcast`, 'INFO', acc.email);
    }

    // Announce each assignment
    for (const p of pairs) {
        sendTelegram(`➡️ <code>${p.acc.email}</code> will book <b>${p.target.date} ⏰ ${p.target.time}</b>`);
    }

    // FIRE ALL IN PARALLEL — no waiting between IDs
    const results = await Promise.allSettled(pairs.map(p => attemptBookingOnAccount(p.acc, p.target)));
    const successes = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    const failures = results.length - successes;

    sendTelegram(
        `✅ <b>Booking pass complete</b>\n📍 ${slot.city}\n🎉 ${successes} booked · ❌ ${failures} failed` +
        (idle.length > 0 ? `\n💤 ${idle.length} ID(s) had no slot to attempt` : '')
    );
    BOOKING_BROADCAST.inProgress = false;
    log(`Broadcast done: ${successes} booked, ${failures} failed, ${idle.length} idle`, 'SUCCESS');
}

// ============================================================================
// RESPONSE LISTENER (per-account)
// ============================================================================
function setupResponseListener(account, page) {
    account.pageRef = page;

    page.on('response', async (response) => {
        try {
            const url = response.url();

            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    account.availableDate = data[0];
                    account.lastResponseTime = Date.now();
                    if (account.lastRequestTime > 0) {
                        account.lastLatency = account.lastResponseTime - account.lastRequestTime;
                    }

                    const slotDate = new Date(account.availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    if (slotDate >= today) {
                        if (!account.closestSlotFound || slotDate < new Date(account.closestSlotFound.date)) {
                            account.closestSlotFound = account.availableDate;
                            log(`📅 New closest slot: ${account.closestSlotFound.date}`, 'SUCCESS', account.email);
                        }
                    }

                    if (isDateInRange(account.availableDate.date, account.startDate, account.endDate)) {
                        log(`🚨 INSTANT DETECT: ${account.availableDate.date} IN RANGE!`, 'SUCCESS', account.email);
                    }
                }
            }

            if (url.includes('.json') && url.includes('date=')) {
                const data = await response.json();
                if (data && data.available_times && data.available_times.length > 0) {
                    account.availableTime = data.available_times[0];
                    log(`⏰ Time captured: ${account.availableTime}`, 'INFO', account.email);
                }
            }
        } catch (e) {
            // ignore
        }
    });
}

// ============================================================================
// DIRECT API FETCH (per-account)
// ============================================================================
function fireDirectFetch(account, page) {
    account.lastRequestTime = Date.now();
    page.evaluate(({ baseUrl, sid, fid }) => {
        const url = `${baseUrl}/schedule/${sid}/appointment/days/${fid}.json?appointments[expedite]=false`;
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
        fetch(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrf
            }
        }).then(r => r.ok ? r.json() : null).then(data => {
            window.__latestDates = data;
            window.__lastFetchTime = Date.now();
        }).catch(() => {});
    }, { baseUrl: CONFIG.preferences.baseUrl, sid: account.scheduleId, fid: account.facilityId }).catch(() => {});
}

async function readLatestDates(account, page) {
    try {
        const result = await page.evaluate(() => {
            return { data: window.__latestDates, time: window.__lastFetchTime };
        });

        if (result.time) {
            account.lastResponseTime = result.time;
            if (account.lastRequestTime > 0) {
                account.lastLatency = Date.now() - account.lastRequestTime;
            }
        }

        const data = result.data;
        if (data && Array.isArray(data) && data.length > 0) {
            account.availableDate = data[0];

            const slotDate = new Date(account.availableDate.date);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            if (slotDate >= today) {
                if (!account.closestSlotFound || slotDate < new Date(account.closestSlotFound.date)) {
                    account.closestSlotFound = account.availableDate;
                    log(`📅 New closest slot: ${account.closestSlotFound.date}`, 'SUCCESS', account.email);
                }
            }

            if (isDateInRange(account.availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                log(`🚨 INSTANT DETECT: ${account.availableDate.date} IN RANGE!`, 'SUCCESS', account.email);
            }

            return account.availableDate;
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================================
// STALE DATA VERIFICATION (shared verify account; per-main-account check)
// ============================================================================
async function verifyDataFreshness(account) {
    const hasVerifyAccount = CONFIG.verifyCredentials.email &&
                             CONFIG.verifyCredentials.email.length > 0 &&
                             CONFIG.verifyCredentials.password &&
                             CONFIG.verifyCredentials.password.length > 0;

    if (!hasVerifyAccount) {
        log(`No verification account configured`, 'WARN', account.email);
        account.lastVerifyTime = Date.now();
        return true;
    }

    log('🔍 VERIFYING DATA FRESHNESS with secondary account...', 'SECURITY', account.email);

    let verifyPage = null;
    let capturedVerifyDate = null;

    try {
        const launchOptions = {
            headless: true,
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled', '--disable-webrtc', '--no-sandbox']
        };

        // Verify browser uses the same proxy as its parent account when one is assigned;
        // otherwise it falls back to the global CONFIG.proxy with a fresh oxylabs-style session.
        if (account.proxy) {
            launchOptions.proxy = {
                server: `http://${account.proxy.server}`,
                username: account.proxy.username,
                password: account.proxy.password
            };
            log(`Verify using account proxy ${account.proxy.server}`, 'INFO', account.email);
        } else if (CONFIG.proxy.enabled) {
            const verifySessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
            const verifyProxyUsername = CONFIG.proxy.username ?
                CONFIG.proxy.username.replace(/sessid-\d+/, `sessid-${verifySessionId}`) :
                CONFIG.proxy.username;
            log(`Using separate proxy session for verify: sessid-${verifySessionId}`, 'INFO', account.email);
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: verifyProxyUsername,
                password: CONFIG.proxy.password
            };
        }

        account.verifyBrowser = await chromium.launch(launchOptions);
        const context = await account.verifyBrowser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 }
        });

        verifyPage = await context.newPage();

        verifyPage.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                    const data = await response.json();
                    if (data && Array.isArray(data) && data.length > 0) {
                        capturedVerifyDate = data[0];
                        log(`🔍 Verify account sees: ${capturedVerifyDate.date}`, 'INFO', account.email);
                    }
                }
            } catch (e) {}
        });

        await verifyPage.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await verifyPage.waitForSelector('#user_email', { timeout: 15000 });
        await verifyPage.fill('#user_email', CONFIG.verifyCredentials.email);
        await verifyPage.fill('#user_password', CONFIG.verifyCredentials.password);

        try {
            await verifyPage.click('label[for="policy_confirmed"]', { timeout: 2000 });
        } catch (e) {
            await verifyPage.click('#policy_confirmed', { force: true }).catch(() => {});
        }

        await verifyPage.click('input[type="submit"]');
        await verifyPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        if (verifyPage.url().includes('sign_in')) {
            log('Verification account login failed', 'ERROR', account.email);
            await account.verifyBrowser.close();
            account.verifyBrowser = null;
            return true;
        }

        log('Verification account logged in', 'SUCCESS', account.email);

        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
        await verifyPage.waitForSelector(continueBtn, { timeout: 15000 });
        await verifyPage.click(continueBtn);
        await verifyPage.waitForTimeout(2000);

        const currentUrl = verifyPage.url();
        const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
        await verifyPage.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        await verifyPage.waitForSelector(facilitySelector, { timeout: 10000 });

        const options = await verifyPage.$$eval(`${facilitySelector} option`, opts =>
            opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );

        const target = options.find(o => o.text.toLowerCase().includes(account.city.toLowerCase()));
        if (target) {
            await verifyPage.selectOption(facilitySelector, target.value);
        }

        await verifyPage.waitForTimeout(3000);

        const mainDate = account.availableDate ? account.availableDate.date : null;
        const verifyDate = capturedVerifyDate ? capturedVerifyDate.date : null;

        log(`📊 COMPARISON: Main=${mainDate} | Verify=${verifyDate}`, 'INFO', account.email);

        await account.verifyBrowser.close();
        account.verifyBrowser = null;
        account.lastVerifyTime = Date.now();

        if (mainDate && verifyDate && mainDate !== verifyDate) {
            log(`🚨 STALE DATA DETECTED! Main: ${mainDate} vs Verify: ${verifyDate}`, 'ERROR', account.email);
            sendTelegram(
                `🚨 <b>STALE DATA DETECTED!</b>\n📧 ${account.email}\n` +
                `Main: ${mainDate}\nVerify: ${verifyDate}\n⚡ Restarting...`
            );
            return false;
        }

        if (!mainDate && verifyDate) {
            log(`🚨 STALE DATA: Main has no date, Verify sees: ${verifyDate}`, 'ERROR', account.email);
            sendTelegram(
                `🚨 <b>STALE DATA!</b>\n📧 ${account.email}\nMain: No dates\nVerify: ${verifyDate}\n⚡ Restarting...`
            );
            return false;
        }

        log(`✅ Data verified fresh: ${mainDate || 'no dates'}`, 'SUCCESS', account.email);
        sendTelegram(`✅ <b>Data Fresh</b>\n📧 ${account.email}\nBoth see: ${mainDate || 'no dates'}`);
        return true;

    } catch (error) {
        log(`Verification error: ${error.message}`, 'ERROR', account.email);
        sendTelegram(`⚠️ <b>Verify Failed</b>\n📧 ${account.email}\n${error.message.substring(0, 100)}`);
        if (account.verifyBrowser) {
            await account.verifyBrowser.close().catch(() => {});
            account.verifyBrowser = null;
        }
        account.lastVerifyTime = Date.now();
        return true;
    }
}

// ============================================================================
// LOGIN
// ============================================================================
// Wraps login() with a per-account retry cap.
// On success: resets the counter.
// On failure: increments and, after MAX_LOGIN_ATTEMPTS, throws a "permanent" error
// that the run loop recognizes and uses to mark the account login_failed.
const MAX_LOGIN_ATTEMPTS = 3;
async function tryLogin(account, page) {
    try {
        await login(account, page);
        account.loginAttempts = 0;
        account.loginError = null;
    } catch (err) {
        account.loginAttempts = (account.loginAttempts || 0) + 1;
        account.loginError = err.message;
        log(`Login attempt ${account.loginAttempts}/${MAX_LOGIN_ATTEMPTS} failed: ${err.message}`, 'ERROR', account.email);
        if (account.loginAttempts >= MAX_LOGIN_ATTEMPTS || err.message === 'ACCOUNT_LOCKED') {
            const permErr = new Error(
                err.message === 'ACCOUNT_LOCKED'
                    ? 'ACCOUNT_LOCKED'
                    : `LOGIN_FAILED_PERMANENT after ${account.loginAttempts} attempts: ${err.message}`
            );
            permErr.permanent = true;
            throw permErr;
        }
        throw err;
    }
}

async function login(account, page) {
    log('Attempting login...', 'INFO', account.email);

    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });

    const pageText = await page.innerText('body').catch(() => '');
    if (pageText.toLowerCase().includes('system is busy') ||
        pageText.toLowerCase().includes('too many requests')) {
        throw new Error('SYSTEM_BUSY');
    }
    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    await page.fill('#user_email', account.email);
    await page.fill('#user_password', account.password);

    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch (e) {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await page.click('input[type="submit"]');

    try {
        const okButton = page.locator('button:has-text("OK"), a:has-text("OK")');
        if (await okButton.isVisible({ timeout: 3000 })) {
            await okButton.click();
            await page.click('.icheckbox', { force: true }).catch(() => {});
            await page.click('input[type="submit"]');
        }
    } catch (e) {}

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (page.url().includes('sign_in')) {
        throw new Error('LOGIN_FAILED');
    }

    log('Login successful!', 'SUCCESS', account.email);
    return true;
}

// ============================================================================
// NAVIGATE TO APPOINTMENT PAGE
// ============================================================================
async function navigateToAppointmentPage(account, page) {
    log('Navigating to appointment page...', 'INFO', account.email);

    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 20000 });
    await page.click(continueBtn);

    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');

    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    const options = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
    );

    const target = options.find(o => o.text.toLowerCase().includes(account.city.toLowerCase()));
    if (target) {
        await page.selectOption(facilitySelector, target.value);
        log(`Selected city: ${target.text}`, 'INFO', account.email);
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

    if (ids.scheduleId) account.scheduleId = ids.scheduleId;
    if (ids.facilityId) account.facilityId = ids.facilityId;
    if (ids.csrf) account.csrfToken = ids.csrf;
    log(`Extracted IDs - schedule: ${account.scheduleId}, facility: ${account.facilityId}`, 'INFO', account.email);

    try {
        await page.waitForSelector('input[type="submit"][value="Continue"]', { timeout: 3000 });
        await page.click('input[type="submit"][value="Continue"]');
    } catch (e) {}

    return true;
}

// ============================================================================
// BOOKING
// ============================================================================
async function performBooking(account, page, slot) {
    const startTime = Date.now();
    let capturedTime = slot.time || null; // if orchestrator pre-assigned a time, use it

    sendTelegram(
        `🚀 <b>BOOKING STARTED!</b>\n📅 ${slot.date}` +
        (capturedTime ? ` ⏰ ${capturedTime}` : '') +
        `\n📍 ${account.city}\n📧 ${account.email}`
    );

    try {
        const ids = await page.evaluate(() => {
            const url = window.location.href;
            const scheduleMatch = url.match(/schedule\/(\d+)/);
            const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            return {
                scheduleId: scheduleMatch ? scheduleMatch[1] : null,
                facilityId: facilitySelect ? facilitySelect.value : null,
                csrf: csrfToken
            };
        });

        if (!ids?.scheduleId || !ids?.facilityId) {
            log(`❌ Missing IDs`, 'ERROR', account.email);
            return false;
        }

        // If no pre-assigned time, fetch the times list and pick the first available
        if (!capturedTime) {
            const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${ids.scheduleId}/appointment/times/${ids.facilityId}.json?date=${slot.date}&appointments[expedite]=false`;

            const timeResult = await Promise.race([
                page.evaluate(async ({ url, csrf }) => {
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 3000);

                        const resp = await fetch(url, {
                            method: 'GET',
                            credentials: 'include',
                            signal: controller.signal,
                            headers: {
                                'Accept': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest',
                                'X-CSRF-Token': csrf || ''
                            }
                        });
                        clearTimeout(timeoutId);
                        if (!resp.ok) return { error: `HTTP ${resp.status}` };
                        const data = await resp.json();
                        return { times: data.available_times || [], time: data.available_times?.[0] || null };
                    } catch (e) {
                        return { error: e.message };
                    }
                }, { url: timesUrl, csrf: ids.csrf }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout fetching times')), 5000))
            ]).catch(e => ({ error: e.message }));

            if (timeResult.error) {
                log(`❌ Times API: ${timeResult.error}`, 'ERROR', account.email);
                return false;
            }

            if (!timeResult.time) {
                log(`❌ No times for ${slot.date}`, 'ERROR', account.email);
                return false;
            }

            capturedTime = timeResult.time;
        }
        log(`⏰ Time: ${capturedTime}`, 'SUCCESS', account.email);

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
            }, { date: slot.date, time: capturedTime });
        } catch (e) {
            if (e.message.includes('context') || e.message.includes('destroyed')) {
                log(`✅ Navigation detected`, 'SUCCESS', account.email);
            } else {
                throw e;
            }
        }

        try {
            await page.waitForSelector('a.button.alert', { timeout: 3000 });
        } catch (e) {
            log(`⚠️ Confirm button wait timeout`, 'WARN', account.email);
        }

        try {
            const confirmBtn = await page.$('a.button.alert') || await page.$('input[value="Confirm"]');
            if (confirmBtn) {
                await confirmBtn.click();
                log(`✅ Confirm clicked`, 'SUCCESS', account.email);
            }
        } catch (e) {
            if (e.message.includes('context') || e.message.includes('destroyed')) {
                log(`✅ Confirm navigation detected`, 'SUCCESS', account.email);
            }
        }

        const elapsed = Date.now() - startTime;
        log(`🎉 BOOKED in ${elapsed}ms!`, 'SUCCESS', account.email);
        sendTelegram(`🎉 <b>BOOKED!</b>\n📅 ${slot.date}\n⏰ ${capturedTime}\n⏱ ${elapsed}ms\n📧 ${account.email}`);
        return true;

    } catch (error) {
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            const elapsed = Date.now() - startTime;
            log(`🎉 Likely BOOKED in ${elapsed}ms!`, 'SUCCESS', account.email);
            sendTelegram(`🎉 <b>LIKELY BOOKED!</b>\n📅 ${slot.date}\n⏱ ${elapsed}ms\n📧 ${account.email}`);
            return true;
        }
        log(`❌ Error: ${error.message}`, 'ERROR', account.email);
        return false;
    }
}

// ============================================================================
// PER-ACCOUNT MAIN LOOP
// ============================================================================
async function runAccountBot(account) {
    const roleTag = account.isMonitor ? 'MONITOR' : 'IDLE';
    log(`Starting [${roleTag}] for ${account.email} (${account.city}, ${account.cpm} CPM)`, 'SUCCESS', account.email);
    account.status = 'starting';

    // Determine which proxy to use: account-specific pool > global CONFIG.proxy
    const useGlobalProxy = !account.proxy && CONFIG.proxy.enabled;
    let proxyIP = null;
    if (useGlobalProxy) {
        proxyIP = await verifyProxyIP();
        if (!proxyIP) {
            log('PROXY FAILED', 'FATAL', account.email);
            account.status = 'error';
            sendTelegram(`🛑 <b>Proxy Failed</b>\n📧 ${account.email}`);
            ACCOUNTS.delete(account.id);
            return;
        }
    } else if (account.proxy) {
        proxyIP = account.proxy.server; // best-effort label; real IP not pre-tested
    }

    // Console-only start log; the launch-batch summary covers Telegram for groups.
    log(`Starting ${roleTag} for ${account.city} · ${account.cpm} CPM · proxy ${proxyIP || 'direct'}`, 'INFO', account.email);

    try {
        const launchOptions = {
            headless: CONFIG.bot.headless,
            args: ['--disable-blink-features=AutomationControlled', '--disable-webrtc', '--no-sandbox']
        };
        if (!CONFIG.bot.headless) launchOptions.channel = 'chrome';

        // Per-account proxy wins over the global one
        if (account.proxy) {
            launchOptions.proxy = {
                server: `http://${account.proxy.server}`,
                username: account.proxy.username,
                password: account.proxy.password
            };
        } else if (CONFIG.proxy.enabled) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            };
        }

        account.browser = await chromium.launch(launchOptions);

        const sessionUserAgent = getRandomUserAgent();
        log(`UA: ${sessionUserAgent.substring(0, 50)}...`, 'INFO', account.email);

        const context = await account.browser.newContext({
            userAgent: sessionUserAgent,
            viewport: { width: 1920, height: 1080 },
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });

        const page = await context.newPage();
        account.context = context;
        account.page = page;
        setupResponseListener(account, page);

        await tryLogin(account, page);
        await navigateToAppointmentPage(account, page);

        // Logged-in success is signaled by status change; the launch-batch helper
        // will Telegram a single summary once all batch accounts settle.
        log(`Logged in — ${account.isMonitor ? 'monitoring' : 'standby ready'}`, 'SUCCESS', account.email);
        account.status = account.isMonitor ? 'running' : 'ready';

        let checkCount = 0;
        const startTime = Date.now();
        let lastTelegramUpdate = Date.now();
        let lastCookieReset = Date.now();
        account.lastVerifyTime = Date.now();

        const verifyIntervalMs = CONFIG.verifyCredentials.intervalMins * 60 * 1000;
        const cookieResetIntervalMs = 15 * 60 * 1000;

        while (!account.stopFlag) {
            try {
                checkCount++;

                // If a broadcast is in progress, stay out of its way until it ends
                if (BOOKING_BROADCAST.inProgress) {
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }

                // Cookie reset every 15 min — applies to BOTH monitors and idles
                if (!account.bookingInProgress && Date.now() - lastCookieReset > cookieResetIntervalMs) {
                    log('🍪 15 min cookie reset...', 'INFO', account.email);
                    sendTelegram(`🍪 <b>Cookie Reset</b>\n📧 ${account.email}`);
                    try {
                        await context.clearCookies();
                        await tryLogin(account, page);
                        await navigateToAppointmentPage(account, page);
                        lastCookieReset = Date.now();
                        sendTelegram(`✅ <b>Cookie Reset Done</b>\n📧 ${account.email}`);
                    } catch (cookieErr) {
                        if (cookieErr.permanent) throw cookieErr; // bubble to outer catch → mark failed
                        log(`Cookie reset failed: ${cookieErr.message}`, 'ERROR', account.email);
                        sendTelegram(`⚠️ <b>Cookie Reset Failed</b>\n📧 ${account.email}\nRestarting account...`);
                        if (account.browser) await account.browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        if (!account.stopFlag) return runAccountBot(account);
                        return;
                    }
                }

                // Page-alive ping (both modes)
                if (checkCount % 100 === 0) {
                    try {
                        await page.evaluate(() => true);
                    } catch (e) {
                        log('Page lost', 'ERROR', account.email);
                        sendTelegram(`⚠️ <b>Connection Lost</b>\n📧 ${account.email}`);
                        if (account.browser) await account.browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        if (!account.stopFlag) return runAccountBot(account);
                        return;
                    }
                }

                // ============================
                // IDLE MODE: keep alive, wait for broadcast
                // (no per-account heartbeat — global digest covers it)
                // ============================
                if (!account.isMonitor) {
                    await new Promise(r => setTimeout(r, 2000));
                    continue;
                }

                // ============================
                // MONITOR MODE: poll for dates
                // ============================

                // Stale data check
                if (!account.bookingInProgress && Date.now() - account.lastVerifyTime > verifyIntervalMs) {
                    log(`⏰ Stale data check...`, 'SECURITY', account.email);
                    try {
                        const dataIsFresh = await verifyDataFreshness(account);
                        if (!dataIsFresh) {
                            log('🔄 Restarting due to stale data', 'ERROR', account.email);
                            if (account.browser) await account.browser.close().catch(() => {});
                            await new Promise(r => setTimeout(r, 3000));
                            if (!account.stopFlag) return runAccountBot(account);
                            return;
                        }
                    } catch (verifyErr) {
                        log(`Verify failed: ${verifyErr.message}`, 'WARN', account.email);
                        account.lastVerifyTime = Date.now();
                    }
                }

                // System busy / session expired check
                if (!account.bookingInProgress && checkCount % 50 === 0) {
                    const pageText = await page.innerText('body').catch(() => '');
                    if (pageText.toLowerCase().includes('system is busy')) {
                        log('System busy', 'WARN', account.email);
                        await page.waitForTimeout(5000);
                        continue;
                    }
                    if (pageText.toLowerCase().includes('sign in') || pageText.toLowerCase().includes('log in')) {
                        log('Session expired', 'WARN', account.email);
                        sendTelegram(`⚠️ <b>Session Expired</b>\n📧 ${account.email}\nRe-logging in...`);
                        if (account.browser) await account.browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        if (!account.stopFlag) return runAccountBot(account);
                        return;
                    }
                }

                fireDirectFetch(account, page);
                const slot = await readLatestDates(account, page);

                // Latency alert: notify when sustained latency spikes high, and again when it recovers.
                {
                    const HIGH = 3000;       // ms — flag as bad above this
                    const RECOVER = 1500;    // ms — clear flag below this
                    const COOLDOWN = 5 * 60 * 1000;  // don't spam alerts more than once per 5 min
                    const lat = account.lastLatency;
                    const now = Date.now();
                    if (lat > HIGH && !account.latencyAlertActive &&
                        now - account.lastLatencyAlertAt > COOLDOWN) {
                        account.latencyAlertActive = true;
                        account.lastLatencyAlertAt = now;
                        sendTelegram(
                            `🐢 <b>High latency</b>\n📧 ${account.email}\n📍 ${account.city}\n` +
                            `⏱ ${lat}ms (threshold ${HIGH}ms)\n🔌 ${account.proxy ? account.proxy.server : 'global'}`
                        );
                    } else if (lat > 0 && lat < RECOVER && account.latencyAlertActive &&
                               now - account.lastLatencyAlertAt > COOLDOWN) {
                        account.latencyAlertActive = false;
                        account.lastLatencyAlertAt = now;
                        sendTelegram(
                            `🟢 <b>Latency recovered</b>\n📧 ${account.email}\n⏱ ${lat}ms`
                        );
                    }
                }

                const elapsedMinutes = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsedMinutes).toFixed(1);
                const dateDisplay = account.availableDate ? account.availableDate.date : 'SEARCHING';
                const closestDisplay = account.closestSlotFound ? account.closestSlotFound.date : 'N/A';
                const nextVerifyIn = Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - account.lastVerifyTime)) / 60000));
                const nextCookieReset = Math.max(0, Math.ceil((cookieResetIntervalMs - (Date.now() - lastCookieReset)) / 60000));
                // Mirror for the digest function (which doesn't have access to these locals)
                account.actualCpm = cpm;
                account.checkCount = checkCount;
                account.nextVerifyIn = nextVerifyIn;

                if (checkCount % Math.ceil(account.cpm / 60) === 0) {
                    const latencyDisplay = account.lastLatency > 0 ? account.lastLatency + 'ms' : '--';
                    console.log(`\x1b[44m[${account.email} ${cpm} CPM]\x1b[0m #${checkCount} | Latency: ${latencyDisplay} | Slot: ${dateDisplay} | Best: ${closestDisplay} | Verify: ${nextVerifyIn}m | Cookie: ${nextCookieReset}m`);
                }

                // SLOT FOUND → broadcast to ALL accounts (using THIS monitor's date range)
                if (slot && isDateInRange(slot.date, account.startDate, account.endDate)) {
                    log(`🎯 MATCH: ${slot.date} in ${account.city} — broadcasting`, 'SUCCESS', account.email);
                    // Fire and forget; broadcastBooking guards against concurrent triggers
                    broadcastBooking({
                        date: slot.date,
                        city: account.city,
                        rangeStart: account.startDate,
                        rangeEnd: account.endDate
                    }, account.email).catch(err =>
                        log(`Broadcast error: ${err.message}`, 'ERROR', account.email)
                    );
                    // Give the broadcast time to flip its inProgress flag
                    await new Promise(r => setTimeout(r, 250));
                    continue;
                }

                // Per-account per-minute messages REMOVED — see sendDigest() for
                // the single aggregated digest sent every 60s for all accounts.

                await page.waitForTimeout(getDelay(account.cpm));
            } catch (loopError) {
                log(`Loop error: ${loopError.message}`, 'ERROR', account.email);
                await new Promise(r => setTimeout(r, 1000));
                if (loopError.message.includes('closed') || loopError.message.includes('Target')) {
                    log('Browser closed - restarting account', 'ERROR', account.email);
                    sendTelegram(`⚠️ <b>Browser Crashed</b>\n📧 ${account.email}\nRestarting...`);
                    if (account.browser) await account.browser.close().catch(() => {});
                    await new Promise(r => setTimeout(r, 5000));
                    if (!account.stopFlag) return runAccountBot(account);
                    return;
                }
            }
        }

        // Stop flag set externally
        log('Stop flag set - shutting down account', 'INFO', account.email);
        if (account.browser) await account.browser.close().catch(() => {});
        if (account.verifyBrowser) await account.verifyBrowser.close().catch(() => {});
        account.status = 'stopped';
        ACCOUNTS.delete(account.id);
        sendTelegram(`🛑 <b>${account.email} stopped</b>`);
    } catch (error) {
        log(`Fatal: ${error.message}`, 'ERROR', account.email);
        if (account.browser) await account.browser.close().catch(() => {});
        if (account.verifyBrowser) await account.verifyBrowser.close().catch(() => {});

        // Permanent failure (login retries exhausted, account locked, etc.)
        // Keep the account in ACCOUNTS so /list shows it under the failed section.
        if (error.permanent || error.message === 'ACCOUNT_LOCKED' || error.message.includes('LOGIN_FAILED_PERMANENT')) {
            account.status = 'login_failed';
            account.stopFlag = true;
            account.loginError = account.loginError || error.message;
            sendTelegram(
                `🛑 <b>${account.email} disabled</b>\n` +
                `📍 ${account.city}\n` +
                `❌ ${account.loginError}\n` +
                `Login attempts: ${account.loginAttempts}/${MAX_LOGIN_ATTEMPTS}\n\n` +
                `Use <code>/retry ${account.email}</code> to try again, or <code>/close ${account.email}</code> to remove.`
            );
            return;
        }

        sendTelegram(`🛑 <b>Error</b>\n📧 ${account.email}\n${error.message}`);

        if (!account.stopFlag) {
            log('Restarting account in 10s...', 'WARN', account.email);
            await new Promise(r => setTimeout(r, 10000));
            return runAccountBot(account);
        }
        account.status = 'error';
        ACCOUNTS.delete(account.id);
    }
}

function startAccount(opts, chatId) {
    if (ACCOUNTS.has(opts.email)) {
        sendTelegram(`⚠️ <b>Already running</b>\n📧 ${opts.email}`, chatId);
        return null;
    }
    // Assign a proxy from the pool if available and no proxy was passed in opts
    const accountOpts = { ...opts };
    if (!accountOpts.proxy) {
        const assigned = nextProxyFromPool();
        if (assigned) accountOpts.proxy = assigned;
    }
    const account = createAccount(accountOpts);
    if (account.proxy) {
        log(`Assigned proxy ${account.proxy.server} to ${account.email}`, 'INFO', account.email);
    }
    ACCOUNTS.set(account.id, account);
    runAccountBot(account).catch(err => {
        log(`Unhandled in account loop: ${err.message}`, 'ERROR', account.email);
        ACCOUNTS.delete(account.id);
    });
    return account;
}

function stopAccount(email, chatId) {
    const account = ACCOUNTS.get(email);
    if (!account) {
        sendTelegram(`⚠️ Not found: ${email}`, chatId);
        return false;
    }
    account.stopFlag = true;
    sendTelegram(`🛑 Stopping ${email}... (will close shortly)`, chatId);
    // Force close after a short grace period
    setTimeout(async () => {
        if (account.browser) await account.browser.close().catch(() => {});
        if (account.verifyBrowser) await account.verifyBrowser.close().catch(() => {});
        ACCOUNTS.delete(email);
    }, 3000);
    return true;
}

// ============================================================================
// TELEGRAM INTERACTIVE INTERFACE
// ============================================================================
// Per-chat conversation state
const CHAT_STATE = new Map();
// Modes:
//   idle
//   awaiting_city_count        (how many cities)
//   awaiting_verify_email
//   awaiting_verify_password
//   awaiting_city_name         (which city, per city loop)
//   awaiting_city_cpm          (cpm for that city)
//   awaiting_city_monitors     (paste monitor IDs for that city, or "none")
//   awaiting_city_standby      (paste standby IDs for that city, or "none")
//   awaiting_close_choice

// Parse a single ID line: "email password" (separator: whitespace, comma, or pipe).
function parseIdLine(line) {
    const t = (line || '').trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return null;
    const m = t.match(/^(\S+@\S+?)[\s,|]+(.+)$/);
    if (!m) return null;
    return { email: m[1].trim(), password: m[2].trim() };
}

// Parse a multi-line paste of ID lines. Returns { ids: [{email, password}], errors: [] }.
// Parse structured ID blocks of the form:
//   id: someone@gmail.com
//   Password: mypass
//   City: Toronto
//   Type: monitor       (or standby)
//   Cpm: 240
//   Start Date: 2026-05-20
//   End Date: 2026-06-30
//
// Multiple IDs: separate blocks by a blank line OR a line of "---".
function parseStructuredBlock(text) {
    const result = { ids: [], errors: [] };
    if (!text || !text.trim()) return result;

    const keyAliases = {
        id: 'email', email: 'email', username: 'email', user: 'email',
        password: 'password', pass: 'password', pwd: 'password',
        city: 'city', location: 'city',
        type: 'type', role: 'type',
        cpm: 'cpm', targetcpm: 'cpm',
        startdate: 'startDate', start: 'startDate', from: 'startDate',
        enddate: 'endDate', end: 'endDate', to: 'endDate', till: 'endDate'
    };

    // Single pass: blank lines are ignored. A new block starts whenever:
    //   - we see "---" separator, OR
    //   - we see another `id:` / `email:` line after the current block already has one
    let fields = {};
    let blockNum = 0;

    const finalize = () => {
        if (Object.keys(fields).length === 0) return;
        blockNum++;
        const required = ['email', 'password', 'city', 'type', 'cpm', 'startDate', 'endDate'];
        const missing = required.filter(k => !fields[k]);
        if (missing.length > 0) {
            result.errors.push(`Block ${blockNum} (${fields.email || '?'}): missing ${missing.join(', ')}`);
            fields = {};
            return;
        }
        const typeRaw = fields.type.toLowerCase();
        const isMonitor = (typeRaw === 'monitor' || typeRaw === 'm');
        const isStandby = (typeRaw === 'standby' || typeRaw === 's');
        if (!isMonitor && !isStandby) {
            result.errors.push(`Block ${blockNum} (${fields.email}): Type must be "monitor" or "standby" (got "${fields.type}")`);
            fields = {};
            return;
        }
        const cpm = parseInt(fields.cpm);
        if (!Number.isFinite(cpm) || cpm < 1 || cpm > 10000) {
            result.errors.push(`Block ${blockNum} (${fields.email}): bad Cpm "${fields.cpm}"`);
            fields = {};
            return;
        }
        const startDate = new Date(fields.startDate);
        const endDate = new Date(fields.endDate);
        if (isNaN(startDate.getTime())) {
            result.errors.push(`Block ${blockNum} (${fields.email}): bad Start Date "${fields.startDate}" (use YYYY-MM-DD)`);
            fields = {};
            return;
        }
        if (isNaN(endDate.getTime())) {
            result.errors.push(`Block ${blockNum} (${fields.email}): bad End Date "${fields.endDate}" (use YYYY-MM-DD)`);
            fields = {};
            return;
        }
        result.ids.push({
            email: fields.email,
            password: fields.password,
            city: fields.city,
            isMonitor,
            cpm,
            startDate,
            endDate
        });
        fields = {};
    };

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;
        if (/^-{3,}$/.test(line)) { finalize(); continue; }

        const m = line.match(/^([^:]+?)\s*:\s*(.*)$/);
        if (!m) {
            result.errors.push(`Bad line: "${line}"`);
            continue;
        }
        const rawKey = m[1].toLowerCase().replace(/[\s_\-]+/g, '');
        const normalKey = keyAliases[rawKey];
        if (!normalKey) {
            result.errors.push(`Unknown field "${m[1].trim()}"`);
            continue;
        }
        // Detect new block: incoming email line, but current block already has one
        if (normalKey === 'email' && fields.email) {
            finalize();
        }
        fields[normalKey] = m[2].trim();
    }
    finalize();

    return result;
}

const STRUCTURED_HELP =
    '<b>Paste IDs in this format:</b>\n\n' +
    '<code>id: someone@gmail.com\n' +
    'Password: mypass\n' +
    'City: Toronto\n' +
    'Type: monitor\n' +
    'Cpm: 240\n' +
    'Start Date: 2026-05-20\n' +
    'End Date: 2026-06-30</code>\n\n' +
    'For multiple IDs, separate each block with a blank line.\n' +
    'Type: <code>monitor</code> or <code>standby</code>\n' +
    'Dates: YYYY-MM-DD';

async function applyStructuredAdd(text, chatId) {
    const parsed = parseStructuredBlock(text);

    if (parsed.errors.length > 0) {
        sendTelegram(
            `⚠️ <b>Parse errors</b>\n${parsed.errors.join('\n')}\n\nFix and re-paste, or /cancel.`,
            chatId
        );
        return false;
    }
    if (parsed.ids.length === 0) {
        sendTelegram(`⚠️ No IDs parsed. Send the paste in the documented format, or /cancel.`, chatId);
        return false;
    }
    await launchAccountsBatched(parsed.ids, chatId);
    return true;
}

// Launch a batch of accounts and send ONE summary message when all of them
// reach a terminal state (logged in OR login_failed). Individual per-account
// "started" / "logged in" messages are NOT sent — those signals roll up here.
// Failed accounts still get their own ❌ Telegram notification from the
// runAccountBot catch block, so you see each error individually.
async function launchAccountsBatched(optsList, chatId) {
    if (!Array.isArray(optsList) || optsList.length === 0) {
        sendTelegram('⚠️ Nothing to launch.', chatId);
        return;
    }

    // Pre-launch announcement (1 message)
    const monitors = optsList.filter(o => o.isMonitor).length;
    const standby = optsList.length - monitors;
    const cityGroups = new Map();
    for (const o of optsList) {
        if (!cityGroups.has(o.city)) cityGroups.set(o.city, { m: 0, s: 0, cpm: o.cpm });
        if (o.isMonitor) cityGroups.get(o.city).m++;
        else cityGroups.get(o.city).s++;
    }
    let preMsg = `🚀 <b>Launching ${optsList.length} ID(s)</b>\n${monitors} monitor · ${standby} standby`;
    for (const [city, g] of cityGroups) {
        preMsg += `\n📍 ${city}: ${g.m} monitor, ${g.s} standby (${g.cpm} CPM)`;
    }
    preMsg += '\n\n⏳ Waiting for all to log in... (you\'ll get individual ❌ for any failures, then a summary)';
    sendTelegram(preMsg, chatId);

    // Stagger account starts so they don't all hit AIS / Telegram at once
    const launched = [];
    for (const opts of optsList) {
        const acc = startAccount(opts, chatId);
        if (acc) launched.push(acc);
        await new Promise(r => setTimeout(r, 1200));
    }
    if (launched.length === 0) {
        sendTelegram(`⚠️ Nothing launched (all duplicates).`, chatId);
        return;
    }

    // Wait until each launched account reaches a terminal "ready" state.
    // running/ready = logged in successfully; login_failed/error = bad creds or other fatal.
    const TIMEOUT_MS = 5 * 60 * 1000;
    const POLL_MS = 2000;
    const startWait = Date.now();
    const isTerminal = (a) =>
        a.status === 'running' ||
        a.status === 'ready' ||
        a.status === 'login_failed' ||
        a.status === 'error' ||
        !ACCOUNTS.has(a.id);

    while (Date.now() - startWait < TIMEOUT_MS) {
        if (launched.every(isTerminal)) break;
        await new Promise(r => setTimeout(r, POLL_MS));
    }

    const success = launched.filter(a => a.status === 'running' || a.status === 'ready');
    const failed = launched.filter(a => a.status === 'login_failed' || a.status === 'error');
    const pending = launched.length - success.length - failed.length;

    let msg = `✅ <b>Launch complete</b>\n${success.length}/${launched.length} logged in`;
    if (failed.length > 0) msg += ` · ❌ ${failed.length} failed`;
    if (pending > 0) msg += ` · ⏳ ${pending} still starting (after 5 min)`;
    const sGroups = new Map();
    for (const a of success) {
        if (!sGroups.has(a.city)) sGroups.set(a.city, { m: 0, s: 0 });
        if (a.isMonitor) sGroups.get(a.city).m++;
        else sGroups.get(a.city).s++;
    }
    for (const [city, g] of sGroups) {
        const parts = [];
        if (g.m > 0) parts.push(`${g.m} monitor`);
        if (g.s > 0) parts.push(`${g.s} standby`);
        msg += `\n📍 ${city}: ${parts.join(', ')}`;
    }
    if (failed.length > 0) {
        msg += '\n\n❌ Failed (see individual messages above):';
        for (const a of failed) {
            msg += `\n  · ${a.email} — ${a.loginError || a.status}`;
        }
    }
    sendTelegram(msg, chatId);
}

function parseIdBlock(text) {
    const ids = [];
    const errors = [];
    const lower = (text || '').trim().toLowerCase();
    if (!lower || lower === 'none' || lower === 'skip' || lower === '0' || lower === '-') {
        return { ids, errors };
    }
    for (const raw of text.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        const parsed = parseIdLine(trimmed);
        if (!parsed) {
            errors.push(`Bad line: "${trimmed}"`);
            continue;
        }
        ids.push(parsed);
    }
    return { ids, errors };
}

// Launch every pending account (called at the end of the city-by-city flow).
async function launchPending(pending, chatId) {
    await launchAccountsBatched(pending, chatId);
}

// Legacy bulk parser kept for reference; no longer wired up.
// (Removed older code path) — placeholder so subsequent functions don't reference removed names.
function _legacyRemoved() {}

/* OLD BULK PARSER REMOVED — replaced by city-by-city state machine below.
function parseBulkList(text) {
    // Accepts a multi-line paste like:
//
//   verify: verify@gmail.com VerifyPass123   ← optional, omit if .env has it
//
//   Toronto                                  ← city header. default role=monitor, cpm=240
//   scout-toronto@gmail.com Pass1
//   booker1@gmail.com Pass3
//
//   Toronto standby                          ← role on the header line
//   booker2@gmail.com Pass4
//
//   Vancouver monitor 300                    ← optional cpm
//   scout-van@gmail.com Pass2
//
// - Headers: "City [m|monitor|s|standby] [CPM]"
// - ID lines: "email password" (whitespace, comma, or pipe separator)
// - Blank lines and lines starting with # are ignored
// - Two-word city names: wrap in quotes ("New Delhi" m 240) OR replace space with _
// - Verify line: starts with "verify:" or "v:"
function parseBulkList(text) {
    const out = { verify: null, ids: [], errors: [] };
    let currentCity = null;
    let currentRole = 'monitor';
    let currentCpm = CONFIG.bot.defaultCPM;

    const rawLines = text.split('\n');
    for (let raw of rawLines) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('//')) continue;

        // verify: email password   (or v: ...)
        const vMatch = line.match(/^(?:verify|v)\s*[:=]?\s*(\S+@\S+)[\s,|]+(.+)$/i);
        if (vMatch) {
            out.verify = { email: vMatch[1], password: vMatch[2].trim() };
            continue;
        }

        // ID line: email + password (separated by whitespace, comma, or pipe)
        const idMatch = line.match(/^(\S+@\S+?)[\s,|]+(.+)$/);
        if (idMatch) {
            if (!currentCity) {
                out.errors.push(`Line "${line}" — no city header above it`);
                continue;
            }
            out.ids.push({
                email: idMatch[1].trim(),
                password: idMatch[2].trim(),
                city: currentCity,
                isMonitor: currentRole === 'monitor',
                cpm: currentCpm
            });
            continue;
        }

        // Else: header line.  city [m|s] [cpm]
        // Support quoted city names for spaces: "New Delhi" m 240
        let header = line;
        let cityName;
        const quoted = header.match(/^["“”']([^"“”']+)["“”']\s*(.*)$/);
        if (quoted) {
            cityName = quoted[1];
            header = quoted[2].trim();
        } else {
            const firstSpace = header.search(/\s/);
            if (firstSpace === -1) {
                cityName = header;
                header = '';
            } else {
                cityName = header.slice(0, firstSpace);
                header = header.slice(firstSpace).trim();
            }
        }
        cityName = cityName.replace(/_/g, ' ');

        let role = 'monitor';
        let cpm = CONFIG.bot.defaultCPM;
        const tokens = header ? header.split(/[\s,]+/) : [];
        for (const t of tokens) {
            const tl = t.toLowerCase().replace(/^@/, '');
            if (tl === 'm' || tl === 'monitor' || tl === 'monitors') role = 'monitor';
            else if (tl === 's' || tl === 'standby' || tl === 'standbys') role = 'standby';
            else if (/^\d+$/.test(tl)) cpm = parseInt(tl);
        }

        currentCity = cityName;
        currentRole = role;
        currentCpm = cpm;
    }

    return out;
}

async function applyBulkPaste(text, chatId, isAdd) {
    const parsed = parseBulkList(text);

    if (parsed.errors.length > 0) {
        sendTelegram(`⚠️ <b>Parse errors</b>\n${parsed.errors.join('\n')}\n\nFix and re-paste, or /cancel.`, chatId);
        return false;
    }

    if (parsed.ids.length === 0) {
        sendTelegram(`⚠️ No IDs found in your paste. Make sure each city has at least one "email password" line below it.\n\nSend /help for the format, or /cancel.`, chatId);
        return false;
    }

    // Verify creds: from paste, else from .env (already in CONFIG)
    if (parsed.verify) {
        CONFIG.verifyCredentials.email = parsed.verify.email;
        CONFIG.verifyCredentials.password = parsed.verify.password;
    }
    const hasVerify = CONFIG.verifyCredentials.email && CONFIG.verifyCredentials.password;
    if (!isAdd && !hasVerify) {
        sendTelegram(
            `⚠️ No verify account set. Add a line like:\n` +
            `<code>verify: verify@gmail.com VerifyPass</code>\n` +
            `at the top of your paste, or set VERIFY_EMAIL/VERIFY_PASSWORD in .env.`,
            chatId
        );
        return false;
    }

    // Build a summary grouped by city
    const groups = new Map();
    for (const id of parsed.ids) {
        const key = id.city;
        if (!groups.has(key)) groups.set(key, { monitors: [], standby: [], cpm: id.cpm });
        const g = groups.get(key);
        if (id.isMonitor) g.monitors.push(id.email);
        else g.standby.push(id.email);
        g.cpm = id.cpm; // last wins, but they're per-section so fine
    }
    const monitors = parsed.ids.filter(i => i.isMonitor).length;
    const standby = parsed.ids.length - monitors;

    let summary = `<b>Parsed ${parsed.ids.length} ID(s)</b> across ${groups.size} city(ies) · ${monitors} monitor · ${standby} standby\n`;
    for (const [city, g] of groups) {
        summary += `\n<b>📍 ${city}</b> (cpm ${g.cpm})`;
        for (const e of g.monitors) summary += `\n  👁️ ${e}`;
        for (const e of g.standby) summary += `\n  💤 ${e}`;
    }
    if (parsed.verify) summary += `\n\n🔐 Verify account: <code>${parsed.verify.email}</code>`;
    summary += `\n\n🚀 Launching now...`;
    sendTelegram(summary, chatId);

    for (const opts of parsed.ids) {
        startAccount(opts, chatId);
        await new Promise(r => setTimeout(r, 1200)); // stagger
    }
    sendTelegram(`✅ All ${parsed.ids.length} ID(s) launched. /list to view, /add to paste more, /close to stop one.`, chatId);
    return true;
}

const BULK_HELP =
    `<b>Bulk paste format</b>\n` +
    `One city per section. City header on its own line, then <code>email password</code> per line.\n\n` +
    `<code>verify: verify@gmail.com VerifyPass</code>   (optional if .env has it)\n\n` +
    `<code>Toronto</code>                       ← defaults: monitor, 240 CPM\n` +
    `<code>scout-toronto@gmail.com Pass1</code>\n` +
    `<code>booker1@gmail.com Pass3</code>\n\n` +
    `<code>Toronto standby</code>               ← all rows below = standby\n` +
    `<code>booker2@gmail.com Pass4</code>\n\n` +
    `<code>Vancouver monitor 300</code>        ← optional CPM\n` +
    `<code>scout-van@gmail.com Pass2</code>\n\n` +
    `Notes:\n` +
    `• Roles: <code>m</code>/<code>monitor</code> or <code>s</code>/<code>standby</code>\n` +
    `• Multi-word cities: wrap in quotes or use underscores ("New Delhi" or New_Delhi)\n` +
    `• Comma or | separators also work between email and password\n` +
    `• Lines starting with # are ignored`;
*/

function getState(chatId) {
    if (!CHAT_STATE.has(chatId)) {
        CHAT_STATE.set(chatId, { mode: 'idle' });
    }
    return CHAT_STATE.get(chatId);
}

function resetState(chatId) {
    CHAT_STATE.set(chatId, { mode: 'idle' });
}

function tgGet(path) {
    return new Promise((resolve, reject) => {
        https.get(`https://api.telegram.org/bot${CONFIG.telegram.botToken}${path}`, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function handleTelegramMessage(message) {
    const chatId = String(message.chat.id);
    const text = (message.text || '').trim();

    // Authorize: only allow configured CHAT_ID if set
    if (CONFIG.telegram.chatId && chatId !== String(CONFIG.telegram.chatId)) {
        log(`Ignoring message from unauthorized chat ${chatId}`, 'WARN');
        return;
    }

    const state = getState(chatId);

    // Global commands
    if (text === '/cancel' || text === '/reset') {
        resetState(chatId);
        sendTelegram('🚫 Cancelled. Send /start to begin or /help for commands.', chatId);
        return;
    }

    if (text === '/help') {
        sendTelegram(
            '<b>Commands</b>\n' +
            '/start — set up IDs (verify creds + paste IDs)\n' +
            '/add — paste more IDs (id/Password/City/Type/Cpm/Start Date/End Date)\n' +
            '/format — show the paste format\n' +
            '/verify — set or replace the verify account credentials\n' +
            '/verify email pass — set inline\n' +
            '/verify clear — remove the verify account\n' +
            '/proxies — set / view the proxy pool (host:port:user:pass per line)\n' +
            '/proxies clear — empty the proxy pool\n' +
            '/list — show running IDs (and failed IDs separately)\n' +
            '/status — same as /list\n' +
            '/close — pick an ID to stop\n' +
            '/close N — stop ID number N\n' +
            '/close email@x.com — stop by email\n' +
            '/close all — stop every running ID\n' +
            '/retry email — retry a login-failed ID (re-login)\n' +
            '/retry all — retry every failed ID\n' +
            '/cancel — cancel current input\n' +
            '/help — this message',
            chatId
        );
        return;
    }

    if (text === '/list' || text === '/status') {
        if (ACCOUNTS.size === 0) {
            sendTelegram('No IDs are currently running.', chatId);
        } else {
            const all = Array.from(ACCOUNTS.values());
            const failed = all.filter(a => a.status === 'login_failed' || a.status === 'error');
            const healthy = all.filter(a => !failed.includes(a));
            const monitors = healthy.filter(a => a.isMonitor).length;
            const standby = healthy.length - monitors;

            // Group healthy by city
            const groups = new Map();
            for (const acc of healthy) {
                const key = (acc.city || '').toLowerCase();
                if (!groups.has(key)) groups.set(key, { displayName: acc.city, accounts: [] });
                groups.get(key).accounts.push(acc);
            }
            const sortedCities = Array.from(groups.entries()).sort((a, b) => a[0].localeCompare(b[0]));

            let msg = `<b>Running IDs (${healthy.length})</b>\n${monitors} monitor · ${standby} standby` +
                       (failed.length > 0 ? ` · <b>${failed.length} failed</b>` : '') + '\n';
            let globalIdx = 1;
            for (const [, group] of sortedCities) {
                group.accounts.sort((a, b) => {
                    if (a.isMonitor !== b.isMonitor) return a.isMonitor ? -1 : 1;
                    return a.email.localeCompare(b.email);
                });
                msg += `\n\n<b>📍 ${group.displayName}</b> (${group.accounts.length})`;
                for (const acc of group.accounts) {
                    const upMins = Math.floor((Date.now() - acc.startedAt) / 60000);
                    const date = acc.availableDate ? acc.availableDate.date : '-';
                    const role = acc.isMonitor ? '👁️' : '💤';
                    const lat = acc.lastLatency > 0 ? `${acc.lastLatency}ms` : '—';
                    const px = acc.proxy ? acc.proxy.server : 'global';
                    msg += `\n  ${globalIdx}. ${role} <code>${acc.email}</code>\n     ⚡ ${acc.cpm} CPM · 📡 ${lat} · 📅 ${date} · ⏱ ${upMins}m · ${acc.status}\n     🔌 ${px}`;
                    globalIdx++;
                }
            }

            if (failed.length > 0) {
                // Group failed by city too
                const fGroups = new Map();
                for (const acc of failed) {
                    const key = (acc.city || '').toLowerCase();
                    if (!fGroups.has(key)) fGroups.set(key, { displayName: acc.city, accounts: [] });
                    fGroups.get(key).accounts.push(acc);
                }
                msg += `\n\n━━━━━━━━━━━━━━━━━━\n<b>⚠️ Failed IDs (${failed.length})</b>`;
                for (const [, group] of fGroups) {
                    msg += `\n\n<b>📍 ${group.displayName}</b>`;
                    for (const acc of group.accounts) {
                        const role = acc.isMonitor ? '👁️' : '💤';
                        msg += `\n  ${globalIdx}. ${role} ❌ <code>${acc.email}</code>\n     ${acc.loginError || acc.status} (${acc.loginAttempts}/${MAX_LOGIN_ATTEMPTS} attempts)`;
                        globalIdx++;
                    }
                }
                msg += `\n\nRetry: <code>/retry email</code> or <code>/retry all</code>\nRemove: <code>/close email</code>`;
            }
            sendTelegram(msg, chatId);
        }
        return;
    }

    // /start  — same structured paste flow as /add, but asks for verify creds
    // first if they aren't already in .env.
    if (text === '/start' || text.startsWith('/start\n') || text.startsWith('/start ')) {
        const inline = text.replace(/^\/start[\s\n]*/, '').trim();
        const hasVerify = CONFIG.verifyCredentials.email && CONFIG.verifyCredentials.password;

        if (!hasVerify) {
            // Ask for verify creds first; remember any inline paste to consume after
            CHAT_STATE.set(chatId, {
                mode: 'awaiting_verify_email',
                postVerifyPaste: inline.length > 0 ? inline : null
            });
            sendTelegram(
                `👋 <b>Welcome!</b>\nFirst, send the <b>verification account email</b> (used to detect stale data):`,
                chatId
            );
            return;
        }

        // Already have verify — go straight to structured paste
        if (inline.length > 0) {
            await applyStructuredAdd(inline, chatId);
            resetState(chatId);
            return;
        }
        sendTelegram(`✅ Using verify account: <code>${CONFIG.verifyCredentials.email}</code>`, chatId);
        CHAT_STATE.set(chatId, { mode: 'awaiting_structured_add' });
        sendTelegram(`👋 <b>Welcome!</b>\n\n${STRUCTURED_HELP}`, chatId);
        return;
    }

    // /add  — accepts either a multi-line paste in the structured format,
    // either inline (/add\n<block>) or in the following message.
    if (text === '/add' || text.startsWith('/add\n') || text.startsWith('/add ')) {
        const inline = text.replace(/^\/add[\s\n]*/, '').trim();
        if (inline.length > 0) {
            await applyStructuredAdd(inline, chatId);
            resetState(chatId);
            return;
        }
        CHAT_STATE.set(chatId, { mode: 'awaiting_structured_add' });
        sendTelegram(`➕ <b>Add IDs</b>\n\n${STRUCTURED_HELP}`, chatId);
        return;
    }

    if (text === '/format') {
        sendTelegram(STRUCTURED_HELP, chatId);
        return;
    }

    // /verify                          → show current verify account + prompt for new one
    // /verify <email> <password>       → set verify creds in one line
    // /verify clear                    → clear the verify account
    if (text === '/verify' || text.startsWith('/verify ') || text.startsWith('/verify\n')) {
        const arg = text.replace(/^\/verify[\s\n]*/, '').trim();

        if (arg.toLowerCase() === 'clear') {
            CONFIG.verifyCredentials.email = '';
            CONFIG.verifyCredentials.password = '';
            sendTelegram('🗑 Verify account cleared. /start will prompt for one again, or use /verify email password to set a new one.', chatId);
            resetState(chatId);
            return;
        }

        // Inline form: /verify email password (separators: whitespace, comma, pipe)
        if (arg.length > 0) {
            const m = arg.match(/^(\S+@\S+?)[\s,|]+(.+)$/);
            if (m) {
                CONFIG.verifyCredentials.email = m[1].trim();
                CONFIG.verifyCredentials.password = m[2].trim();
                sendTelegram(
                    `✅ <b>Verify account set</b>\n📧 <code>${m[1].trim()}</code>\n\nThis account will be used to detect stale dates for all monitors.`,
                    chatId
                );
                resetState(chatId);
                return;
            }
            // Not the inline form — fall through to prompted flow with this as the email
            if (arg.includes('@')) {
                CHAT_STATE.set(chatId, { mode: 'awaiting_verify_only_password', verifyEmail: arg });
                sendTelegram('Send the verify account password:', chatId);
                return;
            }
        }

        // No args: show current and prompt for email
        const current = CONFIG.verifyCredentials.email
            ? `Current: <code>${CONFIG.verifyCredentials.email}</code>`
            : 'No verify account set.';
        sendTelegram(
            `🔐 <b>Verify account</b>\n${current}\n\n` +
            `Send the new verify account email (next message asks for password), ` +
            `or in one line:\n<code>/verify email@x.com password</code>\n\n` +
            `Use <code>/verify clear</code> to remove it.`,
            chatId
        );
        CHAT_STATE.set(chatId, { mode: 'awaiting_verify_only_email' });
        return;
    }

    // /proxies          → show pool + prompt to paste a new list
    // /proxies <list>   → set the pool inline
    // /proxies clear    → empty the pool
    if (text === '/proxies' || text.startsWith('/proxies\n') || text.startsWith('/proxies ')) {
        const inline = text.replace(/^\/proxies[\s\n]*/, '').trim();
        if (inline.toLowerCase() === 'clear') {
            PROXY_POOL.length = 0;
            _proxyCursor = 0;
            sendTelegram('🗑 Proxy pool cleared. New accounts will use the global proxy (or none).', chatId);
            resetState(chatId);
            return;
        }
        if (inline.length > 0) {
            applyProxyList(inline, chatId);
            resetState(chatId);
            return;
        }
        // No args: show current pool and wait for a paste
        const have = PROXY_POOL.length;
        sendTelegram(
            `📡 <b>Proxy pool</b>: ${have} loaded\n` +
            (have > 0 ? PROXY_POOL.map((p, i) => `  ${i + 1}. ${p.server}`).join('\n') + '\n\n' : '') +
            `Paste your proxy list, one per line:\n` +
            `<code>host:port:user:pass</code>\n\n` +
            `Or send <code>/proxies clear</code> to empty the pool.`,
            chatId
        );
        CHAT_STATE.set(chatId, { mode: 'awaiting_proxy_list' });
        return;
    }

    // /retry <email>  — re-launch an ID that was disabled after 3 login fails
    // /retry all      — retry every failed ID
    if (text === '/retry' || text.startsWith('/retry ') || text.startsWith('/retry\n')) {
        const arg = text.replace(/^\/retry/, '').trim();
        const failed = Array.from(ACCOUNTS.values()).filter(a => a.status === 'login_failed' || a.status === 'error');
        if (failed.length === 0) {
            sendTelegram('No failed IDs to retry.', chatId);
            return;
        }
        if (!arg) {
            let msg = '<b>Failed IDs</b> — send <code>/retry email</code> or <code>/retry all</code>:\n';
            failed.forEach(a => msg += `\n  ❌ ${a.email} | ${a.city} | ${a.loginError || a.status}`);
            sendTelegram(msg, chatId);
            return;
        }
        const targets = (arg.toLowerCase() === 'all')
            ? failed
            : failed.filter(a => a.email.toLowerCase() === arg.toLowerCase());
        if (targets.length === 0) {
            sendTelegram(`No failed ID matches <code>${arg}</code>.`, chatId);
            return;
        }
        for (const acc of targets) {
            acc.loginAttempts = 0;
            acc.loginError = null;
            acc.status = 'starting';
            acc.stopFlag = false;
            sendTelegram(`🔄 Retrying <code>${acc.email}</code>...`, chatId);
            runAccountBot(acc).catch(err => log(`Retry error: ${err.message}`, 'ERROR', acc.email));
            await new Promise(r => setTimeout(r, 800));
        }
        return;
    }

    // /close                      → list IDs grouped by city, prompt for a number
    // /close <number>             → close that index directly
    // /close <email>              → close by email
    // /close all                  → close every running ID
    if (text === '/close' || text.startsWith('/close ') || text.startsWith('/close\n')) {
        if (ACCOUNTS.size === 0) {
            sendTelegram('No IDs to close.', chatId);
            return;
        }
        const arg = text.replace(/^\/close/, '').trim();

        // Build a stable ordered list: sort by city, then monitor-first, then email
        const orderedList = Array.from(ACCOUNTS.values()).sort((a, b) => {
            const ca = (a.city || '').toLowerCase();
            const cb = (b.city || '').toLowerCase();
            if (ca !== cb) return ca.localeCompare(cb);
            if (a.isMonitor !== b.isMonitor) return a.isMonitor ? -1 : 1;
            return a.email.localeCompare(b.email);
        });

        // /close all
        if (arg.toLowerCase() === 'all') {
            const n = orderedList.length;
            sendTelegram(`🛑 Stopping all ${n} ID(s)...`, chatId);
            for (const acc of orderedList) stopAccount(acc.email, chatId);
            resetState(chatId);
            return;
        }

        // /close <number>
        if (/^\d+$/.test(arg)) {
            const idx = parseInt(arg);
            if (idx < 1 || idx > orderedList.length) {
                sendTelegram(`⚠️ Number must be between 1 and ${orderedList.length}.`, chatId);
                return;
            }
            stopAccount(orderedList[idx - 1].email, chatId);
            resetState(chatId);
            return;
        }

        // /close <email>
        if (arg.includes('@')) {
            const target = orderedList.find(a => a.email.toLowerCase() === arg.toLowerCase());
            if (!target) {
                sendTelegram(`⚠️ No running ID with email <code>${arg}</code>. Use /list to see what's running.`, chatId);
                return;
            }
            stopAccount(target.email, chatId);
            resetState(chatId);
            return;
        }

        // No arg: show list grouped by city and wait for a number
        let msg = '<b>Which ID to close?</b> Reply with the number, or use:\n' +
                  '<code>/close N</code> · <code>/close email</code> · <code>/close all</code>\n';
        let i = 1;
        let lastCity = '';
        for (const acc of orderedList) {
            if (acc.city !== lastCity) {
                msg += `\n\n📍 <b>${acc.city}</b>`;
                lastCity = acc.city;
            }
            const role = acc.isMonitor ? '👁️' : '💤';
            msg += `\n  ${i}. ${role} <code>${acc.email}</code>`;
            i++;
        }
        CHAT_STATE.set(chatId, { mode: 'awaiting_close_choice', list: orderedList });
        sendTelegram(msg, chatId);
        return;
    }

    // ===== State machine =====
    switch (state.mode) {
        case 'awaiting_verify_only_email': {
            if (!text.includes('@')) {
                sendTelegram('⚠️ That does not look like an email. Try again or /cancel:', chatId);
                return;
            }
            state.verifyEmail = text.trim();
            state.mode = 'awaiting_verify_only_password';
            sendTelegram('Send the verify account password:', chatId);
            return;
        }

        case 'awaiting_verify_only_password': {
            CONFIG.verifyCredentials.email = state.verifyEmail;
            CONFIG.verifyCredentials.password = text;
            sendTelegram(`✅ <b>Verify account saved</b>\n📧 <code>${state.verifyEmail}</code>`, chatId);
            resetState(chatId);
            return;
        }

        case 'awaiting_proxy_list': {
            const ok = applyProxyList(message.text || '', chatId);
            if (ok) resetState(chatId);
            return;
        }

        case 'awaiting_structured_add': {
            const ok = await applyStructuredAdd(message.text || '', chatId);
            if (ok) resetState(chatId);
            // if !ok, applyStructuredAdd already showed errors and we stay in the same state
            return;
        }

        case 'awaiting_city_count': {
            const n = parseInt(text);
            if (!Number.isFinite(n) || n < 1 || n > 50) {
                sendTelegram('⚠️ Please send a number between 1 and 50.', chatId);
                return;
            }
            state.cityCount = n;
            state.cityIdx = 0;
            state.pending = state.pending || [];
            // For /add we already have verify creds; for /start, ask if not in .env
            if (!state.isAdd && (!CONFIG.verifyCredentials.email || !CONFIG.verifyCredentials.password)) {
                state.mode = 'awaiting_verify_email';
                sendTelegram(
                    `Got it — ${n} city(ies).\nFirst, send the <b>verification account email</b> (used to detect stale data):`,
                    chatId
                );
            } else {
                if (CONFIG.verifyCredentials.email) {
                    sendTelegram(`✅ Using verify account: <code>${CONFIG.verifyCredentials.email}</code>`, chatId);
                }
                state.mode = 'awaiting_city_name';
                state.cityIdx = 1;
                sendTelegram(`<b>City 1/${n}</b> — which city? (e.g. <code>Toronto</code>)`, chatId);
            }
            return;
        }

        case 'awaiting_verify_email': {
            if (!text.includes('@')) {
                sendTelegram('⚠️ That does not look like an email. Try again:', chatId);
                return;
            }
            state.verifyEmail = text;
            state.mode = 'awaiting_verify_password';
            sendTelegram('Send the <b>verification account password</b>:', chatId);
            return;
        }

        case 'awaiting_verify_password': {
            CONFIG.verifyCredentials.email = state.verifyEmail;
            CONFIG.verifyCredentials.password = text;
            sendTelegram(`✅ Verify account saved: <code>${state.verifyEmail}</code>`, chatId);

            // If /start was given with an inline paste, consume it now
            if (state.postVerifyPaste) {
                const paste = state.postVerifyPaste;
                resetState(chatId);
                await applyStructuredAdd(paste, chatId);
                return;
            }

            state.mode = 'awaiting_structured_add';
            sendTelegram(`\n${STRUCTURED_HELP}`, chatId);
            return;
        }

        case 'awaiting_city_name': {
            const city = text.trim();
            if (!city) {
                sendTelegram('⚠️ City name cannot be empty. Try again:', chatId);
                return;
            }
            state.currentCity = city;
            state.mode = 'awaiting_city_cpm';
            sendTelegram(`<b>${city}</b> — what target CPM? (e.g. <code>240</code>)`, chatId);
            return;
        }

        case 'awaiting_city_cpm': {
            const cpm = parseInt(text);
            if (!Number.isFinite(cpm) || cpm < 1 || cpm > 1000) {
                sendTelegram('⚠️ Please send a number between 1 and 1000:', chatId);
                return;
            }
            state.currentCpm = cpm;
            state.mode = 'awaiting_city_monitors';
            sendTelegram(
                `📥 Paste the <b>MONITOR IDs</b> for <b>${state.currentCity}</b> ` +
                `(one per line: <code>email password</code>), or send <code>none</code> to skip:`,
                chatId
            );
            return;
        }

        case 'awaiting_city_monitors': {
            const block = parseIdBlock(message.text || '');
            if (block.errors.length > 0) {
                sendTelegram(`⚠️ Could not parse some lines:\n${block.errors.join('\n')}\n\nRe-paste, or /cancel.`, chatId);
                return;
            }
            for (const id of block.ids) {
                state.pending.push({
                    email: id.email,
                    password: id.password,
                    city: state.currentCity,
                    cpm: state.currentCpm,
                    isMonitor: true
                });
            }
            sendTelegram(
                `✅ ${block.ids.length} monitor ID(s) saved for <b>${state.currentCity}</b>.\n\n` +
                `📥 Paste the <b>STANDBY IDs</b> for <b>${state.currentCity}</b>, or send <code>none</code> to skip:`,
                chatId
            );
            state.mode = 'awaiting_city_standby';
            return;
        }

        case 'awaiting_city_standby': {
            const block = parseIdBlock(message.text || '');
            if (block.errors.length > 0) {
                sendTelegram(`⚠️ Could not parse some lines:\n${block.errors.join('\n')}\n\nRe-paste, or /cancel.`, chatId);
                return;
            }
            for (const id of block.ids) {
                state.pending.push({
                    email: id.email,
                    password: id.password,
                    city: state.currentCity,
                    cpm: state.currentCpm,
                    isMonitor: false
                });
            }
            sendTelegram(
                `✅ ${block.ids.length} standby ID(s) saved for <b>${state.currentCity}</b>.`,
                chatId
            );

            // Check if any IDs were added for this city at all
            const cityHasMonitor = state.pending.some(p => p.city === state.currentCity && p.isMonitor);
            if (!cityHasMonitor) {
                sendTelegram(
                    `⚠️ <b>${state.currentCity}</b> has no MONITOR ID — standby IDs there will never be triggered. ` +
                    `Consider re-running for that city or moving on.`,
                    chatId
                );
            }

            // Next city or launch?
            if (state.cityIdx >= state.cityCount) {
                await launchPending(state.pending, chatId);
                resetState(chatId);
            } else {
                state.cityIdx++;
                state.mode = 'awaiting_city_name';
                state.currentCity = null;
                state.currentCpm = null;
                sendTelegram(`<b>City ${state.cityIdx}/${state.cityCount}</b> — which city?`, chatId);
            }
            return;
        }

        case 'awaiting_close_choice': {
            const choice = parseInt(text);
            if (!Number.isFinite(choice) || choice < 1 || choice > state.list.length) {
                sendTelegram(`⚠️ Please send a number between 1 and ${state.list.length}.`, chatId);
                return;
            }
            const target = state.list[choice - 1];
            stopAccount(target.email, chatId);
            resetState(chatId);
            return;
        }

        default:
            sendTelegram(
                'Send /start to set up IDs, /add to add more, /list to view, /close to stop one, /help for all commands.',
                chatId
            );
    }
}

// ============================================================================
// TELEGRAM LONG-POLL LOOP
// ============================================================================
async function pollTelegramUpdates() {
    if (!CONFIG.telegram.botToken) {
        log('No TELEGRAM_BOT_TOKEN set - Telegram control disabled', 'WARN');
        return;
    }
    let offset = 0;
    log('🤖 Telegram listener started', 'SUCCESS');
    while (true) {
        try {
            const resp = await tgGet(`/getUpdates?offset=${offset}&timeout=25`);
            if (resp && resp.ok && Array.isArray(resp.result)) {
                for (const update of resp.result) {
                    offset = update.update_id + 1;
                    if (update.message && update.message.text) {
                        handleTelegramMessage(update.message).catch(err =>
                            log(`handleTelegramMessage error: ${err.message}`, 'ERROR')
                        );
                    }
                }
            }
        } catch (e) {
            log(`Telegram poll error: ${e.message}`, 'WARN');
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================
// One aggregated digest covering every running account, sent every 5 minutes.
// Format mirrors the per-account "📊 Status" card layout, with one block per
// account, concatenated and split into multiple messages if too long for one.
function sendDigest() {
    const all = Array.from(ACCOUNTS.values());
    if (all.length === 0) return;

    const failed = all.filter(a => a.status === 'login_failed' || a.status === 'error');
    const healthy = all.filter(a => !failed.includes(a));
    const monitors = healthy.filter(a => a.isMonitor);
    const standbys = healthy.filter(a => !a.isMonitor);

    const blocks = [];
    blocks.push(
        `📊 <b>5-min digest</b>\n` +
        `${healthy.length} running (${monitors.length} monitor · ${standbys.length} standby)` +
        (failed.length ? ` · ${failed.length} failed` : '')
    );

    // Sort monitors then standbys by city, alphabetic within
    const sorter = (a, b) => (a.city || '').localeCompare(b.city || '') || a.email.localeCompare(b.email);
    monitors.sort(sorter);
    standbys.sort(sorter);

    for (const a of monitors) {
        const lat = a.lastLatency > 0 ? `${a.lastLatency}ms` : '—';
        const date = a.availableDate ? a.availableDate.date : 'SEARCHING';
        const best = a.closestSlotFound ? a.closestSlotFound.date : 'N/A';
        const px = a.proxy ? a.proxy.server : 'global';
        blocks.push(
            `📊 <b>Status</b>\n` +
            `📧 ${a.email}\n` +
            `📍 ${a.city}\n` +
            `📅 ${a.startDate.toISOString().split('T')[0]} to ${a.endDate.toISOString().split('T')[0]}\n` +
            `⚡ ${a.actualCpm || '0'} CPM · 📡 ${lat} · 🔄 ${a.checkCount || 0}\n` +
            `📅 Current: ${date}\n` +
            `📅 Best: ${best}\n` +
            `🔌 ${px}\n` +
            `🔍 Next verify: ${a.nextVerifyIn || 0}m`
        );
    }

    // Standbys are intentionally NOT detailed in the digest — only monitors.
    // We append a single one-liner per city telling you how many standbys are ready.
    if (standbys.length > 0) {
        const byCity = new Map();
        for (const a of standbys) {
            byCity.set(a.city, (byCity.get(a.city) || 0) + 1);
        }
        let line = '💤 <b>Standby ready</b>';
        for (const [city, n] of byCity) line += `\n  📍 ${city}: ${n}`;
        blocks.push(line);
    }

    if (failed.length > 0) {
        let f = `❌ <b>Failed (${failed.length})</b>`;
        for (const a of failed) {
            f += `\n• ${a.email} (${a.city}) — ${a.loginError || a.status}`;
        }
        blocks.push(f);
    }

    // Glue blocks together with a separator, then split into chunks under
    // Telegram's 4096-char message cap (we target 3500 to leave headroom).
    const SEP = '\n━━━━━━━━━━━━━━━━━━\n';
    const MAX = 3500;
    let current = '';
    for (const b of blocks) {
        const candidate = current ? current + SEP + b : b;
        if (candidate.length > MAX) {
            if (current) sendTelegram(current);
            current = b;
        } else {
            current = candidate;
        }
    }
    if (current) sendTelegram(current);
}

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  VISA BOT v3.0 - TELEGRAM INTERACTIVE MULTI-ACCOUNT\x1b[0m');
    console.log('\x1b[36m  Send /start in Telegram to add IDs\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    // Start Telegram listener (always)
    pollTelegramUpdates();

    // Greet on startup. If verify creds aren't loaded from .env, nudge the user
    // to set them via /verify before running /start.
    const verifyMsg = CONFIG.verifyCredentials.email
        ? `🔐 Verify account: <code>${CONFIG.verifyCredentials.email}</code> (loaded from .env)`
        : `🔐 No verify account set — use <code>/verify</code> to add one, or <code>/start</code> will prompt for it.`;
    sendTelegram(
        `🟢 <b>Bot ready</b>\n${verifyMsg}\n\n` +
        `Commands: /start /add /verify /proxies /list /close /help`
    );

    // One aggregated digest every 5 minutes (single message for all accounts)
    setInterval(sendDigest, 5 * 60_000);

    log('Waiting for /start in Telegram to add IDs', 'INFO');
}

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    sendTelegram('🛑 <b>Bot Stopped</b>');
    for (const acc of ACCOUNTS.values()) {
        acc.stopFlag = true;
        if (acc.browser) await acc.browser.close().catch(() => {});
        if (acc.verifyBrowser) await acc.verifyBrowser.close().catch(() => {});
    }
    setTimeout(() => process.exit(0), 1500);
});

process.on('uncaughtException', async (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Crash</b>\n${err.message}`);
});

process.on('unhandledRejection', async (reason) => {
    console.error('Unhandled Rejection:', reason);
    sendTelegram(`⚠️ <b>Unhandled</b>\n${String(reason).substring(0, 100)}`);
});

main();
