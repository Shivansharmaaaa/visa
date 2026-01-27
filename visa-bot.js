/**
 * US Visa Appointment Bot - Improved Version
 *
 * Key Improvements:
 * 1. Fresh Data: Forces fresh requests with cache-busting and context isolation
 * 2. No Request Queuing: Uses isolated check cycles with proper cleanup
 * 3. Stability: Comprehensive error handling, timeouts, and auto-recovery
 * 4. Proxy Support: Full proxy configuration with authentication
 */

const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
require('dotenv').config();

chromium.use(stealth);

// ============================================================================
// CONFIGURATION - Loaded from .env
// ============================================================================
const CONFIG = {
    credentials: {
        email: process.env.VISA_EMAIL,
        password: process.env.VISA_PASSWORD
    },
    preferences: {
        baseUrl: process.env.VISA_BASE_URL || 'https://ais.usvisa-info.com/en-ca/niv',
        city: process.env.PREFERRED_CITY || 'Toronto',
        startDate: new Date(process.env.START_DATE || new Date().toISOString().split('T')[0]),
        endDate: new Date(process.env.END_DATE || '2026-03-31')
    },
    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        chatId: process.env.TELEGRAM_CHAT_ID
    },
    proxy: {
        enabled: process.env.PROXY_ENABLED === 'true',
        server: process.env.PROXY_SERVER || 'pr.oxylabs.io:7777',
        username: process.env.PROXY_USERNAME,
        password: process.env.PROXY_PASSWORD
    },
    bot: {
        targetCPM: parseInt(process.env.TARGET_CPM) || 20,
        maxLoginRetries: 3,
        checkTimeoutMs: 10000,
        pageTimeoutMs: 60000,
        maxConsecutiveErrors: 10,
        contextRefreshInterval: 50, // Refresh context every N checks
        headless: process.env.HEADLESS === 'true'
    }
};

// ============================================================================
// LOGGING UTILITY
// ============================================================================
function log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const colorCodes = {
        'INFO': '\x1b[36m',    // Cyan
        'SUCCESS': '\x1b[32m', // Green
        'WARN': '\x1b[33m',    // Yellow
        'ERROR': '\x1b[31m',   // Red
        'FATAL': '\x1b[35m',   // Magenta
        'DEBUG': '\x1b[90m'    // Gray
    };
    const reset = '\x1b[0m';
    const color = colorCodes[level] || '';
    console.log(`${color}[${timestamp}] [${level}] ${message}${reset}`);
}

// ============================================================================
// TELEGRAM NOTIFICATIONS
// ============================================================================
async function sendTelegramNotification(message) {
    if (!CONFIG.telegram.botToken || !CONFIG.telegram.chatId) {
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: CONFIG.telegram.chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });
        if (!response.ok) {
            log(`Telegram API error: ${response.status}`, 'WARN');
        }
    } catch (error) {
        log(`Failed to send Telegram notification: ${error.message}`, 'WARN');
    }
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
function getRandomDelay(targetCPM) {
    const baseDelay = 60000 / targetCPM;
    const jitter = baseDelay * 0.3 * (Math.random() - 0.5);
    return Math.max(1000, Math.floor(baseDelay + jitter));
}

function isDateInRange(dateStr, startDate, endDate) {
    const date = new Date(dateStr);
    date.setHours(0, 0, 0, 0);
    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(0, 0, 0, 0);
    return date >= start && date <= end;
}

function generateRandomFingerprint() {
    const resolutions = [
        { width: 1920, height: 1080 },
        { width: 1440, height: 900 },
        { width: 1366, height: 768 },
        { width: 1536, height: 864 },
        { width: 1680, height: 1050 }
    ];

    const userAgents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    ];

    const locationProfiles = [
        { timezone: 'America/Toronto', locale: 'en-CA', lat: 43.6532, lng: -79.3832 },
        { timezone: 'America/Vancouver', locale: 'en-CA', lat: 49.2827, lng: -123.1207 },
        { timezone: 'America/New_York', locale: 'en-US', lat: 40.7128, lng: -74.0060 }
    ];

    return {
        viewport: resolutions[Math.floor(Math.random() * resolutions.length)],
        userAgent: userAgents[Math.floor(Math.random() * userAgents.length)],
        location: locationProfiles[Math.floor(Math.random() * locationProfiles.length)]
    };
}

// ============================================================================
// BROWSER MANAGEMENT - KEY FIX FOR FRESH DATA
// ============================================================================
class BrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isInitialized = false;
    }

    async initialize() {
        log('Initializing browser...');

        const launchOptions = {
            headless: CONFIG.bot.headless
        };

        // Add proxy configuration if enabled
        if (CONFIG.proxy.enabled && CONFIG.proxy.server) {
            launchOptions.proxy = {
                server: `http://${CONFIG.proxy.server}`,
                username: CONFIG.proxy.username,
                password: CONFIG.proxy.password
            };
            log(`Proxy enabled: ${CONFIG.proxy.server}`);
        }

        this.browser = await chromium.launch(launchOptions);
        log('Browser launched successfully');
        this.isInitialized = true;
    }

    /**
     * Creates a fresh context - CRITICAL for avoiding stale data
     * Each context has its own cookies, cache, and session storage
     */
    async createFreshContext() {
        // Close existing context if any
        if (this.context) {
            try {
                await this.context.close();
            } catch (e) {
                log(`Error closing old context: ${e.message}`, 'DEBUG');
            }
        }

        const fingerprint = generateRandomFingerprint();

        const contextOptions = {
            userAgent: fingerprint.userAgent,
            viewport: fingerprint.viewport,
            timezoneId: fingerprint.location.timezone,
            locale: fingerprint.location.locale,
            geolocation: {
                latitude: fingerprint.location.lat,
                longitude: fingerprint.location.lng
            },
            permissions: ['geolocation'],
            // CRITICAL: Disable caching for fresh data
            bypassCSP: true,
            ignoreHTTPSErrors: true
        };

        this.context = await this.browser.newContext(contextOptions);

        // Add cache-busting headers to all requests
        await this.context.route('**/*', async (route) => {
            const headers = {
                ...route.request().headers(),
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            };
            await route.continue({ headers });
        });

        this.page = await this.context.newPage();

        // Set page-level timeouts
        this.page.setDefaultTimeout(CONFIG.bot.pageTimeoutMs);
        this.page.setDefaultNavigationTimeout(CONFIG.bot.pageTimeoutMs);

        log('Fresh context created with new fingerprint');
        return this.page;
    }

    async cleanup() {
        try {
            if (this.page) await this.page.close().catch(() => {});
            if (this.context) await this.context.close().catch(() => {});
            if (this.browser) await this.browser.close().catch(() => {});
        } catch (e) {
            log(`Cleanup error: ${e.message}`, 'DEBUG');
        }
        this.isInitialized = false;
    }
}

// ============================================================================
// SLOT CHECKER - ISOLATED REQUEST PATTERN (NO QUEUING)
// ============================================================================
class SlotChecker {
    constructor(page) {
        this.page = page;
        this.lastSlotData = null;
        this.lastTimeData = null;
        this.responseReceived = false;
    }

    /**
     * Sets up a ONE-TIME response listener
     * This prevents accumulation of listeners that cause queuing
     */
    setupResponseListener() {
        this.responseReceived = false;
        this.lastSlotData = null;
        this.lastTimeData = null;

        const handler = async (response) => {
            try {
                const url = response.url();
                if (url.includes('json?appointments')) {
                    const data = await response.json();
                    if (data && data.length > 0) {
                        this.lastSlotData = data[0];
                        this.responseReceived = true;
                    }
                } else if (url.includes('json?date')) {
                    const data = await response.json();
                    if (data.available_times && data.available_times.length > 0) {
                        this.lastTimeData = data.available_times[0];
                    }
                }
            } catch (e) {
                // Ignore JSON parse errors
            }
        };

        this.page.on('response', handler);

        // Return cleanup function
        return () => {
            this.page.off('response', handler);
        };
    }

    /**
     * Performs a single slot check with timeout
     * Returns immediately when data received or timeout
     */
    async checkForSlot(timeoutMs = CONFIG.bot.checkTimeoutMs) {
        const cleanup = this.setupResponseListener();

        try {
            // Trigger fresh request by re-selecting the city
            await this.triggerFreshRequest();

            // Wait for response with timeout
            const startTime = Date.now();
            while (!this.responseReceived && (Date.now() - startTime) < timeoutMs) {
                await new Promise(r => setTimeout(r, 50));
            }

            return this.lastSlotData;
        } finally {
            // CRITICAL: Always cleanup listener to prevent queuing
            cleanup();
        }
    }

    async triggerFreshRequest() {
        try {
            const facilitySelector = '#appointments_consulate_appointment_facility_id';

            // Check if selector exists
            const selectorExists = await this.page.$(facilitySelector);
            if (!selectorExists) {
                log('Facility selector not found, page may need refresh', 'WARN');
                return;
            }

            const currentValue = await this.page.$eval(facilitySelector, el => el.value).catch(() => null);

            if (currentValue) {
                // Trigger change event to force fresh API call
                await this.page.evaluate((selector, value) => {
                    const select = document.querySelector(selector);
                    if (select) {
                        select.value = '';
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }, facilitySelector, currentValue);

                await this.page.waitForTimeout(100);

                await this.page.selectOption(facilitySelector, currentValue);
            }
        } catch (e) {
            log(`Error triggering fresh request: ${e.message}`, 'DEBUG');
        }
    }

    getTimeData() {
        return this.lastTimeData;
    }
}

// ============================================================================
// LOGIN HANDLER
// ============================================================================
class LoginHandler {
    constructor(page) {
        this.page = page;
    }

    async login() {
        log('Starting login process...');

        const signInUrl = `${CONFIG.preferences.baseUrl}/users/sign_in`;

        // Navigate with retry
        let navigationSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const response = await this.page.goto(signInUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: CONFIG.bot.pageTimeoutMs
                });

                if (response && response.ok()) {
                    navigationSuccess = true;
                    break;
                }
            } catch (e) {
                log(`Navigation attempt ${attempt}/3 failed: ${e.message}`, 'WARN');
                if (attempt < 3) {
                    await this.page.waitForTimeout(3000);
                }
            }
        }

        if (!navigationSuccess) {
            throw new Error('Failed to load login page after 3 attempts');
        }

        // Wait for login form
        await this.page.waitForSelector('#user_email', { timeout: 30000 });

        // Check for account lock or system busy
        const pageText = await this.page.innerText('body').catch(() => '');

        if (pageText.toLowerCase().includes('system is busy') ||
            pageText.toLowerCase().includes('service unavailable')) {
            throw new Error('SYSTEM_BUSY');
        }

        if (pageText.includes('Your account is locked')) {
            throw new Error('ACCOUNT_LOCKED');
        }

        // Fill credentials
        await this.page.fill('#user_email', CONFIG.credentials.email);
        await this.page.fill('#user_password', CONFIG.credentials.password);

        // Handle privacy checkbox
        await this.handleCheckbox();

        // Submit form
        log('Submitting login form...');
        await this.page.click('input[type="submit"]');

        // Handle potential error modal
        try {
            const okButton = this.page.locator('button:has-text("OK"), a:has-text("OK")');
            if (await okButton.isVisible({ timeout: 3000 })) {
                log('Error modal detected, retrying...', 'WARN');
                await okButton.click();
                await this.handleCheckbox();
                await this.page.click('input[type="submit"]');
            }
        } catch (e) {
            // No modal, continue
        }

        // Wait for navigation
        await this.page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.bot.pageTimeoutMs
        });

        // Verify login success
        const currentUrl = this.page.url();
        if (currentUrl.includes('sign_in')) {
            await this.page.screenshot({ path: 'login_failed.png' }).catch(() => {});
            throw new Error('LOGIN_FAILED');
        }

        log('Login successful!', 'SUCCESS');
        return true;
    }

    async handleCheckbox() {
        try {
            const checkboxSelector = '#policy_confirmed';
            const checkboxLabel = 'label[for="policy_confirmed"]';

            // Try clicking label first
            await this.page.click(checkboxLabel, { timeout: 2000 }).catch(() => {});

            // Verify it's checked
            const isChecked = await this.page.isChecked(checkboxSelector).catch(() => false);
            if (!isChecked) {
                // Force click the checkbox
                await this.page.click(checkboxSelector, { force: true }).catch(() => {});
            }
        } catch (e) {
            log(`Checkbox handling: ${e.message}`, 'DEBUG');
        }
    }
}

// ============================================================================
// NAVIGATION HANDLER
// ============================================================================
class NavigationHandler {
    constructor(page) {
        this.page = page;
    }

    async navigateToAppointmentPage() {
        log('Navigating to appointment page...');

        try {
            // Find and click continue button
            const continueBtn = 'a.button.primary.small[href*="/niv/schedule/"]';
            await this.page.waitForSelector(continueBtn, { timeout: 20000 });
            await this.page.click(continueBtn);

            await this.page.waitForTimeout(2000);

            // Navigate to appointment URL
            const currentUrl = this.page.url();
            const appointmentUrl = currentUrl.replace(/\/[^\/]+$/, '/appointment');

            await this.page.goto(appointmentUrl, {
                waitUntil: 'domcontentloaded',
                timeout: CONFIG.bot.pageTimeoutMs
            });

            // Select city
            await this.selectCity(CONFIG.preferences.city);

            // Click continue if visible
            try {
                const secondContinue = 'input[type="submit"][value="Continue"]';
                await this.page.waitForSelector(secondContinue, { timeout: 5000 });
                await this.page.click(secondContinue);
            } catch (e) {
                // Continue button may not be present
            }

            log('Navigation to appointment page complete', 'SUCCESS');
            return true;
        } catch (e) {
            log(`Navigation error: ${e.message}`, 'ERROR');
            return false;
        }
    }

    async selectCity(cityName) {
        const facilitySelector = '#appointments_consulate_appointment_facility_id';
        await this.page.waitForSelector(facilitySelector, { timeout: 10000 });

        const options = await this.page.$$eval(`${facilitySelector} option`, opts =>
            opts.map(o => ({ text: o.innerText.trim(), value: o.value }))
        );

        const target = options.find(o => o.text.toLowerCase().includes(cityName.toLowerCase()));
        if (target) {
            await this.page.selectOption(facilitySelector, target.value);
            log(`Selected city: ${target.text}`);
        } else {
            log(`City "${cityName}" not found in options`, 'WARN');
        }
    }
}

// ============================================================================
// BOOKING HANDLER
// ============================================================================
class BookingHandler {
    constructor(page, slotChecker) {
        this.page = page;
        this.slotChecker = slotChecker;
    }

    async performBooking(slot) {
        try {
            log(`Attempting to book: ${slot.date}`, 'SUCCESS');

            const [targetYear, targetMonth, targetDay] = slot.date.split('-').map(Number);

            // Click date picker
            await this.page.click('#appointments_consulate_appointment_date');
            await this.page.waitForTimeout(500);

            // Wait for datepicker
            await this.page.waitForSelector('.ui-datepicker', { timeout: 5000 });

            // Navigate to correct month
            await this.navigateToMonth(targetYear, targetMonth);

            // Click the day
            const dayClicked = await this.clickDay(targetDay);
            if (!dayClicked) {
                log(`Failed to click day ${targetDay}`, 'ERROR');
                return false;
            }

            await this.page.waitForTimeout(500);

            // Wait for time slots
            let timeData = null;
            for (let i = 0; i < 50; i++) {
                timeData = this.slotChecker.getTimeData();
                if (timeData) break;
                await this.page.waitForTimeout(100);
            }

            if (!timeData) {
                log('No time slot received', 'ERROR');
                return false;
            }

            // Select time
            await this.page.selectOption('#appointments_consulate_appointment_time', timeData);
            log(`Selected time: ${timeData}`);

            // Submit
            await this.page.click('#appointments_submit');

            // Handle confirmation alert
            try {
                const alert = await this.page.waitForSelector('.alert', { timeout: 5000 });
                if (alert) await alert.click();
            } catch (e) {}

            log('Booking submitted!', 'SUCCESS');
            return true;
        } catch (e) {
            log(`Booking error: ${e.message}`, 'ERROR');
            await this.page.screenshot({ path: 'booking_error.png' }).catch(() => {});
            return false;
        }
    }

    async navigateToMonth(targetYear, targetMonth) {
        let maxNavigations = 24;

        while (maxNavigations > 0) {
            const displayedMonth = await this.page.$eval('.ui-datepicker-month', el => {
                if (el.tagName === 'SELECT') return parseInt(el.value) + 1;
                const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                    'July', 'August', 'September', 'October', 'November', 'December'];
                return monthNames.indexOf(el.textContent.trim()) + 1;
            }).catch(() => null);

            const displayedYear = await this.page.$eval('.ui-datepicker-year', el => {
                if (el.tagName === 'SELECT') return parseInt(el.value);
                return parseInt(el.textContent.trim());
            }).catch(() => null);

            if (displayedMonth === targetMonth && displayedYear === targetYear) {
                break;
            }

            const currentDate = new Date(displayedYear, displayedMonth - 1);
            const targetDate = new Date(targetYear, targetMonth - 1);

            if (targetDate > currentDate) {
                await this.page.click('.ui-datepicker-next').catch(() => {});
            } else {
                await this.page.click('.ui-datepicker-prev').catch(() => {});
            }

            await this.page.waitForTimeout(300);
            maxNavigations--;
        }
    }

    async clickDay(targetDay) {
        return await this.page.evaluate((day) => {
            const datepicker = document.querySelector('.ui-datepicker');
            if (!datepicker) return false;

            const dayCells = datepicker.querySelectorAll('td[data-handler="selectDay"]');
            for (const cell of dayCells) {
                const link = cell.querySelector('a');
                if (link && parseInt(link.textContent) === day) {
                    link.click();
                    return true;
                }
            }
            return false;
        }, targetDay);
    }
}

// ============================================================================
// MAIN BOT CLASS
// ============================================================================
class VisaBot {
    constructor() {
        this.browserManager = new BrowserManager();
        this.checkCount = 0;
        this.startTime = null;
        this.consecutiveErrors = 0;
        this.loginFailures = 0;
        this.closestSlot = null;
        this.isRunning = false;
    }

    async start() {
        log('='.repeat(60));
        log('VISA APPOINTMENT BOT - STARTING');
        log('='.repeat(60));
        log(`Email: ${CONFIG.credentials.email}`);
        log(`City: ${CONFIG.preferences.city}`);
        log(`Date Range: ${CONFIG.preferences.startDate.toISOString().split('T')[0]} to ${CONFIG.preferences.endDate.toISOString().split('T')[0]}`);
        log(`Proxy: ${CONFIG.proxy.enabled ? CONFIG.proxy.server : 'Disabled'}`);
        log('='.repeat(60));

        this.isRunning = true;
        this.startTime = Date.now();

        await sendTelegramNotification(
            `🚀 <b>Bot Started</b>\n` +
            `<b>Email:</b> ${CONFIG.credentials.email}\n` +
            `<b>City:</b> ${CONFIG.preferences.city}\n` +
            `<b>Proxy:</b> ${CONFIG.proxy.enabled ? 'Enabled' : 'Direct'}`
        );

        try {
            await this.browserManager.initialize();
            await this.runMainLoop();
        } catch (error) {
            log(`Fatal error: ${error.message}`, 'FATAL');
            await sendTelegramNotification(
                `🛑 <b>Bot Crashed</b>\n` +
                `<b>Error:</b> ${error.message}`
            );
        } finally {
            await this.browserManager.cleanup();
        }
    }

    async runMainLoop() {
        while (this.isRunning) {
            try {
                // Create fresh context for this session
                const page = await this.browserManager.createFreshContext();

                // Login
                const loginHandler = new LoginHandler(page);
                const loginSuccess = await loginHandler.login().catch(e => {
                    log(`Login error: ${e.message}`, 'ERROR');
                    return false;
                });

                if (!loginSuccess) {
                    this.loginFailures++;
                    if (this.loginFailures >= CONFIG.bot.maxLoginRetries) {
                        throw new Error('Max login failures reached');
                    }
                    await this.waitBeforeRetry(30000);
                    continue;
                }

                this.loginFailures = 0;

                // Navigate to appointment page
                const navHandler = new NavigationHandler(page);
                const navSuccess = await navHandler.navigateToAppointmentPage();

                if (!navSuccess) {
                    log('Navigation failed, retrying...', 'ERROR');
                    await this.waitBeforeRetry(10000);
                    continue;
                }

                await sendTelegramNotification(
                    `✅ <b>Logged In Successfully</b>\n` +
                    `<b>Email:</b> ${CONFIG.credentials.email}\n` +
                    `<b>Status:</b> Monitoring for slots...`
                );

                // Run monitoring loop
                await this.runMonitoringLoop(page);

            } catch (error) {
                log(`Session error: ${error.message}`, 'ERROR');
                this.consecutiveErrors++;

                if (this.consecutiveErrors >= CONFIG.bot.maxConsecutiveErrors) {
                    throw new Error('Too many consecutive errors');
                }

                await this.waitBeforeRetry(10000);
            }
        }
    }

    async runMonitoringLoop(page) {
        const slotChecker = new SlotChecker(page);
        const bookingHandler = new BookingHandler(page, slotChecker);
        let sessionCheckCount = 0;
        let lastStatusUpdate = Date.now();

        while (this.isRunning) {
            try {
                this.checkCount++;
                sessionCheckCount++;
                this.consecutiveErrors = 0;

                // Check for system busy message
                const systemBusy = await this.checkSystemBusy(page);
                if (systemBusy) {
                    log('System busy detected, waiting...', 'WARN');
                    await this.waitBeforeRetry(60000);
                    break; // Break to create fresh context
                }

                // Perform slot check
                const slot = await slotChecker.checkForSlot();

                // Calculate stats
                const elapsedMinutes = (Date.now() - this.startTime) / 60000;
                const cpm = (this.checkCount / elapsedMinutes).toFixed(1);
                const slotDisplay = slot ? slot.date : 'SEARCHING...';

                // Track closest slot
                if (slot) {
                    const slotDate = new Date(slot.date);
                    if (!this.closestSlot || slotDate < new Date(this.closestSlot.date)) {
                        this.closestSlot = slot;
                    }
                }

                // Log status
                log(`[${cpm} CPM] Check #${this.checkCount} | Slot: ${slotDisplay} | Closest: ${this.closestSlot?.date || 'None'}`);

                // Handle slot found
                if (slot) {
                    if (isDateInRange(slot.date, CONFIG.preferences.startDate, CONFIG.preferences.endDate)) {
                        log(`🎯 SLOT FOUND IN RANGE: ${slot.date}`, 'SUCCESS');

                        await sendTelegramNotification(
                            `🎯 <b>SLOT DETECTED!</b>\n` +
                            `<b>Date:</b> ${slot.date}\n` +
                            `<b>Status:</b> Attempting to book...`
                        );

                        const booked = await bookingHandler.performBooking(slot);

                        if (booked) {
                            await sendTelegramNotification(
                                `🎉 <b>APPOINTMENT BOOKED!</b>\n` +
                                `<b>Date:</b> ${slot.date}\n` +
                                `<b>Email:</b> ${CONFIG.credentials.email}`
                            );
                            this.isRunning = false;
                            return;
                        }
                    }
                }

                // Send periodic status update
                if (Date.now() - lastStatusUpdate > 60000) {
                    await sendTelegramNotification(
                        `📊 <b>Status Update</b>\n` +
                        `<b>CPM:</b> ${cpm}\n` +
                        `<b>Checks:</b> ${this.checkCount}\n` +
                        `<b>Current Slot:</b> ${slotDisplay}\n` +
                        `<b>Closest:</b> ${this.closestSlot?.date || 'None'}`
                    );
                    lastStatusUpdate = Date.now();
                }

                // Refresh context periodically to prevent staleness
                if (sessionCheckCount >= CONFIG.bot.contextRefreshInterval) {
                    log('Refreshing context for fresh session...', 'INFO');
                    break;
                }

                // Wait before next check
                const delay = getRandomDelay(CONFIG.bot.targetCPM);
                await page.waitForTimeout(delay);

            } catch (loopError) {
                log(`Monitoring error: ${loopError.message}`, 'ERROR');
                this.consecutiveErrors++;

                if (this.consecutiveErrors >= 5) {
                    break; // Break to create fresh context
                }
            }
        }
    }

    async checkSystemBusy(page) {
        try {
            const pageText = await page.innerText('body').catch(() => '');
            return pageText.toLowerCase().includes('system is busy') ||
                   pageText.toLowerCase().includes('service unavailable') ||
                   pageText.toLowerCase().includes('too many requests');
        } catch (e) {
            return false;
        }
    }

    async waitBeforeRetry(ms) {
        log(`Waiting ${ms/1000}s before retry...`);
        await new Promise(r => setTimeout(r, ms));
    }

    stop() {
        log('Stopping bot...');
        this.isRunning = false;
    }
}

// ============================================================================
// SIGNAL HANDLERS
// ============================================================================
const bot = new VisaBot();

process.on('SIGINT', async () => {
    log('Received SIGINT, shutting down...', 'INFO');
    bot.stop();
    await sendTelegramNotification(`🛑 <b>Bot Stopped</b> (SIGINT)`);
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('Received SIGTERM, shutting down...', 'INFO');
    bot.stop();
    await sendTelegramNotification(`🛑 <b>Bot Stopped</b> (SIGTERM)`);
    process.exit(0);
});

process.on('uncaughtException', async (err) => {
    log(`Uncaught Exception: ${err.message}`, 'FATAL');
    await sendTelegramNotification(`⚠️ <b>Bot Crashed</b>\n<b>Error:</b> ${err.message}`);
    process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
    log(`Unhandled Rejection: ${reason}`, 'FATAL');
    await sendTelegramNotification(`⚠️ <b>Bot Crashed</b>\n<b>Reason:</b> ${reason}`);
    process.exit(1);
});

// ============================================================================
// START BOT
// ============================================================================
bot.start();
