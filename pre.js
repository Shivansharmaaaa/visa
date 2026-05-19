/**
 * US Visa Appointment Bot v2.3 - HIGH SPEED + STALE DATA PROTECTION
 *
 * Based on working ok.js approach:
 * - Uses response listener to capture dates (not direct API calls)
 * - Triggers fresh requests by re-selecting city
 * - 240 CPM target with proxy support
 * - IP leak protection
 * - STALE DATA VERIFICATION: Every 5 min, logs into verification account
 *   to compare dates. If data is stale, auto-restarts main session.
 */

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
// Debug: Print loaded env vars
console.log('Loading VERIFY_EMAIL:', process.env.VERIFY_EMAIL);
console.log('Loading VERIFY_PASSWORD:', process.env.VERIFY_PASSWORD ? '****' : 'NOT SET');

const CONFIG = {
    credentials: {
        email: process.env.VISA_EMAIL,
        password: process.env.VISA_PASSWORD
    },
    // Verification account for stale data detection
    verifyCredentials: {
        email: process.env.VERIFY_EMAIL || '',
        password: process.env.VERIFY_PASSWORD || '',
        intervalMins: parseInt(process.env.VERIFY_INTERVAL_MINS) || 5
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
// GLOBAL STATE FOR RESPONSE LISTENER (like ok.js)
// ============================================================================
let availableDate = null;
let availableTime = null;
let allAvailableDates = [];           // Store ALL dates from API
let prefetchedTimes = new Map();       // Map: date -> [times array]
let lastResponseTime = 0;
let closestSlotFound = null;
let lastRequestTime = 0;
let lastLatency = 0;
let instantBookingTriggered = false;   // Flag for instant booking
let cachedIds = null;                  // Cache schedule/facility IDs
let verifyInProgress = false;          // Flag to pause prefetch during verification

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
    // Account for ~100ms overhead (selectOption + network)
    // Actual cycle = delay + overhead, so reduce delay to compensate
    const overhead = 100;
    const idealCycle = 60000 / targetCPM;
    return Math.max(0, Math.floor(idealCycle - overhead));
}

// ============================================================================
// RESPONSE LISTENER (KEY - from ok.js) - INSTANT DETECTION
// ============================================================================
let bookingInProgress = false;
let pageRef = null;

function setupResponseListener(page) {
    pageRef = page;

    page.on('response', async (response) => {
        try {
            const url = response.url();

            // Capture available dates - INSTANT DETECTION + STORE ALL
            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    // Store ALL dates
                    allAvailableDates = data;
                    availableDate = data[0];
                    lastResponseTime = Date.now();
                    if (lastRequestTime > 0) {
                        lastLatency = lastResponseTime - lastRequestTime;
                    }

                    const slotDate = new Date(availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    // Track closest slot - only prefetch when slot CHANGES
                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = availableDate;
                            log(`📅 New closest slot: ${closestSlotFound.date}`, 'SUCCESS');
                            // Prefetch times ONLY when slot changes
                            prefetchTimesForDates(page, [closestSlotFound.date]);
                        }
                    }

                    // Check if any dates are in range
                    const datesInRange = data.filter(d =>
                        isDateInRange(d.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)
                    );

                    if (datesInRange.length > 0) {
                        log(`🚨 INSTANT DETECT: ${datesInRange.length} dates in range! First: ${datesInRange[0].date}`, 'SUCCESS');
                        instantBookingTriggered = true;
                    }
                }
            }

            // Capture available times - store in prefetch map
            if (url.includes('.json') && url.includes('date=')) {
                const data = await response.json();
                const dateMatch = url.match(/date=(\d{4}-\d{2}-\d{2})/);
                const capturedDate = dateMatch ? dateMatch[1] : null;

                if (data && data.available_times && data.available_times.length > 0 && capturedDate) {
                    // Store only LAST 3 times (less competition on later slots)
                    const last3Times = data.available_times.slice(-3);
                    prefetchedTimes.set(capturedDate, last3Times);
                    availableTime = last3Times[last3Times.length - 1]; // Use last slot
                    log(`⏰ PREFETCHED ${capturedDate}: ${last3Times.length} slots [${last3Times.join(', ')}]`, 'SUCCESS');
                }
            }
        } catch (e) {
            // Log parsing errors for debugging
            if (!e.message.includes('body stream')) {
                log(`Response parse: ${e.message}`, 'WARN');
            }
        }
    });
}

// ============================================================================
// PRE-FETCH TIMES FOR DATES (called when dates in range detected)
// ============================================================================
async function prefetchTimesForDates(page, dates) {
    // Skip prefetching during verification
    if (verifyInProgress) return;

    if (!cachedIds) {
        // Get IDs once and cache them
        cachedIds = await page.evaluate(() => {
            const url = window.location.href;
            const scheduleMatch = url.match(/schedule\/(\d+)/);
            const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            return {
                scheduleId: scheduleMatch ? scheduleMatch[1] : null,
                facilityId: facilitySelect ? facilitySelect.value : null,
                csrf: csrfToken
            };
        }).catch(() => null);
    }

    if (!cachedIds?.scheduleId || !cachedIds?.facilityId) {
        log(`⚠️ Cannot prefetch - missing IDs`, 'WARN');
        return;
    }

    // Prefetch times for all dates in parallel (fire and forget)
    for (const date of dates) {
        if (prefetchedTimes.has(date)) continue; // Already have times for this date

        // Fire fetch request - response listener will capture the times
        page.evaluate(async ({ baseUrl, scheduleId, facilityId, date, csrf }) => {
            try {
                const url = `${baseUrl}/schedule/${scheduleId}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`;
                await fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-Token': csrf || ''
                    }
                });
            } catch (e) {}
        }, {
            baseUrl: CONFIG.preferences.baseUrl,
            scheduleId: cachedIds.scheduleId,
            facilityId: cachedIds.facilityId,
            date,
            csrf: cachedIds.csrf
        }).catch(() => {});
    }

    log(`🔄 Prefetching times for ${dates.length} dates...`, 'INFO');
}

// ============================================================================
// WAIT FOR FRESH RESPONSE
// ============================================================================
async function waitForAvailableSlot(timeoutMs = 100) {
    const prevTime = lastResponseTime;
    let elapsed = 0;

    while (lastResponseTime === prevTime && elapsed < timeoutMs) {
        // Check instant flag during wait - immediate exit if date found
        if (instantBookingTriggered) {
            return availableDate;
        }
        await new Promise(r => setTimeout(r, 10));
        elapsed += 10;
    }

    return availableDate;
}

// ============================================================================
// STALE DATA VERIFICATION SYSTEM
// ============================================================================
let verifyBrowser = null;
let lastVerifyTime = Date.now(); // Initialize to NOW so first check happens after interval
let shouldRestart = false;

async function verifyDataFreshness() {
    verifyInProgress = true;  // Pause prefetching during verification

    const hasVerifyAccount = CONFIG.verifyCredentials.email &&
                             CONFIG.verifyCredentials.email.length > 0 &&
                             CONFIG.verifyCredentials.password &&
                             CONFIG.verifyCredentials.password.length > 0;

    if (!hasVerifyAccount) {
        log(`No verification account configured (email: ${CONFIG.verifyCredentials.email || 'EMPTY'})`, 'WARN');
        lastVerifyTime = Date.now(); // Reset timer so we don't spam this message
        verifyInProgress = false;
        return true;
    }

    log('🔍 VERIFYING DATA FRESHNESS with secondary account...', 'SECURITY');

    let verifyPage = null;
    let capturedVerifyDate = null;

    try {
        // Generate a NEW proxy session ID for verification browser
        // This prevents conflicts with main browser's proxy session
        const verifySessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
        const verifyProxyUsername = CONFIG.proxy.username.replace(/sessid-\d+/, `sessid-${verifySessionId}`);
        log(`Using separate proxy session for verify: sessid-${verifySessionId}`, 'INFO');

        // Launch separate browser for verification
        const launchOptions = {
            headless: true, // Run verification in headless mode
            channel: 'chrome',
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-webrtc',
                '--no-sandbox'
            ]
        };

        if (CONFIG.proxy.enabled) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: verifyProxyUsername, // Use NEW session ID
                password: CONFIG.proxy.password
            };
        }

        verifyBrowser = await chromium.launch(launchOptions);
        const context = await verifyBrowser.newContext({
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 }
        });

        verifyPage = await context.newPage();

        // Set up response listener for verification page
        verifyPage.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                    const data = await response.json();
                    if (data && Array.isArray(data) && data.length > 0) {
                        capturedVerifyDate = data[0];
                        log(`🔍 Verify account sees: ${capturedVerifyDate.date}`, 'INFO');
                    }
                }
            } catch (e) {}
        });

        // Login with verification account
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
            log('Verification account login failed', 'ERROR');
            await verifyBrowser.close();
            verifyInProgress = false;
            return true; // Don't restart on verify login failure
        }

        log('Verification account logged in', 'SUCCESS');

        // Navigate to appointment page
        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
        await verifyPage.waitForSelector(continueBtn, { timeout: 15000 });
        await verifyPage.click(continueBtn);
        await verifyPage.waitForTimeout(2000);

        const currentUrl = verifyPage.url();
        const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
        await verifyPage.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Select city
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        await verifyPage.waitForSelector(facilitySelector, { timeout: 10000 });

        const options = await verifyPage.$$eval(`${facilitySelector} option`, opts =>
            opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );

        const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
        if (target) {
            await verifyPage.selectOption(facilitySelector, target.value);
        }

        // Wait for response
        await verifyPage.waitForTimeout(3000);

        // Compare dates
        const mainDate = availableDate ? availableDate.date : null;
        const verifyDate = capturedVerifyDate ? capturedVerifyDate.date : null;

        log(`📊 COMPARISON: Main=${mainDate} | Verify=${verifyDate}`, 'INFO');

        await verifyBrowser.close();
        verifyBrowser = null;
        lastVerifyTime = Date.now();

        if (mainDate && verifyDate && mainDate !== verifyDate) {
            log(`🚨 STALE DATA DETECTED! Main: ${mainDate} vs Verify: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `🚨 <b>STALE DATA DETECTED!</b>\n` +
                `Main account: ${mainDate}\n` +
                `Verify account: ${verifyDate}\n` +
                `⚡ Restarting main session...`
            );
            verifyInProgress = false;
            return false; // Data is stale, need restart
        }

        if (!mainDate && verifyDate) {
            log(`🚨 STALE DATA: Main has no date, Verify sees: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `🚨 <b>STALE DATA!</b>\n` +
                `Main: No dates\n` +
                `Verify: ${verifyDate}\n` +
                `⚡ Restarting...`
            );
            verifyInProgress = false;
            return false;
        }

        log(`✅ Data verified fresh! Both accounts see: ${mainDate || 'no dates'}`, 'SUCCESS');
        sendTelegram(`✅ <b>Data Fresh</b>\nBoth accounts see: ${mainDate || 'no dates'}`);
        verifyInProgress = false;
        return true;

    } catch (error) {
        log(`Verification error: ${error.message}`, 'ERROR');
        sendTelegram(`⚠️ <b>Verify Failed</b>\n${error.message.substring(0, 100)}\nBot continues...`);
        if (verifyBrowser) {
            await verifyBrowser.close().catch(() => {});
            verifyBrowser = null;
        }
        lastVerifyTime = Date.now(); // Reset timer so we don't spam retries
        verifyInProgress = false;
        return true; // Don't restart on verify error, continue monitoring
    }
}

// ============================================================================
// TRIGGER FRESH REQUEST (re-select city) - OPTIMIZED FOR SPEED
// ============================================================================
async function resetSelection(page) {
    try {
        lastRequestTime = Date.now();
        // Single evaluate call - faster than $eval + selectOption (saves ~50ms round trip)
        await page.evaluate(() => {
            const sel = document.querySelector('#appointments_consulate_appointment_facility_id');
            if (sel && sel.value) {
                // Trigger change event which calls the API
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                // Also trigger jQuery if available
                if (typeof $ !== 'undefined') {
                    $(sel).trigger('change');
                }
            }
        });
    } catch (e) {
        // Ignore errors
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

    // Click continue if visible
    try {
        await page.waitForSelector('input[type="submit"][value="Continue"]', { timeout: 3000 });
        await page.click('input[type="submit"][value="Continue"]');
    } catch (e) {}

    return true;
}

// ============================================================================
// BOOKING - RAPID FIRE WITH PREFETCHED TIMES (LAST SLOT FIRST)
// ============================================================================
async function performBooking(page, slot) {
    const startTime = Date.now();
    let successTime = null;

    // Notify booking started
    sendTelegram(`🚀 <b>BOOKING STARTED!</b>\n📅 ${slot.date}\n📍 ${CONFIG.preferences.city}\n📧 ${CONFIG.credentials.email}`);

    try {
        // Use cached IDs or get them
        if (!cachedIds) {
            cachedIds = await page.evaluate(() => {
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
        }

        if (!cachedIds?.scheduleId || !cachedIds?.facilityId) {
            log(`❌ Missing IDs`, 'ERROR');
            return false;
        }

        // GET TIME SLOTS - Use prefetched if available, otherwise fetch
        let timesToTry = [];

        if (prefetchedTimes.has(slot.date)) {
            timesToTry = [...prefetchedTimes.get(slot.date)];
            log(`⚡ PREFETCHED ${timesToTry.length} times for ${slot.date}: [${timesToTry.join(', ')}]`, 'SUCCESS');
        } else {
            // Fallback: fetch times now
            log(`⏳ Fetching times for ${slot.date}...`, 'INFO');
            const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${cachedIds.scheduleId}/appointment/times/${cachedIds.facilityId}.json?date=${slot.date}&appointments[expedite]=false`;

            const timeResult = await Promise.race([
                page.evaluate(async ({ url, csrf }) => {
                    try {
                        const resp = await fetch(url, {
                            method: 'GET',
                            credentials: 'include',
                            headers: {
                                'Accept': 'application/json',
                                'X-Requested-With': 'XMLHttpRequest',
                                'X-CSRF-Token': csrf || ''
                            }
                        });
                        if (!resp.ok) return { error: `HTTP ${resp.status}` };
                        const data = await resp.json();
                        return { times: data.available_times || [] };
                    } catch (e) {
                        return { error: e.message };
                    }
                }, { url: timesUrl, csrf: cachedIds.csrf }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))
            ]).catch(e => ({ error: e.message }));

            if (timeResult.error || !timeResult.times?.length) {
                log(`❌ Times API: ${timeResult.error || 'No times'}`, 'ERROR');
                return false;
            }
            timesToTry = timeResult.times;
        }

        // REVERSE ORDER - Try LAST slot first (less competition)
        timesToTry = timesToTry.reverse();
        log(`🔄 Trying ${timesToTry.length} slots REVERSED (last→first): ${timesToTry[0]} → ${timesToTry[timesToTry.length-1]}`, 'INFO');

        // RAPID FIRE - Try each time slot sequentially
        for (let i = 0; i < timesToTry.length; i++) {
            const timeToTry = timesToTry[i];
            const attemptStart = Date.now();

            try {
                // Set date + time + submit
                const submitResult = await page.evaluate(({ date, time }) => {
                    try {
                        const dateInput = document.querySelector('#appointments_consulate_appointment_date');
                        if (!dateInput) return { error: 'No date input' };

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
                        if (form) {
                            form.submit();
                            return { submitted: true };
                        } else {
                            document.querySelector('#appointments_submit')?.click();
                            return { submitted: true };
                        }
                    } catch (e) {
                        return { error: e.message };
                    }
                }, { date: slot.date, time: timeToTry }).catch(e => {
                    if (e.message.includes('context') || e.message.includes('destroyed')) {
                        return { navigated: true };
                    }
                    return { error: e.message };
                });

                if (submitResult.navigated || submitResult.submitted) {
                    // Wait briefly for confirm button
                    await page.waitForSelector('a.button.alert', { timeout: 2000 }).catch(() => {});

                    // Click confirm
                    const confirmed = await page.evaluate(() => {
                        const btn = document.querySelector('a.button.alert') || document.querySelector('input[value="Confirm"]');
                        if (btn) { btn.click(); return true; }
                        return false;
                    }).catch(e => {
                        if (e.message.includes('context') || e.message.includes('destroyed')) return true;
                        return false;
                    });

                    if (confirmed) {
                        successTime = timeToTry;
                        const elapsed = Date.now() - startTime;
                        log(`🎉 BOOKED in ${elapsed}ms! Time: ${timeToTry} (slot ${i + 1}/${timesToTry.length})`, 'SUCCESS');
                        sendTelegram(`🎉 <b>BOOKED!</b>\n📅 ${slot.date}\n⏰ ${timeToTry}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
                        return true;
                    }
                }

                // Check if still on form (slot might be taken)
                const stillOnForm = await page.$('#appointments_consulate_appointment_date').catch(() => null);
                if (!stillOnForm) {
                    // Navigated away - likely success or slot gone
                    const elapsed = Date.now() - startTime;
                    log(`🎉 Likely BOOKED in ${elapsed}ms!`, 'SUCCESS');
                    sendTelegram(`🎉 <b>LIKELY BOOKED!</b>\n📅 ${slot.date}\n⏰ ${timeToTry}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
                    return true;
                }

                log(`❌ Slot ${i + 1} (${timeToTry}) failed - trying next...`, 'WARN');

            } catch (e) {
                if (e.message.includes('context') || e.message.includes('destroyed')) {
                    const elapsed = Date.now() - startTime;
                    log(`🎉 Likely BOOKED in ${elapsed}ms!`, 'SUCCESS');
                    sendTelegram(`🎉 <b>LIKELY BOOKED!</b>\n📅 ${slot.date}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
                    return true;
                }
                log(`❌ Attempt ${i + 1} error: ${e.message}`, 'ERROR');
            }
        }

        log(`❌ All ${timesToTry.length} time slots failed`, 'ERROR');
        return false;

    } catch (error) {
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            const elapsed = Date.now() - startTime;
            log(`🎉 Likely BOOKED in ${elapsed}ms!`, 'SUCCESS');
            sendTelegram(`🎉 <b>LIKELY BOOKED!</b>\n📅 ${slot.date}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
            return true;
        }

        log(`❌ Error: ${error.message}`, 'ERROR');
        return false;
    }
}

// ============================================================================
// MAIN BOT
// ============================================================================
async function runBot() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  VISA BOT v2.3 - STALE DATA PROTECTION\x1b[0m');
    console.log('\x1b[36m  Target: ' + CONFIG.bot.targetCPM + ' CPM\x1b[0m');
    console.log('\x1b[33m  Verify Interval: ' + CONFIG.verifyCredentials.intervalMins + ' mins\x1b[0m');
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

        sendTelegram(`✅ <b>Logged In</b>\n📧 ${CONFIG.credentials.email}\n📍 ${CONFIG.preferences.city}\nMonitoring for slots...`);

        // Monitoring loop
        let checkCount = 0;
        const startTime = Date.now();
        let lastTelegramUpdate = Date.now();
        let lastCookieReset = Date.now(); // Track cookie reset time
        lastVerifyTime = Date.now(); // Initialize verify timer

        const verifyIntervalMs = CONFIG.verifyCredentials.intervalMins * 60 * 1000;
        const cookieResetIntervalMs = 21 * 60 * 1000; // Reset cookies every 21 minutes

        while (true) {
            try {
                checkCount++;

                // =====================================================
                // COOKIE RESET - Every 21 minutes to prevent stale sessions
                // =====================================================
                if (!bookingInProgress && Date.now() - lastCookieReset > cookieResetIntervalMs) {
                    log('🍪 21 min cookie reset - clearing cookies and re-logging in...', 'INFO');
                    sendTelegram(`🍪 <b>Cookie Reset</b>\nClearing cookies for fresh session...`);

                    try {
                        // Clear all cookies from the context
                        await context.clearCookies();
                        log('Cookies cleared', 'SUCCESS');

                        // Re-login
                        await login(page);
                        await navigateToAppointmentPage(page);

                        lastCookieReset = Date.now();
                        log('🍪 Cookie reset complete - back to monitoring', 'SUCCESS');
                        sendTelegram(`✅ <b>Cookie Reset Complete</b>\nBack to monitoring...`);
                    } catch (cookieErr) {
                        log(`Cookie reset failed: ${cookieErr.message} - full restart...`, 'ERROR');
                        sendTelegram(`⚠️ <b>Cookie Reset Failed</b>\nFull restart...`);
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

                // =====================================================
                // STALE DATA VERIFICATION - Every X minutes
                // SKIP if booking in progress!
                // =====================================================
                if (!bookingInProgress && Date.now() - lastVerifyTime > verifyIntervalMs) {
                    log(`⏰ ${CONFIG.verifyCredentials.intervalMins} min passed - Running stale data check...`, 'SECURITY');

                    try {
                        const dataIsFresh = await verifyDataFreshness();
                        if (!dataIsFresh) {
                            log('🔄 RESTARTING due to stale data...', 'ERROR');
                            if (browser) await browser.close().catch(() => {});
                            await new Promise(r => setTimeout(r, 3000));
                            return runBot();
                        }
                    } catch (verifyErr) {
                        log(`Verification failed: ${verifyErr.message} - continuing...`, 'WARN');
                        lastVerifyTime = Date.now();
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

                // Trigger fresh request
                await resetSelection(page).catch(() => {});

                // Wait for response - BUT check instant flag first
                let slot = null;
                if (instantBookingTriggered && availableDate) {
                    slot = availableDate;
                    log(`⚡ INSTANT PATH - date already detected!`, 'SUCCESS');
                } else {
                    slot = await waitForAvailableSlot(100);
                }

                // Stats
                const elapsedMinutes = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsedMinutes).toFixed(1);
                const dateDisplay = availableDate ? availableDate.date : 'SEARCHING';
                const closestDisplay = closestSlotFound ? closestSlotFound.date : 'N/A';
                const nextVerifyIn = Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - lastVerifyTime)) / 60000));
                const nextCookieReset = Math.max(0, Math.ceil((cookieResetIntervalMs - (Date.now() - lastCookieReset)) / 60000));

                // Log every second
                if (checkCount % Math.ceil(CONFIG.bot.targetCPM / 60) === 0) {
                    const latencyDisplay = lastLatency > 0 ? lastLatency + 'ms' : '--';
                    const prefetchCount = prefetchedTimes.size;
                    const datesCount = allAvailableDates.length;
                    console.log(`\x1b[44m[${cpm} CPM]\x1b[0m #${checkCount} | Lat: ${latencyDisplay} | Slot: ${dateDisplay} | Best: ${closestDisplay} | Dates: ${datesCount} | Prefetch: ${prefetchCount}`);
                }

                // INSTANT BOOKING - no delays when slot found!
                if (slot && isDateInRange(slot.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                    log(`🎯 MATCH FOUND: ${slot.date} - ULTRA FAST BOOKING!`, 'SUCCESS');

                    // STOP ALL OTHER PROCESSES - FOCUS ON BOOKING ONLY
                    bookingInProgress = true;

                    // Try booking up to 3 times - SAME BROWSER, NO NEW LAUNCH
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        log(`🚀 Booking attempt ${attempt}/3...`, 'INFO');
                        try {
                            const booked = await performBooking(page, slot);
                            if (booked) {
                                log(`🎉🎉🎉 SUCCESSFULLY BOOKED! 🎉🎉🎉`, 'SUCCESS');
                                log(`🛑 STOPPING BOT - BOOKING COMPLETE`, 'SUCCESS');
                                sendTelegram(`🛑 <b>Bot Stopped</b>\n✅ Booking completed successfully!`);
                                if (browser) await browser.close().catch(() => {});
                                if (verifyBrowser) await verifyBrowser.close().catch(() => {});
                                process.exit(0);
                            }
                        } catch (bookErr) {
                            log(`Booking attempt failed: ${bookErr.message}`, 'ERROR');
                        }
                        await page.waitForTimeout(50);
                    }
                    bookingInProgress = false;
                    instantBookingTriggered = false;  // Reset flag
                    prefetchedTimes.clear();          // Clear cached times
                    allAvailableDates = [];           // Clear cached dates
                }

                // Telegram update every 4 min
                if (Date.now() - lastTelegramUpdate > 240000) {
                    sendTelegram(
                        `📊 <b>Status</b>\n` +
                        `📧 ${CONFIG.credentials.email}\n` +
                        `📍 ${CONFIG.preferences.city}\n` +
                        `📅 Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}\n` +
                        `⚡ ${cpm} CPM\n` +
                        `🔄 ${checkCount} checks\n` +
                        `📅 Current: ${dateDisplay}\n` +
                        `📅 Best: ${closestDisplay}\n` +
                        `🔍 Next verify: ${nextVerifyIn}m`
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
        if (verifyBrowser) await verifyBrowser.close().catch(() => {});

        // Restart
        log('Restarting in 10s...');
        await new Promise(r => setTimeout(r, 10000));
        return runBot();
    }
}

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    sendTelegram('🛑 <b>Bot Stopped</b>');
    setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', async (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Crash - Auto Restarting</b>\n${err.message}`);

    // Close any open browsers
    if (verifyBrowser) {
        await verifyBrowser.close().catch(() => {});
        verifyBrowser = null;
    }

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
