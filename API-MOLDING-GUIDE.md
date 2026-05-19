# API Molding Recon Tool - Setup & Usage Guide

## What is API Molding?

API molding is a reverse-engineering technique where instead of automating a browser to click through pages (like Playwright/Puppeteer does in nothang.js), you **intercept the raw API calls** the website makes, study their patterns, and then **craft direct fetch() calls** that skip the browser entirely.

**Why it's better than browser automation:**

- **10-100x faster**: Direct HTTP calls vs. rendering full pages
- **No detection**: No headless browser fingerprint to detect
- **Lower resource usage**: No Chrome instance eating RAM
- **More reliable**: No DOM changes breaking your selectors
- **Parallel-friendly**: Fire hundreds of API calls simultaneously

**The 3-step process:**

1. **RECON** (this tool): Capture every API call the site makes as you browse normally
2. **MOLD**: Study the captured endpoints, headers, tokens, and payloads to understand the API contract
3. **EXECUTE**: Build a lightweight Node.js/fetch script that calls APIs directly

---

## Setup

### Option A: Full Service Worker (persistent, survives refresh)

The Service Worker intercepts requests at the network level, so it captures everything even if the page reloads. However, it requires that `sw-interceptor.js` is accessible from the site's origin.

**Steps:**

1. Open Chrome DevTools on `ais.usvisa-info.com` (F12 → Console)
2. In the **Sources** tab, find any JS file the site serves
3. Use Chrome's "Override" feature:
   - Right-click in Sources → "Override content"
   - Choose a local folder
   - Copy `sw-interceptor.js` into that override folder at the root path
4. Now paste the contents of `api-recon.js` into the Console
5. The script will register the SW and start capturing

**Alternative (simpler):** Use Chrome's Local Overrides to serve `sw-interceptor.js` at the site's root.

### Option B: Console-Only Mode (recommended for quick recon)

If the SW can't register (which is common since you don't control the server), the script automatically falls back to **hooks-only mode** — it monkey-patches `fetch()` and `XMLHttpRequest` to capture everything. This works perfectly, you just lose persistence across page refreshes.

**Steps:**

1. Open Chrome DevTools on `ais.usvisa-info.com` (F12 → Console)
2. Paste the entire contents of `api-recon.js`
3. Done — every API call is now being captured

---

## Usage

After pasting, a `MOLD` object is available globally in the console:

```
MOLD.help()         - Show all available commands
MOLD.all()          - List all captured requests (table view)
MOLD.json()         - Show only JSON API calls (the interesting ones)
MOLD.map()          - Deduplicated endpoint map with patterns
MOLD.dates()        - Date-checking API calls only
MOLD.times()        - Time-slot API calls only
MOLD.login()        - Login-related API calls
MOLD.booking()      - Booking-related API calls
MOLD.find('keyword')- Search captures by URL keyword
MOLD.last(10)       - Show the last N captures
MOLD.get(id)        - Full details for a specific capture
MOLD.curl(id)       - Generate a cURL command you can run in terminal
MOLD.replay(id)     - Replay the exact request (same headers, payload)
MOLD.export()       - Download everything as a JSON file
MOLD.verbose(false) - Turn off live console printing
MOLD.status()       - Check if SW is active + stats
MOLD.clear()        - Clear all captured data
MOLD.stop()         - Unregister the service worker
```

---

## Recon Workflow

### Step 1: Capture the login flow

1. Start on the login page (logged out)
2. Paste `api-recon.js` into console
3. Enter your credentials and log in normally
4. Run `MOLD.login()` to see the login API calls
5. Note the CSRF token, cookies, and payload format

### Step 2: Capture the appointment flow

1. Navigate to the appointment page normally
2. Select a city from the dropdown
3. The site will fire API calls to check available dates
4. Run `MOLD.dates()` to see those calls
5. Run `MOLD.times()` if any time-check calls were made

### Step 3: Build your API map

1. Run `MOLD.map()` to see all unique endpoints
2. For each endpoint, you get:
   - URL pattern (with `{id}` placeholders for numeric IDs)
   - Query parameters and their observed values
   - Required headers (especially `X-CSRF-Token`, `X-Requested-With`)
   - Payload samples
   - Response samples
   - Average response time

### Step 4: Generate direct calls

1. Find an interesting capture: `MOLD.get(42)` (by ID number)
2. Generate a cURL: `MOLD.curl(42)`
3. Test it in your terminal
4. Or replay it directly: `MOLD.replay(42)`

### Step 5: Export for offline analysis

1. Run `MOLD.export()` — downloads a JSON file with everything
2. Use this to build your direct-fetch bot script

---

## What Each Capture Records

Every intercepted request saves:

| Field | Description |
|-------|-------------|
| `url` | Full request URL |
| `method` | GET, POST, PUT, etc. |
| `request.headers` | All request headers (including CSRF tokens, cookies via credentials) |
| `request.payload` | POST/PUT body (parsed as JSON or form data) |
| `response.status` | HTTP status code |
| `response.headers` | All response headers (including set-cookie) |
| `response.body` | Full response body (parsed JSON or truncated text) |
| `response.preview` | First 200 chars of response |
| `timing.duration` | Request-to-response time in ms |
| `tags` | Auto-detected categories (dates, times, login, booking, etc.) |

---

## Key Endpoints to Watch For (from nothang.js)

Based on the existing bot code, these are the critical APIs:

| Endpoint Pattern | Purpose |
|-----------------|---------|
| `/en-ca/niv/users/sign_in` | Login (POST with email + password + CSRF) |
| `/en-ca/niv/schedule/{id}/appointment/days/{facilityId}.json` | Get available dates |
| `/en-ca/niv/schedule/{id}/appointment/times/{facilityId}.json?date=YYYY-MM-DD` | Get available times for a date |
| `/api/v2/visa_schedule/available_dates` | Alternative dates endpoint (v2 API) |
| `meta[name="csrf-token"]` | CSRF token (extracted from page HTML, not an API) |

---

## Tips

- **CSRF tokens expire**: They rotate, so you need to re-extract them periodically
- **Cookies matter**: The `credentials: 'include'` flag sends session cookies automatically
- **Rate limits**: The site detects rapid requests — the existing bot targets 240 CPM with proxy rotation
- **Stale data**: The site can serve cached/stale appointment data (this is why nothang.js has verification accounts)
- **The `X-Requested-With: XMLHttpRequest` header is often required** for JSON endpoints to respond with JSON instead of HTML
