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

function getFingerprintForAccount(email) {
    const fingerprints = loadFingerprints();

    if (fingerprints[email]) {
        console.log(`[FINGERPRINT] Loaded existing fingerprint for ${email.split('@')[0]}`);
        return fingerprints[email];
    }

    // Generate new fingerprint for this account
    // Store the FULL object (fingerprint + headers) for injection
    const fingerprintWithHeaders = fingerprintGenerator.getFingerprint({
        locales: ['en-CA', 'en-US', 'en'],
    });

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
const BOOKING_DELAY_MS = 60000;  // Wait 1 minute before allowing booking
let bookingEnabledTime = 0;      // When booking becomes allowed
let closestSlotFound = null;
const startTime = Date.now();

// Latency tracking
let avgLatency = 0;
let latencyCount = 0;
let minLatency = Infinity;
let maxLatency = 0;

// Verify timing
let lastVerifyTime = 0;

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
                    // Only book after login phase + delay is complete
                    const bookingReady = loginPhaseComplete && Date.now() >= bookingEnabledTime;
                    if (bookingReady && isDateInRange(session.availableDate.date) && !bookingInProgress) {
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
// BOOKING - HYBRID (Direct POST with Form Fallback)
// ============================================================================
async function performBookingDirect(session, date) {
    const startMs = Date.now();
    const page = session.page;

    // Use PRE-CACHED IDs (no DOM query needed!)
    const scheduleId = session.scheduleId;
    const facilityId = session.facilityId;
    const csrf = session.csrfToken;
    const accountName = session.email.split('@')[0];

    log(`⚡ [${accountName}] BOOKING: ${date}`, 'BOOK');

    try {
        // Ensure we're on the appointment page
        const currentUrl = page.url();
        if (!currentUrl.includes('/appointment')) {
            await page.goto(`${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`, {
                waitUntil: 'domcontentloaded',
                timeout: 5000
            }).catch(() => {});
        }

        // STEP 1: Fetch times (reduced timeout: 2s)
        const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/times/${facilityId}.json?date=${date}&appointments[expedite]=false`;

        const timeResult = await Promise.race([
            page.evaluate(async ({ url, csrf }) => {
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
            }, { url: timesUrl, csrf }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), 2000))
        ]).catch(e => ({ error: e.message }));

        if (timeResult.error || !timeResult.time) {
            return { success: false, error: timeResult.error || 'No times', session };
        }

        const time = timeResult.time;
        log(`⏰ [${accountName}] Time: ${time}`, 'SUCCESS');

        // STEP 2: FORM-BASED BOOKING (more reliable than Direct POST)
        // Set date + time + submit via DOM manipulation
        const bookResult = await page.evaluate(async ({ date, time, facilityId }) => {
            try {
                // Select facility if not selected
                const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
                if (facilitySelect && facilitySelect.value !== facilityId) {
                    facilitySelect.value = facilityId;
                    facilitySelect.dispatchEvent(new Event('change', { bubbles: true }));
                }

                // Set date
                const dateInput = document.querySelector('#appointments_consulate_appointment_date');
                if (!dateInput) return { error: 'No date input found' };

                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(dateInput).trigger('change');

                // Wait a tiny bit for time dropdown to populate
                await new Promise(r => setTimeout(r, 100));

                // Set time
                const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
                if (timeSelect) {
                    // Add option if needed
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

                // Submit form
                const form = document.querySelector('form#appointment-form') ||
                             document.querySelector('form[action*="appointment"]') ||
                             dateInput.closest('form');
                if (form) {
                    form.submit();
                    return { submitted: true };
                } else {
                    const submitBtn = document.querySelector('#appointments_submit');
                    if (submitBtn) {
                        submitBtn.click();
                        return { submitted: true };
                    }
                    return { error: 'No form/submit found' };
                }
            } catch (e) {
                return { error: e.message };
            }
        }, { date, time, facilityId });

        if (bookResult.error) {
            return { success: false, error: bookResult.error, session };
        }

        // Wait for confirm page
        try {
            await page.waitForSelector('a.button.alert', { timeout: 2000 });
        } catch (e) {
            // Might already be confirmed or different page
        }

        // Click confirm
        try {
            const confirmBtn = await page.$('a.button.alert') || await page.$('input[value="Confirm"]');
            if (confirmBtn) {
                await confirmBtn.click();
                log(`✅ [${accountName}] Confirm clicked`, 'SUCCESS');
            }
        } catch (e) {
            // Context destroyed = navigation = likely success
            if (e.message.includes('context') || e.message.includes('destroyed')) {
                const elapsed = Date.now() - startMs;
                return { success: true, elapsed, time, session, uncertain: true };
            }
        }

        const elapsed = Date.now() - startMs;
        return { success: true, elapsed, time, session, uncertain: true };

    } catch (error) {
        // Context destroyed often means success (navigation happened)
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            const elapsed = Date.now() - startMs;
            return { success: true, elapsed, time: 'unknown', session, uncertain: true };
        }
        return { success: false, error: error.message, session };
    }
}

// ============================================================================
// PARALLEL BOOKING - All sessions try simultaneously, first wins
// ============================================================================
async function performParallelBooking(date) {
    if (bookingInProgress) return false;
    bookingInProgress = true;

    const startMs = Date.now();
    log(`🚀 PARALLEL BOOKING: ${date} with ALL ${browserSessions.length} accounts!`, 'BOOK');
    sendTelegram(`🚀 <b>PARALLEL BOOKING!</b>\n📅 ${date}\n📍 ${CONFIG.preferences.city}\n🔥 ${browserSessions.length} accounts racing!`);

    try {
        // Fire ALL sessions simultaneously
        const bookingPromises = browserSessions.map(session =>
            performBookingDirect(session, date)
        );

        // Wait for first success OR all failures
        const results = await Promise.all(bookingPromises);

        // Find winner
        const winner = results.find(r => r.success);
        const elapsed = Date.now() - startMs;

        if (winner) {
            log(`🎉 BOOKED in ${winner.elapsed}ms by ${winner.session.email}!`, 'SUCCESS');
            sendTelegram(
                `🎉 <b>BOOKED!</b>\n` +
                `📅 ${date}\n` +
                `⏰ ${winner.time}\n` +
                `⏱ ${winner.elapsed}ms\n` +
                `📧 ${winner.session.email}\n` +
                `${winner.uncertain ? '⚠️ Verify in account!' : '✅ Confirmed!'}`
            );

            log(`🛑 STOPPING - BOOKING COMPLETE`, 'SUCCESS');
            process.exit(0);
        } else {
            // All failed
            const errors = results.map(r => `${r.session.email.split('@')[0]}: ${r.error}`).join(', ');
            log(`❌ All ${browserSessions.length} booking attempts failed: ${errors}`, 'ERROR');
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
        // CHECK IF RESTART NEEDED (stale data detected)
        // =====================================================
        if (shouldRestartSessions) {
            log(`🔄 Restarting all sessions...`, 'WARN');
            shouldRestartSessions = false;

            // Close all browsers
            for (const session of browserSessions) {
                await session.browser.close().catch(() => {});
            }
            browserSessions.length = 0;

            // Re-login all accounts
            for (const account of CONFIG.accounts) {
                try {
                    const session = await loginAccount(account);
                    browserSessions.push(session);
                } catch (error) {
                    log(`Failed to restart ${account.email}: ${error.message}`, 'ERROR');
                }
            }

            log(`✅ Restarted ${browserSessions.length} sessions`, 'SUCCESS');
            sendTelegram(`✅ <b>Sessions Restarted</b>\n${browserSessions.length} accounts active`);
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
            if (!bookingInProgress && bookingReady) {
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

                sendTelegram(
                    `📊 <b>Status</b>\n` +
                    `⚡ ${cpm} CPM | ${totalChecks} checks\n` +
                    `🔄 ${browserSessions.length} rotating accounts\n` +
                    `⏱ Latency: ${avgLatencyDisplay} avg (${minLatencyDisplay}-${maxLatencyDisplay})\n` +
                    `📅 Current: ${currentSlot}\n` +
                    `📅 Best: ${closestDisplay}\n` +
                    `🔍 Next verify: ${nextVerifyIn}m`
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
