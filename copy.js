
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// BOOKING TEST - 6 accounts, 1 date, 1 time slot, parallel fire
// ============================================================================
// Set these in .env:
//   BOOK_DATE=2026-03-15       (the date to book)
//   BOOK_TIME=10:00            (the time slot to book)
//   KA_EMAIL_1..6              (6 account emails)
//   KA_PASSWORD_1..6           (6 account passwords)
// ============================================================================

const BOOK_DATE = process.env.BOOK_DATE;
const BOOK_TIME = process.env.BOOK_TIME;
const BASE_URL = process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv';
const CITY = process.env.PREFERRED_CITY || 'Toronto';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Load 6 test accounts
const ACCOUNTS = [];
for (let i = 1; i <= 6; i++) {
    const email = process.env[`KA_EMAIL_${i}`];
    const password = process.env[`KA_PASSWORD_${i}`];
    if (email && password) {
        ACCOUNTS.push({ email, password, index: i });
    }
}

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
    };
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${message}\x1b[0m`);
}

// ============================================================================
// TELEGRAM
// ============================================================================
function sendTelegram(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const postData = JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'HTML'
    });

    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000
    }, () => {});

    req.on('error', (err) => console.log(`Telegram error: ${err.message}`));
    req.write(postData);
    req.end();
}

// ============================================================================
// USER AGENTS
// ============================================================================
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ============================================================================
// LOGIN
// ============================================================================
async function loginAccount(page, email, password, tag) {
    log(`${tag} Logging in ${email}...`, 'INFO');

    await page.goto(`${BASE_URL}/users/sign_in`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    await page.waitForSelector('#user_email', { timeout: 30000 });

    const pageText = await page.innerText('body').catch(() => '');
    if (pageText.toLowerCase().includes('system is busy')) {
        throw new Error('SYSTEM_BUSY');
    }
    if (pageText.includes('account is locked')) {
        throw new Error('ACCOUNT_LOCKED');
    }

    await page.fill('#user_email', email);
    await page.fill('#user_password', password);

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

    log(`${tag} ✅ Logged in`, 'SUCCESS');
    return true;
}

// ============================================================================
// NAVIGATE TO APPOINTMENT PAGE + SELECT CITY
// ============================================================================
async function navigateToAppointment(page, tag) {
    log(`${tag} Navigating to appointment page...`, 'INFO');

    try {
        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
        await page.waitForSelector(continueBtn, { timeout: 15000 });
        await page.click(continueBtn);
        await page.waitForTimeout(2000);
    } catch (e) {}

    const currentUrl = page.url();
    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const facilitySelector = '#appointments_consulate_appointment_facility_id';
    await page.waitForSelector(facilitySelector, { timeout: 10000 });

    const options = await page.$$eval(`${facilitySelector} option`, opts =>
        opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
    );

    const target = options.find(o => o.text.toLowerCase().includes(CITY.toLowerCase()));
    if (target) {
        await page.selectOption(facilitySelector, target.value);
        log(`${tag} Selected city: ${target.text}`, 'INFO');
    }

    await page.waitForTimeout(2000);
    log(`${tag} 📋 On appointment page, ready`, 'SUCCESS');
}

// ============================================================================
// BOOKING - DIRECT API POST (same method as main bot)
// ============================================================================
async function performBooking(page, date, time, email, tag) {
    log(`${tag} 🚀 BOOKING API: date=${date}, time=${time}`, 'SUCCESS');
    const startTime = Date.now();

    try {
        const pageData = await page.evaluate(() => {
            const url = window.location.href;
            const scheduleMatch = url.match(/schedule\/(\d+)/);
            const facilitySelect = document.querySelector('#appointments_consulate_appointment_facility_id');
            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;
            const form = document.querySelector('form#appointment-form') ||
                         document.querySelector('form[action*="appointment"]');
            const hiddenFields = {};
            if (form) {
                form.querySelectorAll('input[type="hidden"]').forEach(input => {
                    if (input.name) hiddenFields[input.name] = input.value || '';
                });
            }
            return {
                scheduleId: scheduleMatch ? scheduleMatch[1] : null,
                facilityId: facilitySelect ? facilitySelect.value : null,
                csrf: csrfToken,
                formAction: form ? form.action : null,
                hiddenFields,
                currentUrl: url,
                origin: window.location.origin
            };
        });

        if (!pageData?.scheduleId || !pageData?.facilityId) {
            log(`${tag} ❌ Missing IDs (schedule: ${pageData?.scheduleId}, facility: ${pageData?.facilityId})`, 'ERROR');
            return false;
        }

        const submitUrl = pageData.formAction ||
            `${pageData.origin}/en-ca/niv/schedule/${pageData.scheduleId}/appointment`;

        log(`${tag} ⏰ ${time} | 📅 ${date} | 🔗 ${submitUrl}`, 'INFO');

        const bookResult = await Promise.race([
            page.evaluate(async ({ submitUrl, facilityId, csrf, date, time, hiddenFields, origin }) => {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                    const params = new URLSearchParams();
                    for (const [key, value] of Object.entries(hiddenFields)) {
                        params.set(key, value);
                    }
                    params.set('appointments[consulate_appointment][facility_id]', facilityId);
                    params.set('appointments[consulate_appointment][date]', date);
                    params.set('appointments[consulate_appointment][time]', time);

                    const resp = await fetch(submitUrl, {
                        method: 'POST',
                        credentials: 'include',
                        redirect: 'follow',
                        signal: controller.signal,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Origin': origin,
                            'Referer': submitUrl,
                            'Upgrade-Insecure-Requests': '1'
                        },
                        body: params.toString()
                    });
                    clearTimeout(timeoutId);

                    const finalUrl = resp.url;
                    const responseText = await resp.text();
                    const titleMatch = responseText.match(/<title[^>]*>(.*?)<\/title>/i);
                    const pageTitle = titleMatch ? titleMatch[1] : '';

                    return {
                        status: resp.status,
                        ok: resp.ok,
                        finalUrl,
                        redirected: resp.redirected,
                        pageTitle,
                        isInstructionsPage: finalUrl.includes('/instructions') ||
                                            pageTitle.includes('Confirmation and Instructions'),
                        bodySnippet: responseText.substring(0, 500)
                    };
                } catch (e) {
                    return { error: e.message };
                }
            }, { submitUrl, facilityId: pageData.facilityId, csrf: pageData.csrf, date, time, hiddenFields: pageData.hiddenFields, origin: pageData.origin }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 15000))
        ]).catch(e => ({ error: e.message }));

        const elapsed = Date.now() - startTime;

        if (bookResult.error) {
            log(`${tag} ❌ API error (${elapsed}ms): ${bookResult.error}`, 'ERROR');
            return false;
        }

        log(`${tag} 📡 status=${bookResult.status}, redirected=${bookResult.redirected}, final=${bookResult.finalUrl} (${elapsed}ms)`, 'INFO');
        log(`${tag} 📄 Title: ${bookResult.pageTitle}`, 'INFO');

        if (bookResult.isInstructionsPage) {
            log(`${tag} 🎉 BOOKED! ${date} @ ${time} (${elapsed}ms)`, 'SUCCESS');
            sendTelegram(`🎉 <b>BOOKED!</b>\n${tag}\n📅 ${date}\n⏰ ${time}\n📧 ${email}\n⏱ ${elapsed}ms`);
            return true;
        }

        log(`${tag} ⚠️ Not booked. Title: ${bookResult.pageTitle}`, 'WARN');
        log(`${tag} 📄 Body: ${bookResult.bodySnippet}`, 'INFO');
        return false;

    } catch (error) {
        const elapsed = Date.now() - startTime;
        if (error.message.includes('context') || error.message.includes('destroyed')) {
            log(`${tag} 🎉 Likely BOOKED! (context destroyed) (${elapsed}ms)`, 'SUCCESS');
            sendTelegram(`🎉 <b>LIKELY BOOKED!</b>\n${tag}\n📅 ${date}\n⏰ ${time}\n📧 ${email}\n⏱ ${elapsed}ms`);
            return true;
        }
        log(`${tag} ❌ Error (${elapsed}ms): ${error.message}`, 'ERROR');
        return false;
    }
}

// ============================================================================
// BOOK SINGLE ACCOUNT (3 attempts)
// ============================================================================
async function bookSingleAccount(session) {
    const { page, tag, account } = session;
    for (let attempt = 1; attempt <= 3; attempt++) {
        log(`${tag} Attempt ${attempt}/3...`, 'INFO');
        try {
            const booked = await performBooking(page, BOOK_DATE, BOOK_TIME, account.email, tag);
            if (booked) return { tag, email: account.email, booked: true, attempt };
        } catch (err) {
            log(`${tag} Attempt ${attempt} failed: ${err.message}`, 'ERROR');
        }
        if (attempt < 3) await new Promise(r => setTimeout(r, 50));
    }
    return { tag, email: account.email, booked: false };
}

// ============================================================================
// MAIN TEST
// ============================================================================
async function runTest() {
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  BOOKING TEST - 6 ACCOUNTS, PARALLEL FIRE\x1b[0m');
    console.log('\x1b[36m  Date: ' + (BOOK_DATE || 'NOT SET') + '\x1b[0m');
    console.log('\x1b[33m  Time: ' + (BOOK_TIME || 'NOT SET') + '\x1b[0m');
    console.log('\x1b[35m  City: ' + CITY + '\x1b[0m');
    console.log('\x1b[35m  Accounts: ' + ACCOUNTS.length + '\x1b[0m');
    console.log('═'.repeat(60) + '\n');

    // Validate
    if (!BOOK_DATE || !BOOK_TIME) {
        log('❌ BOOK_DATE and BOOK_TIME must be set in .env', 'ERROR');
        log('   Example: BOOK_DATE=2026-03-15  BOOK_TIME=10:00', 'ERROR');
        process.exit(1);
    }

    if (ACCOUNTS.length === 0) {
        log('❌ No accounts configured (set KA_EMAIL_1..6 / KA_PASSWORD_1..6 in .env)', 'ERROR');
        process.exit(1);
    }

    log(`📅 Booking: ${BOOK_DATE} @ ${BOOK_TIME}`, 'INFO');
    log(`📍 City: ${CITY}`, 'INFO');
    log(`📧 Accounts: ${ACCOUNTS.length}`, 'INFO');
    ACCOUNTS.forEach(a => log(`   [${a.index}] ${a.email}`, 'INFO'));

    sendTelegram(
        `🧪 <b>BOOKING TEST STARTED</b>\n` +
        `📅 ${BOOK_DATE} @ ${BOOK_TIME}\n` +
        `📍 ${CITY}\n` +
        `📧 ${ACCOUNTS.length} accounts`
    );

    // ===================================================================
    // PHASE 1: Login all 6 accounts and navigate to appointment page
    // ===================================================================
    log('\n📋 PHASE 1: Logging in all accounts...', 'INFO');
    const sessions = [];
    const browsers = [];

    for (let i = 0; i < ACCOUNTS.length; i++) {
        const account = ACCOUNTS[i];
        const tag = `[ACC-${account.index}]`;

        try {
            const browser = await chromium.launch({
                headless: true,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--disable-webrtc',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--disable-dev-shm-usage'
                ]
            });
            browsers.push(browser);

            const context = await browser.newContext({
                userAgent: getRandomUserAgent(),
                viewport: { width: 1920, height: 1080 },
                locale: 'en-CA',
                timezoneId: 'America/Toronto'
            });

            const page = await context.newPage();

            await loginAccount(page, account.email, account.password, tag);
            await navigateToAppointment(page, tag);

            sessions.push({ page, context, browser, account, tag });
            log(`${tag} ✅ Ready (${i + 1}/${ACCOUNTS.length})`, 'SUCCESS');

        } catch (error) {
            log(`${tag} ❌ Setup failed: ${error.message}`, 'ERROR');
        }

        // Small stagger between logins
        if (i < ACCOUNTS.length - 1) {
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
        }
    }

    log(`\n✅ ${sessions.length}/${ACCOUNTS.length} accounts ready`, 'SUCCESS');

    if (sessions.length === 0) {
        log('❌ No sessions ready, aborting', 'ERROR');
        for (const b of browsers) await b.close().catch(() => {});
        process.exit(1);
    }

    sendTelegram(
        `✅ <b>${sessions.length} Accounts Ready</b>\n` +
        `📅 ${BOOK_DATE} @ ${BOOK_TIME}\n` +
        `🔥 Firing in parallel NOW...`
    );

    // ===================================================================
    // PHASE 2: Fire ALL bookings in parallel via Promise.all
    // ===================================================================
    log('\n🔥🔥🔥 PHASE 2: FIRING ALL BOOKINGS IN PARALLEL!\n', 'SUCCESS');

    const fireTime = Date.now();

    const results = await Promise.all(
        sessions.map(session => bookSingleAccount(session))
    );

    const totalElapsed = Date.now() - fireTime;
    const successes = results.filter(r => r.booked);
    const failures = results.filter(r => !r.booked);

    // ===================================================================
    // PHASE 3: Results
    // ===================================================================
    console.log('\n' + '═'.repeat(60));
    console.log('\x1b[32m  RESULTS\x1b[0m');
    console.log('═'.repeat(60));

    log(`📊 Total time: ${totalElapsed}ms`, 'INFO');
    log(`✅ Succeeded: ${successes.length}/${results.length}`, successes.length > 0 ? 'SUCCESS' : 'WARN');
    log(`❌ Failed: ${failures.length}/${results.length}`, failures.length > 0 ? 'ERROR' : 'INFO');

    successes.forEach(r => log(`   🎉 ${r.tag} ${r.email} (attempt ${r.attempt})`, 'SUCCESS'));
    failures.forEach(r => log(`   ❌ ${r.tag} ${r.email}`, 'ERROR'));

    sendTelegram(
        `📊 <b>BOOKING TEST RESULTS (${totalElapsed}ms)</b>\n` +
        `📅 ${BOOK_DATE} @ ${BOOK_TIME}\n` +
        `✅ ${successes.length}/${results.length} succeeded\n` +
        (successes.length > 0
            ? successes.map(r => `🎉 ${r.email} (attempt ${r.attempt})`).join('\n')
            : '❌ None succeeded') +
        `\n⏱ Total: ${totalElapsed}ms`
    );

    // Cleanup
    log('\nCleaning up browsers...', 'INFO');
    for (const b of browsers) {
        await b.close().catch(() => {});
    }

    log('Done!', 'SUCCESS');
    process.exit(successes.length > 0 ? 0 : 1);
}

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================
process.on('SIGINT', () => {
    console.log('\nAborted.');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('FATAL:', err.message);
    sendTelegram(`⚠️ <b>Test Crashed</b>\n${err.message}`);
    process.exit(1);
});

// Start
runTest();
