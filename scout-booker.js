/**
 * SCOUT + BOOKING ARMY Strategy
 *
 * Architecture:
 * - 1 SCOUT account: High CPM (300+ req/min), only detects dates
 * - 4 BOOKER accounts: Human-like (1 check per 30s), kept warm
 * - When scout detects date in range: ALL bookers race to book simultaneously
 *
 * Theory: Website tracks request frequency per session. High-activity accounts
 * get throttled for booking. By keeping booker accounts "clean" with human-like
 * activity, they have better booking success.
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    // Scout account (first account - high CPM checking)
    scout: {
        email: process.env.SCOUT_EMAIL || process.env.ACCOUNT_1_EMAIL,
        password: process.env.SCOUT_PASSWORD || process.env.ACCOUNT_1_PASSWORD,
        targetCPM: parseInt(process.env.SCOUT_CPM) || 300
    },

    // Booker accounts (human-like, kept warm for booking)
    bookers: [],

    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
        city: process.env.PREFERRED_CITY || 'Ottawa',
        facilityId: process.env.FACILITY_ID || '92',
        startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
        endDate: new Date(process.env.END_DATE || '2026-05-30'),
        bookerCheckIntervalSec: parseInt(process.env.BOOKER_CHECK_INTERVAL) || 30
    },

    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    },

    // Proxy configuration
    proxy: {
        enabled: process.env.PROXY_ENABLED === 'true',
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD,
        // If true, bookers also use proxy (for when your IP is blocked)
        bookersUseProxy: process.env.BOOKERS_USE_PROXY === 'true'
    },

    // Verification account for stale data detection
    verify: {
        email: process.env.VERIFY_EMAIL || '',
        password: process.env.VERIFY_PASSWORD || '',
        intervalMins: parseInt(process.env.VERIFY_INTERVAL_MINS) || 7
    },

    // Timings
    timings: {
        telegramUpdateMins: parseInt(process.env.TELEGRAM_UPDATE_MINS) || 5,
        cookieResetMins: parseInt(process.env.COOKIE_RESET_MINS) || 23
    },

    bot: {
        headless: process.env.HEADLESS === 'true'
    }
};

// Load booker accounts (ACCOUNT_2 through ACCOUNT_10, or BOOKER_1 through BOOKER_10)
for (let i = 2; i <= 10; i++) {
    const email = process.env[`BOOKER_${i-1}_EMAIL`] || process.env[`ACCOUNT_${i}_EMAIL`];
    const password = process.env[`BOOKER_${i-1}_PASSWORD`] || process.env[`ACCOUNT_${i}_PASSWORD`];
    if (email && password) {
        CONFIG.bookers.push({ email, password });
    }
}

// ============================================================================
// RANDOM USER AGENTS (different for each session)
// ============================================================================
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

// Track which user agents are used to avoid duplicates
const usedUserAgents = new Set();

function getUniqueUserAgent() {
    const available = USER_AGENTS.filter(ua => !usedUserAgents.has(ua));
    if (available.length === 0) {
        // All used, reset and pick random
        usedUserAgents.clear();
        const ua = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        usedUserAgents.add(ua);
        return ua;
    }
    const ua = available[Math.floor(Math.random() * available.length)];
    usedUserAgents.add(ua);
    return ua;
}

// ============================================================================
// GLOBAL STATE
// ============================================================================
let scoutSession = null;           // Scout browser session
let bookerSessions = [];           // Array of booker sessions
let bookingInProgress = false;
let bookingTriggered = false;      // Signal from scout to bookers
let targetBookingDate = null;      // Date to book when triggered
let totalScoutChecks = 0;
let scoutAvailableDate = null;
let closestSlotFound = null;
let startTime = Date.now();

// Timing trackers
let lastTelegramUpdate = Date.now();
let lastVerifyTime = Date.now();
let lastCookieReset = Date.now();

// SINGLETON LOCKS - prevent multiple instances
let isRunning = false;
let isVerifying = false;
let isRestarting = false;

// ============================================================================
// LOGGING
// ============================================================================
function log(message, level = 'INFO') {
    const ts = new Date().toLocaleTimeString();
    const colors = {
        'INFO': '\x1b[36m',
        'SUCCESS': '\x1b[32m',
        'WARN': '\x1b[33m',
        'ERROR': '\x1b[31m',
        'SCOUT': '\x1b[44m',
        'BOOKER': '\x1b[45m',
        'BOOK': '\x1b[42m\x1b[30m'
    };
    console.log(`${colors[level] || ''}[${ts}] [${level}] ${message}\x1b[0m`);
}

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
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
    }, () => {});
    req.on('error', () => {});
    req.write(postData);
    req.end();
}

// ============================================================================
// UTILITIES
// ============================================================================
function isDateInRange(dateStr) {
    const date = new Date(dateStr);
    return date >= CONFIG.preferences.startDate && date <= CONFIG.preferences.endDate;
}

function getDelay(targetCPM) {
    // For 500 CPM: 60000/500 = 120ms between checks
    // triggerDateCheck is nearly instant, so use full delay
    return Math.floor(60000 / targetCPM);
}

// ============================================================================
// CREATE SESSION (Login + Navigate to Appointment Page)
// ============================================================================
async function createSession(account, role, useProxy = false) {
    const accountName = account.email.split('@')[0];
    log(`[${role}] Logging in: ${accountName}...`, role === 'SCOUT' ? 'SCOUT' : 'BOOKER');

    const userAgent = getUniqueUserAgent();
    log(`[${role}] User-Agent: ${userAgent.substring(0, 50)}...`, 'INFO');

    const launchOptions = {
        headless: CONFIG.bot.headless,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-webrtc',
            '--no-sandbox'
        ]
    };

    // Use system Chrome if available (better anti-detection), otherwise use bundled Chromium
    // launchOptions.channel = 'chrome';  // Uncomment if you have Chrome installed

    // Apply proxy only if requested (Scout uses proxy, Bookers optionally)
    if (useProxy && CONFIG.proxy.enabled && CONFIG.proxy.server) {
        // Generate unique session ID for each browser to avoid conflicts
        const sessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
        const proxyUsername = CONFIG.proxy.username.replace(/sessid-\d+/, `sessid-${sessionId}`);

        launchOptions.proxy = {
            server: `http://${CONFIG.proxy.server}`,
            username: proxyUsername,
            password: CONFIG.proxy.password
        };
        log(`[${role}] Using PROXY: ${CONFIG.proxy.server} (session: ${sessionId.slice(-6)})`, 'INFO');
    } else {
        log(`[${role}] Running DIRECT (no proxy)`, 'INFO');
    }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
        userAgent: userAgent,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-CA',
        timezoneId: 'America/Toronto'
    });

    const page = await context.newPage();

    // Login
    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });
    await page.fill('#user_email', account.email);
    await page.fill('#user_password', account.password);

    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await page.click('input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (page.url().includes('sign_in')) {
        await browser.close();
        throw new Error('LOGIN_FAILED');
    }

    // Navigate to appointment page
    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 20000 });
    await page.click(continueBtn);
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const scheduleId = currentUrl.match(/schedule\/(\d+)/)?.[1];
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');

    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Select facility
    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });
    await page.selectOption(facilitySelector, CONFIG.preferences.facilityId);
    await page.waitForTimeout(1000);

    // Get CSRF token
    const csrfToken = await page.evaluate(() => {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    });

    const session = {
        email: account.email,
        role,
        browser,
        context,
        page,
        scheduleId,
        facilityId: CONFIG.preferences.facilityId,
        csrfToken,
        userAgent,
        availableDate: null,
        lastCheck: Date.now(),
        checkCount: 0
    };

    log(`[${role}] ✅ Logged in: ${accountName} (Schedule: ${scheduleId})`, 'SUCCESS');

    return session;
}

// ============================================================================
// SCOUT: Response Listener (captures dates instantly)
// ============================================================================
function setupScoutResponseListener(session) {
    session.page.on('response', async (response) => {
        try {
            const url = response.url();

            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    scoutAvailableDate = data[0];
                    session.availableDate = data[0];

                    // Track closest slot
                    const slotDate = new Date(scoutAvailableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = scoutAvailableDate;
                            log(`[SCOUT] 📅 New closest: ${closestSlotFound.date}`, 'SUCCESS');
                        }
                    }

                    // CHECK IF IN RANGE - TRIGGER BOOKING!
                    if (!bookingInProgress && !bookingTriggered && isDateInRange(scoutAvailableDate.date)) {
                        log(`[SCOUT] 🚨 DATE IN RANGE: ${scoutAvailableDate.date} - TRIGGERING BOOKERS!`, 'BOOK');
                        bookingTriggered = true;
                        targetBookingDate = scoutAvailableDate.date;

                        sendTelegram(
                            `🚨 <b>DATE DETECTED!</b>\n` +
                            `📅 ${scoutAvailableDate.date}\n` +
                            `🚀 Triggering ${bookerSessions.length} bookers!`
                        );
                    }
                }
            }
        } catch (e) {}
    });
}

// ============================================================================
// TRIGGER DATE CHECK (re-select facility)
// ============================================================================
async function triggerDateCheck(session) {
    try {
        await session.page.evaluate(() => {
            const sel = document.querySelector('#appointments_consulate_appointment_facility_id');
            if (sel && sel.value) {
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(sel).trigger('change');
            }
        });
        session.lastCheck = Date.now();
        session.checkCount++;
    } catch (e) {
        throw new Error('PAGE_DEAD');
    }
}

// ============================================================================
// BOOKING (for booker accounts)
// ============================================================================
async function performBooking(session, date) {
    const startMs = Date.now();
    const page = session.page;
    const accountName = session.email.split('@')[0];

    log(`[BOOKER] ⚡ ${accountName} booking: ${date}`, 'BOOK');

    try {
        const scheduleId = session.scheduleId;
        const facilityId = session.facilityId;

        // IMPORTANT: Make sure we're on the appointment page first
        const currentUrl = page.url();
        if (!currentUrl.includes('/appointment') || currentUrl.includes('instructions')) {
            log(`[BOOKER] ${accountName} navigating to appointment page...`, 'INFO');
            await page.goto(`${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000
            });
            // Wait for and select facility
            await page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });
            await page.selectOption('#appointments_consulate_appointment_facility_id', facilityId);
            await page.waitForTimeout(500);
        }

        // Get fresh CSRF token
        const csrf = await page.evaluate(() => {
            return document.querySelector('meta[name="csrf-token"]')?.content || '';
        });

        if (!scheduleId || !facilityId || !csrf) {
            return { success: false, error: 'Missing IDs', session };
        }

        // Step 1: Get available times (with 60 second timeout + race condition)
        const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`;

        const TIME_FETCH_TIMEOUT = 60000; // 60 seconds

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('TIMEOUT')), TIME_FETCH_TIMEOUT);
        });

        const fetchPromise = page.evaluate(async ({ url, csrf }) => {
            try {
                const resp = await fetch(url, {
                    method: 'GET',
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest',
                        'X-CSRF-Token': csrf
                    }
                });
                if (!resp.ok) return { error: `HTTP ${resp.status}` };
                const data = await resp.json();
                return { time: data.available_times?.[0] || null };
            } catch (e) {
                return { error: e.message };
            }
        }, { url: timesUrl, csrf });

        let timeResult;
        try {
            timeResult = await Promise.race([fetchPromise, timeoutPromise]);
        } catch (e) {
            if (e.message === 'TIMEOUT') {
                log(`[BOOKER] ${accountName} ⏱️ Time fetch TIMEOUT (60s)`, 'ERROR');
                return { success: false, error: 'Time fetch timeout (60s)', session };
            }
            return { success: false, error: e.message, session };
        }

        if (timeResult.error) {
            return { success: false, error: `Times: ${timeResult.error}`, session };
        }

        if (!timeResult.time) {
            return { success: false, error: 'No times available', session };
        }

        const time = timeResult.time;
        log(`[BOOKER] ${accountName} got time: ${time}`, 'SUCCESS');

        // Step 2: Wait for form elements, then fill and submit
        try {
            // Wait for date input to exist
            await page.waitForSelector('#appointments_consulate_appointment_date', { timeout: 5000 });

            await page.evaluate(({ date, time }) => {
                const dateInput = document.querySelector('#appointments_consulate_appointment_date');
                if (!dateInput) throw new Error('Date input not found');

                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(dateInput).trigger('change');

                const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
                if (timeSelect) {
                    if (!timeSelect.querySelector(`option[value="${time}"]`)) {
                        const opt = document.createElement('option');
                        opt.value = time;
                        opt.text = time;
                        timeSelect.appendChild(opt);
                    }
                    timeSelect.value = time;
                    timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
                    if (typeof $ !== 'undefined') $(timeSelect).trigger('change');
                }
            }, { date, time });

            // Click submit button
            const submitBtn = await page.$('#appointments_submit');
            if (submitBtn) {
                await submitBtn.click();
            } else {
                await page.evaluate(() => {
                    const form = document.querySelector('form#appointment-form') ||
                                 document.querySelector('form[action*="appointment"]');
                    if (form) form.submit();
                });
            }
        } catch (e) {
            if (!e.message.includes('context') && !e.message.includes('destroyed')) {
                return { success: false, error: `Form: ${e.message}`, session };
            }
        }

        // Step 3: Wait and check result
        await page.waitForTimeout(3000);

        let pageUrl = page.url();
        let pageContent = await page.content().catch(() => '');

        if (pageUrl.includes('instructions') ||
            pageContent.includes('Successfully') ||
            pageContent.includes('Your appointment') ||
            pageContent.includes('has been scheduled')) {
            const elapsed = Date.now() - startMs;
            log(`[BOOKER] ${accountName} ✅ BOOKED!`, 'SUCCESS');
            return { success: true, elapsed, time, session };
        }

        // Try clicking confirm button - try multiple selectors
        const confirmSelectors = ['a.button.alert', 'a[href*="confirm"]', 'input[value="Confirm"]'];
        for (const selector of confirmSelectors) {
            try {
                const confirmBtn = await page.$(selector);
                if (confirmBtn) {
                    log(`[BOOKER] ${accountName} clicking confirm...`, 'INFO');
                    await confirmBtn.click();
                    await page.waitForTimeout(3000);

                    pageUrl = page.url();
                    pageContent = await page.content().catch(() => '');

                    if (pageUrl.includes('instructions') ||
                        pageContent.includes('Successfully') ||
                        pageContent.includes('Your appointment') ||
                        pageContent.includes('has been scheduled') ||
                        pageContent.includes('Appointment Confirmation')) {
                        const elapsed = Date.now() - startMs;
                        log(`[BOOKER] ${accountName} ✅ CONFIRMED!`, 'SUCCESS');
                        return { success: true, elapsed, time, session };
                    }
                    break;
                }
            } catch (e) {}
        }

        return { success: false, error: 'Booking not confirmed', session };

    } catch (error) {
        return { success: false, error: error.message, session };
    }
}

// ============================================================================
// PARALLEL BOOKING (all bookers race)
// ============================================================================
async function triggerParallelBooking(date) {
    if (bookingInProgress) return;
    bookingInProgress = true;

    log(`🚀 PARALLEL BOOKING: ${date} with ${bookerSessions.length} bookers!`, 'BOOK');

    // Fire ALL bookers simultaneously
    const bookingPromises = bookerSessions.map(session =>
        performBooking(session, date).catch(err => ({ success: false, error: err.message, session }))
    );

    const results = await Promise.all(bookingPromises);
    const winner = results.find(r => r.success);

    if (winner) {
        const accountName = winner.session.email.split('@')[0];
        log(`🎉 BOOKED by ${accountName} in ${winner.elapsed}ms!`, 'SUCCESS');
        sendTelegram(
            `🎉 <b>BOOKED!</b>\n` +
            `📅 ${date}\n` +
            `⏰ ${winner.time}\n` +
            `⏱ ${winner.elapsed}ms\n` +
            `📧 ${accountName}`
        );
        process.exit(0);
    } else {
        log(`❌ All ${bookerSessions.length} bookers failed`, 'ERROR');
        results.forEach(r => {
            const name = r.session.email.split('@')[0];
            log(`  - ${name}: ${r.error}`, 'ERROR');
        });

        // Reset for retry
        bookingTriggered = false;
        bookingInProgress = false;
        targetBookingDate = null;
    }
}

// ============================================================================
// STALE DATA VERIFICATION
// ============================================================================
async function verifyDataFreshness() {
    // MUTEX - prevent multiple verifications
    if (isVerifying) {
        log('Verification already in progress, skipping', 'WARN');
        return true;
    }

    if (!CONFIG.verify.email || !CONFIG.verify.password) {
        log('No verify account configured, skipping verify', 'WARN');
        return true;
    }

    isVerifying = true;
    log('🔍 VERIFYING DATA FRESHNESS with verify account...', 'INFO');
    sendTelegram(`🔍 <b>Verifying...</b>\nChecking for stale data`);

    let verifyBrowser = null;
    let capturedVerifyDate = null;

    try {
        const launchOptions = {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
        };

        verifyBrowser = await chromium.launch(launchOptions);
        const context = await verifyBrowser.newContext({
            userAgent: getUniqueUserAgent(),
            viewport: { width: 1920, height: 1080 }
        });

        const verifyPage = await context.newPage();

        // Response listener for verify page
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

        // Login
        await verifyPage.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await verifyPage.waitForSelector('#user_email', { timeout: 15000 });
        await verifyPage.fill('#user_email', CONFIG.verify.email);
        await verifyPage.fill('#user_password', CONFIG.verify.password);

        try {
            await verifyPage.click('label[for="policy_confirmed"]', { timeout: 2000 });
        } catch {
            await verifyPage.click('#policy_confirmed', { force: true }).catch(() => {});
        }

        await verifyPage.click('input[type="submit"]');
        await verifyPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        if (verifyPage.url().includes('sign_in')) {
            log('Verify account login failed', 'ERROR');
            await verifyBrowser.close();
            return true;
        }

        log('Verify account logged in', 'SUCCESS');

        // Navigate to appointment page
        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
        await verifyPage.waitForSelector(continueBtn, { timeout: 15000 });
        await verifyPage.click(continueBtn);
        await verifyPage.waitForTimeout(2000);

        const currentUrl = verifyPage.url();
        const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
        await verifyPage.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Select facility
        await verifyPage.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });
        await verifyPage.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.preferences.facilityId);
        await verifyPage.waitForTimeout(3000);

        // Compare dates
        const mainDate = scoutAvailableDate ? scoutAvailableDate.date : null;
        const verifyDate = capturedVerifyDate ? capturedVerifyDate.date : null;

        log(`📊 COMPARISON: Main=${mainDate || 'NONE'} | Verify=${verifyDate || 'NONE'}`, 'INFO');

        await verifyBrowser.close();
        verifyBrowser = null;
        lastVerifyTime = Date.now();

        if (mainDate && verifyDate && mainDate !== verifyDate) {
            log(`🚨 STALE DATA DETECTED! Main: ${mainDate} vs Verify: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `🚨 <b>STALE DATA DETECTED!</b>\n` +
                `Main: ${mainDate}\n` +
                `Verify: ${verifyDate}\n` +
                `⚡ Restarting sessions...`
            );
            isVerifying = false;
            return false;
        }

        if (!mainDate && verifyDate) {
            log(`🚨 STALE: Main has no date, Verify sees: ${verifyDate}`, 'ERROR');
            sendTelegram(`🚨 <b>STALE DATA!</b>\nMain: No dates\nVerify: ${verifyDate}\n⚡ Restarting...`);
            isVerifying = false;
            return false;
        }

        log(`✅ DATA FRESH! Both see: ${mainDate || 'no dates'}`, 'SUCCESS');
        sendTelegram(`✅ <b>Data Fresh</b>\nBoth see: ${mainDate || 'no dates'}`);
        isVerifying = false;
        return true;

    } catch (error) {
        log(`Verification error: ${error.message}`, 'ERROR');
        if (verifyBrowser) await verifyBrowser.close().catch(() => {});
        isVerifying = false;
        return true;
    }
}

// ============================================================================
// COOKIE RESET (refreshes sessions)
// ============================================================================
async function resetAllCookies() {
    log('🍪 COOKIE RESET - Refreshing all sessions...', 'WARN');
    sendTelegram(`🍪 <b>Cookie Reset</b>\nRefreshing all sessions...`);

    // Reset scout session
    if (scoutSession) {
        try {
            await scoutSession.context.clearCookies();
            // Re-login scout
            await scoutSession.page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await scoutSession.page.waitForSelector('#user_email', { timeout: 30000 });
            await scoutSession.page.fill('#user_email', CONFIG.scout.email);
            await scoutSession.page.fill('#user_password', CONFIG.scout.password);
            try {
                await scoutSession.page.click('label[for="policy_confirmed"]', { timeout: 2000 });
            } catch {
                await scoutSession.page.click('#policy_confirmed', { force: true }).catch(() => {});
            }
            await scoutSession.page.click('input[type="submit"]');
            await scoutSession.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

            // Navigate back to appointment page
            await scoutSession.page.goto(`${CONFIG.preferences.baseUrl}/schedule/${scoutSession.scheduleId}/appointment`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            await scoutSession.page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });
            await scoutSession.page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.preferences.facilityId);

            log('🍪 Scout cookies reset', 'SUCCESS');
        } catch (e) {
            log(`Scout cookie reset failed: ${e.message}`, 'ERROR');
        }
    }

    // Reset booker sessions
    for (const session of bookerSessions) {
        try {
            const accountName = session.email.split('@')[0];
            await session.context.clearCookies();

            // Re-login
            await session.page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
                waitUntil: 'domcontentloaded',
                timeout: 60000
            });
            await session.page.waitForSelector('#user_email', { timeout: 30000 });
            await session.page.fill('#user_email', session.email);
            await session.page.fill('#user_password', CONFIG.bookers.find(b => b.email === session.email)?.password || '');
            try {
                await session.page.click('label[for="policy_confirmed"]', { timeout: 2000 });
            } catch {
                await session.page.click('#policy_confirmed', { force: true }).catch(() => {});
            }
            await session.page.click('input[type="submit"]');
            await session.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

            // Navigate back to appointment page
            await session.page.goto(`${CONFIG.preferences.baseUrl}/schedule/${session.scheduleId}/appointment`, {
                waitUntil: 'domcontentloaded',
                timeout: 30000
            });
            await session.page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });
            await session.page.selectOption('#appointments_consulate_appointment_facility_id', session.facilityId);

            log(`🍪 ${accountName} cookies reset`, 'SUCCESS');
        } catch (e) {
            log(`Booker cookie reset failed: ${e.message}`, 'ERROR');
        }
    }

    lastCookieReset = Date.now();
    log('🍪 All cookies reset complete', 'SUCCESS');
    sendTelegram(`✅ <b>Cookie Reset Complete</b>\nAll sessions refreshed`);
}

// ============================================================================
// SCOUT LOOP (high CPM checking)
// ============================================================================
async function runScoutLoop() {
    const delayMs = getDelay(CONFIG.scout.targetCPM);
    log(`[SCOUT] Starting loop: Target ${CONFIG.scout.targetCPM} CPM = ${delayMs}ms delay between checks`, 'SCOUT');

    let lastLogTime = Date.now();

    const telegramIntervalMs = CONFIG.timings.telegramUpdateMins * 60 * 1000;
    const verifyIntervalMs = CONFIG.verify.intervalMins * 60 * 1000;
    const cookieResetIntervalMs = CONFIG.timings.cookieResetMins * 60 * 1000;

    while (true) {
        try {
            // Check for page death
            if (totalScoutChecks % 100 === 0) {
                try {
                    await scoutSession.page.evaluate(() => true);
                } catch (e) {
                    log('[SCOUT] Page died - restarting...', 'ERROR');
                    throw new Error('RESTART_NEEDED');
                }
            }

            // =====================================================
            // PERIODIC CHECKS (only when not booking)
            // =====================================================
            if (!bookingInProgress) {
                // COOKIE RESET - Every 23 minutes
                if (Date.now() - lastCookieReset > cookieResetIntervalMs) {
                    await resetAllCookies();
                }

                // STALE DATA VERIFICATION - Every 7 minutes
                if (Date.now() - lastVerifyTime > verifyIntervalMs) {
                    const dataIsFresh = await verifyDataFreshness();
                    if (!dataIsFresh) {
                        log('🔄 RESTARTING due to stale data...', 'ERROR');
                        throw new Error('RESTART_NEEDED');
                    }
                }

                // TELEGRAM STATUS UPDATE - Every 5 minutes
                if (Date.now() - lastTelegramUpdate > telegramIntervalMs) {
                    const elapsed = (Date.now() - startTime) / 60000;
                    const cpm = (totalScoutChecks / elapsed).toFixed(1);
                    const dateDisplay = scoutAvailableDate?.date || 'SEARCHING';
                    const closestDisplay = closestSlotFound?.date || 'N/A';
                    const nextVerifyMins = Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - lastVerifyTime)) / 60000));
                    const nextCookieMins = Math.max(0, Math.ceil((cookieResetIntervalMs - (Date.now() - lastCookieReset)) / 60000));

                    sendTelegram(
                        `📊 <b>Status Update</b>\n` +
                        `⚡ ${cpm} CPM | ${totalScoutChecks} checks\n` +
                        `🔭 Scout: ${CONFIG.scout.email.split('@')[0]}\n` +
                        `🎯 Bookers: ${bookerSessions.length} active\n` +
                        `📅 Current: ${dateDisplay}\n` +
                        `📅 Best: ${closestDisplay}\n` +
                        `🔍 Next verify: ${nextVerifyMins}m\n` +
                        `🍪 Next cookie reset: ${nextCookieMins}m`
                    );
                    lastTelegramUpdate = Date.now();
                }
            }

            // Trigger date check
            await triggerDateCheck(scoutSession);
            totalScoutChecks++;

            // If booking triggered, wait for it to complete
            if (bookingTriggered && targetBookingDate) {
                await triggerParallelBooking(targetBookingDate);
            }

            // Log stats every second
            if (Date.now() - lastLogTime >= 1000) {
                const elapsed = (Date.now() - startTime) / 60000;
                const cpm = (totalScoutChecks / elapsed).toFixed(1);
                const dateDisplay = scoutAvailableDate?.date || 'SEARCHING';
                const bestDisplay = closestSlotFound?.date || 'N/A';
                const nextVerifyMins = Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - lastVerifyTime)) / 60000));
                const nextCookieMins = Math.max(0, Math.ceil((cookieResetIntervalMs - (Date.now() - lastCookieReset)) / 60000));
                const bookerStatus = bookerSessions.map(s => {
                    const name = s.email.split('@')[0].substring(0, 6);
                    const ago = Math.floor((Date.now() - s.lastCheck) / 1000);
                    return `${name}:${ago}s`;
                }).join(' | ');

                console.log(
                    `\x1b[44m[SCOUT ${cpm} CPM]\x1b[0m #${totalScoutChecks} | ` +
                    `Slot: ${dateDisplay} | Best: ${bestDisplay} | ` +
                    `V:${nextVerifyMins}m C:${nextCookieMins}m | ` +
                    `Bookers: ${bookerStatus}`
                );
                lastLogTime = Date.now();
            }

            await new Promise(r => setTimeout(r, delayMs));

        } catch (error) {
            if (error.message === 'RESTART_NEEDED') {
                throw error;
            }
            log(`[SCOUT] Error: ${error.message}`, 'ERROR');
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// ============================================================================
// BOOKER LOOP (human-like, keep warm)
// ============================================================================
async function runBookerLoop(session) {
    const accountName = session.email.split('@')[0];
    const intervalMs = CONFIG.preferences.bookerCheckIntervalSec * 1000;

    log(`[BOOKER] ${accountName} starting human-like loop: 1 check per ${CONFIG.preferences.bookerCheckIntervalSec}s`, 'BOOKER');

    while (true) {
        try {
            // Skip if booking in progress
            if (bookingInProgress) {
                await new Promise(r => setTimeout(r, 100));
                continue;
            }

            // Do a human-like date check (keeps session warm)
            await triggerDateCheck(session);

            // Small random variation to look more human (25-35 seconds)
            const variation = Math.floor(Math.random() * 10000) - 5000; // -5s to +5s
            const waitTime = intervalMs + variation;

            await new Promise(r => setTimeout(r, waitTime));

        } catch (error) {
            if (error.message === 'PAGE_DEAD') {
                log(`[BOOKER] ${accountName} page died - needs restart`, 'ERROR');
                throw error;
            }
            log(`[BOOKER] ${accountName} error: ${error.message}`, 'ERROR');
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    // SINGLETON - prevent multiple instances
    if (isRunning) {
        log('Bot already running, ignoring duplicate start', 'WARN');
        return;
    }
    isRunning = true;

    // Reset state for clean start
    scoutSession = null;
    bookerSessions = [];
    bookingInProgress = false;
    bookingTriggered = false;
    targetBookingDate = null;
    totalScoutChecks = 0;
    scoutAvailableDate = null;
    startTime = Date.now();
    lastTelegramUpdate = Date.now();
    lastVerifyTime = Date.now();
    lastCookieReset = Date.now();
    isVerifying = false;

    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[45m  SCOUT + BOOKING ARMY Strategy\x1b[0m');
    console.log('\x1b[44m  Scout: ' + CONFIG.scout.targetCPM + ' CPM (high-speed detection)\x1b[0m');
    console.log('\x1b[45m  Bookers: ' + CONFIG.bookers.length + ' accounts (human-like, 1 check/' + CONFIG.preferences.bookerCheckIntervalSec + 's)\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    if (!CONFIG.scout.email || !CONFIG.scout.password) {
        log('No scout account configured!', 'ERROR');
        log('Set SCOUT_EMAIL/SCOUT_PASSWORD or ACCOUNT_1_EMAIL/ACCOUNT_1_PASSWORD', 'ERROR');
        process.exit(1);
    }

    if (CONFIG.bookers.length === 0) {
        log('No booker accounts configured!', 'ERROR');
        log('Set BOOKER_1_EMAIL/BOOKER_1_PASSWORD or ACCOUNT_2_EMAIL/ACCOUNT_2_PASSWORD', 'ERROR');
        process.exit(1);
    }

    log(`City: ${CONFIG.preferences.city} (Facility: ${CONFIG.preferences.facilityId})`);
    log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);
    log(`Scout: ${CONFIG.scout.email} (PROXY: ${CONFIG.proxy.enabled ? CONFIG.proxy.server : 'DISABLED'})`);
    const bookerProxyStatus = CONFIG.proxy.bookersUseProxy ? 'PROXY' : 'DIRECT';
    log(`Bookers: ${CONFIG.bookers.map(b => b.email.split('@')[0]).join(', ')} (${bookerProxyStatus})`);

    // ===== PHASE 1: Login Scout (with PROXY for high CPM) =====
    log('\n===== PHASE 1: Login Scout Account (PROXY) =====', 'SCOUT');

    // Scout login with retry
    let scoutRetries = 3;
    while (scoutRetries > 0) {
        try {
            scoutSession = await createSession(
                { email: CONFIG.scout.email, password: CONFIG.scout.password },
                'SCOUT',
                true  // useProxy = true for Scout
            );
            setupScoutResponseListener(scoutSession);
            break;  // Success
        } catch (error) {
            scoutRetries--;
            log(`Scout login failed: ${error.message} (${scoutRetries} retries left)`, 'ERROR');
            if (scoutRetries > 0) {
                log('Waiting 10s before retry...', 'WARN');
                await new Promise(r => setTimeout(r, 10000));
            } else {
                log('Scout login failed after 3 attempts!', 'ERROR');
                sendTelegram(`❌ <b>Scout Login Failed</b>\nAfter 3 attempts. Check account manually.`);
                process.exit(1);
            }
        }
    }

    // ===== PHASE 2: Login Bookers (DIRECT for low latency) =====
    log('\n===== PHASE 2: Login Booker Accounts (DIRECT) =====', 'BOOKER');

    const bookerUseProxy = CONFIG.proxy.bookersUseProxy;
    log(`Bookers will use proxy: ${bookerUseProxy ? 'YES' : 'NO (direct)'}`, 'INFO');

    for (const booker of CONFIG.bookers) {
        try {
            const session = await createSession(booker, 'BOOKER', bookerUseProxy);
            bookerSessions.push(session);
        } catch (error) {
            log(`Booker login failed (${booker.email}): ${error.message}`, 'ERROR');
        }
    }

    if (bookerSessions.length === 0) {
        log('No bookers logged in!', 'ERROR');
        process.exit(1);
    }

    log(`\n✅ Ready: 1 Scout + ${bookerSessions.length} Bookers\n`, 'SUCCESS');

    sendTelegram(
        `🚀 <b>Scout + Booker Army Started</b>\n` +
        `🔭 Scout: ${CONFIG.scout.email.split('@')[0]} (${CONFIG.scout.targetCPM} CPM) [PROXY]\n` +
        `🎯 Bookers: ${bookerSessions.length} accounts (${CONFIG.preferences.bookerCheckIntervalSec}s interval) [DIRECT]\n` +
        `📍 ${CONFIG.preferences.city}\n` +
        `📅 Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`
    );

    // ===== PHASE 3: Start Loops =====
    log('===== PHASE 3: Starting Monitoring =====', 'INFO');

    // Start booker loops (run in background)
    for (const session of bookerSessions) {
        runBookerLoop(session).catch(err => {
            log(`Booker ${session.email} crashed: ${err.message}`, 'ERROR');
        });
    }

    // Start scout loop (main thread)
    try {
        await runScoutLoop();
    } catch (error) {
        log(`Scout crashed: ${error.message}`, 'ERROR');
        sendTelegram(`⚠️ <b>Scout Crashed</b>\n${error.message}\nRestarting in 30s...`);

        // Cleanup all browsers
        await cleanupAllBrowsers();

        // Allow restart
        isRunning = false;

        // Cooldown before restart (let rate limits reset)
        log('⏳ Waiting 30s before restart (cooldown)...', 'WARN');
        await new Promise(r => setTimeout(r, 30000));
        return main();
    }
}

// ============================================================================
// CLEANUP HELPER
// ============================================================================
async function cleanupAllBrowsers() {
    log('Cleaning up all browsers...', 'INFO');

    if (scoutSession?.browser) {
        await scoutSession.browser.close().catch(() => {});
    }

    for (const session of bookerSessions) {
        if (session?.browser) {
            await session.browser.close().catch(() => {});
        }
    }

    scoutSession = null;
    bookerSessions = [];
}

// ============================================================================
// CLEANUP
// ============================================================================
async function cleanup() {
    log('\nShutting down...', 'WARN');
    sendTelegram('🛑 <b>Bot Stopped</b>');

    if (scoutSession?.browser) await scoutSession.browser.close().catch(() => {});
    for (const session of bookerSessions) {
        if (session.browser) await session.browser.close().catch(() => {});
    }

    process.exit(0);
}

process.on('SIGINT', cleanup);

process.on('uncaughtException', async (err) => {
    console.error('FATAL:', err.message);

    // Prevent multiple restart attempts
    if (isRestarting) {
        console.log('Already restarting, ignoring...');
        return;
    }
    isRestarting = true;

    sendTelegram(`⚠️ <b>Crash</b>\n${err.message}\nRestarting in 15s...`);

    // Cleanup all browsers
    await cleanupAllBrowsers();

    // Reset flags
    isRunning = false;
    isVerifying = false;

    // Wait before restart
    console.log('Auto-restarting in 15s...');
    setTimeout(() => {
        isRestarting = false;
        main();
    }, 15000);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
    // Don't crash, just log
});

// Start
main();
