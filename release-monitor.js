/**
 * RELEASE MONITOR - Simple Version
 *
 * Watches /days/ API for when new dates appear
 * Uses the same pattern as nothang.js (response interception)
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
require('dotenv').config();
const fs = require('fs');

const CONFIG = {
    email: process.env.VISA_EMAIL,
    password: process.env.VISA_PASSWORD,
    baseUrl: 'https://ais.usvisa-info.com/en-ca/niv',
    facilityId: '94',
    checkIntervalMs: 60000,  // Check every 60 seconds
    logFile: 'release-events.json'
};

let previousDates = [];
let releaseEvents = [];

const log = (msg, type = 'INFO') => {
    const colors = {
        INFO: '\x1b[36m', SUCCESS: '\x1b[32m', WARN: '\x1b[33m',
        ERROR: '\x1b[31m', FOUND: '\x1b[35m', RELEASE: '\x1b[42m\x1b[30m'
    };
    const ts = new Date().toLocaleTimeString();
    console.log(`${colors[type] || ''}[${ts}] ${msg}\x1b[0m`);
};

function saveEvents() {
    fs.writeFileSync(CONFIG.logFile, JSON.stringify({
        started: new Date().toISOString(),
        events: releaseEvents
    }, null, 2));
}

async function run() {
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('  RELEASE MONITOR');
    console.log('  Finding when dates get released');
    console.log('══════════════════════════════════════════════════════════\n');

    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();

    let scheduleId = null;
    let latestDates = null;

    // Capture /days/ responses
    page.on('response', async response => {
        const url = response.url();
        if (url.includes('/days/') && url.includes('.json')) {
            try {
                const data = await response.json();
                if (Array.isArray(data)) {
                    latestDates = data.map(d => d.date);
                }
            } catch {}
        }
    });

    try {
        // Login
        log('Logging in...');
        await page.goto(`${CONFIG.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.fill('#user_email', CONFIG.email);
        await page.fill('#user_password', CONFIG.password);
        try { await page.click('label[for="policy_confirmed"]', { timeout: 2000 }); } catch {}
        await page.click('input[type="submit"][name="commit"]');
        await page.waitForTimeout(5000);

        scheduleId = (await page.content()).match(/schedule\/(\d+)/)?.[1];
        log(`Schedule ID: ${scheduleId}`, 'SUCCESS');

        // Go to appointment page
        await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, { waitUntil: 'networkidle' });
        await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);
        await page.waitForTimeout(3000);

        // Get initial dates
        if (latestDates) {
            previousDates = [...latestDates];
            log(`Initial: ${latestDates.length} dates, first: ${latestDates[0]}, last: ${latestDates[latestDates.length-1]}`, 'FOUND');
        }

        // Also check hidden date
        const hiddenDate = '2026-02-02';
        await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment/times/${CONFIG.facilityId}.json?date=${hiddenDate}`);
        const hiddenText = await page.locator('body').innerText();
        try {
            const hiddenTimes = JSON.parse(hiddenText);
            if (hiddenTimes.available_times?.length > 0) {
                log(`Hidden date ${hiddenDate} has times: ${hiddenTimes.available_times.join(', ')}`, 'FOUND');
            } else {
                log(`Hidden date ${hiddenDate} has no times`, 'INFO');
            }
        } catch {}

        // Go back
        await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, { waitUntil: 'networkidle' });
        await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);

        log(`\nMonitoring every ${CONFIG.checkIntervalMs/1000}s - Press Ctrl+C to stop\n`, 'INFO');

        let checkNum = 0;

        // Monitoring loop
        while (true) {
            checkNum++;
            const now = new Date();
            const timeStr = now.toLocaleTimeString();

            // Refresh to trigger new /days/ request
            latestDates = null;
            await page.reload({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
            await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId).catch(() => {});
            await page.waitForTimeout(2000);

            if (!latestDates) {
                log(`[${checkNum}] No data received - session may have expired`, 'WARN');

                // Try to re-login
                const content = await page.content();
                if (content.includes('Sign in') || content.includes('sign_in')) {
                    log('Re-logging in...', 'WARN');
                    await page.goto(`${CONFIG.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded' });
                    await page.fill('#user_email', CONFIG.email);
                    await page.fill('#user_password', CONFIG.password);
                    try { await page.click('label[for="policy_confirmed"]', { timeout: 2000 }); } catch {}
                    await page.click('input[type="submit"][name="commit"]');
                    await page.waitForTimeout(5000);
                    await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, { waitUntil: 'networkidle' });
                    await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);
                }
            } else {
                // Compare dates
                const newDates = latestDates.filter(d => !previousDates.includes(d));
                const removedDates = previousDates.filter(d => !latestDates.includes(d));

                if (newDates.length > 0) {
                    console.log('');
                    log(`🚨 NEW DATES RELEASED!`, 'RELEASE');
                    newDates.forEach(d => log(`   + ${d}`, 'SUCCESS'));
                    console.log('');

                    releaseEvents.push({
                        type: 'RELEASE',
                        time: now.toISOString(),
                        localTime: timeStr,
                        newDates,
                        totalBefore: previousDates.length,
                        totalAfter: latestDates.length
                    });
                    saveEvents();
                }

                if (removedDates.length > 0) {
                    log(`📉 Dates removed (booked): ${removedDates.join(', ')}`, 'WARN');
                    releaseEvents.push({
                        type: 'BOOKED',
                        time: now.toISOString(),
                        localTime: timeStr,
                        removedDates
                    });
                    saveEvents();
                }

                if (newDates.length === 0 && removedDates.length === 0) {
                    process.stdout.write(`\r[${timeStr}] Check #${checkNum} - No changes | ${latestDates.length} dates | First: ${latestDates[0]}       `);
                }

                previousDates = [...latestDates];
            }

            await page.waitForTimeout(CONFIG.checkIntervalMs);
        }

    } catch (error) {
        log(`Error: ${error.message}`, 'ERROR');
        console.error(error.stack);
    }
}

process.on('SIGINT', () => {
    console.log('\n\n══════════════════════════════════════════════════════════');
    console.log('  STOPPED');
    console.log('══════════════════════════════════════════════════════════');

    if (releaseEvents.length > 0) {
        console.log(`\nRecorded ${releaseEvents.length} events:`);
        releaseEvents.forEach((e, i) => {
            console.log(`  ${i+1}. [${e.localTime}] ${e.type}`);
            if (e.newDates) console.log(`     New: ${e.newDates.join(', ')}`);
            if (e.removedDates) console.log(`     Removed: ${e.removedDates.join(', ')}`);
        });
        console.log(`\nSaved to: ${CONFIG.logFile}`);
    } else {
        console.log('\nNo release events recorded.');
    }

    process.exit(0);
});

run();
