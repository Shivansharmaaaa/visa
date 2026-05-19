
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

// ============================================================================
// GLOBAL STATE
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
        'SECURITY': '\x1b[45m',
        'DEBUG': '\x1b[43m\x1b[30m',
        'API': '\x1b[44m'
    };
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${message}\x1b[0m`);
}

// ============================================================================
// PROXY HTTP CLIENT
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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getDelay(targetCPM) {
    const overhead = 100;
    const idealCycle = 60000 / targetCPM;
    return Math.max(0, Math.floor(idealCycle - overhead));
}

// ============================================================================
// RESPONSE LISTENER - FULL DEBUG LOGGING
// ============================================================================
let requestCount = 0;

function setupResponseListener(page) {
    // Log ALL outgoing requests
    page.on('request', (request) => {
        const url = request.url();
        if (url.includes('ais.usvisa-info.com')) {
            requestCount++;
            const method = request.method();
            const headers = request.headers();
            const postData = request.postData();

            log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'API');
            log(`📤 REQUEST #${requestCount}`, 'API');
            log(`   Method: ${method}`, 'API');
            log(`   URL: ${url}`, 'API');
            log(`   Headers:`, 'DEBUG');
            for (const [key, value] of Object.entries(headers)) {
                if (['cookie', 'user-agent', 'accept', 'content-type', 'x-csrf-token', 'x-requested-with', 'referer', 'origin'].includes(key.toLowerCase())) {
                    const displayValue = key.toLowerCase() === 'cookie' ? value.substring(0, 80) + '...' : value;
                    log(`      ${key}: ${displayValue}`, 'DEBUG');
                }
            }
            if (postData) {
                log(`   Body: ${postData.substring(0, 500)}`, 'DEBUG');
            }
        }
    });

    // Log ALL responses
    page.on('response', async (response) => {
        try {
            const url = response.url();

            if (url.includes('ais.usvisa-info.com')) {
                const status = response.status();
                const statusText = response.statusText();
                const headers = response.headers();
                const timing = response.request().timing();

                log(`📥 RESPONSE`, 'API');
                log(`   Status: ${status} ${statusText}`, status >= 400 ? 'ERROR' : 'API');
                log(`   URL: ${url}`, 'API');

                // Log important response headers
                const importantHeaders = ['content-type', 'set-cookie', 'location', 'x-request-id', 'cache-control'];
                for (const h of importantHeaders) {
                    if (headers[h]) {
                        const displayValue = h === 'set-cookie' ? headers[h].substring(0, 80) + '...' : headers[h];
                        log(`      ${h}: ${displayValue}`, 'DEBUG');
                    }
                }

                // Log timing if available
                if (timing) {
                    log(`   Timing: connect=${timing.connectEnd - timing.connectStart}ms, response=${timing.responseEnd - timing.responseStart}ms`, 'DEBUG');
                }
            }

            // Capture available dates - same as main bot
            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();

                log(`🗓️  DATES API RESPONSE:`, 'SUCCESS');
                log(`   URL: ${url}`, 'SUCCESS');
                log(`   Data: ${JSON.stringify(data)}`, 'SUCCESS');

                if (data && Array.isArray(data) && data.length > 0) {
                    availableDate = data[0];
                    lastResponseTime = Date.now();
                    if (lastRequestTime > 0) {
                        lastLatency = lastResponseTime - lastRequestTime;
                    }

                    log(`   📅 First available: ${availableDate.date}`, 'SUCCESS');
                    log(`   📋 All dates returned: ${data.map(d => d.date).join(', ')}`, 'SUCCESS');

                    const slotDate = new Date(availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = availableDate;
                            log(`   🏆 New closest slot: ${closestSlotFound.date}`, 'SUCCESS');
                        }
                    }

                    const inRange = isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate);
                    log(`   🎯 In range (${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}): ${inRange ? 'YES ✅' : 'NO ❌'}`, inRange ? 'SUCCESS' : 'WARN');
                } else {
                    log(`   ❌ No dates available (empty array)`, 'WARN');
                }
            }

            // Capture available times
            if (url.includes('.json') && url.includes('date=')) {
                const data = await response.json();
                log(`⏰ TIMES API RESPONSE:`, 'SUCCESS');
                log(`   URL: ${url}`, 'SUCCESS');
                log(`   Data: ${JSON.stringify(data)}`, 'SUCCESS');

                if (data && data.available_times && data.available_times.length > 0) {
                    availableTime = data.available_times[0];
                    log(`   ⏰ Available times: ${data.available_times.join(', ')}`, 'SUCCESS');
                }
            }

        } catch (e) {
            // Ignore parsing errors
        }
    });
}

// ============================================================================
// RESET SELECTION (triggers API call)
// ============================================================================
async function resetSelection(page) {
    try {
        lastRequestTime = Date.now();
        await page.evaluate(() => {
            const sel = document.querySelector('#appointments_consulate_appointment_facility_id');
            if (sel && sel.value) {
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') {
                    $(sel).trigger('change');
                }
            }
        });
    } catch (e) {}
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

    try {
        await page.waitForSelector('input[type="submit"][value="Continue"]', { timeout: 3000 });
        await page.click('input[type="submit"][value="Continue"]');
    } catch (e) {}

    return true;
}

// ============================================================================
// MAIN - DATE CHECKER ONLY (NO BOOKING)
// ============================================================================
async function runChecker() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  DATE CHECKER - DEBUG MODE (NO BOOKING)\x1b[0m');
    console.log('\x1b[36m  Target: ' + CONFIG.bot.targetCPM + ' CPM\x1b[0m');
    console.log('\x1b[33m  Logs ALL API requests & responses\x1b[0m');
    console.log('\x1b[31m  ⚠️  NO BOOKING - MONITOR ONLY\x1b[0m');
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

    let browser;
    let page;

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

        const context = await browser.newContext({
            userAgent: sessionUserAgent,
            viewport: { width: 1920, height: 1080 },
            locale: 'en-CA',
            timezoneId: 'America/Toronto'
        });

        page = await context.newPage();

        // Setup FULL debug response listener
        setupResponseListener(page);

        // Login
        await login(page);

        // Navigate
        await navigateToAppointmentPage(page);

        sendTelegram(`🔍 <b>Date Checker Started (DEBUG)</b>\n📧 ${CONFIG.credentials.email}\n📍 ${CONFIG.preferences.city}\n⚠️ NO BOOKING`);

        log(`✅ Ready - starting monitoring loop (NO BOOKING)`, 'SUCCESS');
        log(`📋 All API requests/responses will be logged below`, 'DEBUG');
        log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, 'DEBUG');

        // Monitoring loop - NO BOOKING
        let checkCount = 0;
        const startTime = Date.now();
        const DEAD_SESSION_TIMEOUT = 60000;

        while (true) {
            try {
                checkCount++;

                // Dead session detection
                if (lastResponseTime > 0 && Date.now() - lastResponseTime > DEAD_SESSION_TIMEOUT) {
                    log(`💀 No response for ${Math.round((Date.now() - lastResponseTime) / 1000)}s - re-logging in...`, 'WARN');
                    try {
                        await login(page);
                        await navigateToAppointmentPage(page);
                        lastResponseTime = Date.now();
                        log('✅ Re-login complete', 'SUCCESS');
                    } catch (reloginErr) {
                        log(`Re-login failed: ${reloginErr.message} - full restart...`, 'ERROR');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runChecker();
                    }
                }

                // Page alive check
                if (checkCount % 100 === 0) {
                    try {
                        await page.evaluate(() => true);
                    } catch (e) {
                        log('Page connection lost - restarting...', 'ERROR');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 5000));
                        return runChecker();
                    }
                }

                // System busy / logged out check
                if (checkCount % 50 === 0) {
                    const pageText = await page.innerText('body').catch(() => '');
                    if (pageText.toLowerCase().includes('system is busy')) {
                        log('System busy - waiting 5s', 'WARN');
                        await page.waitForTimeout(5000);
                        continue;
                    }
                    if (pageText.toLowerCase().includes('sign in') || pageText.toLowerCase().includes('log in')) {
                        log('Session expired - restarting...', 'WARN');
                        if (browser) await browser.close().catch(() => {});
                        await new Promise(r => setTimeout(r, 3000));
                        return runChecker();
                    }
                }

                // Trigger fresh request
                await resetSelection(page).catch(() => {});

                // Wait for response
                const prevTime = lastResponseTime;
                let elapsed = 0;
                while (lastResponseTime === prevTime && elapsed < 100) {
                    await new Promise(r => setTimeout(r, 25));
                    elapsed += 25;
                }

                // Stats
                const elapsedMinutes = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsedMinutes).toFixed(1);
                const dateDisplay = availableDate ? availableDate.date : 'SEARCHING';
                const closestDisplay = closestSlotFound ? closestSlotFound.date : 'N/A';
                const silentSecs = lastResponseTime > 0 ? Math.round((Date.now() - lastResponseTime) / 1000) : 0;

                if (checkCount % Math.ceil(CONFIG.bot.targetCPM / 60) === 0) {
                    const latencyDisplay = lastLatency > 0 ? lastLatency + 'ms' : '--';
                    console.log(`\x1b[44m[${cpm} CPM]\x1b[0m #${checkCount} | Latency: ${latencyDisplay} | Slot: ${dateDisplay} | Best: ${closestDisplay} | Silent: ${silentSecs}s | Requests: ${requestCount}`);
                }

                // LOG when date in range is found (but DO NOT book)
                if (availableDate && isDateInRange(availableDate.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                    log(`🎯 DATE IN RANGE DETECTED: ${availableDate.date} — NOT BOOKING (debug mode)`, 'SUCCESS');
                    sendTelegram(`🔍 <b>Date Found (NO BOOK)</b>\n📅 ${availableDate.date}\n⚠️ Debug mode - not booking`);
                    // Reset so we keep logging fresh detections
                    availableDate = null;
                }

                // Delay
                await page.waitForTimeout(getDelay(CONFIG.bot.targetCPM));

            } catch (loopError) {
                log(`Loop error: ${loopError.message}`, 'ERROR');
                await new Promise(r => setTimeout(r, 1000));

                if (loopError.message.includes('closed') || loopError.message.includes('Target')) {
                    log('Browser closed - restarting...', 'ERROR');
                    if (browser) await browser.close().catch(() => {});
                    await new Promise(r => setTimeout(r, 5000));
                    return runChecker();
                }
            }
        }

    } catch (error) {
        log(`Fatal error: ${error.message}`, 'FATAL');
        if (browser) await browser.close().catch(() => {});
        await new Promise(r => setTimeout(r, 10000));
        return runChecker();
    }
}

// Start
runChecker();
