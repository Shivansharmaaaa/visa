'use strict';

const puppeteer = require('puppeteer');
const inquirer = require('inquirer');
const readline = require('readline');
const { state } = require('./config');

// ── Task 3.1 helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if val is a non-empty, non-whitespace-only string.
 * Exported for unit/property tests.
 */
function validateCredential(val) {
  return typeof val === 'string' && val.trim().length > 0;
}

/**
 * Prompts the user for email and PIN via inquirer.
 * Re-prompts on blank / whitespace-only input.
 * Stores results into state.email and state.pin.
 */
async function promptCredentials() {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'email',
      message: 'Amazon email:',
      validate(val) {
        return validateCredential(val) || 'Email cannot be empty.';
      },
    },
    {
      type: 'password',
      name: 'pin',
      message: 'Amazon PIN / password:',
      mask: '*',
      validate(val) {
        return validateCredential(val) || 'PIN cannot be empty.';
      },
    },
  ]);

  state.email = answers.email;
  state.pin = answers.pin;
  return { email: state.email, pin: state.pin };
}

// ── Task 3.5 helpers ──────────────────────────────────────────────────────────

/**
 * Returns the accessToken string from a headers object, or null.
 * Exported for unit/property tests.
 */
function extractAccessToken(headers) {
  if (!headers || typeof headers !== 'object') return null;
  const val = headers['accesstoken'];
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Returns the candidateId from a parsed GraphQL response body, or null.
 * Checks data.queryCandidate.candidateId first, then
 * data.queryCommunicationPreference.candidateId.
 * Exported for unit/property tests.
 */
function extractCandidateId(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') return null;
  const d = responseBody.data;
  if (!d) return null;
  if (d.queryCandidate && d.queryCandidate.candidateId) {
    return d.queryCandidate.candidateId;
  }
  if (d.queryCommunicationPreference && d.queryCommunicationPreference.candidateId) {
    return d.queryCommunicationPreference.candidateId;
  }
  return null;
}

/**
 * Attaches a response interceptor to `page` that:
 *  - Captures accessToken header → state.accessToken, state.lastHeaders
 *  - Parses GraphQL body for candidateId → state.userID
 *  - Also captures userSFId and fullName from queryCandidate
 *
 * Must be called BEFORE any navigation.
 */
function attachResponseInterceptor(page) {
  // Capture token from RESPONSE headers
  page.on('response', async (response) => {
    try {
      const headers = response.headers();
      const token = extractAccessToken(headers);
      if (token) {
        state.accessToken = token;
        state.lastHeaders = { ...headers };
      }

      const contentType = headers['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      let body;
      try { body = await response.json(); } catch (_) { return; }

      const candidateId = extractCandidateId(body);
      if (candidateId) state.userID = candidateId;

      const qc = body && body.data && body.data.queryCandidate;
      if (qc) {
        if (qc.candidateSFId) state.userSFId = qc.candidateSFId;
        if (qc.firstName || qc.lastName) {
          state.fullName = `${qc.firstName || ''} ${qc.lastName || ''}`.trim();
        }
      }
    } catch (_) {}
  });

  // Also capture token from REQUEST headers (Amazon SPA sends it this way)
  page.on('request', (request) => {
    try {
      const headers = request.headers();
      const token = extractAccessToken(headers);
      if (token && !state.accessToken) {
        state.accessToken = token;
        state.lastHeaders = { ...headers };
        console.log('[login] Token captured from request headers.');
      }
    } catch (_) {}
  });
}

// ── Task 3.4 — OTP detection and submission ───────────────────────────────────

/**
 * Prompts the user for an OTP code via readline (terminal).
 */
function promptOtp() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Enter OTP code: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const OTP_SELECTORS = [
  'input[name="otpCode"]',
  'input[type="tel"]',
  '#auth-mfa-otpcode',
  '#auth-mfa-otp-code-input',
  'input[placeholder*="code" i]',
  'input[placeholder*="OTP" i]',
  'input[autocomplete="one-time-code"]',
  'input[inputmode="numeric"]',
];

const SEND_CODE_SELECTORS = [
  'button[data-testid="send-code-button"]',
  'button[type="submit"]',
  'input[type="submit"]',
];

/**
 * Polls every 500ms for:
 * 1. Token already captured (login done, no OTP needed)
 * 2. "Send verification code" button — clicks it automatically
 * 3. OTP input field — returns selector when found
 */
async function waitForOtpField(page) {
  console.log('[login] Waiting for login flow (CAPTCHA + OTP)...');
  console.log('[login] Please complete any CAPTCHA in the browser window.');

  let sentCode = false;

  while (true) {
    // Already logged in — token captured from page traffic
    if (state.accessToken) {
      console.log('[login] Token captured from page — login complete!');
      return null;
    }

    // Auto-click "Send verification code" button if present and not yet clicked
    if (!sentCode) {
      for (const sel of SEND_CODE_SELECTORS) {
        try {
          const btn = await page.$(sel);
          if (btn) {
            const text = await page.evaluate(el => (el.textContent || el.value || ''), btn);
            if (/send/i.test(text)) {
              console.log('[login] Clicking "Send verification code"...');
              await btn.click();
              sentCode = true;
              await new Promise(r => setTimeout(r, 2000));
              break;
            }
          }
        } catch (_) {}
      }
    }

    // Check for OTP input field
    for (const selector of OTP_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (el) {
          const visible = await page.evaluate(el => {
            const s = window.getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden' && el.offsetParent !== null;
          }, el);
          if (visible) return selector;
        }
      } catch (_) {}
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Waits for OTP field, prompts user, submits OTP,
 * then waits up to 5 minutes for the accessToken to be captured.
 */
async function handleOtp(page) {
  const otpField = await waitForOtpField(page);

  // Token already captured (no OTP needed)
  if (!otpField) return;

  console.log('[login] OTP field detected. Check your email/phone for the code.');
  const otp = await promptOtp();

  try {
    await page.click(otpField);
    // Clear field first in case there's stale content
    await page.evaluate(sel => { document.querySelector(sel).value = ''; }, otpField);
    await page.type(otpField, otp, { delay: 80 });
    await new Promise(r => setTimeout(r, 300));

    // Try clicking submit button after typing OTP
    for (const sel of SEND_CODE_SELECTORS) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          const text = await page.evaluate(el => (el.textContent || el.value || ''), btn);
          if (/verify|confirm|submit|continue|sign/i.test(text)) {
            await btn.click();
            break;
          }
        }
      } catch (_) {}
    }
    // Fallback: press Enter
    await page.keyboard.press('Enter');
  } catch (err) {
    console.warn('[login] Could not type OTP:', err.message);
  }

  // Wait up to 5 minutes for accessToken
  console.log('[login] OTP submitted. Waiting for login to complete...');
  const tokenDeadline = Date.now() + 5 * 60_000;
  while (!state.accessToken && Date.now() < tokenDeadline) {
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!state.accessToken) {
    console.error('[login] No access token captured within 5 minutes. Exiting.');
    process.exit(1);
  }
}

// ── Task 3.3 — login ──────────────────────────────────────────────────────────

/**
 * Launches a non-headless Puppeteer browser, navigates to the Amazon login
 * page, fills in credentials, handles OTP if required, and waits for the
 * accessToken to be captured from page traffic.
 *
 * @param {string} email
 * @param {string} pin
 * @returns {{ browser, page }}
 */
async function login(email, pin) {
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
    ],
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  state.browser = browser;

  const page = await browser.newPage();

  // Hide webdriver flag — key to avoiding 403 bot detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  });

  // Set a real user-agent
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  // Attach interceptor BEFORE any navigation (Task 3.5)
  attachResponseInterceptor(page);

  const loginUrl = `https://hiring.amazon.${state.domain}/app#/login`;
  console.log(`[login] Navigating to ${loginUrl}`);
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Amazon hiring uses auth.hiring.amazon.com — detect the email field by
  // trying multiple selectors used on that page
  const EMAIL_SELECTORS = [
    '#ap_email',
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="Email" i]',
  ];

  const PIN_SELECTORS = [
    '#ap_password',
    'input[type="password"]',
    'input[name="password"]',
    'input[name="pin"]',
    'input[placeholder*="password" i]',
    'input[placeholder*="PIN" i]',
  ];

  // Try to fill email
  let filledEmail = false;
  for (const sel of EMAIL_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 8_000 });
      await page.click(sel);
      await page.type(sel, email, { delay: 60 });
      filledEmail = true;
      console.log(`[login] Filled email using selector: ${sel}`);
      break;
    } catch (_) {}
  }
  if (!filledEmail) {
    console.warn('[login] Could not find email field — please fill it manually in the browser.');
  }

  // Small delay between fields
  await new Promise(r => setTimeout(r, 500));

  // Try to fill PIN/password
  let filledPin = false;
  for (const sel of PIN_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 8_000 });
      await page.click(sel);
      await page.type(sel, pin, { delay: 60 });
      filledPin = true;
      console.log(`[login] Filled PIN using selector: ${sel}`);
      break;
    } catch (_) {}
  }
  if (!filledPin) {
    console.warn('[login] Could not find PIN field — please fill it manually in the browser.');
  }

  // Submit login form
  const SUBMIT_SELECTORS = [
    '#signInSubmit',
    'button[type="submit"]',
    'input[type="submit"]',
    'button[data-testid="login-button"]',
    'button[data-testid="submit-button"]',
  ];

  let submitted = false;
  for (const sel of SUBMIT_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 5_000 });
      await page.click(sel);
      submitted = true;
      console.log(`[login] Submitted form using: ${sel}`);
      break;
    } catch (_) {}
  }
  if (!submitted) {
    console.warn('[login] Could not find submit button — please click Sign In manually.');
  }

  // Now wait for the full login flow:
  // 1. User solves CAPTCHA manually if shown
  // 2. Bot auto-clicks "Send verification code" button
  // 3. User enters OTP in terminal
  // 4. Bot waits for accessToken to be captured from page traffic
  await handleOtp(page);

  console.log(`[login] Login complete. Token captured. UserID: ${state.userID || 'pending'}`);
  return { browser, page };
}

module.exports = {
  promptCredentials,
  login,
  validateCredential,
  extractAccessToken,
  extractCandidateId,
};
