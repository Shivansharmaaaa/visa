/**
 * Multi-session rotator (no proxy)
 * - Uses 5 accounts, each spun up 5 times (25 sessions)
 * - Round-robin checks; no booking, just monitoring
 * - Dead session (no responses for 3 minutes) triggers site check:
 *     - If site unreachable -> shutdown
 *     - If reachable -> relogin all sessions
 * - Telegram notifications include uptime
 * - Logs include IST time with milliseconds
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const https = require('https');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// CONFIG
// ============================================================================
const CONFIG = {
    baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
    city: process.env.PREFERRED_CITY || 'Toronto',
    facilityId: process.env.FACILITY_ID || '',
    startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
    endDate: new Date(process.env.END_DATE || '2026-05-30'),
    targetCPM: parseInt(process.env.TARGET_CPM, 10) || 200,
    sessionMultiplier: parseInt(process.env.SESSION_MULTIPLIER, 10) || 5, // per account
    perSessionMaxCPM: parseInt(process.env.PER_SESSION_MAX_CPM, 10) || 8, // cap per session
    headless: process.env.HEADLESS === 'true',
    deadTimeoutMs: parseInt(process.env.DEAD_TIMEOUT_MS, 10) || 3 * 60 * 1000, // 3 minutes
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    }
};

// Load accounts (ACCOUNT_1_EMAIL/PASSWORD ... ACCOUNT_5_EMAIL/PASSWORD)
const ACCOUNTS = [];
for (let i = 1; i <= 5; i++) {
    const email = process.env[`ACCOUNT_${i}_EMAIL`];
    const password = process.env[`ACCOUNT_${i}_PASSWORD`];
    if (email && password) ACCOUNTS.push({ email, password });
}
if (ACCOUNTS.length === 0 && process.env.VISA_EMAIL && process.env.VISA_PASSWORD) {
    ACCOUNTS.push({ email: process.env.VISA_EMAIL, password: process.env.VISA_PASSWORD });
}

if (ACCOUNTS.length === 0) {
    console.error('No accounts found in env');
    process.exit(1);
}

// ============================================================================
// TIME / LOGGING HELPERS
// ============================================================================
const botStart = Date.now();

function nowIST() {
    const d = new Date();
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    const ts = d.toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false
    });
    return `${ts}.${ms}`;
}

function uptime() {
    const ms = Date.now() - botStart;
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function log(message, level = 'INFO') {
    const colors = {
        INFO: '\x1b[36m',
        WARN: '\x1b[33m',
        ERROR: '\x1b[31m',
        SUCCESS: '\x1b[32m'
    };
    const prefix = `${nowIST()} | up ${uptime()}`;
    console.log(`${colors[level] || ''}[${prefix}] ${message}\x1b[0m`);
}

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
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        },
        timeout: 5000
    }, () => {});
    req.on('error', () => {});
    req.write(postData);
    req.end();
}

// ============================================================================
// SESSION STATE
// ============================================================================
const sessions = []; // { id, accountEmail, browser, context, page, scheduleId, facilityId, availableDate, lastResponseTime }
let currentIndex = 0;
let stopping = false;

function isDateInRange(dateStr) {
    const d = new Date(dateStr);
    return d >= CONFIG.startDate && d <= CONFIG.endDate;
}

// ============================================================================
// SESSION SETUP
// ============================================================================
async function setupResponseListener(session) {
    session.page.on('response', async (response) => {
        try {
            const url = response.url();
            if (url.includes('.json') && url.includes('appointments') && !url.includes('date=')) {
                const data = await response.json();
                if (Array.isArray(data) && data.length > 0) {
                    session.availableDate = data[0];
                    session.lastResponseTime = Date.now();
                    if (isDateInRange(session.availableDate.date)) {
                        log(`IN-RANGE DATE (${session.availableDate.date}) from ${session.accountEmail}`, 'SUCCESS');
                        sendTelegram(
                            `📅 <b>In-range date</b>\n` +
                            `👤 ${session.accountEmail}\n` +
                            `📍 ${CONFIG.city}\n` +
                            `📅 ${session.availableDate.date}\n` +
                            `⏱ Uptime: ${uptime()}`
                        );
                    }
                }
            }
        } catch {}
    });
}

async function loginSession(account, copyIndex) {
    const label = `${account.email}#${copyIndex}`;
    log(`Logging in session ${label}...`);

    const browser = await chromium.launch({
        headless: CONFIG.headless,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-webrtc']
    });

    const context = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        locale: 'en-CA',
        timezoneId: 'Asia/Kolkata'
    });

    const page = await context.newPage();

    await page.goto(`${CONFIG.baseUrl}/users/sign_in`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('#user_email', account.email);
    await page.fill('#user_password', account.password);
    try {
        await page.click('label[for="policy_confirmed"]', { timeout: 2000 });
    } catch {
        await page.click('#policy_confirmed', { force: true }).catch(() => {});
    }
    await page.click('input[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    const signUrl = page.url();
    if (signUrl.includes('sign_in')) {
        await browser.close();
        throw new Error(`Login failed for ${label}`);
    }

    // Extract schedule ID
    const content = await page.content();
    const scheduleId = content.match(/schedule\/(\d+)/)?.[1];
    if (!scheduleId) {
        await browser.close();
        throw new Error(`No schedule ID for ${label}`);
    }

    // Go to appointment page
    await page.goto(`${CONFIG.baseUrl}/schedule/${scheduleId}/appointment`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000
    });

    // Select facility if provided
    if (CONFIG.facilityId) {
        try {
            await page.waitForSelector('#appointments_consulate_appointment_facility_id', { timeout: 10000 });
            await page.selectOption('#appointments_consulate_appointment_facility_id', CONFIG.facilityId);
        } catch {}
    }

    const session = {
        id: `${label}`,
        accountEmail: account.email,
        browser,
        context,
        page,
        scheduleId,
        facilityId: CONFIG.facilityId,
        availableDate: null,
        lastResponseTime: Date.now()
    };

    await setupResponseListener(session);
    log(`Session ready: ${label}`, 'SUCCESS');
    return session;
}

async function buildAllSessions() {
    log(`Spinning up ${ACCOUNTS.length} accounts x ${CONFIG.sessionMultiplier} sessions each...`);
    // Close existing sessions if any
    for (const s of sessions) {
        try { await s.browser.close(); } catch {}
    }
    sessions.length = 0;

    for (const account of ACCOUNTS) {
        for (let i = 1; i <= CONFIG.sessionMultiplier; i++) {
            try {
                const session = await loginSession(account, i);
                sessions.push(session);
                await new Promise(r => setTimeout(r, 200)); // stagger
            } catch (e) {
                log(e.message, 'ERROR');
            }
        }
    }

    if (sessions.length === 0) {
        log('No sessions active after login attempts', 'ERROR');
        process.exit(1);
    }
    log(`Total sessions active: ${sessions.length}`, 'SUCCESS');
}

// ============================================================================
// MONITORING
// ============================================================================
async function triggerCheck(session) {
    session.lastRequestTime = Date.now();
    await session.page.evaluate(() => {
        const sel = document.querySelector('#appointments_consulate_appointment_facility_id');
        if (sel && sel.value) {
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof $ !== 'undefined') $(sel).trigger('change');
        }
    });
}

function deadSessions() {
    const now = Date.now();
    return sessions.filter(s => now - s.lastResponseTime > CONFIG.deadTimeoutMs);
}

function checkSiteAccessible() {
    return new Promise((resolve) => {
        const req = https.request(CONFIG.baseUrl, { method: 'GET', timeout: 8000 }, (res) => {
            resolve(res.statusCode && res.statusCode < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

async function handleDeadSession(dList) {
    const names = dList.map(s => s.id).join(', ');
    log(`Dead sessions detected (${names}). Checking site...`, 'WARN');
    const accessible = await checkSiteAccessible();
    if (!accessible) {
        const msg = `🛑 <b>Site unreachable</b>\nDead sessions: ${names}\nUptime: ${uptime()}`;
        sendTelegram(msg);
        log('Site unreachable. Shutting down.', 'ERROR');
        await shutdown();
        return;
    }

    sendTelegram(
        `♻️ <b>Dead sessions detected</b>\nSessions: ${names}\nReloading all sessions...\nUptime: ${uptime()}`
    );
    await buildAllSessions();
}

// ============================================================================
// MAIN LOOP
// ============================================================================
async function main() {
    log('Starting multi-session rotator (no proxy)...');
    log(`City: ${CONFIG.city} | Facility: ${CONFIG.facilityId || 'default'} | Target CPM: ${CONFIG.targetCPM}`);
    sendTelegram(
        `🚀 <b>Rotator Started</b>\n` +
        `Accounts: ${ACCOUNTS.length}\n` +
        `Sessions: ${ACCOUNTS.length * CONFIG.sessionMultiplier}\n` +
        `City: ${CONFIG.city}\n` +
        `CPM: ${CONFIG.targetCPM}\n` +
        `Uptime: ${uptime()}`
    );

    await buildAllSessions();

    const totalSessions = sessions.length;
    const perSessionCap = CONFIG.perSessionMaxCPM * totalSessions;
    const cycleDelayMs = Math.max(
        10,
        Math.floor(60000 / CONFIG.targetCPM),
        Math.floor(60000 / (perSessionCap || 1))
    );

    const effectiveCPM = Math.round(60000 / cycleDelayMs);
    const effectivePerSession = (effectiveCPM / totalSessions).toFixed(2);

    log(`Cycle delay: ${cycleDelayMs} ms (effective ~${effectiveCPM} CPM total; ~${effectivePerSession} per session, cap ${CONFIG.perSessionMaxCPM})`);

    while (!stopping) {
        const session = sessions[currentIndex];
        try {
            await triggerCheck(session);
        } catch (e) {
            log(`Trigger failed for ${session.id}: ${e.message}`, 'WARN');
            session.lastResponseTime = 0; // mark as dead quickly
        }

        const dList = deadSessions();
        if (dList.length > 0) {
            await handleDeadSession(dList);
        }

        currentIndex = (currentIndex + 1) % sessions.length;
        await new Promise(r => setTimeout(r, cycleDelayMs));
    }
}

// ============================================================================
// CLEANUP
// ============================================================================
async function shutdown() {
    if (stopping) return;
    stopping = true;
    log('Shutting down...', 'WARN');
    sendTelegram(`🛑 <b>Bot Stopped</b>\nUptime: ${uptime()}`);
    for (const s of sessions) {
        try { await s.browser.close(); } catch {}
    }
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', async (err) => {
    log(`Fatal error: ${err.message}`, 'ERROR');
    sendTelegram(`⚠️ <b>Crash</b>\n${err.message}\nUptime: ${uptime()}`);
    await shutdown();
});

// Start
main();
