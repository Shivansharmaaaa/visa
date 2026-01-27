# US Visa Appointment Bot v2.0

A robust Playwright-based automation for booking US visa appointments with improved reliability, fresh data fetching, and no request queuing.

## Key Improvements Over Previous Version

### 1. Fresh Data Fetching
- **Context Isolation**: Creates a fresh browser context periodically (every 50 checks by default)
- **Cache-Busting Headers**: All requests include `Cache-Control: no-cache` headers
- **No Persistent State**: Slot data is reset before each check to prevent stale responses
- **One-Time Listeners**: Response listeners are attached and removed per-check to prevent accumulation

### 2. No Request Queuing
- **Isolated Check Pattern**: Each slot check is independent with its own listener lifecycle
- **Listener Cleanup**: Response listeners are properly removed after each check
- **Fresh Triggers**: City selection is toggled to force new API calls (not reusing cached responses)
- **Timeout-Based Returns**: Checks return immediately when data is received or timeout occurs

### 3. Stability & Long-Run Reliability
- **Comprehensive Error Handling**: Try-catch blocks at every level with specific error recovery
- **Automatic Context Refresh**: Browser context is refreshed every N checks to prevent memory leaks
- **Configurable Timeouts**: All operations have explicit timeouts (page load, API response, navigation)
- **Consecutive Error Tracking**: Bot restarts cleanly after too many errors
- **Graceful Shutdown**: Signal handlers for SIGINT/SIGTERM with proper cleanup

### 4. Proxy Support
- **Full Proxy Authentication**: Username/password proxy support via Playwright's built-in proxy
- **Configurable via .env**: Enable/disable proxy without code changes

## Installation

```bash
# Install dependencies
npm install

# Install Playwright browsers
npx playwright install chromium
```

## Configuration

Edit the `.env` file with your settings:

```env
# Account Credentials
VISA_EMAIL=your-email@example.com
VISA_PASSWORD=your-password

# Appointment Preferences
PREFERRED_CITY=Toronto
START_DATE=2026-01-17
END_DATE=2026-03-31
VISA_BASE_URL=https://ais.usvisa-info.com/en-ca/niv

# Telegram Notifications
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_CHAT_ID=your-chat-id

# Proxy Configuration
PROXY_ENABLED=true
PROXY_SERVER=pr.oxylabs.io:7777
PROXY_USERNAME=your-proxy-username
PROXY_PASSWORD=your-proxy-password

# Bot Settings
TARGET_CPM=20
HEADLESS=false
```

## Usage

```bash
# Standard run with proxy
npm start

# Run in headless mode
npm run start:headless

# Run without proxy
npm run start:no-proxy
```

## Architecture

```
VisaBot
├── BrowserManager       # Browser lifecycle, context creation
│   └── createFreshContext()  # KEY: Creates isolated contexts with cache-busting
├── LoginHandler         # Authentication with retry logic
├── NavigationHandler    # Page navigation and city selection
├── SlotChecker          # CRITICAL: Isolated slot checking with listener cleanup
│   ├── setupResponseListener()   # One-time listener attachment
│   ├── checkForSlot()            # Single check with timeout
│   └── triggerFreshRequest()     # Force new API call
└── BookingHandler       # Calendar navigation and time selection
```

## How Fresh Data is Ensured

1. **Before Each Check**:
   - Previous response data is cleared
   - A new response listener is attached

2. **During Check**:
   - City selection is toggled to trigger a fresh API call
   - Wait for new response with timeout

3. **After Check**:
   - Response listener is immediately removed
   - No lingering listeners accumulate

4. **Periodically**:
   - Entire browser context is destroyed and recreated
   - This clears all cookies, cache, and session storage

## Scaling

To run multiple instances:

```bash
# Create separate .env files
cp .env .env.account1
cp .env .env.account2

# Run with specific env files
DOTENV_CONFIG_PATH=.env.account1 node visa-bot.js
DOTENV_CONFIG_PATH=.env.account2 node visa-bot.js
```

## Troubleshooting

### Bot stops responding
- Check Telegram notifications for error messages
- The bot will automatically restart on errors
- Reduce `TARGET_CPM` if you're hitting rate limits

### "System is busy" messages
- The bot automatically waits 60 seconds when this occurs
- It then creates a fresh context and retries

### Login failures
- Check credentials in `.env`
- The bot will retry 3 times before stopping
- Screenshots are saved on failure: `login_failed.png`

### Stale data issues
- Reduce `contextRefreshInterval` in config (default: 50 checks)
- This forces more frequent context recreation

## Exit Codes

- `0`: Normal shutdown (SIGINT/SIGTERM)
- `1`: Fatal error (uncaught exception)
- `10`: Account banned/locked
- `20`: System busy cooldown
