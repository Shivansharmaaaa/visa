/**
 * US Visa Appointment Bot - TOKEN ROTATION (Browser-Based)
 *
 * The site requires real browser context - raw HTTP doesn't work.
 * This bot keeps multiple browser contexts open, one per account,
 * and rotates between them for monitoring.
 *
 * Strategy:
 * - Login to all accounts in separate browser contexts
 * - Keep browsers open (not HTTP)
 * - Rotate monitoring between accounts
 * - Each account gets fewer requests = less rate limiting
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
const fs = require('fs');
const path = require('path');
const { FingerprintGenerator } = require('fingerprint-generator');
const { FingerprintInjector } = require('fingerprint-injector');
require('dotenv').config();

const fingerprintInjector = new FingerprintInjector();

chromium.use(stealth);

// ============================================================================
// FINGERPRINT MANAGEMENT (persistent per account)
// ============================================================================
const FINGERPRINTS_FILE = path.join(__dirname, 'fingerprints.json');
const fingerprintGenerator = new FingerprintGenerator({
    browsers: [{ name: 'chrome', minVersion: 119, maxVersion: 125 }],
    devices: ['desktop'],
    operatingSystems: ['windows', 'macos'],
});

// Fingerprint regeneration interval (minutes) - set to 0 to disable
const FINGERPRINT_REGEN_MINS = parseInt(process.env.FINGERPRINT_REGEN_MINS) || 30;

// Load or create fingerprints for accounts
function loadFingerprints() {
    try {
        if (fs.existsSync(FINGERPRINTS_FILE)) {
            return JSON.parse(fs.readFileSync(FINGERPRINTS_FILE, 'utf8'));
        }
    } catch (e) {
        console.log('Failed to load fingerprints, generating new ones');
    }
    return {};
}

function saveFingerprints(fingerprints) {
    try {
        fs.writeFileSync(FINGERPRINTS_FILE, JSON.stringify(fingerprints, null, 2));
    } catch (e) {
        console.log('Failed to save fingerprints:', e.message);
    }
}

function getFingerprintForAccount(email, forceRegenerate = false) {
    const fingerprints = loadFingerprints();

    if (fingerprints[email] && !forceRegenerate) {
        // Check if fingerprint has expired
        const createdAt = fingerprints[email].createdAt || 0;
        const ageMins = (Date.now() - createdAt) / (1000 * 60);

        if (FINGERPRINT_REGEN_MINS > 0 && ageMins >= FINGERPRINT_REGEN_MINS) {
            console.log(`[FINGERPRINT] Expired (${ageMins.toFixed(0)}m old) for ${email.split('@')[0]} - regenerating...`);
        } else {
            console.log(`[FINGERPRINT] Loaded existing fingerprint for ${email.split('@')[0]} (${ageMins.toFixed(0)}m old)`);
            return fingerprints[email];
        }
    }

    // Generate new fingerprint for this account
    // Store the FULL object (fingerprint + headers) for injection
    const fingerprintWithHeaders = fingerprintGenerator.getFingerprint({
        locales: ['en-CA', 'en-US', 'en'],
    });

    // Add timestamp for expiry tracking
    fingerprintWithHeaders.createdAt = Date.now();

    fingerprints[email] = fingerprintWithHeaders;
    saveFingerprints(fingerprints);
    console.log(`[FINGERPRINT] Generated NEW fingerprint for ${email.split('@')[0]}: ${fingerprintWithHeaders.fingerprint.navigator.userAgent.substring(0, 50)}...`);

    return fingerprintWithHeaders;
}

// ============================================================================
// CONFIGURATION
// ============================================================================
const CONFIG = {
    accounts: [],

    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
        city: process.env.PREFERRED_CITY || 'Ottawa',
        facilityId: process.env.FACILITY_ID || '92',
        startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
        endDate: new Date(process.env.END_DATE || '2026-05-30'),
        targetCPM: parseInt(process.env.TARGET_CPM) || 300
    },

    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    },

    proxy: {
        enabled: process.env.PROXY_ENABLED === 'true',
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
    },

    bot: {
        headless: process.env.HEADLESS === 'true'
    },

    verify: {
        email: process.env.VERIFY_EMAIL,
        password: process.env.VERIFY_PASSWORD,
        intervalMins: parseInt(process.env.VERIFY_INTERVAL_MINS) || 7
    }
};

// Load accounts from .env
for (let i = 1; i <= 10; i++) {
    const email = process.env[`ACCOUNT_${i}_EMAIL`];
    const password = process.env[`ACCOUNT_${i}_PASSWORD`];
    if (email && password) {
        CONFIG.accounts.push({ email, password });
    }
}

if (CONFIG.accounts.length === 0 && process.env.VISA_EMAIL) {
    CONFIG.accounts.push({
        email: process.env.VISA_EMAIL,
        password: process.env.VISA_PASSWORD
    });
}

// ============================================================================
// GLOBAL STATE
// ============================================================================
const browserSessions = [];  // { email, browser, context, page, scheduleId, facilityId, availableDate, lastRequestTime, lastLatency }
let currentSessionIndex = 0;
let totalChecks = 0;
let bookingInProgress = false;
let loginPhaseComplete = false;  // Prevent booking during login
const BOOKING_DELAY_MS = 0;  // No delay - book immediately
let bookingEnabledTime = 0;      // When booking becomes allowed
let lastBookingAttempt = 0;      // Cooldown between booking attempts
const BOOKING_COOLDOWN_MS = 10000; // 10 second cooldown after failed booking
let closestSlotFound = null;
const startTime = Date.now();

// Latency tracking
let avgLatency = 0;
let latencyCount = 0;
let minLatency = Infinity;
let maxLatency = 0;

// Verify timing
let lastVerifyTime = 0;

// Fingerprint refresh timing
let lastFingerprintCheck = Date.now();

// ============================================================================
// RANDOM USER AGENTS (different for each browser)
// ============================================================================
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

// ============================================================================
// LOGGING
// ============================================================================
function log(message, level = 'INFO') {
    const colors = {
        'INFO': '\x1b[36m',
        'SUCCESS': '\x1b[32m',
        'WARN': '\x1b[33m',
        'ERROR': '\x1b[31m',
        'TOKEN': '\x1b[45m',
        'BOOK': '\x1b[42m\x1b[30m'
    };
    const ts = new Date().toLocaleTimeString();
    console.log(`${colors[level] || ''}[${ts}] ${message}\x1b[0m`);
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
// SETUP RESPONSE LISTENER (captures dates from API responses)
// ============================================================================
function setupResponseListener(session) {
    session.page.on('response', async (response) => {
        try {
            const url = response.url();

            // Capture available dates
            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    session.availableDate = data[0];
                    session.lastResponseTime = Date.now();

                    // Calculate latency
                    if (session.lastRequestTime > 0) {
                        session.lastLatency = session.lastResponseTime - session.lastRequestTime;
                        // Update global latency stats
                        latencyCount++;
                        avgLatency = avgLatency + (session.lastLatency - avgLatency) / latencyCount;
                        if (session.lastLatency < minLatency) minLatency = session.lastLatency;
                        if (session.lastLatency > maxLatency) maxLatency = session.lastLatency;
                    }

                    // Track closest slot globally
                    const slotDate = new Date(session.availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = session.availableDate;
                            log(`📅 New closest: ${closestSlotFound.date} (${session.email.split('@')[0]})`, 'SUCCESS');
                        }
                    }

                    // Check if in range - INSTANT PARALLEL BOOKING!
                    // Only book after login phase + delay is complete + cooldown passed
                    const bookingReady = loginPhaseComplete && Date.now() >= bookingEnabledTime;
                    const cooldownPassed = Date.now() >= lastBookingAttempt + BOOKING_COOLDOWN_MS;
                    if (bookingReady && cooldownPassed && isDateInRange(session.availableDate.date) && !bookingInProgress) {
                        log(`🚨 IN RANGE: ${session.availableDate.date}! PARALLEL BOOKING NOW!`, 'BOOK');
                        performParallelBooking(session.availableDate.date);
                    } else if (loginPhaseComplete && !bookingReady && isDateInRange(session.availableDate.date)) {
                        const secsLeft = Math.ceil((bookingEnabledTime - Date.now()) / 1000);
                        log(`⏳ IN RANGE: ${session.availableDate.date} - Booking in ${secsLeft}s...`, 'WARN');
                    }
                }
            }
        } catch (e) {}
    });
}

function isDateInRange(dateStr) {
    const date = new Date(dateStr);
    return date >= CONFIG.preferences.startDate && date <= CONFIG.preferences.endDate;
}

// ============================================================================
// LOGIN ACCOUNT (Browser stays open) - WITH FINGERPRINT-SUITE
// ============================================================================
async function loginAccount(account) {
    log(`Logging in: ${account.email}...`, 'TOKEN');

    // Get persistent fingerprint for this account (includes fingerprint + headers)
    const fingerprintData = getFingerprintForAccount(account.email);
    const fingerprint = fingerprintData.fingerprint;

    const launchOptions = {
        headless: CONFIG.bot.headless,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-webrtc',
            '--no-sandbox',
            '--disable-features=IsolateOrigins,site-per-process'
        ]
    };

    if (!CONFIG.bot.headless) {
        launchOptions.channel = 'chrome';
    }

    if (CONFIG.proxy.enabled && CONFIG.proxy.server) {
        // Generate unique session ID for each browser (so they look like different users)
        const sessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
        const proxyUsername = CONFIG.proxy.username.includes('sessid-')
            ? CONFIG.proxy.username.replace(/sessid-\d+/, `sessid-${sessionId}`)
            : `${CONFIG.proxy.username}-sessid-${sessionId}`;

        log(`Proxy session: sessid-${sessionId}`, 'INFO');

        launchOptions.proxy = {
            server: `http://${CONFIG.proxy.server}`,
            username: proxyUsername,
            password: CONFIG.proxy.password
        };
    }

    const browser = await chromium.launch(launchOptions);

    // Use fingerprint's user agent and screen settings
    log(`Using fingerprint UA: ${fingerprint.navigator.userAgent.substring(0, 60)}...`, 'INFO');

    // Full request headers for realistic browser behavior
    const extraHeaders = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': fingerprint.navigator.language || 'en-CA,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'sec-ch-ua': `"Google Chrome";v="${fingerprint.navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || '120'}", "Chromium";v="${fingerprint.navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || '120'}", "Not_A Brand";v="8"`,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': fingerprint.navigator.userAgent.includes('Windows') ? '"Windows"' : '"macOS"',
    };

    // Create context with fingerprint settings
    const context = await browser.newContext({
        userAgent: fingerprint.navigator.userAgent,
        viewport: {
            width: fingerprint.screen.width || 1920,
            height: fingerprint.screen.height || 1080
        },
        screen: {
            width: fingerprint.screen.width || 1920,
            height: fingerprint.screen.height || 1080
        },
        locale: fingerprint.navigator.language?.split(',')[0] || 'en-CA',
        timezoneId: 'America/Toronto',
        colorScheme: 'light',
        extraHTTPHeaders: extraHeaders
    });

    // Inject fingerprint (Canvas, WebGL, AudioContext, etc.)
    await fingerprintInjector.attachFingerprintToPlaywright(context, fingerprintData);
    log(`✅ Fingerprint injected for ${account.email.split('@')[0]}`, 'SUCCESS');

    const page = await context.newPage();

    // Setup dynamic referer - update on navigation
    page.on('framenavigated', async (frame) => {
        if (frame === page.mainFrame()) {
            const currentUrl = frame.url();
            if (currentUrl.includes('ais.usvisa-info.com')) {
                await context.setExtraHTTPHeaders({
                    ...extraHeaders,
                    'Referer': currentUrl,
                    'Sec-Fetch-Site': 'same-origin'
                });
            }
        }
    });

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

    // Extract schedule ID
    const content = await page.content();
    const scheduleId = content.match(/schedule\/(\d+)/)?.[1];

    if (!scheduleId) {
        await browser.close();
        throw new Error('No schedule ID found');
    }

    // Navigate to appointment page
    await page.goto(`${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    // Select facility
    await page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });
    await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.preferences.facilityId);
    await page.waitForTimeout(1000);

    // Pre-cache CSRF token for faster booking
    const csrfToken = await page.evaluate(() => {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    });

    const session = {
        email: account.email,
        browser,
        context,
        page,
        scheduleId,
        facilityId: CONFIG.preferences.facilityId,
        csrfToken,  // Pre-cached for instant booking
        availableDate: null,
        lastResponseTime: 0,
        lastCheck: Date.now()
    };

    // Setup response listener
    setupResponseListener(session);

    log(`✅ Logged in: ${account.email} (Schedule: ${scheduleId})`, 'SUCCESS');

    return session;
}

// ============================================================================
// TRIGGER DATE CHECK (re-select facility to trigger API call)
// ============================================================================
async function triggerDateCheck(session) {
    try {
        session.lastRequestTime = Date.now();  // Track request time for latency calculation
        await session.page.evaluate(() => {
            const sel = document.querySelector('#appointments_consulate_appointment_facility_id');
            if (sel && sel.value) {
                sel.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(sel).trigger('change');
            }
        });
        session.lastCheck = Date.now();
    } catch (e) {
        // Page might be closed or navigated away
        throw new Error('PAGE_DEAD');
    }
}

// ============================================================================
// BOOKING - HYBRID (API for times, Form for booking)
// Step 1: API - GET times with date (fast)
// Step 2: FORM - Fill form + submit (reliable)
// Step 3: UI - Click confirm button
// ============================================================================
async function performBookingDirect(session, date) {
    const startMs = Date.now();
    const page = session.page;
    const accountName = session.email.split('@')[0];

    log(`⚡ [${accountName}] BOOKING: ${date}`, 'BOOK');

    try {
        // Use pre-cached IDs from session
        const scheduleId = session.scheduleId;
        const facilityId = session.facilityId;

        // Get fresh CSRF token from page
        const csrf = await page.evaluate(() => {
            return document.querySelector('meta[name="csrf-token"]')?.content || '';
        });

        if (!scheduleId || !facilityId || !csrf) {
            return { success: false, error: `Missing IDs`, session };
        }

        // ===== STEP 1: API - GET available times for this date (fast) =====
        const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`;

        log(`📡 [${accountName}] Fetching times...`, 'INFO');

        const timeResult = await page.evaluate(async ({ url, csrf }) => {
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

        if (timeResult.error) {
            return { success: false, error: `Times: ${timeResult.error}`, session };
        }

        if (!timeResult.time) {
            return { success: false, error: 'No times', session };
        }

        const time = timeResult.time;
        log(`⏰ [${accountName}] Time: ${time}`, 'SUCCESS');

        // ===== STEP 2: FORM - Fill and submit =====
        log(`📝 [${accountName}] Submitting form...`, 'INFO');

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
                else document.querySelector('#appointments_submit')?.click();
            }, { date, time });
        } catch (e) {
            if (!e.message.includes('context') && !e.message.includes('destroyed')) {
                return { success: false, error: `Form: ${e.message}`, session };
            }
        }

        // ===== STEP 3: Wait for navigation and check result =====
        await page.waitForTimeout(2000); // Wait for page to load

        const pageUrl = page.url();
        const pageContent = await page.content().catch(() => '');

        log(`🔍 [${accountName}] Page: ${pageUrl.split('/').slice(-2).join('/')}`, 'INFO');

        // Check if we're on confirmation/instructions page (SUCCESS!)
        if (pageUrl.includes('instructions') ||
            pageContent.includes('Successfully') ||
            pageContent.includes('successfully') ||
            pageContent.includes('Your appointment') ||
            pageContent.includes('has been scheduled') ||
            pageContent.includes('Appointment Confirmation')) {
            log(`✅ [${accountName}] BOOKED! (instructions page)`, 'SUCCESS');
            const elapsed = Date.now() - startMs;
            return { success: true, elapsed, time, session, verified: true };
        }

        // Check if there's a confirm button (need to click it)
        try {
            const confirmBtn = await page.$('a.button.alert');
            if (confirmBtn) {
                await confirmBtn.click();
                log(`🔄 [${accountName}] Confirm clicked...`, 'INFO');
                await page.waitForTimeout(2000);

                const finalUrl = page.url();
                const finalContent = await page.content().catch(() => '');

                if (finalUrl.includes('instructions') ||
                    finalContent.includes('Successfully') ||
                    finalContent.includes('Your appointment')) {
                    log(`✅ [${accountName}] VERIFIED BOOKED!`, 'SUCCESS');
                    const elapsed = Date.now() - startMs;
                    return { success: true, elapsed, time, session, verified: true };
                }
            }
        } catch (e) {
            // Ignore confirm errors
        }

        // If we're back on appointment page, booking failed - navigate back to reset
        if (pageUrl.includes('/appointment') && !pageUrl.includes('instructions')) {
            log(`❌ [${accountName}] Back on appointment page - failed`, 'ERROR');
            // Re-select facility to reset state
            try {
                await page.selectOption('#appointments_consulate_appointment_facility_id', facilityId);
            } catch (e) {}
            return { success: false, error: 'Booking rejected', session };
        }

        return { success: false, error: 'Unknown state', session };

    } catch (error) {
        // Don't assume success - be conservative
        return { success: false, error: error.message, session };
    }
}

// ============================================================================
// SINGLE ACCOUNT BOOKING - Use one account at a time
// ============================================================================
async function performParallelBooking(date) {
    if (bookingInProgress) return false;
    bookingInProgress = true;

    const startMs = Date.now();

    // Find best session to use (one with the date, or first available)
    const bookingSession = browserSessions.find(s => s.availableDate?.date === date) || browserSessions[0];
    const accountName = bookingSession.email.split('@')[0];

    log(`🚀 BOOKING: ${date} with ${accountName}`, 'BOOK');
    sendTelegram(`🚀 <b>BOOKING!</b>\n📅 ${date}\n📍 ${CONFIG.preferences.city}\n📧 ${accountName}`);

    try {
        // Try with single account
        const result = await performBookingDirect(bookingSession, date);
        const elapsed = Date.now() - startMs;

        // Wrap in array for compatibility
        const results = [result];
        const winner = result.success ? result : null;

        if (winner) {
            const verifiedText = winner.verified ? '✅ VERIFIED!' : '⚠️ Check account!';
            log(`🎉 BOOKED in ${winner.elapsed}ms by ${accountName}! ${verifiedText}`, 'SUCCESS');
            sendTelegram(
                `🎉 <b>BOOKED!</b>\n` +
                `📅 ${date}\n` +
                `⏰ ${winner.time}\n` +
                `⏱ ${winner.elapsed}ms\n` +
                `📧 ${accountName}\n` +
                `${verifiedText}`
            );

            log(`🛑 STOPPING - BOOKING COMPLETE`, 'SUCCESS');
            process.exit(0);
        } else {
            // Failed - set cooldown
            log(`❌ Booking failed: ${result.error}`, 'ERROR');
            log(`⏳ Cooling down for ${BOOKING_COOLDOWN_MS/1000}s before retry...`, 'WARN');
            lastBookingAttempt = Date.now();
            bookingInProgress = false;
            return false;
        }

    } catch (error) {
        log(`❌ Parallel booking error: ${error.message}`, 'ERROR');
        bookingInProgress = false;
        return false;
    }
}

// ============================================================================
// STALE DATA VERIFICATION (compares main sessions with fresh verify login)
// ============================================================================
let shouldRestartSessions = false;
let shouldRefreshFingerprints = false;

// Check if any fingerprints have expired and need regeneration
function checkFingerprintExpiry() {
    if (FINGERPRINT_REGEN_MINS <= 0) return false;

    const fingerprints = loadFingerprints();
    const now = Date.now();

    for (const session of browserSessions) {
        const fp = fingerprints[session.email];
        if (fp && fp.createdAt) {
            const ageMins = (now - fp.createdAt) / (1000 * 60);
            if (ageMins >= FINGERPRINT_REGEN_MINS) {
                log(`🔄 Fingerprint expired for ${session.email.split('@')[0]} (${ageMins.toFixed(0)}m old)`, 'WARN');
                return true;
            }
        }
    }
    return false;
}

async function verifyDataFreshness() {
    if (!CONFIG.verify.email || !CONFIG.verify.password) {
        log('No verify account configured, skipping verify', 'WARN');
        return true;
    }

    console.log('\n' + '='.repeat(50));
    log(`🔍 STALE DATA CHECK: Comparing with verify account...`, 'TOKEN');
    sendTelegram(`🔍 <b>Verifying...</b>\nChecking for stale data`);

    let verifyBrowser = null;
    let capturedVerifyDate = null;

    try {
        const launchOptions = {
            headless: CONFIG.bot.headless,
            args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
        };

        if (CONFIG.proxy.enabled && CONFIG.proxy.server) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            };
        }

        verifyBrowser = await chromium.launch(launchOptions);

        // Get fingerprint for verify account
        const verifyFingerprintData = getFingerprintForAccount(CONFIG.verify.email);
        const verifyFingerprint = verifyFingerprintData.fingerprint;

        const extraHeaders = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': verifyFingerprint.navigator.language || 'en-CA,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Upgrade-Insecure-Requests': '1',
        };

        const context = await verifyBrowser.newContext({
            userAgent: verifyFingerprint.navigator.userAgent,
            viewport: {
                width: verifyFingerprint.screen.width || 1920,
                height: verifyFingerprint.screen.height || 1080
            },
            locale: verifyFingerprint.navigator.language?.split(',')[0] || 'en-CA',
            timezoneId: 'America/Toronto',
            extraHTTPHeaders: extraHeaders
        });

        // Inject fingerprint
        await fingerprintInjector.attachFingerprintToPlaywright(context, verifyFingerprintData);

        const page = await context.newPage();

        // Set up response listener to capture verify date
        page.on('response', async (response) => {
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

        // Login with verify account
        await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await page.waitForSelector('#user_email', { timeout: 15000 });
        await page.fill('#user_email', CONFIG.verify.email);
        await page.fill('#user_password', CONFIG.verify.password);

        try {
            await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
        } catch {
            await page.click('#policy_confirmed', { force: true }).catch(() => {});
        }

        await page.click('input[type="submit"]');
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        if (page.url().includes('sign_in')) {
            log(`🔍 VERIFY: Login failed`, 'ERROR');
            await verifyBrowser.close();
            return true; // Don't restart on login failure
        }

        log(`🔍 Verify account logged in`, 'SUCCESS');

        // Navigate to appointment page
        const content = await page.content();
        const scheduleId = content.match(/schedule\/(\d+)/)?.[1];

        if (!scheduleId) {
            log(`🔍 VERIFY: No schedule ID found`, 'WARN');
            await verifyBrowser.close();
            return true;
        }

        await page.goto(`${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`, {
            waitUntil: 'domcontentloaded',
            timeout: 20000
        });

        // Select facility to trigger API call
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        await page.waitForSelector(facilitySelector, { timeout: 10000 });
        await page.selectOption(facilitySelector, CONFIG.preferences.facilityId);

        // Wait for response
        await page.waitForTimeout(3000);

        // Get main sessions' date (use first session that has a date)
        const mainDate = browserSessions.find(s => s.availableDate)?.availableDate?.date || null;
        const verifyDate = capturedVerifyDate?.date || null;

        log(`📊 COMPARISON: Main=${mainDate || 'NONE'} | Verify=${verifyDate || 'NONE'}`, 'INFO');

        await verifyBrowser.close();
        verifyBrowser = null;

        // Compare dates
        if (mainDate && verifyDate && mainDate !== verifyDate) {
            log(`🚨 STALE DATA DETECTED! Main: ${mainDate} vs Verify: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `🚨 <b>STALE DATA DETECTED!</b>\n` +
                `Main sessions: ${mainDate}\n` +
                `Verify account: ${verifyDate}\n` +
                `⚡ Restarting all sessions...`
            );
            console.log('='.repeat(50) + '\n');
            return false; // Data is stale
        }

        if (!mainDate && verifyDate) {
            log(`🚨 STALE: Main has no date, Verify sees: ${verifyDate}`, 'ERROR');
            sendTelegram(
                `🚨 <b>STALE DATA!</b>\n` +
                `Main: No dates\n` +
                `Verify: ${verifyDate}\n` +
                `⚡ Restarting...`
            );
            console.log('='.repeat(50) + '\n');
            return false;
        }

        log(`✅ DATA FRESH! Both see: ${mainDate || 'no dates'}`, 'SUCCESS');
        sendTelegram(`✅ <b>Data Fresh</b>\nMain & Verify both see: ${mainDate || 'no dates'}`);
        console.log('='.repeat(50) + '\n');
        return true;

    } catch (error) {
        log(`🔍 VERIFY ERROR: ${error.message}`, 'ERROR');
        if (verifyBrowser) await verifyBrowser.close().catch(() => {});
        console.log('='.repeat(50) + '\n');
        return true; // Don't restart on error
    }
}

async function runVerifyLoop() {
    if (!CONFIG.verify.email || !CONFIG.verify.password) {
        log('No verify account configured, skipping verify loop', 'WARN');
        return;
    }

    const intervalMs = CONFIG.verify.intervalMins * 60 * 1000;

    console.log('\n' + '='.repeat(50));
    console.log('\x1b[45m  🔍 STALE DATA VERIFY LOOP\x1b[0m');
    console.log(`\x1b[36m  Account: ${CONFIG.verify.email}\x1b[0m`);
    console.log(`\x1b[33m  Interval: ${CONFIG.verify.intervalMins} minutes\x1b[0m`);
    console.log('='.repeat(50) + '\n');

    while (true) {
        // Wait first, then verify (so first verify is after interval)
        log(`🔍 Next stale data check in ${CONFIG.verify.intervalMins} minutes...`, 'INFO');
        await new Promise(r => setTimeout(r, intervalMs));

        if (bookingInProgress) {
            log(`🔍 Skipping verify - booking in progress`, 'WARN');
            continue;
        }

        const dataIsFresh = await verifyDataFreshness();
        lastVerifyTime = Date.now();  // Track when verify completed

        if (!dataIsFresh) {
            log(`🔄 RESTARTING ALL SESSIONS due to stale data...`, 'ERROR');
            shouldRestartSessions = true;
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[45m  TOKEN ROTATION BOT (Browser-Based)\x1b[0m');
    console.log('\x1b[36m  ' + CONFIG.accounts.length + ' accounts loaded\x1b[0m');
    console.log('\x1b[33m  Target: ' + CONFIG.preferences.targetCPM + ' CPM\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    if (CONFIG.accounts.length === 0) {
        log('No accounts configured!', 'ERROR');
        process.exit(1);
    }

    log(`City: ${CONFIG.preferences.city} (Facility: ${CONFIG.preferences.facilityId})`);
    log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);
    log(`Proxy: ${CONFIG.proxy.enabled ? CONFIG.proxy.server : 'DISABLED'}`);
    log(`Fingerprint Refresh: ${FINGERPRINT_REGEN_MINS > 0 ? FINGERPRINT_REGEN_MINS + ' mins' : 'DISABLED'}`);

    // ===== PHASE 1: Login to all accounts =====
    log('\n===== PHASE 1: Logging into accounts =====', 'TOKEN');

    for (const account of CONFIG.accounts) {
        try {
            const session = await loginAccount(account);
            browserSessions.push(session);
        } catch (error) {
            log(`Failed to login ${account.email}: ${error.message}`, 'ERROR');
        }
    }

    if (browserSessions.length === 0) {
        log('No sessions! Check credentials.', 'ERROR');
        process.exit(1);
    }

    // Login phase complete - start booking delay timer
    loginPhaseComplete = true;
    bookingEnabledTime = Date.now() + BOOKING_DELAY_MS;
    log(`✅ Login phase complete - booking enabled in ${BOOKING_DELAY_MS/1000}s!`, 'SUCCESS');

    log(`\n✅ ${browserSessions.length} browser sessions ready!\n`, 'SUCCESS');

    sendTelegram(
        `🚀 <b>Token Rotation Bot Started</b>\n` +
        `📧 ${browserSessions.length} accounts\n` +
        `📍 ${CONFIG.preferences.city}\n` +
        `⚡ Target: ${CONFIG.preferences.targetCPM} CPM\n` +
        `🔄 Fingerprint refresh: ${FINGERPRINT_REGEN_MINS > 0 ? FINGERPRINT_REGEN_MINS + 'm' : 'OFF'}\n` +
        `🖥️ Browser-based (${CONFIG.bot.headless ? 'headless' : 'visible'})`
    );

    // Start verify loop (runs independently in background)
    if (CONFIG.verify.email) {
        runVerifyLoop();  // Don't await - runs in background
    }

    // ===== PHASE 2: Monitoring with TRUE TOKEN ROTATION =====
    log('===== PHASE 2: TOKEN ROTATION (Round-Robin) =====', 'TOKEN');

    const targetCPM = CONFIG.preferences.targetCPM;
    const numSessions = browserSessions.length;

    // With TRUE rotation: one account checks at a time, round-robin
    // cycleDelay = 60000 / targetCPM (one check per cycle)
    // Example: 300 CPM target = 60000/300 = 200ms between checks
    // Each of 6 accounts gets 300/6 = 50 requests/min
    const cycleDelayMs = Math.floor(60000 / targetCPM);

    log(`🔄 ROTATION MODE: cycling through ${numSessions} accounts`, 'SUCCESS');
    log(`🔄 Cycle delay: ${cycleDelayMs}ms = ${targetCPM} checks/min`, 'SUCCESS');
    log(`🔄 Per account: ~${Math.floor(targetCPM / numSessions)} requests/min each`, 'SUCCESS');

    let lastTelegramUpdate = Date.now();
    let lastLogTime = Date.now();

    while (true) {
        const cycleStart = Date.now();

        // =====================================================
        // CHECK IF RESTART NEEDED (stale data or fingerprint expiry)
        // =====================================================

        // Check fingerprint expiry every minute
        if (FINGERPRINT_REGEN_MINS > 0 && Date.now() - lastFingerprintCheck > 60 * 1000) {
            lastFingerprintCheck = Date.now();
            if (checkFingerprintExpiry()) {
                shouldRefreshFingerprints = true;
            }
        }

        if (shouldRestartSessions || shouldRefreshFingerprints) {
            const reason = shouldRefreshFingerprints ? 'fingerprint expiry' : 'stale data';
            log(`🔄 Restarting all sessions (${reason})...`, 'WARN');
            shouldRestartSessions = false;
            shouldRefreshFingerprints = false;

            // Close all browsers
            for (const session of browserSessions) {
                await session.browser.close().catch(() => {});
            }
            browserSessions.length = 0;

            // Re-login all accounts (fingerprints will auto-regenerate if expired)
            for (const account of CONFIG.accounts) {
                try {
                    const session = await loginAccount(account);
                    browserSessions.push(session);
                } catch (error) {
                    log(`Failed to restart ${account.email}: ${error.message}`, 'ERROR');
                }
            }

            log(`✅ Restarted ${browserSessions.length} sessions`, 'SUCCESS');
            sendTelegram(`✅ <b>Sessions Restarted</b>\n${browserSessions.length} accounts active\nReason: ${reason}`);
            continue;
        }

        try {
            // TRUE TOKEN ROTATION: fire ONE session at a time, round-robin
            const session = browserSessions[currentSessionIndex];
            let checkSuccess = true;

            try {
                await triggerDateCheck(session);
            } catch (e) {
                checkSuccess = false;
                if (e.message === 'PAGE_DEAD') {
                    log(`Session ${session.email} died, restarting...`, 'WARN');
                    try {
                        await session.browser.close().catch(() => {});
                        const account = CONFIG.accounts.find(a => a.email === session.email);
                        const newSession = await loginAccount(account);
                        Object.assign(session, newSession);
                    } catch (restartErr) {
                        log(`Failed to restart ${session.email}: ${restartErr.message}`, 'ERROR');
                    }
                }
            }

            totalChecks++;

            // Rotate to next account
            currentSessionIndex = (currentSessionIndex + 1) % numSessions;

            // =====================================================
            // CHECK FOR BOOKABLE SLOTS - PARALLEL BOOKING (all sessions race!)
            // =====================================================
            const bookingReady = Date.now() >= bookingEnabledTime;
            const cooldownPassed = Date.now() >= lastBookingAttempt + BOOKING_COOLDOWN_MS;
            if (!bookingInProgress && bookingReady && cooldownPassed) {
                const bookableSession = browserSessions.find(s =>
                    s.availableDate && isDateInRange(s.availableDate.date)
                );

                if (bookableSession) {
                    const targetDate = bookableSession.availableDate.date;
                    log(`🎯 MATCH FOUND: ${targetDate} - PARALLEL BOOKING ALL ACCOUNTS!`, 'BOOK');

                    // Fire ALL sessions simultaneously - first one wins!
                    await performParallelBooking(targetDate);
                }
            }

            // Stats
            const elapsedMinutes = (Date.now() - startTime) / 60000;
            const cpm = (totalChecks / elapsedMinutes).toFixed(1);
            const closestDisplay = closestSlotFound?.date || 'N/A';

            // Calculate current latency from sessions
            const latencies = browserSessions
                .filter(s => s.lastLatency > 0)
                .map(s => s.lastLatency);
            const currentAvgLatency = latencies.length > 0
                ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
                : 0;
            const latencyDisplay = currentAvgLatency > 0 ? `${currentAvgLatency}ms` : '--';

            // Log every second
            if (Date.now() - lastLogTime >= 1000) {
                const currentAccount = session.email.split('@')[0];
                const latestDates = [...new Set(browserSessions
                    .filter(s => s.availableDate)
                    .map(s => s.availableDate.date))]
                    .join(', ') || 'SEARCHING';

                // Booking countdown
                const bookingCountdown = bookingReady
                    ? '✅ READY'
                    : `⏳ ${Math.ceil((bookingEnabledTime - Date.now()) / 1000)}s`;

                console.log(
                    `\x1b[44m[${cpm} CPM]\x1b[0m #${totalChecks} | ` +
                    `Latency: ${latencyDisplay} | ` +
                    `Account: ${currentAccount} (${currentSessionIndex + 1}/${numSessions}) | ` +
                    `Slot: ${latestDates} | ` +
                    `Book: ${bookingCountdown}`
                );
                lastLogTime = Date.now();
            }

            // Telegram update every 2 min
            if (Date.now() - lastTelegramUpdate > 120000) {
                const avgLatencyDisplay = avgLatency > 0 ? `${Math.round(avgLatency)}ms` : '--';
                const minLatencyDisplay = minLatency < Infinity ? `${minLatency}ms` : '--';
                const maxLatencyDisplay = maxLatency > 0 ? `${maxLatency}ms` : '--';

                // Get current slot from sessions
                const currentSlot = browserSessions
                    .filter(s => s.availableDate)
                    .map(s => s.availableDate.date)[0] || 'SEARCHING';

                // Calculate next verify time
                const verifyIntervalMs = CONFIG.verify.intervalMins * 60 * 1000;
                const nextVerifyIn = lastVerifyTime > 0
                    ? Math.max(0, Math.ceil((verifyIntervalMs - (Date.now() - lastVerifyTime)) / 60000))
                    : CONFIG.verify.intervalMins;

                // Calculate fingerprint age and next refresh
                let fpAgeDisplay = '--';
                let fpRefreshDisplay = '--';
                if (FINGERPRINT_REGEN_MINS > 0) {
                    const fingerprints = loadFingerprints();
                    const firstFp = fingerprints[browserSessions[0]?.email];
                    if (firstFp?.createdAt) {
                        const ageMins = (Date.now() - firstFp.createdAt) / (1000 * 60);
                        fpAgeDisplay = `${ageMins.toFixed(0)}m`;
                        const remainingMins = Math.max(0, FINGERPRINT_REGEN_MINS - ageMins);
                        fpRefreshDisplay = `${Math.ceil(remainingMins)}m`;
                    }
                }

                sendTelegram(
                    `📊 <b>Status</b>\n` +
                    `⚡ ${cpm} CPM | ${totalChecks} checks\n` +
                    `🔄 ${browserSessions.length} rotating accounts\n` +
                    `⏱ Latency: ${avgLatencyDisplay} avg (${minLatencyDisplay}-${maxLatencyDisplay})\n` +
                    `📅 Current: ${currentSlot}\n` +
                    `📅 Best: ${closestDisplay}\n` +
                    `🔍 Next verify: ${nextVerifyIn}m\n` +
                    `🎭 Fingerprint: ${fpAgeDisplay} old (refresh in ${fpRefreshDisplay})`
                );
                lastTelegramUpdate = Date.now();
            }

            // Wait for cycle delay (minus time spent in cycle)
            const cycleTime = Date.now() - cycleStart;
            const waitTime = Math.max(0, cycleDelayMs - cycleTime);
            if (waitTime > 0) {
                await new Promise(r => setTimeout(r, waitTime));
            }

        } catch (error) {
            log(`Cycle error: ${error.message}`, 'ERROR');
            await new Promise(r => setTimeout(r, 500));
        }
    }
}

// ============================================================================
// CLEANUP
// ============================================================================
async function cleanup() {
    log('\nShutting down...', 'WARN');
    sendTelegram('🛑 <b>Bot Stopped</b>');

    for (const session of browserSessions) {
        try {
            await session.browser.close();
        } catch {}
    }

    process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('uncaughtException', (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Crash</b>\n${err.message}`);
    setTimeout(() => main(), 10000);
});

// Start
main();
