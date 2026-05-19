#!/usr/bin/env node
'use strict';

/**
 * Video Viewer — Parallel sessions with rotating proxy IPs
 *
 * Each session:
 *   1. Launches a fresh browser with Oxylabs rotating proxy (new IP per browser)
 *   2. Navigates to the video URL
 *   3. Clicks play / unmutes if needed
 *   4. Watches the full video (detects end or uses max duration)
 *   5. Closes browser → next session gets a fresh IP automatically
 *
 * Oxylabs rotating proxy gives a different IP per connection,
 * so each new browser = new IP. No manual rotation needed.
 *
 * Usage:
 *   node video-viewer.js <video-url> [options]
 *
 * Options:
 *   --workers=N        Number of parallel sessions (default: 3)
 *   --loops=N          Total views to generate (default: unlimited)
 *   --max-duration=N   Max seconds per view before closing (default: 600)
 *   --headless         Run headless (default: false)
 *   --no-proxy         Disable proxy (use local IP)
 *
 * Examples:
 *   node video-viewer.js https://youtube.com/watch?v=abc123
 *   node video-viewer.js https://example.com/video --workers=5 --loops=100
 *   node video-viewer.js https://vimeo.com/12345 --headless --workers=4
 */

const { launchBrowser, authenticateProxy } = require('./bot headless/src/browser');

// ── Config ───────────────────────────────────────────────────────────
const PROXY = {
    server: process.env.PROXY_SERVER || 'pr.oxylabs.io:7777',
    username: process.env.PROXY_USERNAME || 'customer-shivansh_eMxFt',
    password: process.env.PROXY_PASSWORD || 'ay+oWeQ54BO2ko'
};

// ── Parse CLI args ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const videoUrl = args.find(a => !a.startsWith('--'));

if (!videoUrl) {
    console.log('Usage: node video-viewer.js <video-url> [--workers=3] [--loops=0] [--max-duration=600] [--headless]');
    process.exit(1);
}

function getFlag(name, defaultVal) {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : defaultVal;
}

const WORKERS = parseInt(getFlag('workers', '10'));
const MAX_LOOPS = parseInt(getFlag('loops', '0'));       // 0 = unlimited
const MAX_DURATION = parseInt(getFlag('max-duration', '600')); // seconds
const HEADLESS = true;
const NO_PROXY = true;

// ── User agents pool (rotate per session) ────────────────────────────
const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
];

// ── Viewport pool (random realistic sizes) ───────────────────────────
const VIEWPORTS = [
    { width: 1920, height: 1080 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1536, height: 864 },
    { width: 1280, height: 720 },
    { width: 2560, height: 1440 },
];

// ── Stats ────────────────────────────────────────────────────────────
let totalViews = 0;
let totalErrors = 0;
let activeWorkers = 0;

// ── Logging ──────────────────────────────────────────────────────────
function log(workerId, msg, level = 'INFO') {
    const ts = new Date().toISOString().split('T')[1].split('.')[0];
    const colors = {
        'INFO': '\x1b[36m', 'OK': '\x1b[32m', 'WARN': '\x1b[33m',
        'ERR': '\x1b[31m', 'VIEW': '\x1b[42m\x1b[30m'
    };
    const tag = workerId !== null ? `W${workerId}` : 'MAIN';
    console.log(`${colors[level] || ''}[${ts}] [${tag}] ${msg}\x1b[0m`);
}

// ── Random helpers ───────────────────────────────────────────────────
function randomFrom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomDelay(minMs, maxMs) { return Math.floor(Math.random() * (maxMs - minMs) + minMs); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Human behavior simulation ────────────────────────────────────────
// Runs in parallel with video watching to simulate real user activity.
async function simulateHumanBehavior(page, durationMs) {
    const startTime = Date.now();
    const vp = page.viewport();
    if (!vp) return;

    while (Date.now() - startTime < durationMs) {
        try {
            // Pick a random action
            const action = Math.random();

            if (action < 0.35) {
                // ── Mouse drift: smooth movement to random position ──
                const targetX = randomDelay(100, vp.width - 100);
                const targetY = randomDelay(100, vp.height - 100);
                const steps = randomDelay(8, 25); // smooth movement
                await page.mouse.move(targetX, targetY, { steps });

            } else if (action < 0.50) {
                // ── Mouse hover on video player ──
                const centerX = vp.width / 2 + randomDelay(-100, 100);
                const centerY = vp.height / 2 + randomDelay(-50, 50);
                await page.mouse.move(centerX, centerY, { steps: randomDelay(5, 15) });

            } else if (action < 0.60) {
                // ── Small scroll (like reading comments) ──
                const scrollY = randomDelay(-80, 150);
                await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), scrollY);

            } else if (action < 0.68) {
                // ── Hover over like/share buttons (YouTube Shorts) ──
                await page.evaluate(() => {
                    const btns = document.querySelectorAll(
                        'ytd-toggle-button-renderer, #like-button, #dislike-button, ' +
                        '#share-button, ytd-button-renderer'
                    );
                    // Just query them — the mouse move above handles the actual hover
                }).catch(() => {});
                // Move mouse to right side where YT Shorts buttons are
                await page.mouse.move(
                    vp.width - randomDelay(40, 120),
                    vp.height / 2 + randomDelay(-200, 200),
                    { steps: randomDelay(5, 12) }
                );

            } else if (action < 0.75) {
                // ── Brief idle (user is just watching) ──
                // Do nothing — just wait longer this cycle

            } else if (action < 0.82) {
                // ── Move mouse off-screen briefly (tabbed away feeling) ──
                await page.mouse.move(randomDelay(0, 20), randomDelay(0, 20), { steps: 3 });
                await sleep(randomDelay(2000, 5000));
                // Come back
                await page.mouse.move(
                    vp.width / 2 + randomDelay(-200, 200),
                    vp.height / 2 + randomDelay(-100, 100),
                    { steps: randomDelay(8, 20) }
                );

            } else if (action < 0.90) {
                // ── Scroll back to top (re-focus on video) ──
                await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));

            } else {
                // ── Random micro-movements near current position ──
                const jitterX = randomDelay(-30, 30);
                const jitterY = randomDelay(-30, 30);
                await page.mouse.move(
                    Math.max(0, Math.min(vp.width, vp.width / 2 + jitterX)),
                    Math.max(0, Math.min(vp.height, vp.height / 2 + jitterY)),
                    { steps: randomDelay(2, 6) }
                );
            }
        } catch {
            // page closed or navigated — stop behavior sim
            return;
        }

        // Wait between actions (human timing: variable, sometimes long pauses)
        await sleep(randomDelay(1500, 8000));
    }
}

// ── Detect video end ─────────────────────────────────────────────────
async function waitForVideoEnd(page, maxDurationMs) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxDurationMs) {
        try {
            const ended = await page.evaluate(() => {
                // HTML5 <video> element
                const video = document.querySelector('video');
                if (video) {
                    return video.ended || (video.duration > 0 && video.currentTime >= video.duration - 1);
                }
                // YouTube-specific: check if replay button is visible
                const replayBtn = document.querySelector('.ytp-replay-button');
                if (replayBtn) {
                    const style = window.getComputedStyle(replayBtn);
                    return style.display !== 'none';
                }
                return false;
            });

            if (ended) return 'ended';
        } catch {
            // page might have navigated or crashed
            return 'error';
        }

        await sleep(3000); // check every 3 seconds
    }

    return 'timeout';
}

// ── Try to play the video ────────────────────────────────────────────
async function tryPlayVideo(page) {
    await sleep(randomDelay(2000, 4000)); // wait for page to settle

    // Step 1: Physical click on the video/player area to satisfy
    // browser autoplay policy (requires trusted user gesture)
    try {
        // YouTube Shorts: click the shorts player container or video itself
        const clickTarget = await page.$(
            'ytd-shorts video, ' +                          // Shorts video element
            '#shorts-player video, ' +                      // Shorts player video
            'ytd-reel-video-renderer video, ' +             // Reel renderer
            '.html5-video-player, ' +                       // Standard YT player
            '.ytp-large-play-button, ' +                    // Big play button
            'video'                                         // Any video element
        );
        if (clickTarget) {
            await clickTarget.click();
            await sleep(500);
        }
    } catch {}

    // Step 2: Click again — Shorts often need a second click
    // (first click might just focus, second actually plays)
    try {
        const video = await page.$('video');
        if (video) {
            await video.click();
            await sleep(500);
        }
    } catch {}

    // Step 3: Force play via JS as fallback
    await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) {
            video.muted = true;
            video.play().catch(() => {});
        }

        // YouTube: click any play buttons
        const playBtns = [
            '.ytp-large-play-button',
            '.ytp-play-button',
            '[aria-label="Play"]',
            'button[aria-label*="Play"]',
        ];
        for (const sel of playBtns) {
            const btn = document.querySelector(sel);
            if (btn) { btn.click(); break; }
        }
    }).catch(() => {});

    // Step 4: Wait and retry if still paused
    await sleep(2000);
    const paused = await page.evaluate(() => {
        const v = document.querySelector('video');
        return v ? v.paused : true;
    }).catch(() => true);

    if (paused) {
        // Last resort: click center of page + try play again
        try {
            const vp = page.viewport();
            await page.mouse.click(vp.width / 2, vp.height / 2);
            await sleep(500);
            await page.evaluate(() => {
                const v = document.querySelector('video');
                if (v) { v.muted = true; v.play().catch(() => {}); }
            }).catch(() => {});
        } catch {}
    }
}

// ── Handle cookie/consent popups ─────────────────────────────────────
async function dismissPopups(page) {
    await page.evaluate(() => {
        // YouTube consent
        const ytConsent = document.querySelector('button[aria-label*="Accept"], button[aria-label*="Agree"], tp-yt-paper-button.yt-consent');
        if (ytConsent) ytConsent.click();

        // Generic cookie banners
        const cookieBtns = document.querySelectorAll(
            'button[id*="accept"], button[class*="accept"], button[class*="consent"], ' +
            'a[id*="accept"], button[data-testid*="accept"], button[aria-label*="cookie"]'
        );
        cookieBtns.forEach(btn => {
            try { btn.click(); } catch {}
        });
    }).catch(() => {});
}

// ── Single view session ──────────────────────────────────────────────
async function runViewSession(workerId) {
    let browser;
    const ua = randomFrom(USER_AGENTS);
    const vp = randomFrom(VIEWPORTS);

    try {
        activeWorkers++;
        log(workerId, `Launching browser (${vp.width}x${vp.height})...`);

        // Each new browser launch = new proxy connection = new IP
        const launched = await launchBrowser({
            headless: HEADLESS,
            proxyServer: NO_PROXY ? null : `http://${PROXY.server}`,
            userAgent: ua,
            viewport: vp,
            extraArgs: ['--autoplay-policy=no-user-gesture-required']
        });
        browser = launched.browser;
        const page = launched.page;

        // Proxy auth
        if (!NO_PROXY) {
            await authenticateProxy(page, PROXY.username, PROXY.password);
        }

        // Check IP
        try {
            await page.goto('https://httpbin.org/ip', { timeout: 15000, waitUntil: 'domcontentloaded' });
            const ipText = await page.evaluate(() => document.body.innerText).catch(() => '');
            const ipMatch = ipText.match(/"origin":\s*"([^"]+)"/);
            log(workerId, `IP: ${ipMatch ? ipMatch[1] : 'unknown'}`, 'OK');
        } catch {
            log(workerId, 'IP check skipped', 'WARN');
        }

        // Navigate to video
        log(workerId, `Loading: ${videoUrl}`);
        await page.goto(videoUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Human-like landing behavior: look around before watching
        await sleep(randomDelay(1000, 3000));
        await dismissPopups(page);
        await sleep(randomDelay(500, 1500));

        // Move mouse from edge to center (like a real cursor entering the page)
        const vpSize = page.viewport();
        if (vpSize) {
            await page.mouse.move(0, vpSize.height / 2, { steps: 2 });
            await sleep(randomDelay(200, 600));
            await page.mouse.move(
                vpSize.width / 2 + randomDelay(-100, 100),
                vpSize.height / 2 + randomDelay(-50, 50),
                { steps: randomDelay(10, 20) }
            );
        }

        // Random small scroll (looking at the page)
        await page.evaluate(() => {
            window.scrollBy({ top: Math.floor(Math.random() * 200), behavior: 'smooth' });
        }).catch(() => {});
        await sleep(randomDelay(300, 800));
        await page.evaluate(() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }).catch(() => {});

        // Try to play
        await tryPlayVideo(page);

        // Verify playback started
        const isPlaying = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video ? (!video.paused && !video.ended) : false;
        }).catch(() => false);

        if (isPlaying) {
            log(workerId, 'Video playing', 'OK');
        } else {
            log(workerId, 'Could not confirm playback — watching anyway', 'WARN');
        }

        // Watch the video + simulate human behavior in parallel
        const [result] = await Promise.all([
            waitForVideoEnd(page, MAX_DURATION * 1000),
            simulateHumanBehavior(page, MAX_DURATION * 1000)
        ]);

        // Get watch duration
        const watchDuration = await page.evaluate(() => {
            const video = document.querySelector('video');
            return video ? Math.floor(video.currentTime) : 0;
        }).catch(() => 0);

        totalViews++;
        log(workerId, `View #${totalViews} complete (${result}, ${watchDuration}s watched)`, 'VIEW');

    } catch (err) {
        totalErrors++;
        log(workerId, `Error: ${err.message}`, 'ERR');
    } finally {
        activeWorkers--;
        if (browser) await browser.close().catch(() => {});
        // Random delay between sessions (human-like)
        await sleep(randomDelay(2000, 5000));
    }
}

// ── Worker loop ──────────────────────────────────────────────────────
async function workerLoop(workerId) {
    let viewCount = 0;

    while (running) {
        if (MAX_LOOPS > 0 && totalViews >= MAX_LOOPS) break;

        await runViewSession(workerId);
        viewCount++;

        // Periodic longer pause every 10 views (avoid patterns)
        if (viewCount % 10 === 0) {
            const pauseSec = randomDelay(10000, 30000) / 1000;
            log(workerId, `Pausing ${pauseSec.toFixed(0)}s (anti-pattern)...`, 'INFO');
            await sleep(pauseSec * 1000);
        }
    }

    log(workerId, `Worker done (${viewCount} views)`, 'OK');
}

// ── Main ─────────────────────────────────────────────────────────────
let running = true;

async function main() {
    console.log('\n' + '═'.repeat(55));
    console.log('\x1b[32m  VIDEO VIEWER — Rotating Proxy\x1b[0m');
    console.log(`\x1b[36m  URL: ${videoUrl}\x1b[0m`);
    console.log(`\x1b[33m  Workers: ${WORKERS} | Max duration: ${MAX_DURATION}s | Loops: ${MAX_LOOPS || '∞'}\x1b[0m`);
    console.log(`\x1b[35m  Proxy: ${NO_PROXY ? 'disabled' : PROXY.server}\x1b[0m`);
    console.log(`\x1b[35m  Mode: ${HEADLESS ? 'headless' : 'headed'}\x1b[0m`);
    console.log('═'.repeat(55) + '\n');

    // Status printer
    const statusInterval = setInterval(() => {
        if (!running) return;
        console.log(
            `\x1b[44m[STATUS]\x1b[0m ` +
            `Views: ${totalViews} | ` +
            `Errors: ${totalErrors} | ` +
            `Active: ${activeWorkers}/${WORKERS} | ` +
            `Uptime: ${Math.floor((Date.now() - startTime) / 60000)}min`
        );
    }, 30000);

    const startTime = Date.now();

    // Launch workers with staggered starts
    const workers = [];
    for (let i = 0; i < WORKERS; i++) {
        workers.push(workerLoop(i + 1));
        // Stagger launches so they don't all hit the proxy at once
        if (i < WORKERS - 1) await sleep(randomDelay(3000, 8000));
    }

    await Promise.all(workers);
    clearInterval(statusInterval);

    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    console.log(`\n\x1b[32mDone! ${totalViews} views in ${elapsed}s (${totalErrors} errors)\x1b[0m`);
}

// ── Signal handling ──────────────────────────────────────────────────
process.on('SIGINT', () => {
    console.log('\n\x1b[33mStopping... (finishing active sessions)\x1b[0m');
    running = false;
});

process.on('uncaughtException', (err) => {
    console.error('Fatal:', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled:', reason);
});

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
