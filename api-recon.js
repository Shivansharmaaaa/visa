/**
 * API Mold Recon - Console Dashboard & SW Registration
 * ======================================================
 * Paste this ENTIRE script into Chrome DevTools console
 * while on ais.usvisa-info.com (logged in).
 *
 * What it does:
 *   1. Registers sw-interceptor.js as a Service Worker
 *   2. Also hooks fetch() and XMLHttpRequest as a fallback
 *   3. Provides a dashboard object: window.MOLD
 *   4. Live-prints every captured API call to console
 *
 * Usage after pasting:
 *   MOLD.all()           - Show all captured API calls
 *   MOLD.json()          - Show only JSON API calls
 *   MOLD.map()           - Show deduplicated API endpoint map
 *   MOLD.dates()         - Show only date-related API calls
 *   MOLD.times()         - Show only time-related API calls
 *   MOLD.login()         - Show login-related calls
 *   MOLD.find('keyword') - Search by URL keyword
 *   MOLD.last(n)         - Show last N captures
 *   MOLD.export()        - Download all captures as JSON
 *   MOLD.clear()         - Clear all logs
 *   MOLD.status()        - Check SW status + stats
 *   MOLD.curl(id)        - Generate cURL command for a captured request
 *   MOLD.replay(id)      - Replay a captured request
 *   MOLD.stop()          - Unregister the service worker
 *
 * The "API Molding" Technique:
 *   Instead of navigating through UI pages and scraping DOM elements,
 *   we capture the raw API calls the site makes, then replicate them
 *   directly with fetch(). This is faster, stealthier, and more reliable.
 *   1. RECON:    Capture all endpoints, headers, tokens, payloads
 *   2. MOLD:     Build direct fetch() calls using captured patterns
 *   3. EXECUTE:  Call APIs directly without browser automation
 */

(async function API_MOLD_RECON() {
    'use strict';

    // ========================================================================
    // CONFIG
    // ========================================================================
    const CONFIG = {
        swPath: '/sw-interceptor.js',   // Path to the SW file (relative to origin)
        trySW: false,                   // Skip SW registration (404 on sites you don't control)
        logToConsole: true,             // Live-print captures
        captureXHR: true,               // Also hook XMLHttpRequest
        captureFetch: true,             // Also hook fetch()
        filterStaticAssets: true,       // Skip images, CSS, fonts, etc.
        maxLocalLog: 1000               // Max entries in local fallback log
    };

    // Static asset extensions to skip
    const STATIC_EXTS = /\.(png|jpg|jpeg|gif|svg|ico|css|woff2?|ttf|eot|map|webp)(\?|$)/i;

    // ========================================================================
    // LOCAL LOG (fallback when SW can't capture)
    // ========================================================================
    const LOCAL_LOG = [];

    function shouldSkip(url) {
        if (!CONFIG.filterStaticAssets) return false;
        return STATIC_EXTS.test(url);
    }

    function storeLocal(entry) {
        LOCAL_LOG.push(entry);
        if (LOCAL_LOG.length > CONFIG.maxLocalLog) {
            LOCAL_LOG.splice(0, LOCAL_LOG.length - CONFIG.maxLocalLog);
        }
    }

    // ========================================================================
    // CONSOLE PRETTY PRINTER
    // ========================================================================
    function printCapture(entry) {
        if (!CONFIG.logToConsole) return;

        const status = entry.response?.status || '???';
        const duration = entry.timing?.duration ? `${Math.round(entry.timing.duration)}ms` : '?';
        const method = entry.method || 'GET';
        const url = entry.url;

        // Color by status
        let statusColor = '#888';
        if (status >= 200 && status < 300) statusColor = '#4CAF50';
        else if (status >= 300 && status < 400) statusColor = '#FF9800';
        else if (status >= 400) statusColor = '#f44336';

        // Color by method
        const methodColors = {
            GET: '#61affe', POST: '#49cc90', PUT: '#fca130',
            PATCH: '#50e3c2', DELETE: '#f93e3e', OPTIONS: '#888'
        };

        const tags = entry.tags?.length ? ` [${entry.tags.join(', ')}]` : '';

        console.groupCollapsed(
            `%c${method}%c ${status} %c${duration}%c ${url}${tags}`,
            `color: ${methodColors[method] || '#888'}; font-weight: bold`,
            `color: ${statusColor}; font-weight: bold`,
            'color: #888',
            'color: inherit'
        );

        // Request details
        if (Object.keys(entry.request?.headers || {}).length > 0) {
            console.log('%c📤 Request Headers:', 'font-weight: bold; color: #61affe');
            console.table(entry.request.headers);
        }

        if (entry.request?.payload) {
            console.log('%c📦 Payload:', 'font-weight: bold; color: #49cc90');
            if (typeof entry.request.payload === 'object') {
                console.log(JSON.stringify(entry.request.payload, null, 2));
            } else {
                console.log(entry.request.payload);
            }
        }

        // Response details
        if (Object.keys(entry.response?.headers || {}).length > 0) {
            console.log('%c📥 Response Headers:', 'font-weight: bold; color: #FF9800');
            console.table(entry.response.headers);
        }

        if (entry.response?.body) {
            console.log('%c📋 Response Body:', 'font-weight: bold; color: #4CAF50');
            if (typeof entry.response.body === 'object') {
                console.log(JSON.stringify(entry.response.body, null, 2));
            } else {
                console.log(entry.response.preview || entry.response.body);
            }
        }

        console.groupEnd();
    }

    // ========================================================================
    // FETCH HOOK (fallback/supplement to SW)
    // ========================================================================
    if (CONFIG.captureFetch) {
        const originalFetch = window.fetch;
        window.fetch = async function (...args) {
            const request = args[0] instanceof Request ? args[0] : new Request(...args);
            const url = request.url || args[0];

            if (shouldSkip(url)) return originalFetch.apply(this, args);

            const entry = {
                id: LOCAL_LOG.length + 1,
                timestamp: new Date().toISOString(),
                source: 'fetch-hook',
                url: typeof url === 'string' ? url : url.toString(),
                method: request.method || 'GET',
                request: { headers: {}, payload: null },
                response: { status: null, headers: {}, body: null, preview: null },
                timing: { start: performance.now(), end: null, duration: null },
                tags: [],
                error: null
            };

            // Capture request headers
            if (request.headers) {
                for (const [k, v] of request.headers.entries()) {
                    entry.request.headers[k] = v;
                }
            }

            // Also capture from init object if present
            if (args[1]?.headers) {
                const h = args[1].headers;
                if (h instanceof Headers) {
                    for (const [k, v] of h.entries()) entry.request.headers[k] = v;
                } else if (typeof h === 'object') {
                    Object.assign(entry.request.headers, h);
                }
            }

            // Capture payload
            if (args[1]?.body) {
                try {
                    if (typeof args[1].body === 'string') {
                        // Try JSON parse
                        try { entry.request.payload = JSON.parse(args[1].body); }
                        catch { entry.request.payload = args[1].body; }
                    } else if (args[1].body instanceof URLSearchParams) {
                        entry.request.payload = Object.fromEntries(args[1].body);
                    } else {
                        entry.request.payload = '[Binary/FormData]';
                    }
                } catch (e) {
                    entry.request.payload = '[unreadable]';
                }
            }

            try {
                const response = await originalFetch.apply(this, args);
                entry.timing.end = performance.now();
                entry.timing.duration = entry.timing.end - entry.timing.start;

                entry.response.status = response.status;
                entry.response.statusText = response.statusText;

                // Response headers
                for (const [k, v] of response.headers.entries()) {
                    entry.response.headers[k] = v;
                }

                // Try to capture response body (clone to not consume)
                const ct = response.headers.get('content-type') || '';
                if (ct.includes('json') || ct.includes('text') || ct.includes('html')) {
                    const clone = response.clone();
                    try {
                        const text = await clone.text();
                        if (ct.includes('json')) {
                            try { entry.response.body = JSON.parse(text); }
                            catch { entry.response.body = text; }
                        } else {
                            entry.response.body = text.length > 2000
                                ? text.substring(0, 2000) + '...[truncated]'
                                : text;
                        }
                        entry.response.preview = text.substring(0, 200);
                    } catch (e) {
                        entry.response.body = `[read error: ${e.message}]`;
                    }
                }

                // Auto-tag
                tagEntry(entry);
                storeLocal(entry);
                printCapture(entry);

                return response;
            } catch (err) {
                entry.timing.end = performance.now();
                entry.timing.duration = entry.timing.end - entry.timing.start;
                entry.error = err.message;
                tagEntry(entry);
                storeLocal(entry);
                printCapture(entry);
                throw err;
            }
        };
        console.log('[API-MOLD] ✅ fetch() hooked');
    }

    // ========================================================================
    // XHR HOOK (for sites that use XMLHttpRequest)
    // ========================================================================
    if (CONFIG.captureXHR) {
        const XHR = XMLHttpRequest.prototype;
        const origOpen = XHR.open;
        const origSend = XHR.send;
        const origSetHeader = XHR.setRequestHeader;

        XHR.open = function (method, url, ...rest) {
            this._moldData = {
                method: method,
                url: url,
                headers: {},
                startTime: null
            };
            return origOpen.apply(this, [method, url, ...rest]);
        };

        XHR.setRequestHeader = function (key, value) {
            if (this._moldData) {
                this._moldData.headers[key] = value;
            }
            return origSetHeader.apply(this, [key, value]);
        };

        XHR.send = function (body) {
            if (!this._moldData || shouldSkip(this._moldData.url)) {
                return origSend.apply(this, [body]);
            }

            this._moldData.startTime = performance.now();

            this.addEventListener('load', function () {
                const d = this._moldData;
                const entry = {
                    id: LOCAL_LOG.length + 1,
                    timestamp: new Date().toISOString(),
                    source: 'xhr-hook',
                    url: d.url.startsWith('http') ? d.url : `${location.origin}${d.url}`,
                    method: d.method,
                    request: {
                        headers: d.headers,
                        payload: null
                    },
                    response: {
                        status: this.status,
                        statusText: this.statusText,
                        headers: {},
                        body: null,
                        preview: null
                    },
                    timing: {
                        start: d.startTime,
                        end: performance.now(),
                        duration: performance.now() - d.startTime
                    },
                    tags: [],
                    error: null
                };

                // Parse payload
                if (body) {
                    try {
                        if (typeof body === 'string') {
                            try { entry.request.payload = JSON.parse(body); }
                            catch {
                                if (body.includes('=')) {
                                    entry.request.payload = Object.fromEntries(new URLSearchParams(body));
                                } else {
                                    entry.request.payload = body;
                                }
                            }
                        } else {
                            entry.request.payload = '[Binary/FormData]';
                        }
                    } catch (e) {
                        entry.request.payload = '[unreadable]';
                    }
                }

                // Response headers
                const rawHeaders = this.getAllResponseHeaders().trim().split(/\r?\n/);
                for (const line of rawHeaders) {
                    const idx = line.indexOf(':');
                    if (idx > 0) {
                        entry.response.headers[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
                    }
                }

                // Response body
                const ct = this.getResponseHeader('content-type') || '';
                if (ct.includes('json') || ct.includes('text') || ct.includes('html')) {
                    try {
                        if (ct.includes('json')) {
                            try { entry.response.body = JSON.parse(this.responseText); }
                            catch { entry.response.body = this.responseText; }
                        } else {
                            entry.response.body = this.responseText?.length > 2000
                                ? this.responseText.substring(0, 2000) + '...[truncated]'
                                : this.responseText;
                        }
                        entry.response.preview = (this.responseText || '').substring(0, 200);
                    } catch (e) {
                        entry.response.body = `[read error]`;
                    }
                }

                tagEntry(entry);
                storeLocal(entry);
                printCapture(entry);
            });

            this.addEventListener('error', function () {
                const d = this._moldData;
                const entry = {
                    id: LOCAL_LOG.length + 1,
                    timestamp: new Date().toISOString(),
                    source: 'xhr-hook',
                    url: d.url,
                    method: d.method,
                    request: { headers: d.headers, payload: null },
                    response: { status: 0, headers: {}, body: null, preview: null },
                    timing: { start: d.startTime, end: performance.now(), duration: performance.now() - d.startTime },
                    tags: [],
                    error: 'Network error'
                };
                tagEntry(entry);
                storeLocal(entry);
                printCapture(entry);
            });

            return origSend.apply(this, [body]);
        };
        console.log('[API-MOLD] ✅ XMLHttpRequest hooked');
    }

    // ========================================================================
    // AUTO-TAGGER
    // ========================================================================
    const TAG_PATTERNS = {
        dates:       /schedule\/\d+\/appointment\/days\/\d+\.json|available_dates/,
        times:       /schedule\/\d+\/appointment\/times\/\d+\.json|available_times/,
        login:       /users\/sign_in|sign_in|login/,
        logout:      /sign_out|logout/,
        schedule:    /schedule\/\d+/,
        appointment: /appointment/,
        api_v2:      /\/api\/v2\//,
        json_api:    /\.json/,
        csrf:        /csrf|authenticity/,
        booking:     /book|confirm|submit/i,
        navigation:  /continue|next_step|step/i
    };

    function tagEntry(entry) {
        for (const [tag, pattern] of Object.entries(TAG_PATTERNS)) {
            if (pattern.test(entry.url)) {
                entry.tags.push(tag);
            }
        }
    }

    // ========================================================================
    // SERVICE WORKER REGISTRATION
    // ========================================================================
    let swRegistered = false;

    async function registerSW() {
        if (!('serviceWorker' in navigator)) {
            console.warn('[API-MOLD] ⚠️ Service Workers not supported. Using fetch/XHR hooks only.');
            return false;
        }

        try {
            const reg = await navigator.serviceWorker.register(CONFIG.swPath, { scope: '/' });
            console.log('[API-MOLD] ✅ Service Worker registered:', reg.scope);
            swRegistered = true;

            // Listen for messages from SW
            navigator.serviceWorker.addEventListener('message', (event) => {
                const { type, entry, entries, map } = event.data || {};

                switch (type) {
                    case 'API_MOLD_CAPTURE':
                        // Don't double-log if we already captured via hooks
                        // SW captures are authoritative when available
                        break;
                    case 'API_MOLD_ALL_LOGS':
                        console.log(`[API-MOLD] 📊 ${entries.length} entries from SW:`);
                        console.table(entries.map(e => ({
                            id: e.id,
                            method: e.method,
                            status: e.response?.status,
                            url: e.url.substring(0, 80),
                            duration: e.timing?.duration ? Math.round(e.timing.duration) + 'ms' : '?',
                            tags: e.tags?.join(', ') || ''
                        })));
                        break;
                    case 'API_MOLD_API_MAP':
                        console.log('[API-MOLD] 🗺️ API Endpoint Map:');
                        for (const [key, ep] of Object.entries(map)) {
                            console.groupCollapsed(
                                `%c${ep.method}%c ${ep.pathPattern} (${ep.count}x, ~${Math.round(ep.avgDuration)}ms)`,
                                'color: #61affe; font-weight: bold',
                                'color: inherit'
                            );
                            console.log('Example URL:', ep.exampleUrl);
                            console.log('Query Params:', ep.queryParams);
                            console.log('Request Headers:', ep.requestHeaders);
                            if (ep.requestPayloadSample) console.log('Payload Sample:', ep.requestPayloadSample);
                            console.log('Status Codes:', ep.responseStatusCodes);
                            console.log('Response Headers:', ep.responseHeaders);
                            if (ep.responseSample) console.log('Response Sample:', ep.responseSample);
                            console.log('Tags:', ep.tags);
                            console.groupEnd();
                        }
                        break;
                    case 'API_MOLD_PONG':
                        console.log(`[API-MOLD] 🏓 SW alive | ${event.data.logCount} entries | uptime: ${Math.round(event.data.uptime / 1000)}s`);
                        break;
                }
            });

            return true;
        } catch (err) {
            console.warn(`[API-MOLD] ⚠️ SW registration failed: ${err.message}`);
            console.log('[API-MOLD] Falling back to fetch/XHR hooks (still fully functional)');
            return false;
        }
    }

    function sendToSW(command, data = {}) {
        if (navigator.serviceWorker?.controller) {
            navigator.serviceWorker.controller.postMessage({ command, data });
            return true;
        }
        return false;
    }

    // ========================================================================
    // API MAP BUILDER (local fallback, mirrors SW logic)
    // ========================================================================
    function buildLocalApiMap() {
        const map = {};

        for (const entry of LOCAL_LOG) {
            try {
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
                        responseStatusCodes: [],
                        responseHeaders: {},
                        responseSample: null,
                        tags: [],
                        count: 0,
                        avgDuration: 0,
                        totalDuration: 0
                    };
                }

                const ep = map[key];
                ep.count++;
                ep.totalDuration += (entry.timing?.duration || 0);
                ep.avgDuration = ep.totalDuration / ep.count;

                for (const [k, v] of urlObj.searchParams.entries()) {
                    if (!ep.queryParams[k]) ep.queryParams[k] = [];
                    if (!ep.queryParams[k].includes(v) && ep.queryParams[k].length < 5) {
                        ep.queryParams[k].push(v);
                    }
                }

                Object.assign(ep.requestHeaders, entry.request?.headers || {});
                if (entry.request?.payload) ep.requestPayloadSample = entry.request.payload;
                if (entry.response?.status && !ep.responseStatusCodes.includes(entry.response.status)) {
                    ep.responseStatusCodes.push(entry.response.status);
                }
                Object.assign(ep.responseHeaders, entry.response?.headers || {});
                if (entry.response?.body && typeof entry.response.body === 'object') {
                    ep.responseSample = entry.response.body;
                }
                entry.tags?.forEach(t => {
                    if (!ep.tags.includes(t)) ep.tags.push(t);
                });
            } catch (e) {
                // skip malformed URLs
            }
        }

        return map;
    }

    // ========================================================================
    // cURL GENERATOR
    // ========================================================================
    function generateCurl(entry) {
        if (!entry) return null;

        let cmd = `curl '${entry.url}'`;

        // Method
        if (entry.method !== 'GET') {
            cmd += ` \\\n  -X ${entry.method}`;
        }

        // Headers
        const headers = entry.request?.headers || {};
        for (const [k, v] of Object.entries(headers)) {
            cmd += ` \\\n  -H '${k}: ${v}'`;
        }

        // Payload
        if (entry.request?.payload) {
            if (typeof entry.request.payload === 'object') {
                cmd += ` \\\n  -d '${JSON.stringify(entry.request.payload)}'`;
            } else {
                cmd += ` \\\n  -d '${entry.request.payload}'`;
            }
        }

        return cmd;
    }

    // ========================================================================
    // FETCH REPLAYER
    // ========================================================================
    async function replayRequest(entry) {
        if (!entry) {
            console.error('[API-MOLD] Entry not found');
            return null;
        }

        console.log(`[API-MOLD] 🔄 Replaying: ${entry.method} ${entry.url}`);

        const opts = {
            method: entry.method,
            credentials: 'include',
            headers: { ...entry.request?.headers }
        };

        if (entry.request?.payload && ['POST', 'PUT', 'PATCH'].includes(entry.method)) {
            if (typeof entry.request.payload === 'object') {
                opts.body = JSON.stringify(entry.request.payload);
            } else {
                opts.body = entry.request.payload;
            }
        }

        // Use the ORIGINAL fetch to avoid re-capture loop
        const origFetch = window.__origFetch || window.fetch;
        try {
            const resp = await origFetch(entry.url, opts);
            const ct = resp.headers.get('content-type') || '';
            let body;
            if (ct.includes('json')) {
                body = await resp.json();
            } else {
                body = await resp.text();
            }
            console.log(`[API-MOLD] ✅ Replay result: ${resp.status}`);
            console.log(body);
            return { status: resp.status, body };
        } catch (err) {
            console.error(`[API-MOLD] ❌ Replay failed: ${err.message}`);
            return { error: err.message };
        }
    }

    // Store original fetch for replay
    window.__origFetch = window.__origFetch || fetch.bind(window);

    // ========================================================================
    // DASHBOARD - window.MOLD
    // ========================================================================
    window.MOLD = {
        // Show all captures
        all() {
            // Try SW first, fall back to local
            if (!sendToSW('GET_ALL_LOGS')) {
                console.log(`[API-MOLD] 📊 ${LOCAL_LOG.length} captured requests:`);
                console.table(LOCAL_LOG.map(e => ({
                    '#': e.id,
                    method: e.method,
                    status: e.response?.status,
                    url: e.url.substring(0, 100),
                    ms: e.timing?.duration ? Math.round(e.timing.duration) : '?',
                    tags: e.tags?.join(', ') || '',
                    src: e.source
                })));
            }
            return `${LOCAL_LOG.length} entries`;
        },

        // Show only JSON API calls
        json() {
            const filtered = LOCAL_LOG.filter(e =>
                e.url.includes('.json') ||
                (e.response?.headers?.['content-type'] || '').includes('json') ||
                e.tags?.includes('json_api')
            );
            console.log(`[API-MOLD] 📊 ${filtered.length} JSON API calls:`);
            filtered.forEach(e => printCapture(e));
            return `${filtered.length} JSON entries`;
        },

        // Show deduplicated API map
        map() {
            if (!sendToSW('GET_API_MAP')) {
                const map = buildLocalApiMap();
                console.log('[API-MOLD] 🗺️ API Endpoint Map:');
                for (const [key, ep] of Object.entries(map)) {
                    console.groupCollapsed(
                        `%c${ep.method}%c ${ep.pathPattern} (${ep.count}x, ~${Math.round(ep.avgDuration)}ms)`,
                        'color: #61affe; font-weight: bold',
                        'color: inherit'
                    );
                    console.log('Example URL:', ep.exampleUrl);
                    console.log('Query Params:', ep.queryParams);
                    console.log('Request Headers:', ep.requestHeaders);
                    if (ep.requestPayloadSample) console.log('Payload Sample:', ep.requestPayloadSample);
                    console.log('Status Codes:', ep.responseStatusCodes);
                    console.log('Response Headers:', ep.responseHeaders);
                    if (ep.responseSample) console.log('Response Sample:', ep.responseSample);
                    console.log('Tags:', ep.tags);
                    console.groupEnd();
                }
                return `${Object.keys(map).length} unique endpoints`;
            }
        },

        // Filter by tag
        dates() {
            return this._byTag('dates');
        },
        times() {
            return this._byTag('times');
        },
        login() {
            return this._byTag('login');
        },
        booking() {
            return this._byTag('booking');
        },

        _byTag(tag) {
            const filtered = LOCAL_LOG.filter(e => e.tags?.includes(tag));
            console.log(`[API-MOLD] 🏷️ ${filtered.length} entries tagged "${tag}":`);
            filtered.forEach(e => printCapture(e));
            return `${filtered.length} ${tag} entries`;
        },

        // Search by URL keyword
        find(keyword) {
            const filtered = LOCAL_LOG.filter(e =>
                e.url.toLowerCase().includes(keyword.toLowerCase())
            );
            console.log(`[API-MOLD] 🔍 ${filtered.length} entries matching "${keyword}":`);
            filtered.forEach(e => printCapture(e));
            return `${filtered.length} matches`;
        },

        // Show last N entries
        last(n = 10) {
            const recent = LOCAL_LOG.slice(-n);
            console.log(`[API-MOLD] 📊 Last ${recent.length} captures:`);
            recent.forEach(e => printCapture(e));
            return `${recent.length} entries`;
        },

        // Get entry by ID
        get(id) {
            const entry = LOCAL_LOG.find(e => e.id === id);
            if (entry) {
                printCapture(entry);
                return entry;
            }
            console.warn(`[API-MOLD] Entry #${id} not found`);
            return null;
        },

        // Generate cURL command
        curl(id) {
            const entry = LOCAL_LOG.find(e => e.id === id);
            const cmd = generateCurl(entry);
            if (cmd) {
                console.log(`[API-MOLD] 📋 cURL for request #${id}:\n\n${cmd}`);
                return cmd;
            }
            console.warn(`[API-MOLD] Entry #${id} not found`);
        },

        // Replay a captured request
        async replay(id) {
            const entry = LOCAL_LOG.find(e => e.id === id);
            return replayRequest(entry);
        },

        // Export all data as downloadable JSON
        export() {
            const data = {
                exportedAt: new Date().toISOString(),
                site: location.origin,
                totalEntries: LOCAL_LOG.length,
                apiMap: buildLocalApiMap(),
                entries: LOCAL_LOG
            };

            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `api-mold-recon-${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);

            console.log(`[API-MOLD] 💾 Exported ${LOCAL_LOG.length} entries`);
            return `Exported ${LOCAL_LOG.length} entries`;
        },

        // Check status
        status() {
            sendToSW('PING');
            console.log(`[API-MOLD] Local log: ${LOCAL_LOG.length} entries`);
            console.log(`[API-MOLD] SW registered: ${swRegistered}`);
            console.log(`[API-MOLD] Hooks: fetch=${CONFIG.captureFetch}, XHR=${CONFIG.captureXHR}`);
            return { local: LOCAL_LOG.length, sw: swRegistered };
        },

        // Clear all logs
        clear() {
            LOCAL_LOG.length = 0;
            sendToSW('CLEAR_LOGS');
            console.log('[API-MOLD] 🧹 All logs cleared');
        },

        // Toggle live logging
        verbose(on = true) {
            CONFIG.logToConsole = on;
            console.log(`[API-MOLD] Live logging: ${on ? 'ON' : 'OFF'}`);
        },

        // Unregister SW
        async stop() {
            const regs = await navigator.serviceWorker?.getRegistrations();
            for (const reg of (regs || [])) {
                await reg.unregister();
            }
            swRegistered = false;
            console.log('[API-MOLD] 🛑 Service Worker unregistered');
            console.log('[API-MOLD] Fetch/XHR hooks remain active until page reload');
        },

        // Quick reference
        help() {
            console.log(`
%c╔══════════════════════════════════════════════════╗
║          API MOLD RECON - Quick Reference         ║
╠══════════════════════════════════════════════════╣
║  MOLD.all()         Show all captured requests    ║
║  MOLD.json()        Show only JSON API calls      ║
║  MOLD.map()         Deduplicated endpoint map     ║
║  MOLD.dates()       Date-check API calls          ║
║  MOLD.times()       Time-check API calls          ║
║  MOLD.login()       Login-related calls           ║
║  MOLD.booking()     Booking-related calls         ║
║  MOLD.find('word')  Search by URL keyword         ║
║  MOLD.last(10)      Last N captures               ║
║  MOLD.get(id)       Get full details for entry    ║
║  MOLD.curl(id)      Generate cURL command         ║
║  MOLD.replay(id)    Replay a captured request     ║
║  MOLD.export()      Download all as JSON          ║
║  MOLD.verbose(bool) Toggle live console logging   ║
║  MOLD.status()      Check SW status & stats       ║
║  MOLD.clear()       Clear all logs                ║
║  MOLD.stop()        Unregister service worker     ║
╚══════════════════════════════════════════════════╝`, 'color: #61affe; font-family: monospace');
        },

        // Direct access to raw log array
        get _raw() { return LOCAL_LOG; }
    };

    // ========================================================================
    // BOOT
    // ========================================================================
    console.log(`
%c╔══════════════════════════════════════════════════╗
║            🔬 API MOLD RECON v1.0                 ║
║         Network Interception Active               ║
╠══════════════════════════════════════════════════╣
║  All API calls are being captured with:           ║
║  • Payload    • Headers    • Response    • Timing ║
║                                                   ║
║  Type %cMOLD.help()%c for commands                    ║
║  Type %cMOLD.map()%c  for endpoint summary            ║
╚══════════════════════════════════════════════════╝`,
    'color: #4CAF50; font-family: monospace',
    'color: #FF9800; font-weight: bold; font-family: monospace',
    'color: #4CAF50; font-family: monospace',
    'color: #FF9800; font-weight: bold; font-family: monospace',
    'color: #4CAF50; font-family: monospace'
    );

    // Try to register the SW (non-blocking) — skipped by default for sites you don't control
    if (CONFIG.trySW) {
        await registerSW();
    }

    if (!swRegistered) {
        console.log('[API-MOLD] Running in hooks-only mode (fetch + XHR interception)');
    }

    console.log('[API-MOLD] 🎯 Now browse the site normally. Every API call is being recorded.');
    console.log('[API-MOLD] 💡 Tip: Navigate through login → appointment page to capture all endpoints.');

})();
