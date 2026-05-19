/**
 * SIMPLE BYPASS TEST
 * Uses Playwright's request context instead of page.evaluate fetch
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
require('dotenv').config();

const CONFIG = {
    email: process.env.VISA_EMAIL,
    password: process.env.VISA_PASSWORD,
    baseUrl: 'https://ais.usvisa-info.com/en-ca/niv',
    hiddenDate: '2026-02-02',
    hiddenTime: '08:00',
    facilityId: '94'
};

const log = (msg, type = 'INFO') => {
    const colors = { INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', FOUND: '\x1b[35m' };
    console.log(`${colors[type] || ''}[${new Date().toLocaleTimeString()}] ${msg}\x1b[0m`);
};

async function run() {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  SIMPLE BYPASS TEST');
    console.log('══════════════════════════════════════════════════════════\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        // Login
        log('Logging in...');
        await page.goto(`${CONFIG.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.fill('#user_email', CONFIG.email);
        await page.fill('#user_password', CONFIG.password);
        try { await page.click('label[for="policy_confirmed"]', { timeout: 2000 }); } catch {}
        await page.click('input[type="submit"][name="commit"]');
        await page.waitForTimeout(5000);

        const scheduleId = (await page.content()).match(/schedule\/(\d+)/)?.[1];
        log(`Schedule ID: ${scheduleId}`, 'SUCCESS');

        // Go to appointment page
        await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, { waitUntil: 'networkidle' });
        await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);
        await page.waitForTimeout(2000);

        // Get tokens
        const csrf = await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.content);
        const authToken = await page.evaluate(() => document.querySelector('input[name="authenticity_token"]')?.value);

        log(`CSRF: ${csrf?.substring(0, 30)}...`, 'FOUND');
        log(`Auth Token: ${authToken?.substring(0, 30)}...`, 'FOUND');

        // Get valid date
        const daysUrl = `${CONFIG.baseUrl}/schedule/${scheduleId}/appointment/days/${CONFIG.facilityId}.json`;
        await page.goto(daysUrl);
        const daysText = await page.locator('body').innerText();
        let validDate = '2027-04-28';
        try {
            const days = JSON.parse(daysText);
            if (days[0]?.date) validDate = days[0].date;
        } catch {}
        log(`Valid date: ${validDate}`, 'FOUND');

        // Check hidden date times
        const timesUrl = `${CONFIG.baseUrl}/schedule/${scheduleId}/appointment/times/${CONFIG.facilityId}.json?date=${CONFIG.hiddenDate}`;
        await page.goto(timesUrl);
        const timesText = await page.locator('body').innerText();
        log(`Hidden date /times/ response: ${timesText}`, 'FOUND');

        // Go back to appointment page for form submission tests
        await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, { waitUntil: 'networkidle' });
        await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);
        await page.waitForTimeout(2000);

        // Get fresh tokens
        const freshCsrf = await page.evaluate(() => document.querySelector('meta[name="csrf-token"]')?.content);
        const freshAuth = await page.evaluate(() => document.querySelector('input[name="authenticity_token"]')?.value);

        console.log('\n══════════════════════════════════════════════════════════');
        console.log('  TEST 1: FORM INJECTION + SUBMIT');
        console.log('══════════════════════════════════════════════════════════\n');

        // Inject date and time into form
        log('Injecting hidden date into form...', 'INFO');

        await page.evaluate(({ date, time }) => {
            // Set date
            const dateInput = document.querySelector('#appointments_consulate_appointment_date');
            if (dateInput) {
                dateInput.readOnly = false;
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Add and select time
            const timeSelect = document.querySelector('#appointments_consulate_appointment_time');
            if (timeSelect) {
                const opt = document.createElement('option');
                opt.value = time;
                opt.text = time;
                opt.selected = true;
                timeSelect.appendChild(opt);
                timeSelect.value = time;
                timeSelect.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, { date: CONFIG.hiddenDate, time: CONFIG.hiddenTime });

        // Verify injection
        const injectedDate = await page.evaluate(() =>
            document.querySelector('#appointments_consulate_appointment_date')?.value
        );
        const injectedTime = await page.evaluate(() =>
            document.querySelector('#appointments_consulate_appointment_time')?.value
        );
        log(`Injected - Date: ${injectedDate}, Time: ${injectedTime}`, injectedDate ? 'SUCCESS' : 'ERROR');

        // Click submit button
        log('Clicking submit...', 'INFO');

        // Wait for navigation after submit
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {}),
            page.click('#appointments_submit').catch(e => log(`Click error: ${e.message}`, 'WARN'))
        ]);

        await page.waitForTimeout(2000);

        // Check result
        const resultUrl = page.url();
        const resultContent = await page.content();

        log(`Result URL: ${resultUrl}`, 'INFO');

        if (resultContent.includes('could not be scheduled') || resultContent.includes('valid selection')) {
            log('❌ REJECTED: Server validation blocked the hidden date', 'ERROR');
        } else if (resultContent.includes('Successfully') || resultContent.includes('Confirmation')) {
            log('🎉 SUCCESS: Booking may have worked!', 'SUCCESS');
        } else if (resultContent.includes('Confirm')) {
            log('📋 On confirmation page - checking...', 'WARN');
        }

        // Take screenshot
        await page.screenshot({ path: 'test1-result.png' });
        log('Screenshot saved: test1-result.png', 'INFO');

        console.log('\n══════════════════════════════════════════════════════════');
        console.log('  TEST 2: VALID DATE WITH MANIPULATED TIME');
        console.log('══════════════════════════════════════════════════════════\n');

        // Go back to appointment page
        await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, { waitUntil: 'networkidle' });
        await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);
        await page.waitForTimeout(3000);

        // Wait for datepicker to load
        log(`Trying to select valid date: ${validDate}`, 'INFO');

        // Click on date input to open picker
        await page.click('#appointments_consulate_appointment_date');
        await page.waitForTimeout(1000);

        // Try to type the valid date
        await page.evaluate(({ date }) => {
            const dateInput = document.querySelector('#appointments_consulate_appointment_date');
            if (dateInput) {
                dateInput.value = date;
                dateInput.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof $ !== 'undefined') {
                    $(dateInput).trigger('change');
                }
            }
        }, { date: validDate });

        await page.waitForTimeout(2000);

        // Check if times loaded for valid date
        const validDateTimes = await page.evaluate(() => {
            const select = document.querySelector('#appointments_consulate_appointment_time');
            return Array.from(select?.options || []).map(o => o.value).filter(v => v);
        });

        log(`Times for valid date: ${validDateTimes.join(', ') || 'NONE'}`, validDateTimes.length ? 'SUCCESS' : 'WARN');

        // If we got times, try to use a time that exists on hidden date but maybe not on valid date
        if (validDateTimes.length > 0) {
            log('Attempting to submit with valid date...', 'INFO');

            await page.selectOption('#appointments_consulate_appointment_time', validDateTimes[0]);
            await page.waitForTimeout(500);

            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {}),
                page.click('#appointments_submit').catch(e => {})
            ]);

            await page.waitForTimeout(2000);

            const test2Content = await page.content();
            if (test2Content.includes('Confirm')) {
                log('Got to confirmation page with VALID date!', 'SUCCESS');
                log('This proves booking flow works - server just rejects hidden dates', 'INFO');
            }
        }

        console.log('\n══════════════════════════════════════════════════════════');
        console.log('  CONCLUSION');
        console.log('══════════════════════════════════════════════════════════\n');

        log('Summary:', 'FOUND');
        console.log('  • Hidden date exists in /times/ API but NOT in /days/ API');
        console.log('  • Form injection works (we can set any date/time)');
        console.log('  • Server validates date against /days/ list on submit');
        console.log('  • No bypass found - validation is SERVER-SIDE');
        console.log('');
        console.log('  The hidden dates in /times/ API appear to be:');
        console.log('    1. Cached/stale data');
        console.log('    2. Reserved slots for specific users');
        console.log('    3. System inconsistency (not exploitable)');

        log('\nBrowser left open. Press Ctrl+C to exit.', 'INFO');
        await new Promise(() => {});

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        console.error(error.stack);
    }
}

run();
