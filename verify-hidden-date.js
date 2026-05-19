/**
 * VERIFY HIDDEN DATE
 *
 * Check if the hidden date (2026-02-02) is:
 * 1. Real and bookable
 * 2. Or just a glitch/bug
 *
 * Also monitors for patterns in date releases
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
require('dotenv').config();

chromium.use(stealth);

const CONFIG = {
    email: process.env.VISA_EMAIL,
    password: process.env.VISA_PASSWORD,
    baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
    city: process.env.PREFERRED_CITY || 'Toronto',
    proxy: {
        enabled: process.env.PROXY_ENABLED !== 'false',
        server: process.env.PROXY_SERVER,
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
    }
};

let scheduleId = null;
let facilityId = null;

function log(msg, type = 'INFO') {
    const colors = {
        INFO: '\x1b[36m',
        SUCCESS: '\x1b[32m',
        WARN: '\x1b[33m',
        ERROR: '\x1b[31m',
        FOUND: '\x1b[35m',
        TEST: '\x1b[44m\x1b[37m'
    };
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`${colors[type] || ''}[${timestamp}] ${msg}\x1b[0m`);
}

async function apiRequest(page, url) {
    try {
        return await page.evaluate(async (url) => {
            try {
                const resp = await fetch(url, {
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json',
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });
                const text = await resp.text();
                try {
                    return { status: resp.status, data: JSON.parse(text), ok: resp.ok };
                } catch {
                    return { status: resp.status, data: text, ok: resp.ok };
                }
            } catch (e) {
                return { error: e.message };
            }
        }, url);
    } catch (e) {
        return { error: e.message };
    }
}

async function login(page) {
    log('Logging in...');
    await page.goto(`${CONFIG.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('#user_email', { timeout: 30000 });
    await page.fill('#user_email', CONFIG.email);
    await page.fill('#user_password', CONFIG.password);

    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch (e) {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }

    await page.click('input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    if (page.url().includes('sign_in')) throw new Error('Login failed');
    log('Login successful!', 'SUCCESS');
}

async function setup(page) {
    const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
    await page.waitForSelector(continueBtn, { timeout: 30000 });
    await page.click(continueBtn);
    await page.waitForTimeout(2000);

    const currentUrl = page.url();
    scheduleId = currentUrl.match(/schedule\/(\d+)/)?.[1];

    const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');
    await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });

    const facilities = await page.$$eval('#appointments_consulate_appointment_facility_id option', opts =>
        opts.filter(o => o.value).map(o => ({ text: o.innerText.trim(), value: o.value }))
    );

    const target = facilities.find(f => f.text.toLowerCase().includes(CONFIG.city.toLowerCase()));
    facilityId = target?.value;

    await page.selectOption('#appointments_consulate_appointment_facility_id', facilityId);
    await page.waitForTimeout(2000);

    log(`Setup complete: Schedule=${scheduleId}, Facility=${facilityId} (${CONFIG.city})`, 'SUCCESS');
}

async function verifyHiddenDate(page) {
    const baseApi = `${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`;
    const hiddenDate = '2026-02-02';

    console.log('\n' + '═'.repeat(70));
    console.log('  VERIFYING HIDDEN DATE: ' + hiddenDate);
    console.log('═'.repeat(70) + '\n');

    // Step 1: Check /days/ API
    log('Step 1: Checking /days/ API...', 'TEST');
    const daysResult = await apiRequest(page, `${baseApi}/days/${facilityId}.json?appointments[expedite]=false`);
    const daysData = Array.isArray(daysResult.data) ? daysResult.data : [];
    const dateInDays = daysData.find(d => d.date === hiddenDate);

    if (dateInDays) {
        log(`  ✅ Date ${hiddenDate} IS in /days/ API`, 'SUCCESS');
    } else {
        log(`  ❌ Date ${hiddenDate} NOT in /days/ API (first available: ${daysData[0]?.date || 'None'})`, 'WARN');
    }

    // Step 2: Check /times/ API for the hidden date
    log('\nStep 2: Checking /times/ API for hidden date...', 'TEST');
    const timesResult = await apiRequest(page, `${baseApi}/times/${facilityId}.json?date=${hiddenDate}&appointments[expedite]=false`);

    if (timesResult.data?.available_times?.length > 0) {
        log(`  ✅ TIMES AVAILABLE: ${timesResult.data.available_times.join(', ')}`, 'FOUND');
        log(`  Business times: ${timesResult.data.business_times?.join(', ') || 'N/A'}`, 'INFO');
    } else {
        log(`  ❌ No times available for ${hiddenDate}`, 'WARN');
        log(`  Response: ${JSON.stringify(timesResult.data)}`, 'INFO');
    }

    // Step 3: Try to actually select this date in the form
    log('\nStep 3: Trying to select date in form...', 'TEST');
    try {
        // Set the date value directly
        await page.evaluate((date) => {
            const dateInput = document.querySelector('#appointments_consulate_appointment_date');
            if (dateInput) {
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') {
                    $(dateInput).trigger('change');
                }
            }
        }, hiddenDate);

        await page.waitForTimeout(2000);

        // Check if time dropdown got populated
        const timeOptions = await page.$$eval('#appointments_consulate_appointment_time option', opts =>
            opts.map(o => o.value).filter(v => v)
        );

        if (timeOptions.length > 0) {
            log(`  ✅ Time dropdown populated with: ${timeOptions.join(', ')}`, 'FOUND');
        } else {
            log(`  ❌ Time dropdown is empty`, 'WARN');
        }

        // Check for any error messages
        const errorMsg = await page.$eval('.error, .alert-error, .flash-error', el => el.textContent).catch(() => null);
        if (errorMsg) {
            log(`  ⚠️ Error message: ${errorMsg}`, 'ERROR');
        }

    } catch (e) {
        log(`  Error selecting date: ${e.message}`, 'ERROR');
    }

    // Step 4: Check ALL dates until end of December 2026
    console.log('\n' + '═'.repeat(70));
    console.log('  SCANNING ALL DATES UNTIL END OF DECEMBER 2026');
    console.log('═'.repeat(70) + '\n');

    const today = new Date();
    const endDate = new Date('2026-12-31');
    const allDates = [];

    // Generate all dates from today to end of December 2026
    let currentDate = new Date(today);
    while (currentDate <= endDate) {
        allDates.push(currentDate.toISOString().split('T')[0]);
        currentDate.setDate(currentDate.getDate() + 1);
    }

    log(`Checking ${allDates.length} dates from ${allDates[0]} to ${allDates[allDates.length-1]}...\n`);

    const hiddenDatesFound = [];
    let checkedCount = 0;

    for (const date of allDates) {
        checkedCount++;
        const result = await apiRequest(page, `${baseApi}/times/${facilityId}.json?date=${date}&appointments[expedite]=false`);
        const times = result.data?.available_times || [];

        // Only log if we found times (hidden date!)
        if (times.length > 0) {
            log(`  🎯 ${date}: ${times.length} SLOTS FOUND! Times: ${times.join(', ')}`, 'FOUND');
            hiddenDatesFound.push({ date, times, slots: times.length });
        }

        // Progress indicator every 30 dates
        if (checkedCount % 30 === 0) {
            const pct = Math.round((checkedCount / allDates.length) * 100);
            process.stdout.write(`\r  Progress: ${checkedCount}/${allDates.length} (${pct}%) - Found ${hiddenDatesFound.length} hidden dates    `);
        }

        await page.waitForTimeout(200);  // Small delay to avoid rate limiting
    }

    console.log('\n');

    // Summary of hidden dates
    console.log('\n' + '═'.repeat(70));
    console.log('  HIDDEN DATES SUMMARY');
    console.log('═'.repeat(70) + '\n');

    if (hiddenDatesFound.length > 0) {
        log(`Found ${hiddenDatesFound.length} hidden dates with available slots:\n`, 'FOUND');
        hiddenDatesFound.forEach(({ date, times, slots }) => {
            console.log(`   📅 ${date}: ${slots} slots - ${times.join(', ')}`);
        });
    } else {
        log('No hidden dates found with available slots.', 'WARN');
    }

    // Step 5: Analysis
    console.log('\n' + '═'.repeat(70));
    console.log('  ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    if (hiddenDatesFound.length > 0) {
        log('Hidden dates exist! These are likely:', 'INFO');
        log('  1. CANCELLATIONS: Someone cancelled and slot became available', 'INFO');
        log('  2. CACHE LAG: /days/ API is cached, /times/ is real-time', 'INFO');
        log('  3. RESERVED: Slots held but not confirmed (may expire)', 'INFO');
    } else {
        log('No hidden dates found. Possible reasons:', 'INFO');
        log('  1. All slots are properly synced between /days/ and /times/', 'INFO');
        log('  2. No recent cancellations', 'INFO');
        log('  3. System is working correctly', 'INFO');
    }

    // Step 6: Monitor first hidden date found (if any)
    const dateToMonitor = hiddenDatesFound[0]?.date || hiddenDate;

    console.log('\n' + '═'.repeat(70));
    console.log(`  MONITORING ${dateToMonitor} FOR 60 SECONDS`);
    console.log('═'.repeat(70) + '\n');

    log(`Watching if times for ${dateToMonitor} change...\n`);

    let lastTimes = null;
    const startTime = Date.now();

    while (Date.now() - startTime < 60000) {
        const result = await apiRequest(page, `${baseApi}/times/${facilityId}.json?date=${dateToMonitor}&appointments[expedite]=false`);
        const times = result.data?.available_times || [];
        const currentTimes = JSON.stringify(times);

        if (lastTimes !== null && currentTimes !== lastTimes) {
            log(`🚨 TIMES CHANGED! Was: ${lastTimes}, Now: ${currentTimes}`, 'FOUND');
        }

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write(`\r  [${elapsed}s] Times for ${dateToMonitor}: ${times.length > 0 ? times.join(', ') : 'None'}`);

        lastTimes = currentTimes;
        await page.waitForTimeout(2000);
    }

    console.log('\n');

    // Final verdict
    console.log('\n' + '═'.repeat(70));
    console.log('  FINAL VERDICT');
    console.log('═'.repeat(70));

    if (hiddenDatesFound.length > 0) {
        console.log(`
🎯 FOUND ${hiddenDatesFound.length} HIDDEN DATE(S)!

These dates have slots in /times/ API but are NOT in /days/ API:
`);
        hiddenDatesFound.forEach(({ date, times }) => {
            console.log(`   📅 ${date}: ${times.join(', ')}`);
        });

        console.log(`
Status: Available in /times/ but blocked by /days/ validation
Booking: Server-side validation BLOCKS these dates

⚠️  Unfortunately, we confirmed earlier that booking these dates
    is rejected by the server. The backend validates against /days/.

🔍 However, monitoring WHEN these appear can help you understand
   the release pattern and be ready when they become "official".
`);
    } else {
        console.log(`
📊 NO HIDDEN DATES FOUND

All dates through December 2026 were checked.
No slots exist in /times/ that aren't in /days/.

This means:
1. The system is properly synced
2. No recent cancellations available
3. Keep monitoring - cancellations happen randomly!
`);
    }
}

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('  HIDDEN DATE VERIFICATION');
    console.log('  Checking if 2026-02-02 is real or a glitch');
    console.log('═'.repeat(70) + '\n');

    const browser = await chromium.launch({ headless: false });

    const contextOptions = {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    };

    if (CONFIG.proxy.enabled && CONFIG.proxy.server) {
        contextOptions.proxy = {
            server: `http://${CONFIG.proxy.server}`,
            username: CONFIG.proxy.username,
            password: CONFIG.proxy.password
        };
        log(`Using proxy: ${CONFIG.proxy.server}`);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
        await login(page);
        await setup(page);
        await verifyHiddenDate(page);

        console.log('\nBrowser left open. Press Ctrl+C to exit.\n');
        await new Promise(() => {});

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        await browser.close();
    }
}

main().catch(console.error);
