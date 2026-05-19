/**
 * Account Login Checker - Tests all accounts from .env.nothang_rotation
 * Logs into each account one by one and reports which ones work / fail.
 *
 * Usage: node check_accounts.js
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
require('dotenv').config({ path: '.env.nothang_rotation' });

chromium.use(stealth);

// ============================================================================
// LOAD CONFIG
// ============================================================================
const BASE_URL = process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv';

const PROXY = {
    enabled: process.env.PROXY_ENABLED !== 'false',
    server: process.env.PROXY_SERVER || 'pr.oxylabs.io:7777',
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD
};

const TELEGRAM = {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
};

// Load all accounts
const ACCOUNTS = [];
for (let i = 1; i <= 20; i++) {
    const email = process.env[`ACCOUNT${i}_EMAIL`];
    const password = process.env[`ACCOUNT${i}_PASSWORD`];
    if (email && password) {
        ACCOUNTS.push({ index: i, email, password });
    }
}

// Also check verify account
const VERIFY_EMAIL = process.env.VERIFY_EMAIL;
const VERIFY_PASSWORD = process.env.VERIFY_PASSWORD;
if (VERIFY_EMAIL && VERIFY_PASSWORD) {
    ACCOUNTS.push({ index: 'V', email: VERIFY_EMAIL, password: VERIFY_PASSWORD, isVerify: true });
}

console.log(`\nFound ${ACCOUNTS.length} accounts to check\n`);

// ============================================================================
// TELEGRAM
// ============================================================================
function sendTelegram(message) {
    if (!TELEGRAM.botToken || !TELEGRAM.chatId) return;

    const postData = JSON.stringify({
        chat_id: TELEGRAM.chatId,
        text: message,
        parse_mode: 'HTML'
    });

    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TELEGRAM.botToken}/sendMessage`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 10000
    }, () => {});

    req.on('error', () => {});
    req.write(postData);
    req.end();
}

// ============================================================================
// TEST SINGLE ACCOUNT
// ============================================================================
async function testAccount(account) {
    const label = account.isVerify ? `[VERIFY]` : `[Account #${account.index}]`;
    console.log(`\x1b[36m${label} Testing: ${account.email}...\x1b[0m`);

    let browser = null;

    try {
        // Generate unique proxy session per account test
        const launchOptions = {
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-webrtc',
                '--no-sandbox'
            ]
        };

        if (PROXY.enabled && PROXY.username) {
            const sessionId = Math.floor(Math.random() * 9999999999).toString().padStart(10, '0');
            const proxyUsername = PROXY.username.replace(/sessid-\d+/, `sessid-${sessionId}`);
            launchOptions.proxy = {
                server: `http://${PROXY.server}`,
                username: proxyUsername,
                password: PROXY.password
            };
        }

        browser = await chromium.launch(launchOptions);
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();

        // Go to login page
        await page.goto(`${BASE_URL}/users/sign_in`, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        await page.waitForSelector('#user_email', { timeout: 15000 });

        // Check for system busy
        const pageText = await page.innerText('body').catch(() => '');
        if (pageText.toLowerCase().includes('system is busy')) {
            await browser.close();
            return { ...account, status: 'SYSTEM_BUSY', error: 'System is busy', color: '\x1b[33m' };
        }

        // Fill credentials
        await page.fill('#user_email', account.email);
        await page.fill('#user_password', account.password);

        // Checkbox
        try {
            await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
        } catch (e) {
            await page.click('#policy_confirmed', { force: true }).catch(() => {});
        }

        // Submit
        await page.click('input[type="submit"]');

        // Handle error modal
        try {
            const okButton = page.locator('button:has-text("OK"), a:has-text("OK")');
            if (await okButton.isVisible({ timeout: 3000 })) {
                await okButton.click();
                await page.click('.icheckbox', { force: true }).catch(() => {});
                await page.click('input[type="submit"]');
            }
        } catch (e) {}

        // Wait for navigation
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        const finalUrl = page.url();
        const finalText = await page.innerText('body').catch(() => '');

        await browser.close();
        browser = null;

        // Check result
        if (finalUrl.includes('sign_in')) {
            // Still on login page - check why
            if (finalText.toLowerCase().includes('locked')) {
                return { ...account, status: 'LOCKED', error: 'Account is locked', color: '\x1b[31m' };
            }
            if (finalText.toLowerCase().includes('invalid') || finalText.toLowerCase().includes('incorrect')) {
                return { ...account, status: 'BAD_CREDENTIALS', error: 'Invalid email or password', color: '\x1b[31m' };
            }
            if (finalText.toLowerCase().includes('too many')) {
                return { ...account, status: 'RATE_LIMITED', error: 'Too many attempts', color: '\x1b[33m' };
            }
            return { ...account, status: 'FAILED', error: 'Login failed (still on sign_in page)', color: '\x1b[31m' };
        }

        // Successfully logged in
        // Check if we can see the continue/schedule button
        let hasAppointment = false;
        if (finalText.includes('Continue') || finalUrl.includes('schedule')) {
            hasAppointment = true;
        }

        return {
            ...account,
            status: 'OK',
            hasAppointment,
            error: null,
            color: '\x1b[32m'
        };

    } catch (error) {
        if (browser) await browser.close().catch(() => {});

        let status = 'ERROR';
        let color = '\x1b[31m';

        if (error.message.includes('timeout') || error.message.includes('Timeout')) {
            status = 'TIMEOUT';
            color = '\x1b[33m';
        }

        return { ...account, status, error: error.message.substring(0, 80), color };
    }
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
    console.log('='.repeat(70));
    console.log('\x1b[32m  ACCOUNT LOGIN CHECKER\x1b[0m');
    console.log(`  URL: ${BASE_URL}`);
    console.log(`  Proxy: ${PROXY.enabled ? 'ON' : 'OFF'}`);
    console.log(`  Accounts to test: ${ACCOUNTS.length}`);
    console.log('='.repeat(70) + '\n');

    const results = [];
    const startTime = Date.now();

    for (const account of ACCOUNTS) {
        const result = await testAccount(account);
        results.push(result);

        const label = result.isVerify ? 'VERIFY' : `#${result.index}`;
        const apptTag = result.hasAppointment ? ' [Has Appointment]' : '';
        console.log(`${result.color}  ${label} | ${result.email} | ${result.status}${result.error ? ' - ' + result.error : ''}${apptTag}\x1b[0m`);

        // Small delay between tests to avoid rate limiting
        await new Promise(r => setTimeout(r, 3000));
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // Summary
    const ok = results.filter(r => r.status === 'OK');
    const failed = results.filter(r => r.status === 'FAILED' || r.status === 'BAD_CREDENTIALS');
    const locked = results.filter(r => r.status === 'LOCKED');
    const timeout = results.filter(r => r.status === 'TIMEOUT');
    const rateLimited = results.filter(r => r.status === 'RATE_LIMITED');
    const busy = results.filter(r => r.status === 'SYSTEM_BUSY');
    const errors = results.filter(r => r.status === 'ERROR');

    console.log('\n' + '='.repeat(70));
    console.log('\x1b[32m  RESULTS SUMMARY\x1b[0m');
    console.log('='.repeat(70));
    console.log(`\x1b[32m  OK:             ${ok.length}\x1b[0m`);
    if (failed.length)      console.log(`\x1b[31m  BAD CREDENTIALS: ${failed.length}\x1b[0m`);
    if (locked.length)      console.log(`\x1b[31m  LOCKED:          ${locked.length}\x1b[0m`);
    if (timeout.length)     console.log(`\x1b[33m  TIMEOUT:         ${timeout.length}\x1b[0m`);
    if (rateLimited.length) console.log(`\x1b[33m  RATE LIMITED:    ${rateLimited.length}\x1b[0m`);
    if (busy.length)        console.log(`\x1b[33m  SYSTEM BUSY:     ${busy.length}\x1b[0m`);
    if (errors.length)      console.log(`\x1b[31m  ERRORS:          ${errors.length}\x1b[0m`);
    console.log(`  Time: ${elapsed}s`);
    console.log('='.repeat(70));

    // Detailed list
    console.log('\n\x1b[32m  WORKING:\x1b[0m');
    if (ok.length === 0) console.log('    (none)');
    ok.forEach(r => {
        const label = r.isVerify ? 'VERIFY' : `#${r.index}`;
        console.log(`    ${label} - ${r.email}${r.hasAppointment ? ' [Has Appointment]' : ''}`);
    });

    if (failed.length + locked.length + errors.length > 0) {
        console.log('\n\x1b[31m  NOT WORKING:\x1b[0m');
        [...failed, ...locked, ...errors].forEach(r => {
            const label = r.isVerify ? 'VERIFY' : `#${r.index}`;
            console.log(`    ${label} - ${r.email} (${r.status}: ${r.error})`);
        });
    }

    if (timeout.length + rateLimited.length + busy.length > 0) {
        console.log('\n\x1b[33m  TEMPORARY ISSUES (retry later):\x1b[0m');
        [...timeout, ...rateLimited, ...busy].forEach(r => {
            const label = r.isVerify ? 'VERIFY' : `#${r.index}`;
            console.log(`    ${label} - ${r.email} (${r.status})`);
        });
    }

    console.log('');

    // Send Telegram summary
    let telegramMsg = `<b>Account Check Results</b>\n\n`;
    telegramMsg += `OK: ${ok.length} / ${results.length}\n\n`;

    results.forEach(r => {
        const label = r.isVerify ? 'VERIFY' : `#${r.index}`;
        const icon = r.status === 'OK' ? '✅' : r.status === 'LOCKED' ? '🔒' : r.status === 'TIMEOUT' || r.status === 'RATE_LIMITED' || r.status === 'SYSTEM_BUSY' ? '⏳' : '❌';
        telegramMsg += `${icon} ${label} ${r.email}\n→ ${r.status}${r.error ? ': ' + r.error.substring(0, 50) : ''}\n\n`;
    });

    sendTelegram(telegramMsg);

    // Wait for telegram to send
    await new Promise(r => setTimeout(r, 2000));

    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
});
