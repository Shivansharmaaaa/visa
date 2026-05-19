/**
 * PURE API BOOKING - No UI interactions for booking
 *
 * Flow:
 * 1. Browser login (needed for session cookies)
 * 2. API: Get available dates
 * 3. API: Get available times
 * 4. API: POST booking submission
 * 5. API: POST confirmation
 *
 * No dropdowns, no form filling, no button clicks during booking
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
    credentials: {
        email: process.env.VISA_EMAIL || process.env.ACCOUNT_1_EMAIL,
        password: process.env.VISA_PASSWORD || process.env.ACCOUNT_1_PASSWORD
    },
    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
        facilityId: process.env.FACILITY_ID || '94',
        startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
        endDate: new Date(process.env.END_DATE || '2026-05-30'),
        targetCPM: parseInt(process.env.TARGET_CPM) || 300,
        // Preferred time - if set, will try to book this time first (e.g., "10:00" or "09:30")
        // Leave empty to use first available time
        preferredTime: process.env.PREFERRED_TIME || ''
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
    }
};

// ============================================================================
// GLOBAL STATE
// ============================================================================
let browser = null;
let page = null;
let scheduleId = null;
let csrfToken = null;
let checkCount = 0;
let startTime = Date.now();
let closestSlotFound = null;

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
        'API': '\x1b[44m',
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
    return Math.floor(60000 / targetCPM);
}

// ============================================================================
// API: GET AVAILABLE DATES
// ============================================================================
async function apiGetDates() {
    const url = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/days/${CONFIG.preferences.facilityId}.json?appointments[expedite]=false`;

    const result = await page.evaluate(async ({ url, csrf }) => {
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
            return { data: await resp.json() };
        } catch (e) {
            return { error: e.message };
        }
    }, { url, csrf: csrfToken });

    return result;
}

// ============================================================================
// API: GET AVAILABLE TIMES FOR DATE
// ============================================================================
async function apiGetTimes(date) {
    const url = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/times/${CONFIG.preferences.facilityId}.json?date=${date}&appointments[expedite]=false`;

    const result = await page.evaluate(async ({ url, csrf }) => {
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
            return { data: await resp.json() };
        } catch (e) {
            return { error: e.message };
        }
    }, { url, csrf: csrfToken });

    return result;
}

// ============================================================================
// API: SUBMIT BOOKING (Pure POST - no form/UI)
// ============================================================================
async function apiSubmitBooking(date, time) {
    const url = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`;

    // Get the authenticity_token from the FORM (not meta tag - they're different!)
    const formToken = await page.evaluate(() => {
        const input = document.querySelector('input[name="authenticity_token"]');
        return input ? input.value : null;
    });

    const tokenToUse = formToken || csrfToken;

    const formData = {
        'utf8': '✓',
        'authenticity_token': tokenToUse,
        'confirmed_limit_message': '1',
        'use_consulate_appointment_capacity': 'true',
        'appointments[consulate_appointment][facility_id]': CONFIG.preferences.facilityId,
        'appointments[consulate_appointment][date]': date,
        'appointments[consulate_appointment][time]': time,
        'commit': 'Schedule Appointment'
    };

    log(`[API] POST ${url}`, 'API');
    log(`[API] Data: facility=${CONFIG.preferences.facilityId}, date=${date}, time=${time}`, 'API');
    log(`[API] Token: ${tokenToUse.substring(0, 20)}...`, 'API');

    const result = await page.evaluate(async ({ url, formData }) => {
        try {
            // Build form body exactly like browser would
            const body = new URLSearchParams();
            for (const [key, value] of Object.entries(formData)) {
                body.append(key, value);
            }

            const resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                redirect: 'follow',  // Follow redirects
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Origin': window.location.origin,
                    'Referer': window.location.href
                },
                body: body.toString()
            });

            const responseUrl = resp.url;
            const responseText = await resp.text();

            return {
                status: resp.status,
                url: responseUrl,
                redirected: resp.redirected,
                // Check for success indicators
                hasConfirmPage: responseText.includes('Confirm') || responseText.includes('confirm') || responseText.includes('Review'),
                hasSuccess: responseText.includes('Successfully') || responseText.includes('scheduled') || responseText.includes('Appointment Confirmation'),
                hasInstructions: responseUrl.includes('instructions'),
                hasError: responseText.includes('error') || responseText.includes('Error') || responseText.includes('alert'),
                hasCaptcha: responseText.includes('recaptcha') || responseText.includes('captcha'),
                // Extract confirm link if present
                confirmUrl: responseText.match(/href="([^"]*confirm[^"]*)"/)?.[1] ||
                           responseText.match(/action="([^"]*confirm[^"]*)"/)?.[1] || null,
                bodyPreview: responseText.substring(0, 800)
            };
        } catch (e) {
            return { error: e.message };
        }
    }, { url, formData });

    return result;
}

// ============================================================================
// API: CONFIRM BOOKING
// ============================================================================
async function apiConfirmBooking(confirmUrl) {
    const url = confirmUrl.startsWith('http') ? confirmUrl : `${CONFIG.preferences.baseUrl}${confirmUrl}`;

    log(`[API] Confirming: ${url}`, 'API');

    const result = await page.evaluate(async ({ url, csrf }) => {
        try {
            const resp = await fetch(url, {
                method: 'GET',
                credentials: 'include',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml',
                    'X-CSRF-Token': csrf
                }
            });

            const responseText = await resp.text();

            return {
                status: resp.status,
                url: resp.url,
                hasSuccess: responseText.includes('Successfully') ||
                           responseText.includes('scheduled') ||
                           responseText.includes('Appointment Confirmation'),
                bodyPreview: responseText.substring(0, 500)
            };
        } catch (e) {
            return { error: e.message };
        }
    }, { url, csrf: csrfToken });

    return result;
}

// ============================================================================
// FULL API BOOKING FLOW - PURE API, NO UI
// ============================================================================
async function performApiBooking(date) {
    const totalStart = Date.now();
    const timings = {
        timesFetch: 0,
        submit: 0,
        confirm: 0,
        total: 0
    };

    log(`🚀 [PURE API BOOKING] Starting for ${date}`, 'BOOK');
    sendTelegram(`🚀 <b>PURE API BOOKING</b>\n📅 ${date}`);

    try {
        // ===== STEP 1: GET TIMES (API) =====
        const timesStart = Date.now();
        log(`[STEP 1/3] API: Fetching times...`, 'API');

        const timesResult = await apiGetTimes(date);
        timings.timesFetch = Date.now() - timesStart;

        if (timesResult.error) {
            log(`❌ Times API failed: ${timesResult.error} (${timings.timesFetch}ms)`, 'ERROR');
            return { success: false, timings };
        }

        const times = timesResult.data?.available_times || [];
        if (times.length === 0) {
            log(`❌ No times available (${timings.timesFetch}ms)`, 'ERROR');
            return { success: false, timings };
        }

        // Select time: prefer configured time, otherwise first available
        let selectedTime = times[0];
        if (CONFIG.preferences.preferredTime) {
            const preferred = CONFIG.preferences.preferredTime;
            if (times.includes(preferred)) {
                selectedTime = preferred;
                log(`✅ Using preferred time: ${selectedTime}`, 'SUCCESS');
            } else {
                log(`⚠️ Preferred time ${preferred} not available, using ${selectedTime}`, 'WARN');
            }
        }

        log(`✅ Times fetched: ${times.length} available, selected: ${selectedTime} (${timings.timesFetch}ms)`, 'SUCCESS');

        // ===== STEP 2: SUBMIT BOOKING (API POST) =====
        const submitStart = Date.now();
        log(`[STEP 2/3] API: Submitting booking...`, 'API');

        const submitResult = await apiSubmitBooking(date, selectedTime);
        timings.submit = Date.now() - submitStart;

        if (submitResult.error) {
            log(`❌ Submit failed: ${submitResult.error} (${timings.submit}ms)`, 'ERROR');
            return { success: false, timings };
        }

        log(`Submit: status=${submitResult.status}, url=${submitResult.url} (${timings.submit}ms)`, 'API');

        // Check for captcha block
        if (submitResult.hasCaptcha) {
            log(`⚠️ CAPTCHA detected! (${timings.submit}ms)`, 'WARN');
            return { success: false, timings, captcha: true };
        }

        // Check if redirected to instructions (INSTANT SUCCESS!)
        if (submitResult.hasInstructions || submitResult.hasSuccess) {
            timings.total = Date.now() - totalStart;
            log(`🎉 BOOKED! Total: ${timings.total}ms (times: ${timings.timesFetch}ms, submit: ${timings.submit}ms)`, 'SUCCESS');
            sendTelegram(
                `🎉 <b>BOOKED!</b>\n` +
                `📅 ${date}\n⏰ ${selectedTime}\n\n` +
                `⏱ <b>Timing Breakdown:</b>\n` +
                `• Times API: ${timings.timesFetch}ms\n` +
                `• Submit API: ${timings.submit}ms\n` +
                `• <b>TOTAL: ${timings.total}ms</b>\n` +
                `🔥 Pure API - Zero UI!`
            );
            return { success: true, timings, time: selectedTime };
        }

        // ===== STEP 3: CONFIRM IF NEEDED (API) =====
        if (submitResult.confirmUrl || submitResult.hasConfirmPage) {
            const confirmStart = Date.now();
            log(`[STEP 3/3] API: Confirming...`, 'API');

            let confirmUrl = submitResult.confirmUrl;
            if (!confirmUrl) {
                confirmUrl = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`;
            }

            const confirmResult = await apiConfirmBooking(confirmUrl);
            timings.confirm = Date.now() - confirmStart;
            timings.total = Date.now() - totalStart;

            if (confirmResult.hasSuccess || confirmResult.url?.includes('instructions')) {
                log(`🎉 CONFIRMED! Total: ${timings.total}ms (times: ${timings.timesFetch}ms, submit: ${timings.submit}ms, confirm: ${timings.confirm}ms)`, 'SUCCESS');
                sendTelegram(
                    `🎉 <b>CONFIRMED!</b>\n` +
                    `📅 ${date}\n⏰ ${selectedTime}\n\n` +
                    `⏱ <b>Timing Breakdown:</b>\n` +
                    `• Times API: ${timings.timesFetch}ms\n` +
                    `• Submit API: ${timings.submit}ms\n` +
                    `• Confirm API: ${timings.confirm}ms\n` +
                    `• <b>TOTAL: ${timings.total}ms</b>\n` +
                    `🔥 Pure API - Zero UI!`
                );
                return { success: true, timings, time: selectedTime };
            }

            log(`Confirm response: ${JSON.stringify(confirmResult).substring(0, 200)}`, 'API');
        }

        timings.total = Date.now() - totalStart;
        log(`❌ Booking not confirmed. Total time: ${timings.total}ms`, 'ERROR');
        log(`Response preview: ${submitResult.bodyPreview?.substring(0, 300)}`, 'ERROR');
        return { success: false, timings };

    } catch (error) {
        timings.total = Date.now() - totalStart;
        log(`❌ API Booking error: ${error.message} (${timings.total}ms)`, 'ERROR');
        return { success: false, timings, error: error.message };
    }
}

// ============================================================================
// LOGIN (Still needs browser for session)
// ============================================================================
async function login() {
    log('Logging in via browser (for session cookies)...');

    await page.goto(`${CONFIG.preferences.baseUrl}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });
    await page.fill('#user_email', CONFIG.credentials.email);
    await page.fill('#user_password', CONFIG.credentials.password);

    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await page.click('input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (page.url().includes('sign_in')) {
        throw new Error('LOGIN_FAILED');
    }

    // Get schedule ID
    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 20000 });

    const href = await page.$eval(continueBtn, el => el.href);
    scheduleId = href.match(/schedule\/(\d+)/)?.[1];

    if (!scheduleId) {
        throw new Error('Could not extract schedule ID');
    }

    // Navigate to appointment page to get CSRF token
    await page.click(continueBtn);
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Get CSRF token
    csrfToken = await page.evaluate(() => {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    });

    log(`✅ Logged in! Schedule: ${scheduleId}`, 'SUCCESS');
    log(`CSRF Token: ${csrfToken.substring(0, 20)}...`, 'INFO');

    return true;
}

// ============================================================================
// MAIN MONITORING LOOP
// ============================================================================
async function runMonitoringLoop() {
    const delayMs = getDelay(CONFIG.preferences.targetCPM);
    log(`Starting API monitoring: ${CONFIG.preferences.targetCPM} CPM (${delayMs}ms delay)`, 'INFO');

    let lastLogTime = Date.now();

    while (true) {
        try {
            checkCount++;

            // API: Get available dates
            const datesResult = await apiGetDates();

            if (datesResult.error) {
                if (checkCount % 10 === 0) {
                    log(`Dates API error: ${datesResult.error}`, 'WARN');
                }
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const dates = datesResult.data || [];
            const firstDate = dates[0]?.date;

            // Track closest slot
            if (firstDate) {
                const slotDate = new Date(firstDate);
                const today = new Date();
                today.setHours(0, 0, 0, 0);

                if (slotDate >= today) {
                    if (!closestSlotFound || slotDate < new Date(closestSlotFound)) {
                        closestSlotFound = firstDate;
                        log(`📅 New closest: ${closestSlotFound}`, 'SUCCESS');
                    }
                }

                // CHECK IF IN RANGE - TRIGGER BOOKING
                if (isDateInRange(firstDate)) {
                    log(`🎯 DATE IN RANGE: ${firstDate}`, 'BOOK');

                    const result = await performApiBooking(firstDate);

                    if (result.success) {
                        log('🛑 STOPPING - BOOKING COMPLETE', 'SUCCESS');
                        log(`📊 Final Timing: Times=${result.timings.timesFetch}ms, Submit=${result.timings.submit}ms, Confirm=${result.timings.confirm}ms, TOTAL=${result.timings.total}ms`, 'SUCCESS');
                        process.exit(0);
                    } else if (result.captcha) {
                        log('⚠️ Captcha blocked booking - waiting 30s before retry', 'WARN');
                        await new Promise(r => setTimeout(r, 30000));
                    } else {
                        log(`❌ Booking failed - Timing: ${result.timings.total}ms`, 'ERROR');
                    }
                }
            }

            // Stats logging
            if (Date.now() - lastLogTime >= 1000) {
                const elapsed = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsed).toFixed(1);
                const dateDisplay = firstDate || 'SEARCHING';
                const bestDisplay = closestSlotFound || 'N/A';

                console.log(
                    `\x1b[44m[API ${cpm} CPM]\x1b[0m #${checkCount} | ` +
                    `Slot: ${dateDisplay} | Best: ${bestDisplay}`
                );
                lastLogTime = Date.now();
            }

            await new Promise(r => setTimeout(r, delayMs));

        } catch (error) {
            log(`Loop error: ${error.message}`, 'ERROR');
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[42m\x1b[30m  PURE API BOOKING BOT  \x1b[0m');
    console.log('\x1b[36m  No UI for booking - Direct API calls\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    log(`Email: ${CONFIG.credentials.email}`);
    log(`Facility: ${CONFIG.preferences.facilityId}`);
    log(`Target CPM: ${CONFIG.preferences.targetCPM}`);
    log(`Preferred Time: ${CONFIG.preferences.preferredTime || 'First available'}`);
    log(`Mode: PURE API (zero UI for booking)`);

    try {
        // Launch browser
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
            log(`Using PROXY: ${CONFIG.proxy.server}`, 'INFO');
        }

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });

        page = await context.newPage();

        // Login
        await login();

        sendTelegram(
            `🚀 <b>API Bot Started</b>\n` +
            `📧 ${CONFIG.credentials.email}\n` +
            `⚡ ${CONFIG.preferences.targetCPM} CPM\n` +
            `🔥 Pure API booking enabled`
        );

        // Start monitoring
        await runMonitoringLoop();

    } catch (error) {
        log(`Fatal error: ${error.message}`, 'ERROR');
        sendTelegram(`❌ <b>Bot Error</b>\n${error.message}`);

        if (browser) await browser.close().catch(() => {});

        log('Restarting in 10s...');
        await new Promise(r => setTimeout(r, 10000));
        return main();
    }
}

// ============================================================================
// CLEANUP
// ============================================================================
process.on('SIGINT', async () => {
    log('Shutting down...', 'WARN');
    sendTelegram('🛑 <b>API Bot Stopped</b>');
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Crash</b>\n${err.message}`);
    setTimeout(() => main(), 10000);
});

// Start
main();
