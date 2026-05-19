/**
 * ULTRA-FAST API BOOKING - Maximum Speed Optimization
 *
 * Optimizations:
 * 1. Native Node.js fetch (no page.evaluate overhead)
 * 2. Parallel token + times fetch
 * 3. HTTP Keep-Alive (connection reuse)
 * 4. Connection pre-warming during monitoring
 * 5. Minimal overhead in booking path
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
const http = require('http');
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
let csrfToken = null;      // Meta tag token
let formToken = null;      // Form hidden input token (the important one!)
let sessionCookies = '';   // Extracted cookies for native fetch
let checkCount = 0;
let startTime = Date.now();
let closestSlotFound = null;

// Keep-Alive HTTP Agent for connection reuse
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 10
});

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
        'BOOK': '\x1b[42m\x1b[30m',
        'FAST': '\x1b[45m\x1b[37m'
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
// EXTRACT COOKIES FROM BROWSER
// ============================================================================
async function extractCookies() {
    const cookies = await page.context().cookies();
    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    log(`Extracted ${cookies.length} cookies for native fetch`, 'SUCCESS');
    return sessionCookies;
}

// ============================================================================
// REFRESH FORM TOKEN (needs page context, but we cache it)
// ============================================================================
async function refreshFormToken() {
    formToken = await page.evaluate(() => {
        const input = document.querySelector('input[name="authenticity_token"]');
        return input ? input.value : null;
    });
    log(`Form token refreshed: ${formToken?.substring(0, 20)}...`, 'INFO');
    return formToken;
}

// ============================================================================
// NATIVE FETCH - ULTRA FAST (bypasses Puppeteer overhead)
// ============================================================================
async function nativeFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);

        const reqOptions = {
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            agent: httpsAgent,
            headers: {
                'Cookie': sessionCookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': options.accept || 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-Token': csrfToken,
                'Referer': `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`,
                'Origin': 'https://ais.usvisa-info.com',
                ...options.headers
            }
        };

        const req = https.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    url: res.headers.location || url,
                    text: () => Promise.resolve(data),
                    json: () => Promise.resolve(JSON.parse(data))
                });
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        if (options.body) {
            req.write(options.body);
        }
        req.end();
    });
}

// ============================================================================
// API: GET DATES (Native - for monitoring)
// Uses page.evaluate for monitoring (proxy support), native for booking
// ============================================================================
async function apiGetDates(useNative = false) {
    const url = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/days/${CONFIG.preferences.facilityId}.json?appointments[expedite]=false`;

    if (useNative && !CONFIG.proxy.enabled) {
        // Native fetch - faster but no proxy
        try {
            const resp = await nativeFetch(url);
            return { data: await resp.json() };
        } catch (e) {
            return { error: e.message };
        }
    }

    // Use page.evaluate for proxy support
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
// API: GET TIMES (Native when possible)
// ============================================================================
async function apiGetTimes(date, useNative = false) {
    const url = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment/times/${CONFIG.preferences.facilityId}.json?date=${date}&appointments[expedite]=false`;

    if (useNative && !CONFIG.proxy.enabled) {
        try {
            const resp = await nativeFetch(url);
            return { data: await resp.json() };
        } catch (e) {
            return { error: e.message };
        }
    }

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
// BROWSER-BASED SUBMISSION (Fallback for CAPTCHA)
// ============================================================================
async function browserSubmitBooking(date, time) {
    log(`🔄 Switching to BROWSER-BASED submission (Captcha fallback)...`, 'WARN');
    
    try {
        // 1. Navigate to appointment page
        const currentUrl = page.url();
        const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
        if (!currentUrl.includes('/appointment')) {
            await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        }

        // 2. Fill the form using native Playwright commands (more reliable for bypass)
        log(`📝 Filling form: ${date} @ ${time}`, 'INFO');
        
        await page.evaluate(({ date, time }) => {
            const dateInput = document.querySelector('#appointments_consulate_appointment_date');
            if (dateInput) {
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') $(dateInput).trigger('change');
            }

            const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
            if (timeSelect) {
                // Add option if it doesn't exist
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

        // 3. Click submit
        log(`🖱️ Clicking submit button...`, 'INFO');
        await page.click('input[type="submit"][name="commit"]');

        // 4. Wait for navigation or CAPTCHA
        log(`⏳ Waiting for response (user may need to solve CAPTCHA if visible)...`, 'INFO');
        sendTelegram(`⚠️ <b>CAPTCHA DETECTED</b>\nSwitching to browser mode. Please solve if needed!`);
        
        // Wait up to 60 seconds for the user to solve it or for the page to navigate
        const startTime = Date.now();
        while (Date.now() - startTime < 60000) {
            const url = page.url();
            const content = await page.content().catch(() => '');
            
            if (url.includes('instructions') || 
                content.includes('Successfully') || 
                content.includes('scheduled') || 
                content.includes('Appointment Confirmation')) {
                return { success: true, url };
            }

            // Check if there's a confirm button (sometimes required after submit)
            const hasConfirm = await page.evaluate(() => {
                const btn = document.querySelector('a.button.alert') || document.querySelector('input[value="Confirm"]');
                if (btn) { btn.click(); return true; }
                return false;
            }).catch(() => false);

            if (hasConfirm) {
                log(`✅ Confirm button clicked!`, 'SUCCESS');
            }

            await page.waitForTimeout(2000);
        }

        return { success: false, error: 'Timeout waiting for success' };
    } catch (error) {
        log(`❌ Browser submit error: ${error.message}`, 'ERROR');
        return { success: false, error: error.message };
    }
}

// ============================================================================
// API: SUBMIT BOOKING (Native when possible)
// ============================================================================
async function apiSubmitBooking(date, time, token) {
    const url = `${CONFIG.preferences.baseUrl}/schedule/${scheduleId}/appointment`;

    const formData = new URLSearchParams({
        'utf8': '✓',
        'authenticity_token': token,
        'confirmed_limit_message': '1',
        'use_consulate_appointment_capacity': 'true',
        'appointments[consulate_appointment][facility_id]': CONFIG.preferences.facilityId,
        'appointments[consulate_appointment][date]': date,
        'appointments[consulate_appointment][time]': time,
        'commit': 'Schedule Appointment'
    }).toString();

    if (!CONFIG.proxy.enabled) {
        // Native POST - faster but no proxy
        try {
            const resp = await nativeFetch(url, {
                method: 'POST',
                accept: 'text/html,application/xhtml+xml',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Content-Length': Buffer.byteLength(formData)
                },
                body: formData
            });

            const responseText = await resp.text();
            return {
                status: resp.status,
                url: resp.url,
                hasSuccess: responseText.includes('Successfully') ||
                           responseText.includes('scheduled') ||
                           responseText.includes('Appointment Confirmation'),
                hasInstructions: resp.url.includes('instructions') || resp.headers.location?.includes('instructions'),
                hasCaptcha: responseText.includes('recaptcha'),
                bodyPreview: responseText.substring(0, 800)
            };
        } catch (e) {
            return { error: e.message };
        }
    }

    // Use page.evaluate for proxy support
    const result = await page.evaluate(async ({ url, formData, csrf }) => {
        try {
            const resp = await fetch(url, {
                method: 'POST',
                credentials: 'include',
                redirect: 'follow',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Accept': 'text/html,application/xhtml+xml',
                    'Origin': window.location.origin,
                    'Referer': window.location.href
                },
                body: formData
            });

            const responseUrl = resp.url;
            const responseText = await resp.text();

            return {
                status: resp.status,
                url: responseUrl,
                hasSuccess: responseText.includes('Successfully') ||
                           responseText.includes('scheduled') ||
                           responseText.includes('Appointment Confirmation'),
                hasInstructions: responseUrl.includes('instructions'),
                hasCaptcha: responseText.includes('recaptcha'),
                bodyPreview: responseText.substring(0, 800)
            };
        } catch (e) {
            return { error: e.message };
        }
    }, { url, formData, csrf: csrfToken });

    return result;
}

// ============================================================================
// ULTRA-FAST BOOKING - SKIP TIMES IF PREFERRED TIME SET
// ============================================================================
async function performUltraFastBooking(date) {
    const totalStart = Date.now();
    const timings = {
        token: 0,
        times: 0,      // Will be 0 if using fixed time
        submit: 0,
        total: 0
    };

    const useFixedTime = !!CONFIG.preferences.preferredTime;
    log(`⚡ [ULTRA-FAST BOOKING] ${date} | Fixed time: ${useFixedTime ? CONFIG.preferences.preferredTime : 'NO'}`, 'FAST');
    sendTelegram(`⚡ <b>ULTRA-FAST BOOKING</b>\n📅 ${date}${useFixedTime ? `\n⏰ Fixed: ${CONFIG.preferences.preferredTime}` : ''}`);

    try {
        let selectedTime;
        let token;

        if (useFixedTime) {
            // ===== FIXED TIME MODE - SKIP TIMES API! =====
            const tokenStart = Date.now();
            log(`[STEP 1/2] Token only (skipping times - using fixed: ${CONFIG.preferences.preferredTime})`, 'FAST');

            token = await page.evaluate(() => {
                const input = document.querySelector('input[name="authenticity_token"]');
                return input ? input.value : null;
            }) || formToken || csrfToken;

            timings.token = Date.now() - tokenStart;
            selectedTime = CONFIG.preferences.preferredTime;

            log(`✅ Token ready (${timings.token}ms) - TIMES SKIPPED!`, 'SUCCESS');

        } else {
            // ===== NO FIXED TIME - PARALLEL TOKEN + TIMES =====
            const parallelStart = Date.now();
            log(`[STEP 1/2] Parallel: Token + Times...`, 'FAST');

            const [tokenResult, timesResult] = await Promise.all([
                page.evaluate(() => {
                    const input = document.querySelector('input[name="authenticity_token"]');
                    return input ? input.value : null;
                }),
                apiGetTimes(date)
            ]);

            timings.token = Date.now() - parallelStart;
            timings.times = timings.token; // Same since parallel

            token = tokenResult || formToken || csrfToken;

            if (timesResult.error) {
                log(`❌ Times failed: ${timesResult.error} (${timings.times}ms)`, 'ERROR');
                return { success: false, timings };
            }

            const times = timesResult.data?.available_times || [];
            if (times.length === 0) {
                log(`❌ No times available (${timings.times}ms)`, 'ERROR');
                return { success: false, timings };
            }

            selectedTime = times[0];
            log(`✅ Parallel done: ${times.length} times, using ${selectedTime} (${timings.times}ms)`, 'SUCCESS');
        }

        // ===== STEP 2: SUBMIT BOOKING =====
        const submitStart = Date.now();
        log(`[STEP 2/2] Submit: ${date} @ ${selectedTime}...`, 'FAST');

        const submitResult = await apiSubmitBooking(date, selectedTime, token);
        timings.submit = Date.now() - submitStart;
        timings.total = Date.now() - totalStart;

        if (submitResult.error) {
            log(`❌ Submit failed: ${submitResult.error} (${timings.submit}ms)`, 'ERROR');
            return { success: false, timings };
        }

        if (submitResult.hasCaptcha) {
            log(`⚠️ CAPTCHA! (${timings.total}ms)`, 'WARN');
            
            // HYBRID FALLBACK: Try browser-based submission
            const recoveryResult = await browserSubmitBooking(date, selectedTime);
            
            if (recoveryResult.success) {
                log(`🎉 RECOVERY SUCCESS! Booked via browser.`, 'SUCCESS');
                sendTelegram(`🎉 <b>RECOVERY SUCCESS!</b>\nBooked ${date} @ ${selectedTime} via browser fallback.`);
                return { success: true, timings, time: selectedTime };
            }
            
            return { success: false, timings, captcha: true };
        }

        if (submitResult.hasInstructions || submitResult.hasSuccess) {
            const timingBreakdown = useFixedTime
                ? `Token: ${timings.token}ms (times SKIPPED!)`
                : `Token+Times: ${timings.token}ms`;

            log(`🎉 BOOKED! ${timingBreakdown}, Submit: ${timings.submit}ms, TOTAL: ${timings.total}ms`, 'SUCCESS');
            sendTelegram(
                `🎉 <b>ULTRA-FAST BOOKED!</b>\n` +
                `📅 ${date}\n⏰ ${selectedTime}\n\n` +
                `⏱ <b>Timing:</b>\n` +
                `• ${useFixedTime ? `Token: ${timings.token}ms (times SKIPPED!)` : `Token+Times: ${timings.token}ms`}\n` +
                `• Submit: ${timings.submit}ms\n` +
                `• <b>TOTAL: ${timings.total}ms</b>\n` +
                `⚡ ${useFixedTime ? 'FIXED TIME - Maximum Speed!' : 'Parallel Flow!'}`
            );
            return { success: true, timings, time: selectedTime };
        }

        log(`❌ Not confirmed. Total: ${timings.total}ms`, 'ERROR');
        log(`Response: ${submitResult.bodyPreview?.substring(0, 200)}`, 'ERROR');
        return { success: false, timings };

    } catch (error) {
        timings.total = Date.now() - totalStart;
        log(`❌ Error: ${error.message} (${timings.total}ms)`, 'ERROR');
        return { success: false, timings, error: error.message };
    }
}

// ============================================================================
// LOGIN
// ============================================================================
async function login() {
    log('Logging in via browser...');

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

    // Get BOTH tokens
    csrfToken = await page.evaluate(() => {
        return document.querySelector('meta[name="csrf-token"]')?.content || '';
    });

    formToken = await page.evaluate(() => {
        const input = document.querySelector('input[name="authenticity_token"]');
        return input ? input.value : null;
    });

    // Extract cookies for native fetch
    await extractCookies();

    log(`✅ Logged in! Schedule: ${scheduleId}`, 'SUCCESS');
    log(`CSRF: ${csrfToken.substring(0, 20)}... | Form: ${formToken?.substring(0, 20)}...`, 'INFO');

    return true;
}

// ============================================================================
// MAIN MONITORING LOOP
// ============================================================================
async function runMonitoringLoop() {
    const delayMs = getDelay(CONFIG.preferences.targetCPM);
    log(`Starting ULTRA-FAST monitoring: ${CONFIG.preferences.targetCPM} CPM`, 'FAST');
    log(`Proxy: ${CONFIG.proxy.enabled ? 'ON' : 'OFF (native fetch enabled)'}`, 'INFO');

    let lastLogTime = Date.now();
    let tokenRefreshTime = Date.now();

    while (true) {
        try {
            checkCount++;

            // Refresh form token every 5 minutes (stays fresh for booking)
            if (Date.now() - tokenRefreshTime > 300000) {
                await refreshFormToken();
                await extractCookies();
                tokenRefreshTime = Date.now();
            }

            // API: Get dates
            const datesResult = await apiGetDates();

            if (datesResult.error) {
                if (checkCount % 10 === 0) {
                    log(`Dates error: ${datesResult.error}`, 'WARN');
                }
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const dates = datesResult.data || [];
            const firstDate = dates[0]?.date;

            // Track closest
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

                // IN RANGE - ULTRA FAST BOOKING
                if (isDateInRange(firstDate)) {
                    log(`🎯 DATE IN RANGE: ${firstDate}`, 'BOOK');

                    const result = await performUltraFastBooking(firstDate);

                    if (result.success) {
                        log('🛑 STOPPING - BOOKING COMPLETE', 'SUCCESS');
                        log(`📊 Final: Token=${result.timings.token}ms, Submit=${result.timings.submit}ms, TOTAL=${result.timings.total}ms`, 'SUCCESS');
                        process.exit(0);
                    } else if (result.captcha) {
                        log('⚠️ Captcha - waiting 30s', 'WARN');
                        await new Promise(r => setTimeout(r, 30000));
                    } else {
                        log(`❌ Failed - ${result.timings.total}ms`, 'ERROR');
                    }
                }
            }

            // Stats
            if (Date.now() - lastLogTime >= 1000) {
                const elapsed = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsed).toFixed(1);
                const dateDisplay = firstDate || 'SEARCHING';
                const bestDisplay = closestSlotFound || 'N/A';

                console.log(
                    `\x1b[45m[FAST ${cpm} CPM]\x1b[0m #${checkCount} | ` +
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
    console.log('\x1b[45m\x1b[37m  ULTRA-FAST API BOOKING  \x1b[0m');
    console.log('\x1b[36m  Fixed time = Skip times API | Parallel | Keep-Alive\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    const fixedTimeMode = !!CONFIG.preferences.preferredTime;

    log(`Email: ${CONFIG.credentials.email}`);
    log(`Facility: ${CONFIG.preferences.facilityId}`);
    log(`Target CPM: ${CONFIG.preferences.targetCPM}`);
    log(`Preferred Time: ${CONFIG.preferences.preferredTime || 'First available'}`);
    log(`Proxy: ${CONFIG.proxy.enabled ? 'ON' : 'OFF'}`);
    log(`Mode: ${fixedTimeMode ? '⚡ FIXED TIME (times API SKIPPED!)' : 'Parallel fetch'}`);
    if (fixedTimeMode) {
        log(`🚀 Times API will be SKIPPED - direct submit with ${CONFIG.preferences.preferredTime}`, 'FAST');
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

        await login();

        sendTelegram(
            `⚡ <b>ULTRA-FAST Bot Started</b>\n` +
            `📧 ${CONFIG.credentials.email}\n` +
            `⚡ ${CONFIG.preferences.targetCPM} CPM\n` +
            `🔥 Parallel + Native fetch`
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
    sendTelegram('🛑 <b>ULTRA-FAST Bot Stopped</b>');
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
