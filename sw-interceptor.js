/**
 * API Mold Recon - Service Worker Interceptor
 * ==============================================
 * Intercepts ALL fetch requests at the network level.
 * Records: URL, method, headers, payload, response, response headers, timing.
 *
 * This is the SERVICE WORKER file. It must be served from the site's origin.
 * See api-recon.js for the registration + dashboard script.
 *
 * Based on patterns from nothang.js (US Visa Appointment system)
 */

// ============================================================================
// STORAGE - All captured API calls
// ============================================================================
const API_LOG = [];
const MAX_LOG_SIZE = 500; // Keep last 500 requests

// Known endpoint patterns (from nothang.js analysis)
const KNOWN_PATTERNS = {
    dates:    /schedule\/\d+\/appointment\/days\/\d+\.json/,
    times:    /schedule\/\d+\/appointment\/times\/\d+\.json/,
    login:    /users\/sign_in/,
    schedule: /schedule\/\d+/,
    appointment: /appointment/,
    api_v2:   /\/api\/v2\//,
    json:     /\.json/
};

// ============================================================================
// INSTALL & ACTIVATE - Take control immediately
// ============================================================================
self.addEventListener('install', (event) => {
    console.log('[API-MOLD-SW] 🔧 Installing interceptor...');
    self.skipWaiting(); // Activate immediately, don't wait
});

self.addEventListener('activate', (event) => {
    console.log('[API-MOLD-SW] ✅ Interceptor ACTIVE - capturing all requests');
    event.waitUntil(self.clients.claim()); // Take control of all pages immediately
});

// ============================================================================
// FETCH INTERCEPTOR - The core of API molding
// ============================================================================
self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = request.url;
    const startTime = performance.now();

    // Clone the request so we can read its body without consuming it
    const requestClone = request.clone();

    event.respondWith(
        (async () => {
            // ── 1. CAPTURE REQUEST DETAILS ──
            const entry = {
                id: API_LOG.length + 1,
                timestamp: new Date().toISOString(),
                url: url,
                method: request.method,
                mode: request.mode,
                credentials: request.credentials,
                referrer: request.referrer,
                destination: request.destination,
                request: {
                    headers: {},
                    payload: null
                },
                response: {
                    status: null,
                    statusText: null,
                    headers: {},
                    body: null,
                    preview: null, // Short preview of response
                    type: null,
                    redirected: false
                },
                timing: {
                    start: startTime,
                    end: null,
                    duration: null
                },
                tags: [],    // Auto-tagged based on URL patterns
                error: null
            };

            // Extract request headers
            for (const [key, value] of request.headers.entries()) {
                entry.request.headers[key] = value;
            }

            // Extract request body/payload (for POST, PUT, PATCH)
            if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
                try {
                    const contentType = request.headers.get('content-type') || '';
                    if (contentType.includes('application/json')) {
                        entry.request.payload = await requestClone.json();
                    } else if (contentType.includes('application/x-www-form-urlencoded')) {
                        const text = await requestClone.text();
                        entry.request.payload = Object.fromEntries(new URLSearchParams(text));
                    } else if (contentType.includes('multipart/form-data')) {
                        entry.request.payload = '[multipart/form-data - binary]';
                    } else {
                        entry.request.payload = await requestClone.text();
                    }
                } catch (e) {
                    entry.request.payload = `[Could not read body: ${e.message}]`;
                }
            }

            // Auto-tag based on URL patterns
            for (const [tag, pattern] of Object.entries(KNOWN_PATTERNS)) {
                if (pattern.test(url)) {
                    entry.tags.push(tag);
                }
            }

            // ── 2. MAKE THE ACTUAL REQUEST (passthrough) ──
            let response;
            try {
                response = await fetch(request);
            } catch (err) {
                entry.error = err.message;
                entry.timing.end = performance.now();
                entry.timing.duration = entry.timing.end - entry.timing.start;
                storeEntry(entry);
                broadcastEntry(entry);
                throw err; // Re-throw so the page sees the error
            }

            // ── 3. CAPTURE RESPONSE DETAILS ──
            entry.timing.end = performance.now();
            entry.timing.duration = entry.timing.end - entry.timing.start;
            entry.response.status = response.status;
            entry.response.statusText = response.statusText;
            entry.response.type = response.type;
            entry.response.redirected = response.redirected;

            // Extract response headers
            for (const [key, value] of response.headers.entries()) {
                entry.response.headers[key] = value;
            }

            // Clone response to read body without consuming it
            const responseClone = response.clone();

            // Try to capture response body (only for text/json responses)
            const responseContentType = response.headers.get('content-type') || '';
            if (responseContentType.includes('json') ||
                responseContentType.includes('text') ||
                responseContentType.includes('html') ||
                responseContentType.includes('xml')) {
                try {
                    const bodyText = await responseClone.text();

                    // Try to parse as JSON for structured storage
                    if (responseContentType.includes('json')) {
                        try {
                            entry.response.body = JSON.parse(bodyText);
                        } catch {
                            entry.response.body = bodyText;
                        }
                    } else {
                        // For HTML/text, store first 2000 chars
                        entry.response.body = bodyText.length > 2000
                            ? bodyText.substring(0, 2000) + '... [truncated]'
                            : bodyText;
                    }

                    // Create short preview
                    entry.response.preview = bodyText.substring(0, 200);
                } catch (e) {
                    entry.response.body = `[Could not read response: ${e.message}]`;
                }
            } else {
                entry.response.body = `[Binary: ${responseContentType}]`;
                entry.response.preview = `[${responseContentType}]`;
            }

            // ── 4. STORE & BROADCAST ──
            storeEntry(entry);
            broadcastEntry(entry);

            // Return the original response to the page (untouched)
            return response;
        })()
    );
});

// ============================================================================
// STORAGE MANAGEMENT
// ============================================================================
function storeEntry(entry) {
    API_LOG.push(entry);

    // Trim if exceeds max
    if (API_LOG.length > MAX_LOG_SIZE) {
        API_LOG.splice(0, API_LOG.length - MAX_LOG_SIZE);
    }
}

// ============================================================================
// BROADCAST TO ALL CLIENTS (pages)
// ============================================================================
async function broadcastEntry(entry) {
    const clients = await self.clients.matchAll({ type: 'window' });
    const message = {
        type: 'API_MOLD_CAPTURE',
        entry: entry
    };

    for (const client of clients) {
        client.postMessage(message);
    }
}

// ============================================================================
// MESSAGE HANDLER - Commands from the page
// ============================================================================
self.addEventListener('message', (event) => {
    const { command, data } = event.data || {};

    switch (command) {
        case 'GET_ALL_LOGS':
            event.source.postMessage({
                type: 'API_MOLD_ALL_LOGS',
                entries: API_LOG
            });
            break;

        case 'GET_FILTERED_LOGS':
            // Filter by tag, method, status, or URL pattern
            const filtered = API_LOG.filter(entry => {
                if (data.tag && !entry.tags.includes(data.tag)) return false;
                if (data.method && entry.method !== data.method) return false;
                if (data.status && entry.response.status !== data.status) return false;
                if (data.urlPattern && !entry.url.includes(data.urlPattern)) return false;
                if (data.jsonOnly && !entry.url.includes('.json') &&
                    !(entry.response.headers['content-type'] || '').includes('json')) return false;
                return true;
            });
            event.source.postMessage({
                type: 'API_MOLD_FILTERED_LOGS',
                entries: filtered,
                filter: data
            });
            break;

        case 'GET_API_MAP':
            // Build a deduplicated map of all unique endpoints
            const apiMap = buildApiMap();
            event.source.postMessage({
                type: 'API_MOLD_API_MAP',
                map: apiMap
            });
            break;

        case 'CLEAR_LOGS':
            API_LOG.length = 0;
            event.source.postMessage({
                type: 'API_MOLD_CLEARED'
            });
            break;

        case 'EXPORT_LOGS':
            event.source.postMessage({
                type: 'API_MOLD_EXPORT',
                entries: API_LOG,
                exportedAt: new Date().toISOString()
            });
            break;

        case 'PING':
            event.source.postMessage({
                type: 'API_MOLD_PONG',
                logCount: API_LOG.length,
                uptime: performance.now()
            });
            break;
    }
});

// ============================================================================
// API MAP BUILDER - Deduplicates & summarizes all endpoints
// ============================================================================
function buildApiMap() {
    const map = {};

    for (const entry of API_LOG) {
        // Normalize URL: replace numeric IDs with {id} placeholders
        const urlObj = new URL(entry.url);
        const normalizedPath = urlObj.pathname.replace(/\/\d+/g, '/{id}');
        const key = `${entry.method} ${normalizedPath}`;

        if (!map[key]) {
            map[key] = {
                method: entry.method,
                pathPattern: normalizedPath,
                exampleUrl: entry.url,
                queryParams: {},
                requestHeaders: {},
                requestPayloadSample: null,
                responseStatusCodes: new Set(),
                responseHeaders: {},
                responseSample: null,
                tags: new Set(),
                count: 0,
                avgDuration: 0,
                totalDuration: 0
            };
        }

        const endpoint = map[key];
        endpoint.count++;
        endpoint.totalDuration += (entry.timing.duration || 0);
        endpoint.avgDuration = endpoint.totalDuration / endpoint.count;

        // Collect query params
        for (const [k, v] of urlObj.searchParams.entries()) {
            if (!endpoint.queryParams[k]) {
                endpoint.queryParams[k] = [];
            }
            if (!endpoint.queryParams[k].includes(v) && endpoint.queryParams[k].length < 5) {
                endpoint.queryParams[k].push(v);
            }
        }

        // Collect request headers (merge)
        Object.assign(endpoint.requestHeaders, entry.request.headers);

        // Keep most recent payload sample
        if (entry.request.payload) {
            endpoint.requestPayloadSample = entry.request.payload;
        }

        // Collect status codes
        if (entry.response.status) {
            endpoint.responseStatusCodes.add(entry.response.status);
        }

        // Collect response headers
        Object.assign(endpoint.responseHeaders, entry.response.headers);

        // Keep most recent response sample
        if (entry.response.body && typeof entry.response.body === 'object') {
            endpoint.responseSample = entry.response.body;
        }

        // Merge tags
        entry.tags.forEach(t => endpoint.tags.add(t));
    }

    // Convert Sets to Arrays for serialization
    for (const key in map) {
        map[key].responseStatusCodes = [...map[key].responseStatusCodes];
        map[key].tags = [...map[key].tags];
    }

    return map;
}
