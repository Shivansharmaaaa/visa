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
let lastResponseTime = 0;
let closestSlotFound = null;
let lastRequestTime = 0;
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

                    // INSTANT TRIGGER: If date in range, log immediately
                    if (isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
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
// STALE DATA VERIFICATION SYSTEM
// ============================================================================
let verifyBrowser = null;
let lastVerifyTime = Date.now(); // Initialize to NOW so first check happens after interval
let shouldRestart = false;

async function verifyDataFreshness() {
    const hasVerifyAccount = CONFIG.verifyCredentials.email &&
                             CONFIG.verifyCredentials.email.length > 0 &&
                             CONFIG.verifyCredentials.password &&
                             CONFIG.verifyCredentials.password.length > 0;

    if (!hasVerifyAccount) {
        log(`No verification account configured (email: ${CONFIG.verifyCredentials.email || 'EMPTY'})`, 'WARN');
        lastVerifyTime = Date.now(); // Reset timer so we don't spam this message
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
            return false;
        }

        log(`✅ Data verified fresh! Both accounts see: ${mainDate || 'no dates'}`, 'SUCCESS');
        sendTelegram(`✅ <b>Data Fresh</b>\nBoth accounts see: ${mainDate || 'no dates'}`);
        return true;

    } catch (error) {
        log(`Verification error: ${error.message}`, 'ERROR');
        sendTelegram(`⚠️ <b>Verify Failed</b>\n${error.message.substring(0, 100)}\nBot continues...`);
        if (verifyBrowser) {
            await verifyBrowser.close().catch(() => {});
            verifyBrowser = null;
        }
        lastVerifyTime = Date.now(); // Reset timer so we don't spam retries
        return true; // Don't restart on verify error, continue monitoring
    }
}

// ============================================================================
// TRIGGER FRESH REQUEST (re-select city)
// ============================================================================
async function resetSelection(page) {
    try {
        // Use evaluate for faster execution - trigger change directly
        await page.evaluate(() => {
            const sel = document.querySelector('#appointments_consulate_appointment_facility_id');
            if (sel && sel.value) {
                // Just trigger change event - this calls the API
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
        lastRequestTime = Date.now();
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
// BOOKING - ULTRA FAST (API-TRIGGERED)
// ============================================================================
async function performBooking(page, slot) {
    const startTime = Date.now();

    // Send booking started notification
    sendTelegram(`🚀 <b>BOOKING STARTED!</b>\n📅 ${slot.date}\n📧 ${CONFIG.credentials.email}`);

    try {
        // Reset availableTime to capture fresh time for this date
        availableTime = null;

        // Step 1: Set date directly and trigger times API via JavaScript
        // This simulates what happens when you select a date in datepicker
        await page.evaluate((date) => {
            const dateInput = document.querySelector('#appointments_consulate_appointment_date');
            if (dateInput) {
                dateInput.value = date;
                // Trigger the change event which calls the times API
                $(dateInput).trigger('change');
                // Also trigger via native event
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, slot.date);

        // Step 2: Wait for times API response (captured by our listener)
        // No timeout - just keep checking until we get it
        while (!availableTime) {
            await page.waitForTimeout(10);
            // Also check if dropdown got populated
            const dropdownTime = await page.$eval(
                '#appointments_consulate_appointment_time option[value]:not([value=""])',
                el => el.value
            ).catch(() => null);
            if (dropdownTime) {
                availableTime = dropdownTime;
                break;
            }
        }

        // Step 3: Set time and submit immediately
        await page.evaluate((time) => {
            const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
            if (timeSelect) {
                timeSelect.value = time;
                $(timeSelect).trigger('change');
            }
            // Click submit
            document.querySelector('#appointments_submit')?.click();
        }, availableTime);

        // Step 4: Wait for page navigation (form submit)
        await page.waitForNavigation({ waitUntil: 'commit' }).catch(() => {});

        // Step 5: Click confirm button
        await page.evaluate(() => {
            const confirmBtn = document.querySelector('a.button.alert, a.button.primary, input[value="Confirm"]');
            if (confirmBtn) confirmBtn.click();
        });

        // Verify: check if we're still on the appointment form
        await page.waitForNavigation({ waitUntil: 'commit' }).catch(() => {});
        const stillOnForm = await page.$('#appointments_submit').catch(() => null);

        if (stillOnForm) {
            sendTelegram(`❌ <b>BOOKING FAILED</b>\n📅 ${slot.date}\nStill on form`);
            return false;
        }

        const elapsed = Date.now() - startTime;
        log(`🎉 BOOKED in ${elapsed}ms!`, 'SUCCESS');
        sendTelegram(`🎉 <b>BOOKED!</b>\n📅 ${slot.date}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
        return true;

    } catch (error) {
        // Check if navigation happened (means submit worked)
        const stillOnForm = await page.$('#appointments_submit').catch(() => null);
        if (!stillOnForm) {
            const elapsed = Date.now() - startTime;
            log(`🎉 BOOKED in ${elapsed}ms!`, 'SUCCESS');
            sendTelegram(`🎉 <b>BOOKED!</b>\n📅 ${slot.date}\n⏱ ${elapsed}ms\n📧 ${CONFIG.credentials.email}`);
            return true;
        }
        sendTelegram(`❌ <b>BOOKING ERROR</b>\n📅 ${slot.date}\n${error.message}`);
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
        const cookieResetIntervalMs = 15 * 60 * 1000; // Reset cookies every 15 minutes

        while (true) {
            try {
                checkCount++;

                // =====================================================
                // COOKIE RESET - Every 15 minutes to prevent stale sessions
                // =====================================================
                if (!bookingInProgress && Date.now() - lastCookieReset > cookieResetIntervalMs) {
                    log('🍪 15 min cookie reset - clearing cookies and re-logging in...', 'INFO');
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
                        log('System busy - waiting 60s', 'WARN');
                        await page.waitForTimeout(60000);
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

                // Wait for response
                const slot = await waitForAvailableSlot(100);

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
