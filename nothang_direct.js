
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// CONFIGURATION
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
        targetCPM: parseInt(process.env.TARGET_CPM) || 240,
        headless: process.env.HEADLESS === 'true'
    }
};

// Debug headless setting
console.log('HEADLESS env:', process.env.HEADLESS);
console.log('CONFIG.bot.headless:', CONFIG.bot.headless);

// ============================================================================
// BOOKING ACCOUNTS (21 unique accounts x1 session = 21 sessions, NO PROXY)
// ============================================================================
const KEEPALIVE_ACCOUNTS = [];
for (let i = 1; i <= 21; i++) {
    const email = process.env[`KA_EMAIL_${i}`];
    const password = process.env[`KA_PASSWORD_${i}`];
    if (email && password) {
        KEEPALIVE_ACCOUNTS.push({ email, password, index: i });
    }
}
console.log(`Loaded ${KEEPALIVE_ACCOUNTS.length} keepalive accounts`);

// ============================================================================
// GLOBAL STATE FOR RESPONSE LISTENER (like ok.js)
// ============================================================================
let availableDate = null;
let availableTime = null;
let lastResponseTime = 0;
let closestSlotFound = null;
let lastRequestTime = 0;

// IDs needed for direct API fetch (extracted after navigation)
let scheduleId = null;
let facilityId = null;
let csrfToken = null;
let lastLatency = 0;

// ============================================================================
// LOGGING
// ============================================================================
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const colors = {
        'INFO': '\x1b[36m',
        'SUCCESS': '\x1b[32m',
        'WARN': '\x1b[33m',
        'ERROR': '\x1b[31m',
        'FATAL': '\x1b[35m',
        'SECURITY': '\x1b[45m'
    };
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${message}\x1b[0m`);
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
// TELEGRAM (direct, no proxy needed)
// ============================================================================
function sendTelegram(message) {
    if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) return;

    const postData = JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
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
        // Response received - don't need to do anything
    });

    req.on('error', (err) => {
        console.log(`Telegram error: ${err.message}`);
    });

    req.write(postData);
    req.end();
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

// Random user agents like ok.js
const USER_AGENTS = [
    // Chrome on macOS
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Chrome on Windows
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    // Firefox
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
    // Edge
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    // Safari
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
// RESPONSE LISTENER (KEY - from ok.js) - INSTANT DETECTION
// ============================================================================
let bookingInProgress = false;
let bookingComplete = false;  // Set to true after successful booking — stops all further booking attempts
let bookedAccounts = new Set();  // Track which accounts successfully booked
let pageRef = null;

function setupResponseListener(page) {
    pageRef = page;

    page.on('response', async (response) => {
        try {
            const url = response.url();

            // Capture available dates - INSTANT DETECTION
            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    availableDate = data[0];
                    lastResponseTime = Date.now();
                    if (lastRequestTime > 0) {
                        lastLatency = lastResponseTime - lastRequestTime;
                    }

                    const slotDate = new Date(availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    // Track closest slot
                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = availableDate;
                            log(`📅 New closest slot: ${closestSlotFound.date}`, 'SUCCESS');
                        }
                    }

                    // INSTANT TRIGGER: If date in range, log immediately (skip if all booked)
                    if (!bookingComplete && isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                        log(`🚨 INSTANT DETECT: ${availableDate.date} IN RANGE!`, 'SUCCESS');
                    }
                }
            }

            // Capture available times - store immediately
            if (url.includes('.json') && url.includes('date=')) {
                const data = await response.json();
                if (data && data.available_times && data.available_times.length > 0) {
                    availableTime = data.available_times[0];
                    log(`⏰ Time captured: ${availableTime}`, 'INFO');
                }
            }
        } catch (e) {
            // Ignore parsing errors
        }
    });
}

// ============================================================================
// WAIT FOR FRESH RESPONSE
// ============================================================================
async function waitForAvailableSlot(timeoutMs = 100) {
    const prevTime = lastResponseTime;
    let elapsed = 0;

    while (lastResponseTime === prevTime && elapsed < timeoutMs) {
        await new Promise(r => setTimeout(r, 25));
        elapsed += 25;
    }

    return availableDate;
}

// ============================================================================
// KEEPALIVE SESSION MANAGEMENT (NO proxy, READY TO BOOK)
// ============================================================================

// All possible 15-min slots from 07:00 to 12:00 (21 total)
const ALL_TIME_SLOTS = [];
for (let h = 7; h <= 12; h++) {
    for (let m = 0; m < 60; m += 15) {
        if (h === 12 && m > 0) break;
        ALL_TIME_SLOTS.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
}

// Time slots: start from START_SLOT env, every 15min, wrap from 12:00 → 07:00
// Example: START_SLOT=11:00, 11 accounts → 11:00,11:15,11:30,11:45,12:00,07:00,07:15,07:30,07:45,08:00,08:15
const START_SLOT = process.env.START_SLOT || '07:00';
const startIdx = ALL_TIME_SLOTS.indexOf(START_SLOT);
if (startIdx === -1) {
    console.log(`⚠️ START_SLOT=${START_SLOT} not valid. Valid: ${ALL_TIME_SLOTS.join(', ')}`);
}

function buildTimeSlots(numAccounts, startSlot) {
    const idx = ALL_TIME_SLOTS.indexOf(startSlot);
    const start = idx >= 0 ? idx : 0;
    const n = Math.min(Math.max(numAccounts, 1), ALL_TIME_SLOTS.length);
    const slots = [];
    for (let i = 0; i < n; i++) {
        slots.push(ALL_TIME_SLOTS[(start + i) % ALL_TIME_SLOTS.length]);
    }
    return slots;
}

const KEEPALIVE_TIME_SLOTS = buildTimeSlots(KEEPALIVE_ACCOUNTS.length, START_SLOT);
console.log(`Time slots (${KEEPALIVE_TIME_SLOTS.length}, start=${START_SLOT}): ${KEEPALIVE_TIME_SLOTS.join(', ')}`);

const keepAliveBrowsers = [];
const keepAliveSessions = []; // { page, context, browser, account, tag, timeSlot }
let keepAliveStarted = false;

async function loginKeepAlive(page, email, password) {
    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });

    const pageText = await page.innerText('body').catch(() => '');
    if (pageText.toLowerCase().includes('system is busy')) {
        throw new Error('SYSTEM_BUSY');
    }
    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    await page.fill('#user_email', email);
    await page.fill('#user_password', password);

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

    return true;
}

async function navigateKeepAliveToAppointment(page) {
    // Click continue to get to schedule page
    try {
        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
        await page.waitForSelector(continueBtn, { timeout: 15000 });
        await page.click(continueBtn);
        await page.waitForTimeout(2000);
    } catch (e) {}

    // Navigate to appointment sub-page
    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Select city (triggers one date API call to set up the form)
    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    const options = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
    );

    const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
    if (target) {
        await page.selectOption(facilitySelector, target.value);
    }

    await page.waitForTimeout(2000);
}

async function reselectKeepAliveCity(page) {
    try {
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        const options = await page.$$eval(`${facilitySelector} option`, opts =>
            opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );
        const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
        if (target) {
            await page.selectOption(facilitySelector, target.value);
        }
        await page.waitForTimeout(1000);
    } catch (e) {}
}

async function performKeepAliveBooking(page, date, time, email, tag, cachedPageData) {
    log(`${tag} 🚀 FIRE: date=${date}, time=${time}`, 'SUCCESS');

    try {
        // Call pre-injected window.__book(date) — minimal page.evaluate overhead
        const bookResult = await Promise.race([
            page.evaluate(async (d) => await window.__book(d), date),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]).catch(e => ({ error: e.message }));

        if (bookResult.error) {
            log(`${tag} ❌ API error: ${bookResult.error}`, 'ERROR');
            return false;
        }

        log(`${tag} 📡 status=${bookResult.status}, redirect=${bookResult.redirected}, loc=${bookResult.finalUrl}`, 'INFO');

        if (bookResult.isInstructionsPage) {
            log(`${tag} 🎉 BOOKED! ${date} @ ${time}`, 'SUCCESS');
            sendTelegram(`🎉 <b>BOOKED via ${tag}!</b>\n📅 ${date}\n⏰ ${time}\n📧 ${email}`);
            return true;
        }

        log(`${tag} ⚠️ Not booked (status=${bookResult.status})`, 'WARN');
        return false;

    } catch (error) {
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            log(`${tag} 🎉 Likely BOOKED! (context destroyed = navigation)`, 'SUCCESS');
            sendTelegram(`🎉 <b>LIKELY BOOKED via ${tag}!</b>\n📅 ${date}\n⏰ ${time}\n📧 ${email}`);
            return true;
        }
        log(`${tag} ❌ Error: ${error.message}`, 'ERROR');
        return false;
    }
}

async function keepSessionAliveLoop(session) {
    const { context, account, tag, timeSlot } = session;
    let page = session.page;
    const email = account.email;
    const password = account.password;
    let lastKeepAlive = Date.now();
    const keepAliveInterval = (5 + Math.random() * 3) * 60 * 1000; // 5-8 min

    while (true) {
        try {
            // === KEEPALIVE REFRESH (every 5-8 min) ===
            if (Date.now() - lastKeepAlive > keepAliveInterval) {
                // Check page alive
                try {
                    await page.evaluate(() => true);
                } catch (e) {
                    log(`${tag} Page dead, recreating...`, 'WARN');
                    try {
                        page = await context.newPage();
                        session.page = page; // Update reference for booking
                        await loginKeepAlive(page, email, password);
                        await navigateKeepAliveToAppointment(page);
                    } catch (reErr) {
                        log(`${tag} Recreate failed: ${reErr.message}`, 'ERROR');
                        await new Promise(r => setTimeout(r, 30000));
                    }
                    lastKeepAlive = Date.now();
                    continue;
                }

                // Check if still logged in
                const currentUrl = page.url();
                const bodyText = await page.innerText('body').catch(() => '');

                if (currentUrl.includes('sign_in') ||
                    bodyText.toLowerCase().includes('sign in') ||
                    bodyText.toLowerCase().includes('log in')) {
                    log(`${tag} Session expired, re-logging in...`, 'WARN');
                    try {
                        await loginKeepAlive(page, email, password);
                        await navigateKeepAliveToAppointment(page);
                        session.page = page;
                    } catch (reLoginErr) {
                        log(`${tag} Re-login failed: ${reLoginErr.message}`, 'ERROR');
                    }
                    lastKeepAlive = Date.now();
                    continue;
                }

                if (bodyText.toLowerCase().includes('system is busy')) {
                    log(`${tag} System busy, waiting...`, 'WARN');
                    await new Promise(r => setTimeout(r, 10000));
                    lastKeepAlive = Date.now();
                    continue;
                }

                // Refresh appointment page + re-select city
                await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await reselectKeepAliveCity(page);
                log(`${tag} ♻️ Alive (${email.substring(0, 15)}...) slot: ${timeSlot}`, 'INFO');
                lastKeepAlive = Date.now();
            }

            // Sleep 5s between keepalive checks (no booking polling needed)
            await new Promise(r => setTimeout(r, 5000));

        } catch (error) {
            log(`${tag} Error: ${error.message}`, 'ERROR');
            await new Promise(r => setTimeout(r, 15000));

            try {
                page = await context.newPage();
                session.page = page;
                await loginKeepAlive(page, email, password);
                await navigateKeepAliveToAppointment(page);
                lastKeepAlive = Date.now();
                log(`${tag} Recovered`, 'SUCCESS');
            } catch (recoveryErr) {
                log(`${tag} Recovery failed: ${recoveryErr.message}`, 'ERROR');
            }
        }
    }
}

// ============================================================================
// INSTANT PARALLEL BOOKING - Called directly by main bot, NO polling delay
// All 21 sessions fire simultaneously via Promise.all
// ============================================================================
async function bookSingleSession(session, date) {
    const { page, tag, timeSlot, account, cachedPageData } = session;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const booked = await performKeepAliveBooking(page, date, timeSlot, account.email, tag, cachedPageData);
            if (booked) return { tag, timeSlot, email: account.email, booked: true, attempt };
        } catch (err) {
            log(`${tag} Attempt ${attempt} failed: ${err.message}`, 'ERROR');
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 50));
    }
    return { tag, timeSlot, email: account.email, booked: false };
}

async function fireAllBookingSessions(date) {
    // Filter out already-booked accounts
    const sessionsToFire = keepAliveSessions.filter(s => !bookedAccounts.has(s.account.email));

    if (sessionsToFire.length === 0) {
        log('All accounts already booked - nothing to fire', 'SUCCESS');
        return [];
    }

    const fireTime = Date.now();
    log(`🔥🔥🔥 FIRING ${sessionsToFire.length} BOOKING SESSIONS IN PARALLEL! Date: ${date}`, 'SUCCESS');
    sendTelegram(
        `🔥 <b>FIRING ${sessionsToFire.length} SESSIONS!</b>\n` +
        `📅 ${date}\n` +
        `⏰ ${KEEPALIVE_TIME_SLOTS[0]}-${KEEPALIVE_TIME_SLOTS[KEEPALIVE_TIME_SLOTS.length-1]} (${KEEPALIVE_TIME_SLOTS.length} slots)\n` +
        `🚀 All booking in parallel NOW!`
    );

    // Fire ALL sessions simultaneously - zero delay between them
    const results = await Promise.all(
        sessionsToFire.map(session => bookSingleSession(session, date))
    );

    const elapsed = Date.now() - fireTime;
    const successes = results.filter(r => r.booked);
    const failures = results.filter(r => !r.booked);

    // Track booked accounts
    successes.forEach(r => bookedAccounts.add(r.email));

    log(`📊 BOOKING RESULTS (${elapsed}ms total):`, 'INFO');
    log(`   ✅ SUCCESS: ${successes.length} / ${results.length}`, successes.length > 0 ? 'SUCCESS' : 'WARN');
    successes.forEach(r => log(`   🎉 ${r.tag} @ ${r.timeSlot} (attempt ${r.attempt})`, 'SUCCESS'));
    failures.forEach(r => log(`   ❌ ${r.tag} @ ${r.timeSlot}`, 'ERROR'));

    sendTelegram(
        `📊 <b>BOOKING RESULTS</b>\n` +
        `📅 Date: ${date}\n` +
        `✅ ${successes.length}/${results.length} succeeded\n` +
        (successes.length > 0 ? successes.map(r => `🎉 ${r.email} @ ${r.timeSlot}`).join('\n') : '❌ None succeeded') +
        `\n⏱ Booking time: ${elapsed}ms\n` +
        `📋 Total booked so far: ${bookedAccounts.size}/${keepAliveSessions.length}`
    );

    return results;
}

async function launchKeepAliveSession(account, slotIndex) {
    const timeSlot = KEEPALIVE_TIME_SLOTS[slotIndex];
    const tag = `[KA-${account.index}|${timeSlot}]`;

    try {
        // Each account gets its own browser (NO PROXY)
        const browser = await chromium.launch({
            headless: CONFIG.bot.headless,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-webrtc',
                '--no-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage'
            ]
        });
        keepAliveBrowsers.push(browser);

        const context = await browser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 },
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });

        const page = await context.newPage();

        log(`${tag} Logging in ${account.email}...`, 'INFO');
        await loginKeepAlive(page, account.email, account.password);
        log(`${tag} ✅ Logged in`, 'SUCCESS');

        // Navigate to appointment page and select city (READY TO BOOK)
        await navigateKeepAliveToAppointment(page);

        // Pre-inject instant booking function into the page (zero overhead at booking time)
        const cachedPageData = await page.evaluate((assignedTime) => {
            const url = window.location.href;
            const scheduleMatch = url.match(/schedule\/(\d+)/);
            const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            const form = document.querySelector('form#appointment-form') ||
                         document.querySelector('form[action*="appointment"]');
            const hiddenFields = {};
            if (form) {
                form.querySelectorAll('input[type="hidden"]').forEach(input => {
                    if (input.name) hiddenFields[input.name] = input.value || '';
                });
            }

            const facilityId = facilitySelect ? facilitySelect.value : null;
            const scheduleId = scheduleMatch ? scheduleMatch[1] : null;
            const origin = window.location.origin;
            const submitUrl = form ? form.action : `${origin}/en-ca/niv/schedule/${scheduleId}/appointment`;

            // Pre-build the static part of the POST body (everything except date)
            const baseParams = new URLSearchParams();
            for (const [key, value] of Object.entries(hiddenFields)) {
                baseParams.set(key, value);
            }
            baseParams.set('appointments[consulate_appointment][facility_id]', facilityId);
            baseParams.set('appointments[consulate_appointment][time]', assignedTime);
            const baseBody = baseParams.toString();

            // Inject instant-fire function into window — just call window.__book(date)
            window.__book = async (date) => {
                const body = baseBody + '&' + encodeURIComponent('appointments[consulate_appointment][date]') + '=' + encodeURIComponent(date);
                const resp = await fetch(submitUrl, {
                    method: 'POST',
                    credentials: 'include',
                    redirect: 'follow',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Origin': origin,
                        'Referer': submitUrl,
                        'Upgrade-Insecure-Requests': '1'
                    },
                    body
                });
                // Check final URL after redirect (don't read body - saves time)
                const finalUrl = resp.url || '';
                return {
                    status: resp.status,
                    redirected: resp.redirected,
                    finalUrl,
                    isInstructionsPage: finalUrl.includes('/instructions') || finalUrl.includes('Confirmation')
                };
            };

            return { scheduleId, facilityId };
        }, timeSlot);
        log(`${tag} 📋 Ready to book @ ${timeSlot} (cached: schedule=${cachedPageData.scheduleId}, __book injected)`, 'SUCCESS');

        const session = { page, context, browser, account, tag, timeSlot, cachedPageData };
        keepAliveSessions.push(session);

        // Fire-and-forget keepalive loop (keeps session alive, NO booking polling)
        keepSessionAliveLoop(session);

        return true;
    } catch (error) {
        log(`${tag} Failed to launch: ${error.message}`, 'ERROR');
        return false;
    }
}

async function startAllKeepAliveSessions() {
    if (KEEPALIVE_ACCOUNTS.length === 0) {
        log('No booking accounts configured (set KA_EMAIL_1..21 / KA_PASSWORD_1..21 in .env)', 'WARN');
        return;
    }

    if (keepAliveStarted) return;
    keepAliveStarted = true;

    // N accounts × 1 session each = N sessions (evenly spread across 07:00-12:00)
    const numToLaunch = Math.min(KEEPALIVE_ACCOUNTS.length, KEEPALIVE_TIME_SLOTS.length);

    log(`🔄 Starting ${numToLaunch} booking sessions (${numToLaunch} accounts × 1 session, NO PROXY)...`, 'INFO');
    log(`⏰ Time slots: ${KEEPALIVE_TIME_SLOTS.join(', ')}`, 'INFO');

    // Launch ALL sessions in parallel for faster startup
    const launchPromises = [];
    for (let i = 0; i < numToLaunch; i++) {
        const account = KEEPALIVE_ACCOUNTS[i];
        const timeSlot = KEEPALIVE_TIME_SLOTS[i];
        log(`🔄 [${i + 1}/${numToLaunch}] ${account.email} → ${timeSlot}`, 'INFO');
        launchPromises.push(launchKeepAliveSession(account, i));
    }

    const results = await Promise.all(launchPromises);
    const totalLaunched = results.filter(ok => ok).length;

    log(`✅ ${totalLaunched}/${numToLaunch} booking sessions READY (NO PROXY)`, 'SUCCESS');
    log(`⚡ When date detected → fireAllBookingSessions() fires ALL in parallel via Promise.all`, 'INFO');
    sendTelegram(
        `🔄 <b>${totalLaunched}/${numToLaunch} Sessions Ready</b>\n` +
        `🚫 No Proxy\n` +
        keepAliveSessions.map(s =>
            `${s.tag} ${s.account.email.substring(0, 20)}`
        ).join('\n')
    );

    // === BACKGROUND RETRY for failed sessions (non-blocking, 10s apart, up to 5 retries) ===
    let failedIndices = [];
    for (let i = 0; i < results.length; i++) {
        if (!results[i]) failedIndices.push(i);
    }

    if (failedIndices.length > 0) {
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 10000; // 10 seconds between retries

        log(`🔁 ${failedIndices.length} sessions failed — background retry starting (every ${RETRY_DELAY / 1000}s, max ${MAX_RETRIES} rounds)`, 'WARN');
        sendTelegram(`🔁 <b>${failedIndices.length} Failed</b>\nBackground retry every ${RETRY_DELAY / 1000}s (max ${MAX_RETRIES} rounds)`);

        // Fire-and-forget: retries run in background while monitoring loop continues
        (async () => {
            let retryRound = 0;
            while (failedIndices.length > 0 && retryRound < MAX_RETRIES) {
                retryRound++;
                await new Promise(r => setTimeout(r, RETRY_DELAY));

                log(`🔁 Background retry ${retryRound}/${MAX_RETRIES}: ${failedIndices.length} sessions...`, 'WARN');

                const retryPromises = failedIndices.map(i => {
                    const account = KEEPALIVE_ACCOUNTS[i];
                    log(`🔁 Retrying [${i + 1}/${numToLaunch}] ${account.email} → ${KEEPALIVE_TIME_SLOTS[i]}`, 'INFO');
                    return launchKeepAliveSession(account, i).then(ok => ({ index: i, ok }));
                });

                const retryResults = await Promise.all(retryPromises);
                const newlyLaunched = retryResults.filter(r => r.ok).length;

                // Update failedIndices to only those still failing
                failedIndices = retryResults.filter(r => !r.ok).map(r => r.index);

                log(`🔁 Retry ${retryRound}: ${newlyLaunched} recovered, ${failedIndices.length} still failed`, newlyLaunched > 0 ? 'SUCCESS' : 'WARN');
                if (newlyLaunched > 0) {
                    sendTelegram(`✅ <b>${newlyLaunched} Recovered (retry ${retryRound})</b>\n${keepAliveSessions.length} total sessions now ready\n${failedIndices.length} still failed`);
                }
            }

            if (failedIndices.length > 0) {
                const failedEmails = failedIndices.map(i => KEEPALIVE_ACCOUNTS[i].email.substring(0, 20)).join(', ');
                log(`⚠️ ${failedIndices.length} sessions failed after ${MAX_RETRIES} retries: ${failedEmails}`, 'ERROR');
                sendTelegram(`⚠️ <b>${failedIndices.length} Sessions Failed</b>\nAfter ${MAX_RETRIES} retries:\n${failedEmails}`);
            } else {
                log(`✅ All sessions recovered! ${keepAliveSessions.length} ready`, 'SUCCESS');
                sendTelegram(`✅ <b>All Sessions Recovered!</b>\n${keepAliveSessions.length} sessions ready`);
            }
        })();
    }
}

async function closeAllKeepAliveSessions() {
    log('Closing all keepalive sessions...', 'INFO');
    for (const browser of keepAliveBrowsers) {
        await browser.close().catch(() => {});
    }
    keepAliveBrowsers.length = 0;
    keepAliveSessions.length = 0;
    keepAliveStarted = false;
    log('All keepalive sessions closed', 'INFO');
}

// ============================================================================
// DIRECT API FETCH - Fire-and-forget via page.evaluate
// Calls /days/{facilityId}.json directly (no dropdown re-trigger)
// ============================================================================
function fireDirectFetch(page) {
    lastRequestTime = Date.now();
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
    }, { baseUrl: CONFIG.preferences.baseUrl, sid: scheduleId, fid: facilityId }).catch(() => {});
}

// Read latest dates from browser (non-blocking, reads what's available)
async function readLatestDates(page) {
    try {
        const result = await page.evaluate(() => {
            return { data: window.__latestDates, time: window.__lastFetchTime };
        });

        if (result.time) {
            lastResponseTime = result.time;
            if (lastRequestTime > 0) {
                lastLatency = Date.now() - lastRequestTime;
            }
        }

        const data = result.data;
        if (data && Array.isArray(data) && data.length > 0) {
            availableDate = data[0];

            const slotDate = new Date(availableDate.date);
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            if (slotDate >= today) {
                if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                    closestSlotFound = availableDate;
                    log(`📅 New closest slot: ${closestSlotFound.date}`, 'SUCCESS');
                }
            }

            if (isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                log(`🚨 INSTANT DETECT: ${availableDate.date} IN RANGE!`, 'SUCCESS');
            }

            return availableDate;
        }

        return null;
    } catch (e) {
        return null;
    }
}

// ============================================================================
// LOGIN
// ============================================================================
async function login(page) {
    log('Attempting login...');

    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });

    // Check for system busy
    const pageText = await page.innerText('body').catch(() => '');
    if (pageText.toLowerCase().includes('system is busy') ||
        pageText.toLowerCase().includes('too many requests')) {
        throw new Error('SYSTEM_BUSY');
    }

    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    await page.fill('#user_email', CONFIG.credentials.email);
    await page.fill('#user_password', CONFIG.credentials.password);

    // Checkbox
    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch (e) {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await page.click('input[type="submit"]');

    // Handle error modal
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

    log('Login successful!', 'SUCCESS');
    return true;
}

// ============================================================================
// NAVIGATE TO APPOINTMENT PAGE
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
        log(`Selected city: ${target.text}`);
    }

    // Extract scheduleId, facilityId, csrfToken for direct API fetch
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

    if (ids.scheduleId) scheduleId = ids.scheduleId;
    if (ids.facilityId) facilityId = ids.facilityId;
    if (ids.csrf) csrfToken = ids.csrf;
    log(`Extracted IDs - schedule: ${scheduleId}, facility: ${facilityId}, csrf: ${csrfToken ? csrfToken.substring(0, 20) + '...' : 'N/A'}`, 'INFO');

    // Click continue if visible
    try {
        await page.waitForSelector('input[type="submit"][value="Continue"]', { timeout: 3000 });
        await page.click('input[type="submit"][value="Continue"]');
    } catch (e) {}

    return true;
}

// ============================================================================
// MAIN BOT
// ============================================================================
async function runBot() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  VISA BOT v3.2 - INSTANT PARALLEL BOOKING\x1b[0m');
    console.log('\x1b[36m  Target: ' + CONFIG.bot.targetCPM + ' CPM\x1b[0m');
    console.log('\x1b[33m  Dead session timeout: 30s\x1b[0m');
    console.log('\x1b[35m  Booking: ' + KEEPALIVE_ACCOUNTS.length + ' accounts × 1 session (' + (KEEPALIVE_TIME_SLOTS[0] || '??') + '-' + (KEEPALIVE_TIME_SLOTS[KEEPALIVE_TIME_SLOTS.length-1] || '??') + ', NO PROXY)\x1b[0m');
    console.log('\x1b[31m  Mode: INSTANT Promise.all parallel fire on detection\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    // Verify proxy
    let proxyIP = null;
    if (CONFIG.proxy.enabled) {
        proxyIP = await verifyProxyIP();
        if (!proxyIP) {
            log('PROXY FAILED - Aborting', 'FATAL');
            process.exit(1);
        }
    }

    log(`Email: ${CONFIG.credentials.email}`);
    log(`City: ${CONFIG.preferences.city}`);
    log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);

    const dateRange = CONFIG.preferences.startDate.toISOString().split('T')[0] + ' to ' + CONFIG.preferences.endDate.toISOString().split('T')[0];
    sendTelegram(
        `🚀 <b>Bot Started</b>\n` +
        `📧 ${CONFIG.credentials.email}\n` +
        `📍 ${CONFIG.preferences.city}\n` +
        `📅 Range: ${dateRange}\n` +
        `🔒 IP: ${proxyIP || 'Direct'}\n` +
        `⚡ Target: ${CONFIG.bot.targetCPM} CPM`
    );

    let browser;
    let page;

    try {
        // Launch browser
        log('Launching browser...');

        const launchOptions = {
            headless: CONFIG.bot.headless,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-webrtc',
                '--no-sandbox'
            ]
        };

        // Only use Chrome channel when NOT headless (for anti-detection)
        if (!CONFIG.bot.headless) {
            launchOptions.channel = 'chrome';
        }

        if (CONFIG.proxy.enabled) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            };
        }

        browser = await chromium.launch(launchOptions);

        // Random user agent like ok.js
        const sessionUserAgent = getRandomUserAgent();
        log(`Using User-Agent: ${sessionUserAgent.substring(0, 50)}...`);

        const context = await browser.newContext({
            userAgent: sessionUserAgent,
            viewport: { width: 1920, height: 1080 },
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });

        page = await context.newPage();

        // Setup response listener (KEY!)
        setupResponseListener(page);

        // Login
        await login(page);

        // Navigate
        await navigateToAppointmentPage(page);

        sendTelegram(`✅ <b>Logged In</b>\n📧 ${CONFIG.credentials.email}\n📍 ${CONFIG.preferences.city}\nLaunching KA sessions...`);

        // Launch ALL KA sessions BEFORE starting monitoring loop
        await startAllKeepAliveSessions();
        log(`✅ All KA sessions ready - starting monitoring loop`, 'SUCCESS');
        sendTelegram(`✅ <b>All KA Sessions Ready</b>\nMonitoring for slots...`);

        // Reset any dates captured during KA launch so we get fresh detections
        availableDate = null;
        lastResponseTime = 0;

        // Monitoring loop
        let checkCount = 0;
        const startTime = Date.now();
        let lastTelegramUpdate = Date.now();
        const DEAD_SESSION_TIMEOUT = 30000; // 30 seconds no response = dead session
        let lastDateReceivedTime = Date.now(); // Track when we last got an actual date (not SEARCHING)
        const SEARCHING_TIMEOUT = 30000; // 30 seconds of SEARCHING = re-login

        while (true) {
            try {
                checkCount++;

                // =====================================================
                // DEAD SESSION DETECTION - No response for 60s = re-login
                // =====================================================
                if (!bookingInProgress && lastResponseTime > 0 && Date.now() - lastResponseTime > DEAD_SESSION_TIMEOUT) {
                    log(`💀 No response for ${Math.round((Date.now() - lastResponseTime) / 1000)}s - session dead, re-logging in...`, 'WARN');
                    sendTelegram(`💀 <b>Dead Session</b>\nNo response for 30s, re-logging in...`);

                    try {
                        await login(page);
                        await navigateToAppointmentPage(page);
                        lastResponseTime = Date.now(); // Reset so we don't immediately trigger again
                        log('✅ Re-login complete - back to monitoring', 'SUCCESS');
                        sendTelegram(`✅ <b>Re-login Complete</b>\nBack to monitoring...`);
                    } catch (reloginErr) {
                        log(`Re-login failed: ${reloginErr.message} - full restart...`, 'ERROR');
                        sendTelegram(`⚠️ <b>Re-login Failed</b>\nFull restart...`);
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runBot();
                    }
                }

                // =====================================================
                // CHECK IF PAGE IS STILL ALIVE
                // =====================================================
                if (checkCount % 100 === 0) {
                    try {
                        await page.evaluate(() => true);
                    } catch (e) {
                        log('Page connection lost - restarting...', 'ERROR');
                        sendTelegram(`⚠️ <b>Connection Lost</b>\nRestarting...`);
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        return runBot();
                    }
                }

                // Check for system busy - SKIP if booking in progress
                if (!bookingInProgress && checkCount % 50 === 0) {
                    const pageText = await page.innerText('body').catch(() => '');
                    if (pageText.toLowerCase().includes('system is busy')) {
                        log('System busy - waiting 5s', 'WARN');
                        await page.waitForTimeout(5000);
                        continue;
                    }
                    // Check if we got logged out
                    if (pageText.toLowerCase().includes('sign in') || pageText.toLowerCase().includes('log in')) {
                        log('Session expired - restarting...', 'WARN');
                        sendTelegram(`⚠️ <b>Session Expired</b>\nRe-logging in...`);
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runBot();
                    }
                }

                // Fire direct API fetch (non-blocking)
                fireDirectFetch(page);

                // Read latest result from previous fetch
                const slot = await readLatestDates(page);

                // Stats
                const elapsedMinutes = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsedMinutes).toFixed(1);
                const dateDisplay = availableDate ? availableDate.date : 'SEARCHING';
                const closestDisplay = closestSlotFound ? closestSlotFound.date : 'N/A';
                const silentSecs = lastResponseTime > 0 ? Math.round((Date.now() - lastResponseTime) / 1000) : 0;

                // Log every second
                if (checkCount % Math.ceil(CONFIG.bot.targetCPM / 60) === 0) {
                    const latencyDisplay = lastLatency > 0 ? lastLatency + 'ms' : '--';
                    console.log(`\x1b[44m[${cpm} CPM]\x1b[0m #${checkCount} | Latency: ${latencyDisplay} | Slot: ${dateDisplay} | Best: ${closestDisplay} | Silent: ${silentSecs}s`);
                }

                // INSTANT BOOKING - no delays when slot found!
                if (!bookingComplete && slot && isDateInRange(slot.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                    log(`🎯 MATCH FOUND: ${slot.date} - FIRING ALL KA SESSIONS!`, 'SUCCESS');

                    // STOP ALL OTHER PROCESSES - FOCUS ON BOOKING ONLY
                    bookingInProgress = true;

                    // FIRE ALL KA BOOKING SESSIONS IN PARALLEL - INSTANTLY
                    const results = await fireAllBookingSessions(slot.date).catch(err => {
                        log(`Parallel booking error: ${err.message}`, 'ERROR');
                        return [];
                    });

                    const successes = (results || []).filter(r => r && r.booked);
                    if (successes.length > 0) {
                        log(`🎉🎉🎉 ${successes.length} BOOKINGS SUCCEEDED! 🎉🎉🎉`, 'SUCCESS');
                        successes.forEach(r => {
                            log(`   🎉 ${r.tag} @ ${r.timeSlot} (${r.email})`, 'SUCCESS');
                        });

                        // Check if ALL accounts are now booked
                        if (bookedAccounts.size >= keepAliveSessions.length) {
                            log(`🛑 ALL ${bookedAccounts.size} ACCOUNTS BOOKED - STOPPING BOT`, 'SUCCESS');
                            sendTelegram(
                                `🛑 <b>ALL BOOKED - Bot Stopped</b>\n` +
                                `📅 Date: ${slot.date}\n` +
                                `✅ ${bookedAccounts.size}/${keepAliveSessions.length} accounts booked!\n` +
                                successes.map(r => `🎉 ${r.email} @ ${r.timeSlot}`).join('\n')
                            );
                            if (browser) await browser.close().catch(() => {});
                            await closeAllKeepAliveSessions();
                            process.exit(0);
                        }

                        // Some booked but not all — continue monitoring for remaining accounts
                        log(`✅ ${bookedAccounts.size}/${keepAliveSessions.length} booked so far, continuing for remaining...`, 'SUCCESS');
                        sendTelegram(
                            `✅ <b>${bookedAccounts.size}/${keepAliveSessions.length} Booked</b>\n` +
                            `📅 Date: ${slot.date}\n` +
                            successes.map(r => `🎉 ${r.email} @ ${r.timeSlot}`).join('\n') +
                            `\nContinuing for remaining accounts...`
                        );
                    }

                    bookingInProgress = false;

                    // Cooldown: reset detected date so we wait for a fresh detection
                    availableDate = null;
                    lastResponseTime = 0;
                    log(`⏳ Booking cooldown - waiting for fresh date detection...`, 'WARN');
                    await page.waitForTimeout(5000);
                }

                // Telegram update every 1 min
                if (Date.now() - lastTelegramUpdate > 60000) {
                    sendTelegram(
                        `📊 <b>Status</b>\n` +
                        `📧 ${CONFIG.credentials.email}\n` +
                        `📍 ${CONFIG.preferences.city}\n` +
                        `📅 Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}\n` +
                        `⚡ ${cpm} CPM\n` +
                        `🔄 ${checkCount} checks\n` +
                        `📅 Current: ${dateDisplay}\n` +
                        `📅 Best: ${closestDisplay}\n` +
                        `💀 Silent: ${silentSecs}s`
                    );
                    lastTelegramUpdate = Date.now();
                }

                // Delay - fixed interval based on TARGET_CPM
                await page.waitForTimeout(getDelay(CONFIG.bot.targetCPM));

            } catch (loopError) {
                log(`Loop error: ${loopError.message} - recovering...`, 'ERROR');
                // Don't crash, try to continue
                await new Promise(r => setTimeout(r, 1000));

                // If too many errors, restart
                if (loopError.message.includes('closed') || loopError.message.includes('Target')) {
                    log('Browser closed - restarting...', 'ERROR');
                    sendTelegram(`⚠️ <b>Browser Crashed</b>\nRestarting...`);
                    if (browser) await browser.close().catch(() => {});
                    await new Promise(r => setTimeout(r, 5000));
                    return runBot();
                }
            }
        }

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        sendTelegram(`🛑 <b>Error</b>\n${error.message}`);

        if (browser) await browser.close();
        await closeAllKeepAliveSessions();

        // Restart
        log('Restarting in 10s...');
        await new Promise(r => setTimeout(r, 10000));
        return runBot();
    }
}

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    sendTelegram('🛑 <b>Bot Stopped</b>');
    await closeAllKeepAliveSessions();
    setTimeout(() => process.exit(0), 2000);
});

process.on('uncaughtException', async (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Crash - Auto Restarting</b>\n${err.message}`);

    // Close keepalive sessions
    await closeAllKeepAliveSessions();

    // Auto-restart after 10 seconds instead of exiting
    console.log('Auto-restarting in 10s...');
    setTimeout(() => {
        runBot();
    }, 10000);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    sendTelegram(`⚠️ <b>Unhandled Error - Continuing</b>\n${String(reason).substring(0, 100)}`);
    // Don't crash, just log and continue
});

// Start
runBot();
