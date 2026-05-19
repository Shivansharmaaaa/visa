/**
 * ULTRA-FAST PURE API BOOKER
 *
 * Based on working1500ms.js booking speed + Pure API (no UI)
 * - Fixed time mode: SKIPS times API completely
 * - Pure API POST: No form filling, no button clicks
 * - Detailed timing breakdown for each step
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
        city: process.env.PREFERRED_CITY || 'Toronto',
        startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
        endDate: new Date(process.env.END_DATE || '2026-05-30'),
        targetCPM: parseInt(process.env.TARGET_CPM) || 300,
        // FIXED TIME - Set this to skip times API entirely!
        fixedTime: process.env.PREFERRED_TIME || process.env.FIXED_TIME || ''
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
let formToken = null;
let checkCount = 0;
let botStartTime = Date.now();
let closestSlotFound = null;

// Response listener state
let availableDate = null;
let lastResponseTime = 0;
let lastRequestTime = 0;
let lastLatency = 0;

// ============================================================================
// LOGGING
// ============================================================================
function log(message, level = 'INFO') {
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
    const colors = {
        'INFO': '\x1b[36m',
        'SUCCESS': '\x1b[32m',
        'WARN': '\x1b[33m',
        'ERROR': '\x1b[31m',
        'BOOK': '\x1b[42m\x1b[30m',
        'TIMING': '\x1b[45m\x1b[37m'
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
// RESPONSE LISTENER - INSTANT DATE DETECTION (from working1500ms.js)
// ============================================================================
function setupResponseListener(pg) {
    pg.on('response', async (response) => {
        try {
            const url = response.url();

            // Capture dates from API response
            if (url.includes('.json') && url.includes('days') && !url.includes('date=')) {
                const data = await response.json();
                if (data && Array.isArray(data) && data.length > 0) {
                    availableDate = data[0];
                    lastResponseTime = Date.now();
                    if (lastRequestTime > 0) {
                        lastLatency = lastResponseTime - lastRequestTime;
                    }

                    // Track closest
                    const slotDate = new Date(availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);

                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound)) {
                            closestSlotFound = availableDate.date;
                            log(`📅 New closest: ${closestSlotFound}`, 'SUCCESS');
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore parse errors
        }
    });
}

// ============================================================================
// TRIGGER DATE CHECK (re-select city to trigger API)
// ============================================================================
async function triggerDateCheck() {
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
    } catch (e) {
        // Ignore
    }
}

// ============================================================================
// FAST FORM SUBMIT (No CAPTCHA - Uses form.submit() like working1500ms.js)
// ============================================================================
async function fastFormSubmit(date, time) {
    try {
        // Set date + time + submit ALL AT ONCE (from working1500ms.js)
        await page.evaluate(({ date, time, facilityId }) => {
            // Set facility if needed
            const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
            if (facilitySelect && facilitySelect.value !== facilityId) {
                facilitySelect.value = facilityId;
                facilitySelect.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Set date
            const dateInput = document.querySelector('#appointments_consulate_appointment_date');
            if (dateInput) {
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(dateInput).trigger('change');
            }

            // Set time - add option if needed
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

            // Submit form directly
            const form = document.querySelector('form#appointment-form') ||
                        document.querySelector('form[action*="appointment"]') ||
                        dateInput?.closest('form');
            if (form) {
                form.submit();
            } else {
                const submitBtn = document.querySelector('#appointments_submit') ||
                                 document.querySelector('input[type="submit"][name="commit"]');
                if (submitBtn) submitBtn.click();
            }
        }, { date, time, facilityId: CONFIG.preferences.facilityId });

        // Wait for navigation (context destroyed = success)
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

        // Check current URL and page content
        const currentUrl = page.url();

        // Quick success check via URL
        if (currentUrl.includes('instructions')) {
            return { success: true, url: currentUrl };
        }

        // Click confirm if present
        const confirmClicked = await page.evaluate(() => {
            const btn = document.querySelector('a.button.alert') ||
                       document.querySelector('input[value="Confirm"]');
            if (btn) { btn.click(); return true; }
            return false;
        }).catch(() => false);

        if (confirmClicked) {
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            const finalUrl = page.url();
            if (finalUrl.includes('instructions')) {
                return { success: true, url: finalUrl };
            }
        }

        // Final content check
        const pageContent = await page.content().catch(() => '');
        const hasSuccess = pageContent.includes('Successfully') ||
                          pageContent.includes('scheduled') ||
                          pageContent.includes('Appointment Confirmation');
        const hasCaptcha = pageContent.includes('recaptcha') || pageContent.includes('g-recaptcha');
        const stillOnForm = pageContent.includes('appointments_submit');

        if (hasSuccess || currentUrl.includes('instructions')) {
            return { success: true, url: currentUrl };
        }

        if (hasCaptcha) {
            return { success: false, hasCaptcha: true };
        }

        if (stillOnForm) {
            return { success: false, stillOnForm: true };
        }

        return { success: false, url: currentUrl };

    } catch (error) {
        // Context destroyed often means navigation happened = likely success
        if (error.message.includes('context') || error.message.includes('destroyed') ||
            error.message.includes('navigation')) {
            return { success: true, navigated: true };
        }
        return { success: false, error: error.message };
    }
}

// ============================================================================
// ULTRA-FAST BOOKING WITH DETAILED TIMING
// ============================================================================
async function performUltraFastBooking(date) {
    const timings = {
        total: 0,
        getToken: 0,
        getTimes: 0,      // Will be 0 with fixed time
        apiSubmit: 0,
        steps: []
    };

    const totalStart = Date.now();
    const useFixedTime = !!CONFIG.preferences.fixedTime;

    log(``, 'BOOK');
    log(`══════════════════════════════════════════════════════`, 'BOOK');
    log(`  🚀 ULTRA-FAST BOOKING STARTED`, 'BOOK');
    log(`  📅 Date: ${date}`, 'BOOK');
    log(`  ⏰ Mode: ${useFixedTime ? `FIXED TIME (${CONFIG.preferences.fixedTime})` : 'Fetch first available'}`, 'BOOK');
    log(`══════════════════════════════════════════════════════`, 'BOOK');

    sendTelegram(
        `🚀 <b>BOOKING STARTED</b>\n` +
        `📅 ${date}\n` +
        `⏰ ${useFixedTime ? `Fixed: ${CONFIG.preferences.fixedTime}` : 'First available'}\n` +
        `📧 ${CONFIG.credentials.email}`
    );

    try {
        let selectedTime;
        let token;

        // ===== STEP 1: GET TOKEN =====
        const tokenStart = Date.now();
        log(`[STEP 1] Getting authenticity token...`, 'TIMING');

        token = await page.evaluate(() => {
            const input = document.querySelector('input[name="authenticity_token"]');
            return input ? input.value : null;
        });

        if (!token) token = formToken || csrfToken;

        timings.getToken = Date.now() - tokenStart;
        timings.steps.push({ name: 'Get Token', time: timings.getToken });
        log(`✅ Token: ${token?.substring(0, 20)}... (${timings.getToken}ms)`, 'SUCCESS');

        // ===== STEP 2: GET TIME (or use fixed) =====
        if (useFixedTime) {
            // FIXED TIME - SKIP API CALL!
            selectedTime = CONFIG.preferences.fixedTime;
            timings.getTimes = 0;
            timings.steps.push({ name: 'Get Times', time: 0, skipped: true });
            log(`[STEP 2] ⚡ SKIPPED - Using fixed time: ${selectedTime}`, 'TIMING');
        } else {
            // Fetch times from API
            const timesStart = Date.now();
            log(`[STEP 2] Fetching available times...`, 'TIMING');

            const timesUrl = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/times/${CONFIG.preferences.facilityId}.json?date=${date}&appointments[expedite]=false`;

            const timesResult = await page.evaluate(async ({ url, csrf }) => {
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
                    return await resp.json();
                } catch (e) {
                    return { error: e.message };
                }
            }, { url: timesUrl, csrf: csrfToken });

            timings.getTimes = Date.now() - timesStart;
            timings.steps.push({ name: 'Get Times', time: timings.getTimes });

            if (timesResult.error || !timesResult.available_times?.length) {
                log(`❌ No times available (${timings.getTimes}ms)`, 'ERROR');
                timings.total = Date.now() - totalStart;
                return { success: false, timings };
            }

            selectedTime = timesResult.available_times[0];
            log(`✅ Times: ${timesResult.available_times.length} available, using ${selectedTime} (${timings.getTimes}ms)`, 'SUCCESS');
        }

        // ===== STEP 3: FAST FORM SUBMIT (No CAPTCHA!) =====
        const submitStart = Date.now();
        log(`[STEP 3] FAST FORM SUBMIT: ${date} @ ${selectedTime}`, 'TIMING');

        const submitResult = await fastFormSubmit(date, selectedTime);
        timings.apiSubmit = Date.now() - submitStart;
        timings.steps.push({ name: 'Form Submit', time: timings.apiSubmit });
        timings.total = Date.now() - totalStart;

        if (submitResult.error) {
            log(`❌ Submit error: ${submitResult.error} (${timings.apiSubmit}ms)`, 'ERROR');
            printTimingReport(timings, false);
            return { success: false, timings };
        }

        // Check for captcha
        if (submitResult.hasCaptcha) {
            log(`⚠️ CAPTCHA DETECTED! (${timings.apiSubmit}ms)`, 'WARN');
            printTimingReport(timings, false, 'CAPTCHA');
            return { success: false, timings, captcha: true };
        }

        // Check for success
        if (submitResult.success) {
            log(``, 'SUCCESS');
            log(`🎉🎉🎉 BOOKING SUCCESSFUL! 🎉🎉🎉`, 'SUCCESS');
            printTimingReport(timings, true);

            sendTelegram(
                `🎉 <b>BOOKED!</b>\n\n` +
                `📅 Date: ${date}\n` +
                `⏰ Time: ${selectedTime}\n` +
                `📧 ${CONFIG.credentials.email}\n\n` +
                `⏱ <b>TIMING BREAKDOWN:</b>\n` +
                `├ Token: ${timings.getToken}ms\n` +
                `├ Times: ${timings.getTimes}ms ${useFixedTime ? '(SKIPPED!)' : ''}\n` +
                `├ Submit: ${timings.apiSubmit}ms\n` +
                `└ <b>TOTAL: ${timings.total}ms</b>\n\n` +
                `⚡ Fast Form + ${useFixedTime ? 'Fixed Time' : 'Dynamic Time'}`
            );

            return { success: true, timings, time: selectedTime };
        }

        // Not confirmed
        log(`❌ Booking not confirmed (${timings.apiSubmit}ms)`, 'ERROR');
        printTimingReport(timings, false, submitResult.stillOnForm ? 'Still on form' : 'Unknown');
        return { success: false, timings };

    } catch (error) {
        timings.total = Date.now() - totalStart;
        log(`❌ Booking error: ${error.message}`, 'ERROR');
        printTimingReport(timings, false, error.message);
        return { success: false, timings, error: error.message };
    }
}

// ============================================================================
// PRINT TIMING REPORT
// ============================================================================
function printTimingReport(timings, success, failReason = null) {
    const useFixedTime = !!CONFIG.preferences.fixedTime;

    console.log('');
    console.log('\x1b[45m\x1b[37m' + '═'.repeat(50) + '\x1b[0m');
    console.log('\x1b[45m\x1b[37m  ⏱  TIMING REPORT                              \x1b[0m');
    console.log('\x1b[45m\x1b[37m' + '═'.repeat(50) + '\x1b[0m');
    console.log('');

    // Step breakdown
    console.log('  \x1b[36mStep Breakdown:\x1b[0m');
    console.log('  ┌─────────────────────────────────────────┐');

    for (const step of timings.steps) {
        const timeStr = step.skipped ? 'SKIPPED' : `${step.time}ms`;
        const bar = step.skipped ? '' : '█'.repeat(Math.min(20, Math.floor(step.time / 50)));
        console.log(`  │ ${step.name.padEnd(15)} │ ${timeStr.padStart(10)} │ ${bar}`);
    }

    console.log('  └─────────────────────────────────────────┘');
    console.log('');

    // Total
    const totalColor = success ? '\x1b[32m' : '\x1b[31m';
    const statusIcon = success ? '✅' : '❌';
    const statusText = success ? 'SUCCESS' : `FAILED${failReason ? ` (${failReason})` : ''}`;

    console.log(`  ${totalColor}┌─────────────────────────────────────────┐\x1b[0m`);
    console.log(`  ${totalColor}│  TOTAL TIME: ${String(timings.total).padStart(6)}ms                   │\x1b[0m`);
    console.log(`  ${totalColor}│  STATUS: ${statusIcon} ${statusText.padEnd(27)} │\x1b[0m`);
    console.log(`  ${totalColor}└─────────────────────────────────────────┘\x1b[0m`);
    console.log('');

    // Summary
    if (success) {
        console.log(`  \x1b[32m⚡ Mode: ${useFixedTime ? 'FIXED TIME (times API skipped!)' : 'Dynamic time'}\x1b[0m`);
        if (useFixedTime) {
            console.log(`  \x1b[32m⚡ Time saved by skipping times API: ~800ms\x1b[0m`);
        }
    }

    console.log('');
    console.log('\x1b[45m\x1b[37m' + '═'.repeat(50) + '\x1b[0m');
    console.log('');
}

// ============================================================================
// LOGIN
// ============================================================================
async function login() {
    log('Logging in...');

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

    // Navigate to appointment page
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
        CONFIG.preferences.facilityId = target.value;
        log(`Selected city: ${target.text} (ID: ${target.value})`);
    }

    // Get tokens
    csrfToken = await page.evaluate(() => {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    });

    formToken = await page.evaluate(() => {
        const input = document.querySelector('input[name="authenticity_token"]');
        return input ? input.value : null;
    });

    log(`✅ Logged in! Schedule: ${scheduleId}`, 'SUCCESS');
    return true;
}

// ============================================================================
// MAIN MONITORING LOOP
// ============================================================================
async function runMonitoringLoop() {
    const delayMs = getDelay(CONFIG.preferences.targetCPM);
    const useFixedTime = !!CONFIG.preferences.fixedTime;

    log(`Starting monitoring: ${CONFIG.preferences.targetCPM} CPM (${delayMs}ms delay)`, 'INFO');
    log(`Fixed time mode: ${useFixedTime ? `YES (${CONFIG.preferences.fixedTime})` : 'NO'}`, 'INFO');

    let lastLogTime = Date.now();

    while (true) {
        try {
            checkCount++;

            // Trigger date check
            await triggerDateCheck();

            // Wait for response
            const prevTime = lastResponseTime;
            let elapsed = 0;
            while (lastResponseTime === prevTime && elapsed < 100) {
                await new Promise(r => setTimeout(r, 25));
                elapsed += 25;
            }

            // Stats logging
            if (Date.now() - lastLogTime >= 1000) {
                const runMins = (Date.now() - botStartTime) / 60000;
                const cpm = (checkCount / runMins).toFixed(1);
                const dateDisplay = availableDate?.date || 'SEARCHING';
                const latencyDisplay = lastLatency > 0 ? `${lastLatency}ms` : '--';

                console.log(
                    `\x1b[44m[${cpm} CPM]\x1b[0m #${checkCount} | ` +
                    `Latency: ${latencyDisplay} | ` +
                    `Slot: ${dateDisplay} | ` +
                    `Best: ${closestSlotFound || 'N/A'}`
                );
                lastLogTime = Date.now();
            }

            // Check if date in range - BOOK!
            if (availableDate && isDateInRange(availableDate.date)) {
                log(`🎯 DATE IN RANGE: ${availableDate.date}`, 'BOOK');

                const result = await performUltraFastBooking(availableDate.date);

                if (result.success) {
                    log('🛑 STOPPING - BOOKING COMPLETE', 'SUCCESS');
                    process.exit(0);
                } else if (result.captcha) {
                    log('⚠️ Captcha detected - waiting 30s', 'WARN');
                    await new Promise(r => setTimeout(r, 30000));
                } else {
                    log(`Booking failed - continuing monitoring`, 'WARN');
                }
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
    const useFixedTime = !!CONFIG.preferences.fixedTime;

    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[42m\x1b[30m  ULTRA-FAST BOOKER v2  \x1b[0m');
    console.log('\x1b[36m  Fast Form Submit (No CAPTCHA) | ' + (useFixedTime ? 'FIXED TIME' : 'Dynamic Time') + '\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    log(`Email: ${CONFIG.credentials.email}`);
    log(`City: ${CONFIG.preferences.city}`);
    log(`Facility: ${CONFIG.preferences.facilityId}`);
    log(`Target CPM: ${CONFIG.preferences.targetCPM}`);
    log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);

    if (useFixedTime) {
        log(`⚡ FIXED TIME: ${CONFIG.preferences.fixedTime}`, 'SUCCESS');
        log(`⚡ Times API will be SKIPPED during booking!`, 'SUCCESS');
    } else {
        log(`Dynamic time: Will fetch first available`, 'INFO');
    }

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
            log(`Using PROXY: ${CONFIG.proxy.server}`, 'INFO');
        }

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });

        page = await context.newPage();

        // Setup response listener for instant date detection
        setupResponseListener(page);

        await login();

        sendTelegram(
            `🚀 <b>Ultra-Fast Bot Started</b>\n` +
            `📧 ${CONFIG.credentials.email}\n` +
            `📍 ${CONFIG.preferences.city}\n` +
            `⚡ ${CONFIG.preferences.targetCPM} CPM\n` +
            `⏰ ${useFixedTime ? `Fixed: ${CONFIG.preferences.fixedTime}` : 'Dynamic time'}`
        );

        await runMonitoringLoop();

    } catch (error) {
        log(`Fatal: ${error.message}`, 'ERROR');
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
    sendTelegram('🛑 <b>Bot Stopped</b>');
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
