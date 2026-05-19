/**
 * US Visa Appointment Bot v3.0 - ACCOUNT ROTATION + STALE DATA PROTECTION
 *
 * Based on nothang.js v2.3:
 * - Uses response listener to capture dates (not direct API calls)
 * - Triggers fresh requests via direct API fetch
 * - 240 CPM target with proxy support
 * - IP leak protection
 * - ACCOUNT ROTATION: Rotates through 5 accounts every 50 minutes
 *   to avoid rate limits and detection
 * - STALE DATA VERIFICATION: Uses separate verify account
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config({ path: '.env.nothang_rotation' });

chromium.use(stealth);

// ============================================================================
// CONFIGURATION
// ============================================================================

// Load rotation accounts from env (supports up to 20)
const ROTATION_ACCOUNTS = [];
for (let i = 1; i <= 20; i++) {
    const email = process.env[`ACCOUNT${i}_EMAIL`];
    const password = process.env[`ACCOUNT${i}_PASSWORD`];
    if (email && password) {
        ROTATION_ACCOUNTS.push({ email, password, index: i });
    }
}

console.log(`Loaded ${ROTATION_ACCOUNTS.length} rotation accounts`);
ROTATION_ACCOUNTS.forEach((acc, i) => {
    console.log(`  Account ${i + 1}: ${acc.email}`);
});

if (ROTATION_ACCOUNTS.length === 0) {
    console.error('ERROR: No accounts configured! Set ACCOUNT1_EMAIL, ACCOUNT1_PASSWORD, etc. in .env.nothang_rotation');
    process.exit(1);
}

const CONFIG = {
    // Current active account (will rotate)
    credentials: {
        email: ROTATION_ACCOUNTS[0].email,
        password: ROTATION_ACCOUNTS[0].password
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
    },
    rotation: {
        intervalMins: parseInt(process.env.ROTATION_INTERVAL_MINS) || 30
    }
};

// ============================================================================
// ACCOUNT ROTATION STATE
// ============================================================================
let currentAccountIndex = 0;
let lastRotationTime = Date.now();
const rotationIntervalMs = CONFIG.rotation.intervalMins * 60 * 1000;

function getCurrentAccount() {
    return ROTATION_ACCOUNTS[currentAccountIndex];
}

function getNextAccountIndex() {
    return (currentAccountIndex + 1) % ROTATION_ACCOUNTS.length;
}

function rotateAccount() {
    const prevIndex = currentAccountIndex;
    currentAccountIndex = getNextAccountIndex();
    const newAccount = getCurrentAccount();

    // Update CONFIG credentials
    CONFIG.credentials.email = newAccount.email;
    CONFIG.credentials.password = newAccount.password;

    log(`🔄 ACCOUNT ROTATED: #${prevIndex + 1} → #${currentAccountIndex + 1} (${newAccount.email})`, 'SUCCESS');
    sendTelegram(
        `🔄 <b>Account Rotated</b>\n` +
        `From: Account #${prevIndex + 1}\n` +
        `To: Account #${currentAccountIndex + 1}\n` +
        `📧 ${newAccount.email}\n` +
        `Next rotation in ${CONFIG.rotation.intervalMins} mins`
    );

    lastRotationTime = Date.now();
    return newAccount;
}

// ============================================================================
// GLOBAL STATE FOR RESPONSE LISTENER
// ============================================================================
let availableDate = null;
let availableTime = null;
let lastResponseTime = 0;
let closestSlotFound = null;
let lastRequestTime = 0;
let lastLatency = 0;

// IDs needed for direct API fetch
let scheduleId = null;
let facilityId = null;
let csrfToken = null;

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
        'SECURITY': '\x1b[45m',
        'ROTATION': '\x1b[43m'
    };
    const accTag = `[Acc#${currentAccountIndex + 1}]`;
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${accTag} ${message}\x1b[0m`);
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
// TELEGRAM
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
    }, (res) => {});

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

// Random viewports for fingerprint variation on each rotation
const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1536, height: 864 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1600, height: 900 },
    { width: 1680, height: 1050 },
    { width: 1280, height: 800 },
    { width: 1920, height: 1200 },
    { width: 1440, height: 1024 },
    { width: 1360, height: 768 }
];

function getRandomViewport() {
    return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

function getDelay(targetCPM) {
    const overhead = 5;
    const idealCycle = 60000 / targetCPM;
    return Math.max(0, Math.floor(idealCycle - overhead));
}

// ============================================================================
// RESPONSE LISTENER - INSTANT DETECTION
// ============================================================================
let bookingInProgress = false;
let pageRef = null;

function setupResponseListener(page) {
    pageRef = page;

    page.on('response', async (response) => {
        try {
            const url = response.url();

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

                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = availableDate;
                            log(`New closest slot: ${closestSlotFound.date}`, 'SUCCESS');
                        }
                    }

                    if (isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                        log(`INSTANT DETECT: ${availableDate.date} IN RANGE!`, 'SUCCESS');
                    }
                }
            }

            if (url.includes('.json') && url.includes('date=')) {
                const data = await response.json();
                if (data && data.available_times && data.available_times.length > 0) {
                    availableTime = data.available_times[0];
                    log(`Time captured: ${availableTime}`, 'INFO');
                }
            }
        } catch (e) {}
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
// STALE DATA VERIFICATION SYSTEM
// ============================================================================
let verifyBrowser = null;
let lastVerifyTime = Date.now();
let shouldRestart = false;

async function verifyDataFreshness() {
    const hasVerifyAccount = CONFIG.verifyCredentials.email &&
                             CONFIG.verifyCredentials.email.length > 0 &&
                             CONFIG.verifyCredentials.password &&
                             CONFIG.verifyCredentials.password.length > 0;

    if (!hasVerifyAccount) {
        log(`No verification account configured`, 'WARN');
        lastVerifyTime = Date.now();
        return true;
    }

    log('VERIFYING DATA FRESHNESS with secondary account...', 'SECURITY');

    let verifyPage = null;
    let capturedVerifyDate = null;

    try {
        const verifySessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
        const verifyProxyUsername = CONFIG.proxy.username.replace(/sessid-\d+/, `sessid-${verifySessionId}`);

        const launchOptions = {
            headless: true,
            channel: 'chrome',
            args: ['--disable-blink-features=AutomationControlled', '--disable-webrtc', '--no-sandbox']
        };

        if (CONFIG.proxy.enabled) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: verifyProxyUsername,
                password: CONFIG.proxy.password
            };
        }

        verifyBrowser = await chromium.launch(launchOptions);
        const context = await verifyBrowser.newContext({
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
                        log(`Verify account sees: ${capturedVerifyDate.date}`, 'INFO');
                    }
                }
            } catch (e) {}
        });

        await verifyPage.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
            waitUntil: 'domcontentloaded', timeout: 30000
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
            return true;
        }

        log('Verification account logged in', 'SUCCESS');

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

        const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
        if (target) {
            await verifyPage.selectOption(facilitySelector, target.value);
        }

        await verifyPage.waitForTimeout(3000);

        const mainDate = availableDate ? availableDate.date : null;
        const verifyDate = capturedVerifyDate ? capturedVerifyDate.date : null;

        log(`COMPARISON: Main=${mainDate} | Verify=${verifyDate}`, 'INFO');

        await verifyBrowser.close();
        verifyBrowser = null;
        lastVerifyTime = Date.now();

        if (mainDate && verifyDate && mainDate !== verifyDate) {
            log(`STALE DATA DETECTED! Main: ${mainDate} vs Verify: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `<b>STALE DATA DETECTED!</b>\nMain: ${mainDate}\nVerify: ${verifyDate}\nRestarting...`
            );
            return false;
        }

        if (!mainDate && verifyDate) {
            log(`STALE DATA: Main has no date, Verify sees: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `<b>STALE DATA!</b>\nMain: No dates\nVerify: ${verifyDate}\nRestarting...`
            );
            return false;
        }

        log(`Data verified fresh! Both see: ${mainDate || 'no dates'}`, 'SUCCESS');
        sendTelegram(`<b>Data Fresh</b>\nBoth accounts see: ${mainDate || 'no dates'}`);
        return true;

    } catch (error) {
        log(`Verification error: ${error.message}`, 'ERROR');
        sendTelegram(`<b>Verify Failed</b>\n${error.message.substring(0, 100)}\nBot continues...`);
        if (verifyBrowser) {
            await verifyBrowser.close().catch(() => {});
            verifyBrowser = null;
        }
        lastVerifyTime = Date.now();
        return true;
    }
}

// ============================================================================
// DIRECT API FETCH
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
                    log(`New closest slot: ${closestSlotFound.date}`, 'SUCCESS');
                }
            }

            if (isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                log(`INSTANT DETECT: ${availableDate.date} IN RANGE!`, 'SUCCESS');
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
    log(`Attempting login with ${CONFIG.credentials.email}...`);

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

    await page.fill('#user_email', CONFIG.credentials.email);
    await page.fill('#user_password', CONFIG.credentials.password);

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
        throw new Error(`LOGIN_FAILED for ${CONFIG.credentials.email}`);
    }

    log(`Login successful with ${CONFIG.credentials.email}!`, 'SUCCESS');
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
    log(`Extracted IDs - schedule: ${scheduleId}, facility: ${facilityId}`, 'INFO');

    try {
        await page.waitForSelector('input[type="submit"][value="Continue"]', { timeout: 3000 });
        await page.click('input[type="submit"][value="Continue"]');
    } catch (e) {}

    return true;
}

// ============================================================================
// BOOKING - ULTRA FAST API APPROACH
// ============================================================================
async function performBooking(page, slot) {
    const startTime = Date.now();
    let capturedTime = null;

    sendTelegram(
        `<b>BOOKING STARTED!</b>\n` +
        `Date: ${slot.date}\n` +
        `City: ${CONFIG.preferences.city}\n` +
        `Account: #${currentAccountIndex + 1} (${CONFIG.credentials.email})`
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
            log('Missing IDs', 'ERROR');
            return false;
        }

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
            log(`Times API: ${timeResult.error}`, 'ERROR');
            return false;
        }

        if (!timeResult.time) {
            log(`No times for ${slot.date}`, 'ERROR');
            return false;
        }

        capturedTime = timeResult.time;
        log(`Time: ${capturedTime}`, 'SUCCESS');

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
                if (form) {
                    form.submit();
                } else {
                    document.querySelector('#appointments_submit').click();
                }
            }, { date: slot.date, time: capturedTime });
        } catch (e) {
            if (e.message.includes('context') || e.message.includes('destroyed')) {
                log('Navigation detected', 'SUCCESS');
            } else {
                throw e;
            }
        }

        try {
            await page.waitForSelector('a.button.alert', { timeout: 3000 });
        } catch (e) {
            log('Confirm button wait timeout', 'WARN');
        }

        try {
            const confirmBtn = await page.$('a.button.alert') || await page.$('input[value="Confirm"]');
            if (confirmBtn) {
                await confirmBtn.click();
                log('Confirm clicked', 'SUCCESS');
            }
        } catch (e) {
            if (e.message.includes('context') || e.message.includes('destroyed')) {
                log('Confirm navigation detected', 'SUCCESS');
            }
        }

        const elapsed = Date.now() - startTime;
        log(`BOOKED in ${elapsed}ms!`, 'SUCCESS');
        sendTelegram(
            `<b>BOOKED!</b>\n` +
            `Date: ${slot.date}\nTime: ${capturedTime}\n` +
            `Speed: ${elapsed}ms\n` +
            `Account: #${currentAccountIndex + 1} (${CONFIG.credentials.email})`
        );
        return true;

    } catch (error) {
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            const elapsed = Date.now() - startTime;
            log(`Likely BOOKED in ${elapsed}ms!`, 'SUCCESS');
            sendTelegram(
                `<b>LIKELY BOOKED!</b>\n` +
                `Date: ${slot.date}\nSpeed: ${elapsed}ms\n` +
                `Account: #${currentAccountIndex + 1} (${CONFIG.credentials.email})`
            );
            return true;
        }

        log(`Error: ${error.message}`, 'ERROR');
        return false;
    }
}

// ============================================================================
// PERFORM ACCOUNT ROTATION (new context + new user agent + new account)
// ============================================================================
async function performAccountRotation(browser, oldContext) {
    log(`${CONFIG.rotation.intervalMins} min rotation timer hit - switching from Account #${currentAccountIndex + 1}...`, 'ROTATION');

    try {
        // Close old context entirely (kills old fingerprint)
        await oldContext.close().catch(() => {});
        log('Old context closed', 'INFO');

        // Rotate to next account
        rotateAccount();

        // Reset global state for fresh session
        availableDate = null;
        availableTime = null;
        lastResponseTime = 0;
        lastRequestTime = 0;
        lastLatency = 0;
        scheduleId = null;
        facilityId = null;
        csrfToken = null;

        // Create brand new context with fresh user agent + fingerprint
        const newUA = getRandomUserAgent();
        const newViewport = getRandomViewport();
        log(`New fingerprint - UA: ${newUA.substring(0, 50)}... | Viewport: ${newViewport.width}x${newViewport.height}`, 'ROTATION');

        const newContext = await browser.newContext({
            userAgent: newUA,
            viewport: newViewport,
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });

        const newPage = await newContext.newPage();
        setupResponseListener(newPage);

        // Login with new account on fresh context
        await loginOnPage(newPage);
        await navigateToAppointmentPage(newPage);

        log(`Rotation complete - Account #${currentAccountIndex + 1} (${CONFIG.credentials.email}) | New fingerprint active`, 'SUCCESS');
        sendTelegram(
            `<b>Rotated + New Fingerprint</b>\n` +
            `Account: #${currentAccountIndex + 1} (${CONFIG.credentials.email})\n` +
            `UA: ${newUA.substring(0, 40)}...\n` +
            `Viewport: ${newViewport.width}x${newViewport.height}`
        );

        return { success: true, context: newContext, page: newPage };
    } catch (error) {
        log(`Rotation failed: ${error.message}`, 'ERROR');
        sendTelegram(
            `<b>Rotation Failed!</b>\n` +
            `Account #${currentAccountIndex + 1}: ${error.message}\n` +
            `Trying next account...`
        );

        // Try the next account if this one failed
        rotateAccount();
        try {
            const fallbackUA = getRandomUserAgent();
            const fallbackViewport = getRandomViewport();
            const fallbackContext = await browser.newContext({
                userAgent: fallbackUA,
                viewport: fallbackViewport,
                locale: 'en-CA',
                timezoneId: 'America/Toronto'
            });
            const fallbackPage = await fallbackContext.newPage();
            setupResponseListener(fallbackPage);
            await loginOnPage(fallbackPage);
            await navigateToAppointmentPage(fallbackPage);
            log(`Fallback rotation worked - Account #${currentAccountIndex + 1}`, 'SUCCESS');
            return { success: true, context: fallbackContext, page: fallbackPage };
        } catch (fallbackErr) {
            log(`Fallback rotation also failed: ${fallbackErr.message}`, 'ERROR');
            return { success: false };
        }
    }
}

// Login helper that takes a page param (used by rotation)
async function loginOnPage(targetPage) {
    log(`Attempting login with ${CONFIG.credentials.email}...`);

    await targetPage.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await targetPage.waitForSelector('#user_email', { timeout: 30000 });

    const pageText = await targetPage.innerText('body').catch(() => '');
    if (pageText.toLowerCase().includes('system is busy') ||
        pageText.toLowerCase().includes('too many requests')) {
        throw new Error('SYSTEM_BUSY');
    }
    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    await targetPage.fill('#user_email', CONFIG.credentials.email);
    await targetPage.fill('#user_password', CONFIG.credentials.password);

    try {
        await targetPage.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch (e) {
        await targetPage.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await targetPage.click('input[type="submit"]');

    try {
        const okButton = targetPage.locator('button:has-text("OK"), a:has-text("OK")');
        if (await okButton.isVisible({ timeout: 3000 })) {
            await okButton.click();
            await targetPage.click('.icheckbox', { force: true }).catch(() => {});
            await targetPage.click('input[type="submit"]');
        }
    } catch (e) {}

    await targetPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (targetPage.url().includes('sign_in')) {
        throw new Error(`LOGIN_FAILED for ${CONFIG.credentials.email}`);
    }

    log(`Login successful with ${CONFIG.credentials.email}!`, 'SUCCESS');
    return true;
}

// ============================================================================
// MAIN BOT
// ============================================================================
async function runBot() {
    console.log('\n' + '='.repeat(60));
    console.log('\x1b[32m  VISA BOT v3.0 - ACCOUNT ROTATION + STALE DATA PROTECTION\x1b[0m');
    console.log('\x1b[36m  Target: ' + CONFIG.bot.targetCPM + ' CPM\x1b[0m');
    console.log('\x1b[43m  Rotation: Every ' + CONFIG.rotation.intervalMins + ' mins across ' + ROTATION_ACCOUNTS.length + ' accounts\x1b[0m');
    console.log('\x1b[33m  Verify Interval: ' + CONFIG.verifyCredentials.intervalMins + ' mins\x1b[0m');
    console.log('='.repeat(60) + '\n');

    // Verify proxy
    let proxyIP = null;
    if (CONFIG.proxy.enabled) {
        proxyIP = await verifyProxyIP();
        if (!proxyIP) {
            log('PROXY FAILED - Aborting', 'FATAL');
            process.exit(1);
        }
    }

    const account = getCurrentAccount();
    log(`Starting with Account #${currentAccountIndex + 1}: ${account.email}`);
    log(`City: ${CONFIG.preferences.city}`);
    log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);

    const dateRange = CONFIG.preferences.startDate.toISOString().split('T')[0] + ' to ' + CONFIG.preferences.endDate.toISOString().split('T')[0];
    sendTelegram(
        `<b>Bot Started (v3.0 Rotation)</b>\n` +
        `Account: #${currentAccountIndex + 1} / ${ROTATION_ACCOUNTS.length}\n` +
        `Email: ${CONFIG.credentials.email}\n` +
        `City: ${CONFIG.preferences.city}\n` +
        `Range: ${dateRange}\n` +
        `IP: ${proxyIP || 'Direct'}\n` +
        `Target: ${CONFIG.bot.targetCPM} CPM\n` +
        `Rotation: Every ${CONFIG.rotation.intervalMins} mins`
    );

    let browser;
    let page;
    let context;

    try {
        log('Launching browser...');

        const launchOptions = {
            headless: CONFIG.bot.headless,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-webrtc',
                '--no-sandbox'
            ]
        };

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

        const sessionUserAgent = getRandomUserAgent();
        log(`Using User-Agent: ${sessionUserAgent.substring(0, 50)}...`);

        context = await browser.newContext({
            userAgent: sessionUserAgent,
            viewport: { width: 1920, height: 1080 },
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });

        page = await context.newPage();

        setupResponseListener(page);

        await login(page);
        await navigateToAppointmentPage(page);

        sendTelegram(
            `<b>Logged In</b>\n` +
            `Account: #${currentAccountIndex + 1} (${CONFIG.credentials.email})\n` +
            `City: ${CONFIG.preferences.city}\n` +
            `Monitoring for slots...`
        );

        // Monitoring loop
        let checkCount = 0;
        const startTime = Date.now();
        let lastTelegramUpdate = Date.now();
        let lastCookieReset = Date.now();
        lastVerifyTime = Date.now();
        lastRotationTime = Date.now();

        const verifyIntervalMs = CONFIG.verifyCredentials.intervalMins * 60 * 1000;
        const cookieResetIntervalMs = 15 * 60 * 1000;

        while (true) {
            try {
                checkCount++;

                // =============================================================
                // ACCOUNT ROTATION - Every 30 minutes (configurable)
                // Creates entirely new browser context + user agent
                // =============================================================
                if (!bookingInProgress && Date.now() - lastRotationTime > rotationIntervalMs) {
                    log(`${CONFIG.rotation.intervalMins} min rotation timer - switching account + fingerprint...`, 'ROTATION');

                    const rotationResult = await performAccountRotation(browser, context);
                    if (!rotationResult.success) {
                        log('All rotation attempts failed - full restart...', 'ERROR');
                        sendTelegram(`<b>Rotation Failed</b>\nFull restart...`);
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        return runBot();
                    }

                    // Update references to new context and page
                    context = rotationResult.context;
                    page = rotationResult.page;

                    // Reset timers after rotation (new session = fresh cookies + fingerprint)
                    lastCookieReset = Date.now();
                    lastVerifyTime = Date.now();
                    lastRotationTime = Date.now();
                    continue;
                }

                // =============================================================
                // COOKIE RESET - Every 15 minutes (skip if rotation will happen sooner)
                // =============================================================
                const timeToNextRotation = rotationIntervalMs - (Date.now() - lastRotationTime);
                if (!bookingInProgress && Date.now() - lastCookieReset > cookieResetIntervalMs && timeToNextRotation > cookieResetIntervalMs) {
                    log('15 min cookie reset - clearing cookies and re-logging in...', 'INFO');
                    sendTelegram(`<b>Cookie Reset</b>\nAccount #${currentAccountIndex + 1}...`);

                    try {
                        await context.clearCookies();
                        log('Cookies cleared', 'SUCCESS');

                        await login(page);
                        await navigateToAppointmentPage(page);

                        lastCookieReset = Date.now();
                        log('Cookie reset complete - back to monitoring', 'SUCCESS');
                    } catch (cookieErr) {
                        log(`Cookie reset failed: ${cookieErr.message} - full restart...`, 'ERROR');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runBot();
                    }
                }

                // =============================================================
                // CHECK IF PAGE IS STILL ALIVE
                // =============================================================
                if (checkCount % 100 === 0) {
                    try {
                        await page.evaluate(() => true);
                    } catch (e) {
                        log('Page connection lost - restarting...', 'ERROR');
                        sendTelegram(`<b>Connection Lost</b>\nRestarting...`);
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        return runBot();
                    }
                }

                // =============================================================
                // STALE DATA VERIFICATION
                // =============================================================
                if (!bookingInProgress && Date.now() - lastVerifyTime > verifyIntervalMs) {
                    log(`${CONFIG.verifyCredentials.intervalMins} min passed - Running stale data check...`, 'SECURITY');

                    try {
                        const dataIsFresh = await verifyDataFreshness();
                        if (!dataIsFresh) {
                            log('RESTARTING due to stale data...', 'ERROR');
                            if (browser) await browser.close().catch(() => {});
                            await new Promise(r => setTimeout(r, 3000));
                            return runBot();
                        }
                    } catch (verifyErr) {
                        log(`Verification failed: ${verifyErr.message} - continuing...`, 'WARN');
                        lastVerifyTime = Date.now();
                    }
                }

                // Check for system busy
                if (!bookingInProgress && checkCount % 50 === 0) {
                    const pageText = await page.innerText('body').catch(() => '');
                    if (pageText.toLowerCase().includes('system is busy')) {
                        log('System busy - waiting 5s', 'WARN');
                        await page.waitForTimeout(5000);
                        continue;
                    }
                    if (pageText.toLowerCase().includes('sign in') || pageText.toLowerCase().includes('log in')) {
                        log('Session expired - re-logging in...', 'WARN');
                        sendTelegram(`<b>Session Expired</b>\nAccount #${currentAccountIndex + 1} - Re-logging in...`);
                        try {
                            await context.clearCookies();
                            await login(page);
                            await navigateToAppointmentPage(page);
                            lastCookieReset = Date.now();
                        } catch (reLoginErr) {
                            log(`Re-login failed: ${reLoginErr.message} - rotating account...`, 'ERROR');
                            const rotationSuccess = await performAccountRotation(page, context);
                            if (!rotationSuccess) {
                                if (browser) await browser.close().catch(() => {});
                                await new Promise(r => setTimeout(r, 5000));
                                return runBot();
                            }
                        }
                        continue;
                    }
                }

                // Fire direct API fetch
                fireDirectFetch(page);

                // Read latest result
                const slot = await readLatestDates(page);

                // Stats
                const elapsedMinutes = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsedMinutes).toFixed(1);
                const dateDisplay = availableDate ? availableDate.date : 'SEARCHING';
                const closestDisplay = closestSlotFound ? closestSlotFound.date : 'N/A';
                const nextVerifyIn = Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - lastVerifyTime)) / 60000));
                const nextRotationIn = Math.max(0, Math.ceil((rotationIntervalMs - (Date.now() - lastRotationTime)) / 60000));

                // Log every second
                if (checkCount % Math.ceil(CONFIG.bot.targetCPM / 60) === 0) {
                    const latencyDisplay = lastLatency > 0 ? lastLatency + 'ms' : '--';
                    console.log(`\x1b[44m[${cpm} CPM]\x1b[0m #${checkCount} | Acc#${currentAccountIndex + 1} | Lat: ${latencyDisplay} | Slot: ${dateDisplay} | Best: ${closestDisplay} | Verify: ${nextVerifyIn}m | Rotate: ${nextRotationIn}m`);
                }

                // INSTANT BOOKING
                if (slot && isDateInRange(slot.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                    log(`MATCH FOUND: ${slot.date} - ULTRA FAST BOOKING!`, 'SUCCESS');
                    bookingInProgress = true;

                    for (let attempt = 1; attempt <= 3; attempt++) {
                        log(`Booking attempt ${attempt}/3...`, 'INFO');
                        try {
                            const booked = await performBooking(page, slot);
                            if (booked) {
                                log('SUCCESSFULLY BOOKED!', 'SUCCESS');
                                log('STOPPING BOT - BOOKING COMPLETE', 'SUCCESS');
                                sendTelegram(`<b>Bot Stopped</b>\nBooking completed successfully!`);
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
                }

                // Telegram update every 1 min
                if (Date.now() - lastTelegramUpdate > 60000) {
                    sendTelegram(
                        `<b>Status</b>\n` +
                        `Account: #${currentAccountIndex + 1}/${ROTATION_ACCOUNTS.length} (${CONFIG.credentials.email})\n` +
                        `City: ${CONFIG.preferences.city}\n` +
                        `Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}\n` +
                        `CPM: ${cpm}\n` +
                        `Checks: ${checkCount}\n` +
                        `Current: ${dateDisplay}\n` +
                        `Best: ${closestDisplay}\n` +
                        `Next verify: ${nextVerifyIn}m\n` +
                        `Next rotation: ${nextRotationIn}m`
                    );
                    lastTelegramUpdate = Date.now();
                }

                // Delay based on target CPM
                await page.waitForTimeout(getDelay(CONFIG.bot.targetCPM));

            } catch (loopError) {
                log(`Loop error: ${loopError.message} - recovering...`, 'ERROR');
                await new Promise(r => setTimeout(r, 1000));

                if (loopError.message.includes('closed') || loopError.message.includes('Target')) {
                    log('Browser closed - restarting...', 'ERROR');
                    sendTelegram(`<b>Browser Crashed</b>\nRestarting...`);
                    if (browser) await browser.close().catch(() => {});
                    await new Promise(r => setTimeout(r, 5000));
                    return runBot();
                }
            }
        }

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        sendTelegram(`<b>Error</b>\n${error.message}`);

        if (browser) await browser.close();
        if (verifyBrowser) await verifyBrowser.close().catch(() => {});

        // If account locked, rotate before restart
        if (error.message.includes('ACCOUNT_LOCKED')) {
            log(`Account #${currentAccountIndex + 1} is LOCKED - rotating...`, 'ERROR');
            rotateAccount();
        }

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
    sendTelegram(`<b>Bot Stopped</b>\nLast active: Account #${currentAccountIndex + 1}`);
    setTimeout(() => process.exit(0), 1000);
});

process.on('uncaughtException', async (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`<b>Crash - Auto Restarting</b>\n${err.message}`);

    if (verifyBrowser) {
        await verifyBrowser.close().catch(() => {});
        verifyBrowser = null;
    }

    console.log('Auto-restarting in 10s...');
    setTimeout(() => {
        runBot();
    }, 10000);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    sendTelegram(`<b>Unhandled Error - Continuing</b>\n${String(reason).substring(0, 100)}`);
});

// Start
runBot();
