const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const config = require('./config');
const { log, getRandomDelay, isDateInRange } = require('./utils');
const { sendTelegramNotification } = require('./notifications');
const { banAccount, isAccountBanned } = require('./ban_tracker');
const { updateStatus, clearStatus } = require('./bot_status');
const fs = require('fs');
const path = require('path');

// Cooldown file for "system busy" - tells launcher to wait
const COOLDOWN_DIR = path.join(process.cwd(), 'cooldowns');
const COOLDOWN_DURATION = 5 * 60 * 1000; // 5 minutes

function setCooldown(email, reason) {
    if (!fs.existsSync(COOLDOWN_DIR)) {
        fs.mkdirSync(COOLDOWN_DIR, { recursive: true });
    }
    const cooldownFile = path.join(COOLDOWN_DIR, `${email.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
    fs.writeFileSync(cooldownFile, JSON.stringify({
        email,
        reason,
        until: Date.now() + COOLDOWN_DURATION,
        createdAt: new Date().toISOString()
    }));
}

chromium.use(stealth);

/**
 * State to store found slots from network responses
 */
let availableDate = null;
let availableTime = null;
let lastResponseTime = 0;
let consecutiveLoginFailures = 0;
let closestSlotFound = null; // Track closest slot to today (even if outside range)

/**
 * Main function to run the visa booking bot WITHOUT PROXY.
 */
async function runBot() {
    // Check if account is banned
    if (isAccountBanned(config.credentials.email)) {
        log(`Account ${config.credentials.email} is banned. Skipping.`, 'FATAL');
        await sendTelegramNotification(`🚫 <b>Account Banned:</b> ${config.credentials.email} is in banned list. Exiting.`).catch(() => {});
        process.exit(10);
    }

    if (consecutiveLoginFailures >= 3) {
        log('Login failed 3 consecutive times. Stopping bot to protect account.', 'FATAL');
        banAccount(config.credentials.email, 'Too many login failures');
        await sendTelegramNotification(`⚠️ <b>Fatal Error:</b> Login failed 3 consecutive times for <b>${config.credentials.email}</b>. Account banned.`).catch(() => {});
        process.exit(1);
    }

    log('--- Starting Visa Appointment Bot (NO PROXY) ---');
    log(`Using Identity: ${config.credentials.email}`);

    const targetCPM = 20; // Default CPM without proxy mode config
    log(`Mode: Direct Connection (No Proxy) | Target CPM: ${targetCPM}`);

    // Ensure dates are set correctly (today to March 31, 2026)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDate = new Date('2026-03-31');

    if (!config.preferences.startDate || config.preferences.startDate.toDateString() !== today.toDateString()) {
        config.preferences.startDate = today;
    }
    if (!config.preferences.endDate || config.preferences.endDate.toDateString() !== endDate.toDateString()) {
        config.preferences.endDate = endDate;
    }

    const dateRange = `${config.preferences.startDate.toISOString().split('T')[0]} to ${config.preferences.endDate.toISOString().split('T')[0]}`;

    await sendTelegramNotification(
        `🚀 <b>Bot Started (No Proxy)</b>\n` +
        `<b>User:</b> ${config.credentials.email}\n` +
        `<b>City:</b> ${config.preferences.cities[0]}\n` +
        `<b>Date Range:</b> ${dateRange}\n` +
        `<b>Connection:</b> Direct (No Proxy)\n` +
        `<b>Target CPM:</b> ${targetCPM}`
    ).catch(err => {
        log(`Failed to send Telegram notification: ${err.message}`, 'ERROR');
    });

    let browser;
    let context;
    let page;

    try {
        // Initialize browser WITHOUT proxy
        log('Launching Chrome browser (direct connection)...');
        try {
            browser = await chromium.launch({
                headless: false
            });
            log('Chrome launched successfully (no proxy)');
        } catch (browserError) {
            await sendTelegramNotification(
                `🚨 <b>Browser Launch Failed</b>\n` +
                `<b>User:</b> ${config.credentials.email}\n` +
                `<b>Error:</b> ${browserError.message}\n` +
                `<b>Connection:</b> Direct\n` +
                `<b>Action:</b> Retrying...`
            ).catch(() => {});
            throw browserError;
        }

        const resolutions = [
            { width: 1920, height: 1080 },
            { width: 1440, height: 900 },
            { width: 1366, height: 768 },
            { width: 1536, height: 864 },
            { width: 1680, height: 1050 },
            { width: 1280, height: 800 },
            { width: 1600, height: 900 },
            { width: 2560, height: 1440 }
        ];
        const randomRes = resolutions[Math.floor(Math.random() * resolutions.length)];

        // Canadian timezone/location profiles for realistic fingerprinting
        const locationProfiles = [
            { timezone: 'America/Toronto', locale: 'en-CA', lat: 43.6532, lng: -79.3832, city: 'Toronto' },
            { timezone: 'America/Toronto', locale: 'en-CA', lat: 45.4215, lng: -75.6972, city: 'Ottawa' },
            { timezone: 'America/Vancouver', locale: 'en-CA', lat: 49.2827, lng: -123.1207, city: 'Vancouver' },
            { timezone: 'America/Edmonton', locale: 'en-CA', lat: 51.0447, lng: -114.0719, city: 'Calgary' },
            { timezone: 'America/Edmonton', locale: 'en-CA', lat: 53.5461, lng: -113.4938, city: 'Edmonton' },
            { timezone: 'America/Winnipeg', locale: 'en-CA', lat: 49.8951, lng: -97.1384, city: 'Winnipeg' },
            { timezone: 'America/Halifax', locale: 'en-CA', lat: 44.6488, lng: -63.5752, city: 'Halifax' },
            { timezone: 'America/Montreal', locale: 'fr-CA', lat: 45.5017, lng: -73.5673, city: 'Montreal' },
            { timezone: 'America/Toronto', locale: 'en-CA', lat: 43.2557, lng: -79.8711, city: 'Hamilton' },
            { timezone: 'America/Toronto', locale: 'en-CA', lat: 42.9849, lng: -81.2453, city: 'London' },
            // US locations (for variety - people travel)
            { timezone: 'America/New_York', locale: 'en-US', lat: 40.7128, lng: -74.0060, city: 'New York' },
            { timezone: 'America/Chicago', locale: 'en-US', lat: 41.8781, lng: -87.6298, city: 'Chicago' },
            { timezone: 'America/Los_Angeles', locale: 'en-US', lat: 34.0522, lng: -118.2437, city: 'Los Angeles' },
            { timezone: 'America/Denver', locale: 'en-US', lat: 39.7392, lng: -104.9903, city: 'Denver' },
        ];
        const sessionLocation = locationProfiles[Math.floor(Math.random() * locationProfiles.length)];

        // Comprehensive user agent randomization
        const userAgents = [
            // Chrome on macOS (various versions)
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            // Chrome on Windows
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            // Firefox on macOS
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:123.0) Gecko/20100101 Firefox/123.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:124.0) Gecko/20100101 Firefox/124.0',
            // Firefox on Windows
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
            // Edge on Windows
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
            // Safari on macOS
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
            // Chrome on Linux
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ];

        // Pick a random user agent for this session
        const sessionUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
        log(`Using User-Agent: ${sessionUserAgent.substring(0, 60)}...`);
        log(`Using Location: ${sessionLocation.city} (${sessionLocation.timezone})`);

        // Create context once - this maintains cookies/session throughout the entire flow
        context = await browser.newContext({
            userAgent: sessionUserAgent,
            viewport: randomRes,
            timezoneId: sessionLocation.timezone,
            locale: sessionLocation.locale,
            geolocation: { latitude: sessionLocation.lat, longitude: sessionLocation.lng },
            permissions: ['geolocation']
        });

        page = await context.newPage();

        // Setup network response listener
        setupResponseListener(page);

        // 1. Perform Login
        let loginError = null;
        const loginSuccess = await login(page, browser).catch(e => {
            loginError = e.message;
            return false;
        });

        if (!loginSuccess) {
            consecutiveLoginFailures++;
            log(`Login attempt #${consecutiveLoginFailures}/3 failed: ${loginError || 'Unknown error'}`, 'ERROR');

            await sendTelegramNotification(
                `❌ <b>Login Failed</b> (#${consecutiveLoginFailures}/3)\n` +
                `<b>User:</b> ${config.credentials.email}\n` +
                `<b>Error:</b> ${loginError}\n` +
                `<b>Connection:</b> Direct (No Proxy)\n` +
                `<b>Status:</b> ${consecutiveLoginFailures < 3 ? 'Will retry' : 'Max attempts reached'}`
            ).catch(() => {});

            await browser.close();

            if (consecutiveLoginFailures < 3) {
                const waitTime = 30000;
                log(`Retrying in ${waitTime/1000} seconds...`);
                clearStatus(config.credentials.email);
                await new Promise(r => setTimeout(r, waitTime));
                return runBot();
            } else {
                log('Max attempts (3) reached for this account. Banning.', 'FATAL');
                banAccount(config.credentials.email, 'Max login attempts reached (3 failures)');
                await sendTelegramNotification(`🔄 <b>Account Banned:</b> Too many failures for <b>${config.credentials.email}</b>.`).catch(() => {});
                clearStatus(config.credentials.email);
                process.exit(10);
            }
        }
        consecutiveLoginFailures = 0; // Reset only on success

        // 2. Navigation to Appointment Page
        const navigationSuccess = await navigateToAppointmentPage(page);
        if (!navigationSuccess) {
            log('Failed to navigate to appointment page. Retrying...', 'ERROR');
            await sendTelegramNotification(
                `⚠️ <b>Navigation Error</b>\n` +
                `<b>User:</b> ${config.credentials.email}\n` +
                `<b>Issue:</b> Could not navigate to appointment page\n` +
                `<b>Connection:</b> Direct (No Proxy)\n` +
                `<b>Action:</b> Restarting...`
            ).catch(() => {});
            await browser.close();
            clearStatus(config.credentials.email);
            return runBot();
        }

        // Notify successful login and navigation
        const currentCity = config.preferences.cities[0];
        await sendTelegramNotification(
            `✅ <b>Successfully Logged In</b>\n` +
            `<b>User:</b> ${config.credentials.email}\n` +
            `<b>City:</b> ${currentCity}\n` +
            `<b>Connection:</b> Direct (No Proxy)\n` +
            `<b>Status:</b> Now monitoring for slots...`
        ).catch(() => {});

        // Update status after successful login
        updateStatus(config.credentials.email, {
            proxy: 'Direct (No Proxy)',
            proxyMode: 'none',
            targetCPM: targetCPM,
            city: currentCity,
            status: 'logged_in'
        });

        // 3. Monitoring Loop
        let checkCount = 0;
        let startTime = Date.now();
        let lastStatusUpdate = Date.now();

        while (true) {
            try {
                checkCount++;

                // Check for "system is busy" message on page
                try {
                    const pageText = await page.innerText('body').catch(() => '');
                    if (pageText.toLowerCase().includes('system is busy') ||
                        pageText.toLowerCase().includes('try again later') ||
                        pageText.toLowerCase().includes('service unavailable') ||
                        pageText.toLowerCase().includes('too many requests')) {
                        log('System is busy detected during monitoring - setting cooldown and moving to next account...', 'WARN');
                        setCooldown(config.credentials.email, 'System busy during monitoring');
                        await sendTelegramNotification(
                            `⏳ <b>System Busy</b>\n` +
                            `<b>User:</b> ${config.credentials.email}\n` +
                            `<b>Detected:</b> During monitoring (check #${checkCount})\n` +
                            `<b>Action:</b> Cooling down for 5 minutes, moving to next account...`
                        ).catch(() => {});
                        await browser.close();
                        clearStatus(config.credentials.email);
                        process.exit(20); // Special exit code for cooldown
                    }
                } catch (e) {
                    // Ignore errors checking page text
                }

                // Trigger a fresh request without changing the city selection
                await resetSelection(page);

                // Ultra-fast check for data (100ms)
                const slotDate = await waitForAvailableSlot(0.1);

                // Calculate Stats
                const elapsedMinutes = (Date.now() - startTime) / 60000;
                const cpm = (checkCount / elapsedMinutes).toFixed(1);
                const dateDisplay = availableDate ? availableDate.date : 'SEARCHING...';
                const closestDisplay = closestSlotFound ? closestSlotFound.date : 'None found';

                // Log status
                log(`[${cpm} CPM] Check #${checkCount} | City: ${currentCity} | Slot: ${dateDisplay} | Closest: ${closestDisplay} | Connection: Direct`);

                // Update status file
                updateStatus(config.credentials.email, {
                    proxy: 'Direct (No Proxy)',
                    proxyMode: 'none',
                    targetCPM: targetCPM,
                    cpm: parseFloat(cpm),
                    slot: dateDisplay,
                    closestSlot: closestDisplay,
                    city: currentCity,
                    checkCount: checkCount,
                    runtime: Math.floor((Date.now() - startTime) / 1000),
                    status: 'running'
                });

                // Send Telegram update every 1 minute
                if (Date.now() - lastStatusUpdate > 60000) {
                    const startDateStr = config.preferences.startDate.toISOString().split('T')[0];
                    const endDateStr = config.preferences.endDate.toISOString().split('T')[0];
                    await sendTelegramNotification(
                        `📊 <b>Status Update</b>\n` +
                        `<b>User:</b> ${config.credentials.email}\n` +
                        `<b>CPM:</b> ${cpm} (target: ${targetCPM})\n` +
                        `<b>Date Range:</b> ${startDateStr} to ${endDateStr}\n` +
                        `<b>Current Slot:</b> ${dateDisplay}\n` +
                        `<b>Closest Slot:</b> ${closestDisplay}\n` +
                        `<b>Connection:</b> Direct (No Proxy)`
                    ).catch(() => {});
                    lastStatusUpdate = Date.now();
                }

                // Booking Logic
                if (slotDate) {
                    if (isDateInRange(slotDate.date, config.preferences.startDate, config.preferences.endDate)) {
                        log(`!!! SLOT FOUND: ${slotDate.date} !!!`, 'SUCCESS');
                        await sendTelegramNotification(
                            `🎯 <b>SLOT DETECTED!</b>\n` +
                            `<b>User:</b> ${config.credentials.email}\n` +
                            `<b>City:</b> ${currentCity}\n` +
                            `<b>Date:</b> ${slotDate.date}\n` +
                            `<b>Connection:</b> Direct (No Proxy)\n` +
                            `<b>Status:</b> Attempting to book...`
                        ).catch(() => {});

                        const booked = await performBooking(page, slotDate);
                        if (booked) {
                            log('Appointment successfully booked!', 'SUCCESS');
                            await sendTelegramNotification(
                                `🎉✅ <b>APPOINTMENT BOOKED!</b>\n` +
                                `<b>User:</b> ${config.credentials.email}\n` +
                                `<b>City:</b> ${currentCity}\n` +
                                `<b>Date:</b> ${slotDate.date}\n` +
                                `<b>Success!</b> Check your email for confirmation.`
                            ).catch(() => {});
                            break;
                        } else {
                            await sendTelegramNotification(
                                `❌ <b>Booking Failed</b>\n` +
                                `<b>User:</b> ${config.credentials.email}\n` +
                                `<b>Date:</b> ${slotDate.date}\n` +
                                `<b>Reason:</b> Could not complete booking\n` +
                                `<b>Status:</b> Continuing to monitor...`
                            ).catch(() => {});
                        }
                    } else {
                        // Slot found but outside date range - notify occasionally
                        if (checkCount % 100 === 0) {
                            await sendTelegramNotification(
                                `📅 <b>Slot Available (Outside Range)</b>\n` +
                                `<b>User:</b> ${config.credentials.email}\n` +
                                `<b>Available:</b> ${slotDate.date}\n` +
                                `<b>Your Range:</b> ${dateRange}\n` +
                                `<b>Status:</b> Continuing search...`
                            ).catch(() => {});
                        }
                    }
                }

                // Small pause with Jitter
                const delay = getRandomDelay(targetCPM);
                await page.waitForTimeout(delay);
            } catch (loopError) {
                log(`Error in monitoring loop: ${loopError.message}`, 'ERROR');
                if (loopError.message.includes('session') || loopError.message.includes('login')) {
                    await sendTelegramNotification(
                        `⚠️ <b>Session Expired</b>\n` +
                        `<b>User:</b> ${config.credentials.email}\n` +
                        `<b>Checks Done:</b> ${checkCount}\n` +
                        `<b>Error:</b> ${loopError.message}\n` +
                        `<b>Action:</b> Restarting and logging in again...`
                    ).catch(() => {});
                    await browser.close();
                    return runBot();
                } else {
                    await sendTelegramNotification(
                        `⚠️ <b>Monitoring Error</b> (continuing...)\n` +
                        `<b>User:</b> ${config.credentials.email}\n` +
                        `<b>Error:</b> ${loopError.message}\n` +
                        `<b>Status:</b> Bot still running`
                    ).catch(() => {});
                }
            }
        }

    } catch (error) {
        log(`Fatal error: ${error.message}`, 'ERROR');
        await sendTelegramNotification(
            `🛑 <b>Bot Crashed:</b> Unexpected error for <b>${config.credentials.email}</b>\n` +
            `<b>Error:</b> ${error.message}\n` +
            `<b>Connection:</b> Direct (No Proxy)`
        ).catch(() => {});
        clearStatus(config.credentials.email);
    }
}

// Cleanup on exit
process.on('exit', () => {
    clearStatus(config.credentials.email);
});
process.on('SIGINT', () => {
    clearStatus(config.credentials.email);
});
process.on('SIGTERM', () => {
    clearStatus(config.credentials.email);
});

/**
 * Listens for network responses to catch available dates/times.
 */
function setupResponseListener(page) {
    page.on('response', async (response) => {
        try {
            const url = response.url();
            if (url.includes('json?appointments')) {
                const data = await response.json();
                if (data && data.length > 0) {
                    availableDate = data[0];
                    lastResponseTime = Date.now();

                    // Track closest slot (even if outside range) - find minimum date >= today
                    const slotDate = new Date(availableDate.date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    slotDate.setHours(0, 0, 0, 0);

                    if (slotDate >= today) {
                        if (!closestSlotFound || slotDate < new Date(closestSlotFound.date)) {
                            closestSlotFound = availableDate;
                        }
                    }
                }
            } else if (url.includes('json?date')) {
                const data = await response.json();
                if (data.available_times && data.available_times.length > 0) {
                    availableTime = data.available_times[0];
                }
            }
        } catch (e) {
            // Silence parsing errors for non-JSON responses
        }
    });
}

/**
 * Wait for a fresh response to be captured.
 */
async function waitForAvailableSlot(timeoutSeconds = 0.1) {
    const prevTime = lastResponseTime;
    let counter = 0;
    while (lastResponseTime === prevTime && counter < timeoutSeconds * 40) {
        await new Promise(r => setTimeout(r, 25));
        counter++;
    }
    return availableDate;
}

async function login(page, browser) {
    log('Attempting login...');
    let retryCount = 0;
    const maxRetries = 3;

    while (retryCount < maxRetries) {
        try {
            const response = await page.goto(`${config.preferences.baseUrl}/users/sign_in`, {
                waitUntil: 'domcontentloaded',
                timeout: 90000
            });

            if (!response || !response.ok()) {
                throw new Error(`HTTP_${response ? response.status() : 'FAILED'}`);
            }
            break;
        } catch (e) {
            retryCount++;
            log(`Connection attempt ${retryCount}/${maxRetries} failed: ${e.message}`, 'WARN');
            if (retryCount >= maxRetries) throw e;
            await page.waitForTimeout(3000);
        }
    }

    try {
        await page.waitForSelector('#user_email', { timeout: 30000 });
        const pageText = await page.innerText('body');

        // Check for "system busy" message
        if (pageText.toLowerCase().includes('system is busy') ||
            pageText.toLowerCase().includes('try again later') ||
            pageText.toLowerCase().includes('service unavailable') ||
            pageText.toLowerCase().includes('too many requests')) {
            log('System is busy - setting 5 minute cooldown and exiting...', 'WARN');
            setCooldown(config.credentials.email, 'System busy');
            await sendTelegramNotification(
                `⏳ <b>System Busy</b>\n` +
                `<b>User:</b> ${config.credentials.email}\n` +
                `<b>Action:</b> Cooling down for 5 minutes...`
            ).catch(() => {});
            await browser.close();
            process.exit(20);
        }

        if (pageText.includes('Your account is locked') || pageText.includes('too many login attempts')) {
            const lockMatch = pageText.match(/locked until (.*)\./);
            const lockMsg = lockMatch ? `Locked until ${lockMatch[1]}` : 'Account Locked';
            log(`CRITICAL: ${lockMsg}. Banning account...`, 'FATAL');

            banAccount(config.credentials.email, lockMsg);

            try {
                await sendTelegramNotification(
                    `🔒 <b>Account Locked & Banned:</b> <b>${config.credentials.email}</b>\n` +
                    `<b>Status:</b> ${lockMsg}\n` +
                    `<b>Action:</b> Account added to banned list`
                ).catch(() => {});
            } catch (e) {}
            await browser.close();
            process.exit(10);
        }

        await page.fill('#user_email', config.credentials.email);
        await page.fill('#user_password', config.credentials.password);

        log('Selecting privacy policy checkbox...');
        try {
            const checkboxSelector = '#policy_confirmed';
            const checkboxLabel = 'label[for="policy_confirmed"]';

            try {
                await page.click(checkboxLabel, { timeout: 2000 }).catch(() => {});
            } catch (e) {
                try {
                    await page.click(checkboxSelector, { timeout: 2000 }).catch(() => {});
                } catch (e2) {
                    await page.click('.icheckbox', { timeout: 2000 }).catch(() => {});
                }
            }

            const isChecked = await page.isChecked(checkboxSelector).catch(() => false);
            if (!isChecked) {
                await page.click(checkboxSelector, { force: true }).catch(() => {});
            }
        } catch (e) {
            log('Checkbox interaction failed: ' + e.message, 'WARN');
        }

        log('Clicking Sign In button...');
        await page.click('input[type="submit"]');

        const okButton = page.locator('button:has-text("OK"), a:has-text("OK")');
        if (await okButton.isVisible({ timeout: 5000 })) {
            log('Error modal detected, clicking OK and retrying checkbox...', 'WARN');
            await okButton.click();
            await page.click('.icheckbox', { force: true });
            await page.click('input[type="submit"]');
        }

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 });

        const postLoginText = await page.innerText('body');
        if (postLoginText.includes('Your account is locked') || postLoginText.includes('too many login attempts')) {
            log('Account locked after login attempt. Banning...', 'FATAL');
            banAccount(config.credentials.email, 'Account locked post-login');
            await sendTelegramNotification(
                `🔒 <b>Account Locked & Banned (Post-Login):</b> <b>${config.credentials.email}</b>\n` +
                `<b>Action:</b> Account added to banned list`
            ).catch(() => {});
            await browser.close();
            process.exit(10);
        }

        if (page.url().includes('sign_in')) {
            await page.screenshot({ path: 'login_failed.png' });
            throw new Error('STILL_ON_SIGN_IN');
        }

        return true;
    } catch (e) {
        await page.screenshot({ path: 'login_error.png' }).catch(() => {});
        throw e;
    }
}

async function navigateToAppointmentPage(page) {
    try {
        log('Navigating to appointment selection...');
        const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';

        log('Waiting for Continue button...');
        await page.waitForSelector(continueBtn, { timeout: 20000 });
        await page.click(continueBtn);

        log('Button clicked. Waiting for URL change...');
        await page.waitForTimeout(3000);
        const currentUrl = page.url();
        const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');

        log('Jumping to appointment page...');
        await page.goto(appointmentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        log('Selecting city...');
        await selectCityByName(page, config.preferences.cities[0]);

        const secondContinue = 'input[type="submit"][value="Continue"]';
        try {
            await page.waitForSelector(secondContinue, { timeout: 5000 });
            await page.click(secondContinue);
        } catch (e) { /* ignore */ }

        return true;
    } catch (e) {
        log(`Navigation error: ${e.message}`, 'ERROR');
        return false;
    }
}

async function selectCityByName(page, cityName) {
    try {
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        await page.waitForSelector(facilitySelector);

        const options = await page.$$eval(`${facilitySelector} option`, opts =>
            opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );

        const target = options.find(o => o.text.includes(cityName));
        if (target) {
            await page.selectOption(facilitySelector, target.value);
        }
    } catch (e) {
        log(`Error selecting city ${cityName}: ${e.message}`, 'WARN');
    }
}

async function resetSelection(page) {
    try {
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        const currentValue = await page.$eval(facilitySelector, el => el.value).catch(() => null);
        if (currentValue) {
            await page.selectOption(facilitySelector, currentValue);
        }
    } catch (e) {
        // If selection fails, just continue
    }
}

async function performBooking(page, slot) {
    try {
        log(`Booking date: ${slot.date}`);

        // Parse the target date (format: YYYY-MM-DD)
        const [targetYear, targetMonth, targetDay] = slot.date.split('-').map(Number);
        log(`Parsed date: Year=${targetYear}, Month=${targetMonth}, Day=${targetDay}`);

        // Click to open the datepicker
        await page.click('#appointments_consulate_appointment_date');
        await page.waitForTimeout(500);

        // Wait for datepicker to be visible
        await page.waitForSelector('.ui-datepicker', { timeout: 5000 });

        // Navigate to the correct month/year
        let maxNavigations = 24; // Max 2 years of navigation
        while (maxNavigations > 0) {
            // Get current displayed month and year from datepicker
            const displayedMonth = await page.$eval('.ui-datepicker-month', el => {
                // Could be text or a select element
                if (el.tagName === 'SELECT') {
                    return parseInt(el.value) + 1; // 0-indexed
                }
                const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
                return monthNames.indexOf(el.textContent.trim()) + 1;
            }).catch(() => null);

            const displayedYear = await page.$eval('.ui-datepicker-year', el => {
                if (el.tagName === 'SELECT') {
                    return parseInt(el.value);
                }
                return parseInt(el.textContent.trim());
            }).catch(() => null);

            log(`Calendar showing: ${displayedMonth}/${displayedYear}, need: ${targetMonth}/${targetYear}`);

            if (displayedMonth === targetMonth && displayedYear === targetYear) {
                // Found the right month, now click the day
                break;
            }

            // Navigate forward or backward
            const currentDate = new Date(displayedYear, displayedMonth - 1);
            const targetDate = new Date(targetYear, targetMonth - 1);

            if (targetDate > currentDate) {
                // Click next month
                await page.click('.ui-datepicker-next').catch(() => {});
            } else {
                // Click previous month
                await page.click('.ui-datepicker-prev').catch(() => {});
            }

            await page.waitForTimeout(300);
            maxNavigations--;
        }

        // Click on the target day - look for available (not disabled) day
        const dayClicked = await page.evaluate((day) => {
            const datepicker = document.querySelector('.ui-datepicker');
            if (!datepicker) return false;

            // Find all day cells that are not disabled
            const dayCells = datepicker.querySelectorAll('td[data-handler="selectDay"]');
            for (const cell of dayCells) {
                const link = cell.querySelector('a');
                if (link && parseInt(link.textContent) === day) {
                    link.click();
                    return true;
                }
            }

            // Fallback: try clicking by link text directly
            const allLinks = datepicker.querySelectorAll('td a.ui-state-default');
            for (const link of allLinks) {
                if (parseInt(link.textContent) === day) {
                    link.click();
                    return true;
                }
            }
            return false;
        }, targetDay);

        if (!dayClicked) {
            log(`Could not click day ${targetDay} in calendar`, 'ERROR');
            // Try one more approach - click via selector
            try {
                await page.click(`td[data-handler="selectDay"] a:text("${targetDay}")`);
            } catch (e) {
                log(`Fallback day click also failed: ${e.message}`, 'ERROR');
            }
        } else {
            log(`Clicked day ${targetDay} successfully`);
        }

        await page.waitForTimeout(500);

        // Wait for time slots to load
        let timeCounter = 0;
        while (availableTime === null && timeCounter < 50) {
            await page.waitForTimeout(100);
            timeCounter++;
        }

        if (availableTime) {
            await page.selectOption('#appointments_consulate_appointment_time', availableTime);
            log(`Selected time: ${availableTime}`);
            await page.click('#appointments_submit');

            try {
                const alert = await page.waitForSelector('.alert', { timeout: 5000 });
                if (alert) await alert.click();
            } catch (e) { /* ignore */ }

            return true;
        } else {
            log('No available time found after selecting date', 'ERROR');
        }
        return false;
    } catch (e) {
        log(`Booking error: ${e.message}`, 'ERROR');
        await page.screenshot({ path: 'booking_error.png' }).catch(() => {});
        return false;
    }
}

// Global signal handler
const shutdown = async (signal) => {
    log(`Bot received ${signal}. Shutting down...`, 'INFO');
    try {
        const delay = Math.floor(Math.random() * 3000);
        await new Promise(r => setTimeout(r, delay));

        await sendTelegramNotification(`🛑 <b>Bot Stopped (${signal})</b> for <b>${config.credentials.email}</b>`);
        log('Shutdown notification sent.', 'INFO');
    } catch (e) {
        log('Failed to send shutdown notification: ' + e.message, 'ERROR');
    }
    await new Promise(r => setTimeout(r, 500));
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', async (err) => {
    log(`Uncaught Exception: ${err.message}`, 'FATAL');
    try {
        await sendTelegramNotification(`⚠️ <b>Bot Crashed (Uncaught Exception):</b>\n<b>User:</b> ${config.credentials.email}\n<b>Error:</b> ${err.message}`);
    } catch (e) {}
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    log(`Unhandled Rejection at: ${promise}, reason: ${reason}`, 'FATAL');
    try {
        await sendTelegramNotification(`⚠️ <b>Bot Crashed (Unhandled Rejection):</b>\n<b>User:</b> ${config.credentials.email}\n<b>Reason:</b> ${reason}`);
    } catch (e) {}
    process.exit(1);
});

runBot();