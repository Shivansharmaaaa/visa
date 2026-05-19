/**
 * US Visa Appointment Bot v3.0 - PUPPETEER VERSION
 *
 * Converted from nothang.js (Playwright) to Puppeteer
 * following the patterns from bot headless/ folder:
 * - Uses Puppeteer with anti-detection (like browser.js)
 * - Response interceptor pattern (like login.js)
 * - Request interception for header capture (like sniper.js)
 * - No Playwright dependency
 *
 * Features:
 * - Response listener to capture dates (not direct API calls)
 * - Triggers fresh requests via direct API fetch
 * - 240 CPM target with proxy support
 * - IP leak protection
 * - STALE DATA VERIFICATION every 5 min via secondary account
 */

'use strict';

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const https = require('https');
const http = require('http');
const { URL } = require('url');
require('dotenv').config();

// ============================================================================
// CONFIGURATION
// ============================================================================
console.log('Loading VERIFY_EMAIL:', process.env.VERIFY_EMAIL);
console.log('Loading VERIFY_PASSWORD:', process.env.VERIFY_PASSWORD ? '****' : 'NOT SET');

const CONFIG = {
    credentials: {
        email: process.env.VISA_EMAIL,
        password: process.env.VISA_PASSWORD
    },
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

console.log('HEADLESS env:', process.env.HEADLESS);
console.log('CONFIG.bot.headless:', CONFIG.bot.headless);

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
    }, () => {});

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

function getDelay(targetCPM) {
    const overhead = 5;
    const idealCycle = 60000 / targetCPM;
    return Math.max(0, Math.floor(idealCycle - overhead));
}

// ============================================================================
// PUPPETEER BROWSER LAUNCHER (from bot headless/src/browser.js pattern)
// ============================================================================
async function launchBrowser(opts = {}) {
    const {
        headless = false,
        proxyServer = null,
        userAgent = getRandomUserAgent(),
        viewport = { width: 1920, height: 1080 },
        extraArgs = []
    } = opts;

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-webrtc',
        ...extraArgs
    ];

    if (proxyServer) {
        args.push(`--proxy-server=${proxyServer}`);
    }

    const launchOpts = {
        headless,
        args,
        ignoreDefaultArgs: ['--enable-automation'],
        defaultViewport: viewport
    };

    // Use installed Chrome when not headless (better anti-detection)
    if (!headless) {
        launchOpts.channel = 'chrome';
    }

    const browser = await puppeteer.launch(launchOpts);
    const page = await browser.newPage();

    // Anti-detection: hide webdriver flag (from bot headless/src/browser.js)
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    await page.setUserAgent(userAgent);

    return { browser, page };
}

// ============================================================================
// RESPONSE LISTENER (KEY - INSTANT DETECTION)
// Puppeteer version using page.on('response') like bot headless/src/login.js
// ============================================================================
let bookingInProgress = false;
let pageRef = null;

function setupResponseListener(page) {
    pageRef = page;

    page.on('response', async (response) => {
        try {
            const url = response.url();

            // Capture available dates - INSTANT DETECTION
            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                let data;
                try { data = await response.json(); } catch (_) { return; }

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

            // Capture available times - store immediately
            if (url.includes('.json') && url.includes('date=')) {
                let data;
                try { data = await response.json(); } catch (_) { return; }

                if (data && data.available_times && data.available_times.length > 0) {
                    availableTime = data.available_times[0];
                    log(`Time captured: ${availableTime}`, 'INFO');
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
// STALE DATA VERIFICATION SYSTEM (Puppeteer version)
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
        log(`No verification account configured (email: ${CONFIG.verifyCredentials.email || 'EMPTY'})`, 'WARN');
        lastVerifyTime = Date.now();
        return true;
    }

    log('VERIFYING DATA FRESHNESS with secondary account...', 'SECURITY');

    let verifyPage = null;
    let capturedVerifyDate = null;

    try {
        // Generate separate proxy session for verification
        const verifySessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
        let verifyProxyServer = null;
        let verifyProxyUsername = null;
        let verifyProxyPassword = null;

        if (CONFIG.proxy.enabled) {
            verifyProxyUsername = CONFIG.proxy.username.replace(/sessid-\d+/, `sessid-${verifySessionId}`);
            verifyProxyPassword = CONFIG.proxy.password;
            verifyProxyServer = `http://${CONFIG.proxy.server}`;
            log(`Using separate proxy session for verify: sessid-${verifySessionId}`, 'INFO');
        }

        // Launch separate headless browser for verification
        const result = await launchBrowser({
            headless: true,
            proxyServer: verifyProxyServer,
            userAgent: getRandomUserAgent(),
            viewport: { width: 1920, height: 1080 }
        });

        verifyBrowser = result.browser;
        verifyPage = result.page;

        // Authenticate proxy if needed (Puppeteer pattern from bot headless/src/browser.js)
        if (CONFIG.proxy.enabled && verifyProxyUsername && verifyProxyPassword) {
            await verifyPage.authenticate({
                username: verifyProxyUsername,
                password: verifyProxyPassword
            });
        }

        // Set up response listener for verification page
        verifyPage.on('response', async (response) => {
            try {
                const url = response.url();
                if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                    let data;
                    try { data = await response.json(); } catch (_) { return; }
                    if (data && Array.isArray(data) && data.length > 0) {
                        capturedVerifyDate = data[0];
                        log(`Verify account sees: ${capturedVerifyDate.date}`, 'INFO');
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

        // Puppeteer: click + type instead of fill
        await verifyPage.click('#user_email');
        await verifyPage.type('#user_email', CONFIG.verifyCredentials.email, { delay: 30 });
        await verifyPage.click('#user_password');
        await verifyPage.type('#user_password', CONFIG.verifyCredentials.password, { delay: 30 });

        // Checkbox
        try {
            await verifyPage.click('label[for="policy_confirmed"]');
        } catch (e) {
            try {
                await verifyPage.evaluate(() => {
                    const cb = document.querySelector('#policy_confirmed');
                    if (cb) cb.click();
                });
            } catch (_) {}
        }

        const verifyNav = verifyPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await verifyPage.click('input[type="submit"]');
        await verifyNav;

        if (verifyPage.url().includes('sign_in')) {
            log('Verification account login failed', 'ERROR');
            await verifyBrowser.close();
            return true;
        }

        log('Verification account logged in', 'SUCCESS');

        // Navigate to appointment page
        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
        await verifyPage.waitForSelector(continueBtn, { timeout: 15000 });
        await verifyPage.click(continueBtn);
        await new Promise(r => setTimeout(r, 2000));

        const currentUrl = verifyPage.url();
        const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
        await verifyPage.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Select city (Puppeteer: page.select instead of page.selectOption)
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        await verifyPage.waitForSelector(facilitySelector, { timeout: 10000 });

        const options = await verifyPage.$$eval(`${facilitySelector} option`, opts =>
            opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );

        const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
        if (target) {
            await verifyPage.select(facilitySelector, target.value);
        }

        // Wait for response
        await new Promise(r => setTimeout(r, 3000));

        // Compare dates
        const mainDate = availableDate ? availableDate.date : null;
        const verifyDate = capturedVerifyDate ? capturedVerifyDate.date : null;

        log(`COMPARISON: Main=${mainDate} | Verify=${verifyDate}`, 'INFO');

        await verifyBrowser.close();
        verifyBrowser = null;
        lastVerifyTime = Date.now();

        if (mainDate && verifyDate && mainDate !== verifyDate) {
            log(`STALE DATA DETECTED! Main: ${mainDate} vs Verify: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `<b>STALE DATA DETECTED!</b>\n` +
                `Main account: ${mainDate}\n` +
                `Verify account: ${verifyDate}\n` +
                `Restarting main session...`
            );
            return false;
        }

        if (!mainDate && verifyDate) {
            log(`STALE DATA: Main has no date, Verify sees: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `<b>STALE DATA!</b>\n` +
                `Main: No dates\n` +
                `Verify: ${verifyDate}\n` +
                `Restarting...`
            );
            return false;
        }

        log(`Data verified fresh! Both accounts see: ${mainDate || 'no dates'}`, 'SUCCESS');
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
// DIRECT API FETCH - Fire-and-forget via page.evaluate
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

// Read latest dates from browser (non-blocking)
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
// LOGIN (Puppeteer version - click + type instead of fill)
// ============================================================================
async function login(page) {
    log('Attempting login...');

    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });

    // Check for system busy
    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (pageText.toLowerCase().includes('system is busy') ||
        pageText.toLowerCase().includes('too many requests')) {
        throw new Error('SYSTEM_BUSY');
    }

    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    // Puppeteer: clear and type (no page.fill)
    await page.click('#user_email');
    await page.evaluate(() => { document.querySelector('#user_email').value = ''; });
    await page.type('#user_email', CONFIG.credentials.email, { delay: 50 });

    await page.click('#user_password');
    await page.evaluate(() => { document.querySelector('#user_password').value = ''; });
    await page.type('#user_password', CONFIG.credentials.password, { delay: 50 });

    // Checkbox
    try {
        await page.click('label[for="policy_confirmed"]');
    } catch (e) {
        try {
            await page.evaluate(() => {
                const cb = document.querySelector('#policy_confirmed');
                if (cb) cb.click();
            });
        } catch (_) {}
    }

    // Puppeteer: set up navigation promise BEFORE clicking submit
    // (unlike Playwright, Puppeteer needs this order or it misses the nav)
    const navPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.click('input[type="submit"]');
    await navPromise;

    log(`Post-submit URL: ${page.url()}`, 'INFO');

    // Handle error modal if we're still on sign_in
    if (page.url().includes('sign_in')) {
        try {
            const buttons = await page.$$('button');
            for (const btn of buttons) {
                const btnText = await page.evaluate(el => el.textContent, btn);
                if (/OK/i.test(btnText)) {
                    log('Clicking OK on error modal...', 'INFO');
                    await btn.click();
                    await new Promise(r => setTimeout(r, 500));
                    try { await page.click('.icheckbox'); } catch (_) {}
                    const nav2 = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                    await page.click('input[type="submit"]');
                    await nav2;
                    break;
                }
            }
        } catch (e) {}
    }

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

    await new Promise(r => setTimeout(r, 2000));

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');

    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Select city (Puppeteer: page.select instead of page.selectOption)
    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    const options = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
    );

    const target = options.find(o => o.text.toLowerCase().includes(CONFIG.preferences.city.toLowerCase()));
    if (target) {
        await page.select(facilitySelector, target.value);
        log(`Selected city: ${target.text}`);
    }

    // Extract scheduleId, facilityId, csrfToken
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
// BOOKING - ULTRA FAST API APPROACH (NO UI, PURE API)
// ============================================================================
async function performBooking(page, slot) {
    const startTime = Date.now();
    let capturedTime = null;

    sendTelegram(`<b>BOOKING STARTED!</b>\n${slot.date}\n${CONFIG.preferences.city}\n${CONFIG.credentials.email}`);

    try {
        // Get IDs from URL and form
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
            log(`Missing IDs`, 'ERROR');
            return false;
        }

        // Fetch times via API with timeout
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

        // Set date + time + submit ALL AT ONCE via evaluate
        try {
            await page.evaluate(({ date, time }) => {
                const dateInput = document.querySelector('#appointments_consulate_appointment_date');
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));

                if (typeof $ !== 'undefined') {
                    $(dateInput).trigger('change');
                }

                const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
                if (!timeSelect.querySelector(`option[value="${time}"]`)) {
                    const opt = document.createElement('option');
                    opt.value = time;
                    opt.text = time;
                    timeSelect.appendChild(opt);
                }
                timeSelect.value = time;
                timeSelect.dispatchEvent(new Event('change', { bubbles: true }));

                if (typeof $ !== 'undefined') {
                    $(timeSelect).trigger('change');
                }

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
            // "context destroyed" / "Execution context" = navigation = SUCCESS
            if (e.message.includes('context') || e.message.includes('destroyed') || e.message.includes('Execution')) {
                log(`Navigation detected`, 'SUCCESS');
            } else {
                throw e;
            }
        }

        // Wait for confirm button
        try {
            await page.waitForSelector('a.button.alert', { timeout: 3000 });
        } catch (e) {
            log(`Confirm button wait timeout`, 'WARN');
        }

        // Click confirm button
        try {
            const confirmBtn = await page.$('a.button.alert') || await page.$('input[value="Confirm"]');
            if (confirmBtn) {
                await confirmBtn.click();
                log(`Confirm clicked`, 'SUCCESS');
            }
        } catch (e) {
            if (e.message.includes('context') || e.message.includes('destroyed') || e.message.includes('Execution')) {
                log(`Confirm navigation detected`, 'SUCCESS');
            }
        }

        const elapsed = Date.now() - startTime;
        log(`BOOKED in ${elapsed}ms!`, 'SUCCESS');
        sendTelegram(`<b>BOOKED!</b>\n${slot.date}\n${capturedTime}\n${elapsed}ms\n${CONFIG.credentials.email}`);
        return true;

    } catch (error) {
        if (error.message.includes('context') || error.message.includes('destroyed') || error.message.includes('Execution')) {
            const elapsed = Date.now() - startTime;
            log(`Likely BOOKED in ${elapsed}ms!`, 'SUCCESS');
            sendTelegram(`<b>LIKELY BOOKED!</b>\n${slot.date}\n${elapsed}ms\n${CONFIG.credentials.email}`);
            return true;
        }

        log(`Error: ${error.message}`, 'ERROR');
        return false;
    }
}

// ============================================================================
// COOKIE CLEARING (Puppeteer version)
// ============================================================================
async function clearCookies(page) {
    const client = await page.target().createCDPSession();
    await client.send('Network.clearBrowserCookies');
    await client.detach();
}

// ============================================================================
// MAIN BOT
// ============================================================================
async function runBot() {
    console.log('\n' + '='.repeat(60));
    console.log('\x1b[32m  VISA BOT v3.0 - PUPPETEER + STALE DATA PROTECTION\x1b[0m');
    console.log('\x1b[36m  Target: ' + CONFIG.bot.targetCPM + ' CPM\x1b[0m');
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

    log(`Email: ${CONFIG.credentials.email}`);
    log(`City: ${CONFIG.preferences.city}`);
    log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);

    const dateRange = CONFIG.preferences.startDate.toISOString().split('T')[0] + ' to ' + CONFIG.preferences.endDate.toISOString().split('T')[0];
    sendTelegram(
        `<b>Bot Started (Puppeteer)</b>\n` +
        `${CONFIG.credentials.email}\n` +
        `${CONFIG.preferences.city}\n` +
        `Range: ${dateRange}\n` +
        `IP: ${proxyIP || 'Direct'}\n` +
        `Target: ${CONFIG.bot.targetCPM} CPM`
    );

    let browser;
    let page;

    try {
        // Launch browser using bot headless pattern
        log('Launching Puppeteer browser...');

        const proxyServer = CONFIG.proxy.enabled ? `http://${CONFIG.proxy.server}` : null;
        const sessionUserAgent = getRandomUserAgent();
        log(`Using User-Agent: ${sessionUserAgent.substring(0, 50)}...`);

        const result = await launchBrowser({
            headless: CONFIG.bot.headless,
            proxyServer: proxyServer,
            userAgent: sessionUserAgent,
            viewport: { width: 1920, height: 1080 }
        });

        browser = result.browser;
        page = result.page;

        // Authenticate proxy if needed (Puppeteer pattern)
        if (CONFIG.proxy.enabled && CONFIG.proxy.username && CONFIG.proxy.password) {
            await page.authenticate({
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            });
        }

        // Setup response listener (KEY!)
        setupResponseListener(page);

        // Login
        await login(page);

        // Navigate
        await navigateToAppointmentPage(page);

        sendTelegram(`<b>Logged In</b>\n${CONFIG.credentials.email}\n${CONFIG.preferences.city}\nMonitoring for slots...`);

        // Monitoring loop
        let checkCount = 0;
        const startTime = Date.now();
        let lastTelegramUpdate = Date.now();
        let lastCookieReset = Date.now();
        lastVerifyTime = Date.now();

        const verifyIntervalMs = CONFIG.verifyCredentials.intervalMins * 60 * 1000;
        const cookieResetIntervalMs = 15 * 60 * 1000;

        while (true) {
            try {
                checkCount++;

                // =====================================================
                // COOKIE RESET - Every 15 minutes
                // =====================================================
                if (!bookingInProgress && Date.now() - lastCookieReset > cookieResetIntervalMs) {
                    log('15 min cookie reset - clearing cookies and re-logging in...', 'INFO');
                    sendTelegram(`<b>Cookie Reset</b>\nClearing cookies for fresh session...`);

                    try {
                        await clearCookies(page);
                        log('Cookies cleared', 'SUCCESS');

                        await login(page);
                        await navigateToAppointmentPage(page);

                        lastCookieReset = Date.now();
                        log('Cookie reset complete - back to monitoring', 'SUCCESS');
                        sendTelegram(`<b>Cookie Reset Complete</b>\nBack to monitoring...`);
                    } catch (cookieErr) {
                        log(`Cookie reset failed: ${cookieErr.message} - full restart...`, 'ERROR');
                        sendTelegram(`<b>Cookie Reset Failed</b>\nFull restart...`);
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
                        sendTelegram(`<b>Connection Lost</b>\nRestarting...`);
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        return runBot();
                    }
                }

                // =====================================================
                // STALE DATA VERIFICATION - Every X minutes
                // =====================================================
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

                // Check for system busy - SKIP if booking in progress
                if (!bookingInProgress && checkCount % 50 === 0) {
                    const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');
                    if (pageText.toLowerCase().includes('system is busy')) {
                        log('System busy - waiting 5s', 'WARN');
                        await new Promise(r => setTimeout(r, 5000));
                        continue;
                    }
                    if (pageText.toLowerCase().includes('sign in') || pageText.toLowerCase().includes('log in')) {
                        log('Session expired - restarting...', 'WARN');
                        sendTelegram(`<b>Session Expired</b>\nRe-logging in...`);
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
                const nextVerifyIn = Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - lastVerifyTime)) / 60000));
                const nextCookieReset = Math.max(0, Math.ceil((cookieResetIntervalMs - (Date.now() - lastCookieReset)) / 60000));

                // Log every second
                if (checkCount % Math.ceil(CONFIG.bot.targetCPM / 60) === 0) {
                    const latencyDisplay = lastLatency > 0 ? lastLatency + 'ms' : '--';
                    console.log(`\x1b[44m[${cpm} CPM]\x1b[0m #${checkCount} | Latency: ${latencyDisplay} | Slot: ${dateDisplay} | Best: ${closestDisplay} | Verify: ${nextVerifyIn}m | Cookie: ${nextCookieReset}m`);
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
                                log(`SUCCESSFULLY BOOKED!`, 'SUCCESS');
                                log(`STOPPING BOT - BOOKING COMPLETE`, 'SUCCESS');
                                sendTelegram(`<b>Bot Stopped</b>\nBooking completed successfully!`);
                                if (browser) await browser.close().catch(() => {});
                                if (verifyBrowser) await verifyBrowser.close().catch(() => {});
                                process.exit(0);
                            }
                        } catch (bookErr) {
                            log(`Booking attempt failed: ${bookErr.message}`, 'ERROR');
                        }
                        await new Promise(r => setTimeout(r, 50));
                    }
                    bookingInProgress = false;
                }

                // Telegram update every 1 min
                if (Date.now() - lastTelegramUpdate > 60000) {
                    sendTelegram(
                        `<b>Status</b>\n` +
                        `${CONFIG.credentials.email}\n` +
                        `${CONFIG.preferences.city}\n` +
                        `Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}\n` +
                        `${cpm} CPM\n` +
                        `${checkCount} checks\n` +
                        `Current: ${dateDisplay}\n` +
                        `Best: ${closestDisplay}\n` +
                        `Next verify: ${nextVerifyIn}m`
                    );
                    lastTelegramUpdate = Date.now();
                }

                // Delay based on target CPM (Puppeteer: setTimeout instead of waitForTimeout)
                await new Promise(r => setTimeout(r, getDelay(CONFIG.bot.targetCPM)));

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
    sendTelegram('<b>Bot Stopped</b>');
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
