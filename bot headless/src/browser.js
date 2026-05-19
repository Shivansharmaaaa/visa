'use strict';

const puppeteer = require('puppeteer');

// ── Fingerprint generator ────────────────────────────────────────────
// Creates a unique, consistent fingerprint per browser session so each
// instance looks like a different real device to canvas/WebGL/audio checks.
function generateFingerprint(userAgent, viewport) {
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const randInt = (min, max) => Math.floor(Math.random() * (max - min) + min);

  // Detect OS from user agent for consistent platform string
  const isWin = userAgent.includes('Windows');
  const isMac = userAgent.includes('Mac');
  const isLinux = userAgent.includes('Linux');

  const platforms = isWin ? ['Win32'] : isMac ? ['MacIntel'] : ['Linux x86_64', 'Linux aarch64'];
  const timezones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
                     'Europe/London', 'Europe/Paris', 'Asia/Tokyo', 'Australia/Sydney',
                     'America/Toronto', 'America/Vancouver', 'Europe/Berlin'];

  const webglVendors = [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1 Pro, OpenGL 4.1)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics, OpenGL 4.1)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
  ];

  const pluginSets = [
    ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer'],
    ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer'],
    ['PDF Viewer', 'Chrome PDF Viewer'],
    ['Chrome PDF Viewer', 'Chromium PDF Viewer', 'Native Client'],
  ];

  const langSets = [
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['en-CA', 'en-US', 'en'],
    ['en-US'],
    ['en-AU', 'en'],
  ];

  return {
    cores: pick([2, 4, 6, 8, 10, 12, 16]),
    memory: pick([4, 8, 16, 32]),
    platform: pick(platforms),
    languages: pick(langSets),
    pluginNames: pick(pluginSets),
    screenW: viewport.width + pick([0, 0, 0, 80, 160]),  // sometimes wider than viewport
    screenH: viewport.height + pick([0, 0, 40, 80, 120]),
    taskbar: pick([30, 40, 48, 60, 72]),
    colorDepth: pick([24, 24, 24, 30, 32]),
    canvasNoise: { step: randInt(4, 40), xor: randInt(1, 3) },
    webgl: pick(webglVendors),
    audioNoise: Math.random() * 0.00001,
    timezone: pick(timezones),
  };
}

/**
 * Shared Puppeteer browser launcher with anti-detection.
 * Used by both the Amazon bot and the Visa bot (nothang-etl).
 *
 * @param {object} opts
 * @param {boolean}  opts.headless   - Run headless (default: false)
 * @param {string}   opts.proxyServer - Proxy URL e.g. "http://pr.oxylabs.io:7777"
 * @param {string}   opts.userAgent  - Custom user agent
 * @param {object}   opts.viewport   - { width, height }
 * @param {string[]} opts.extraArgs  - Additional Chrome args
 * @returns {Promise<{ browser: import('puppeteer').Browser, page: import('puppeteer').Page }>}
 */
async function launchBrowser(opts = {}) {
  const {
    headless = false,
    proxyServer = null,
    userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport = { width: 1920, height: 1080 },
    extraArgs = []
  } = opts;

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-webrtc',
    ...extraArgs
  ];

  if (proxyServer) {
    args.push(`--proxy-server=${proxyServer}`);
  }

  const launchOpts = {
    headless: headless ? 'new' : false,
    channel: 'chrome',   // always use system Chrome (no bundled Chromium needed)
    args,
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: viewport
  };

  const browser = await puppeteer.launch(launchOpts);
  const page = await browser.newPage();

  // ── Randomized fingerprint seed (unique per browser instance) ──
  const fp = generateFingerprint(userAgent, viewport);

  await page.evaluateOnNewDocument((fp) => {
    // ── Core: hide webdriver ──
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };

    // ── Hardware fingerprint ──
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => fp.cores });
    Object.defineProperty(navigator, 'deviceMemory', { get: () => fp.memory });
    Object.defineProperty(navigator, 'platform', { get: () => fp.platform });
    Object.defineProperty(navigator, 'languages', { get: () => fp.languages });
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const arr = fp.pluginNames.map(name => ({ name, description: name, filename: name.toLowerCase().replace(/ /g, '') + '.dll', length: 1 }));
        arr.item = (i) => arr[i];
        arr.namedItem = (n) => arr.find(p => p.name === n);
        arr.refresh = () => {};
        return arr;
      }
    });

    // ── Screen dimensions (match viewport) ──
    Object.defineProperty(screen, 'width', { get: () => fp.screenW });
    Object.defineProperty(screen, 'height', { get: () => fp.screenH });
    Object.defineProperty(screen, 'availWidth', { get: () => fp.screenW });
    Object.defineProperty(screen, 'availHeight', { get: () => fp.screenH - fp.taskbar });
    Object.defineProperty(screen, 'colorDepth', { get: () => fp.colorDepth });
    Object.defineProperty(screen, 'pixelDepth', { get: () => fp.colorDepth });

    // ── Canvas fingerprint noise ──
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      const ctx = this.getContext('2d');
      if (ctx) {
        const imgData = ctx.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imgData.data.length; i += fp.canvasNoise.step) {
          imgData.data[i] = imgData.data[i] ^ fp.canvasNoise.xor;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      return origToDataURL.apply(this, arguments);
    };

    // ── WebGL fingerprint ──
    const origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return fp.webgl.vendor;     // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return fp.webgl.renderer;   // UNMASKED_RENDERER_WEBGL
      return origGetParam.apply(this, arguments);
    };

    // ── AudioContext fingerprint ──
    const origCreateOscillator = (window.OfflineAudioContext || window.webkitOfflineAudioContext || function(){}).prototype.createOscillator;
    if (origCreateOscillator) {
      const OrigAudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (OrigAudioCtx) {
        const origStartRendering = OrigAudioCtx.prototype.startRendering;
        OrigAudioCtx.prototype.startRendering = function() {
          return origStartRendering.apply(this, arguments).then(buffer => {
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i += 100) {
              data[i] += fp.audioNoise * (Math.random() - 0.5);
            }
            return buffer;
          });
        };
      }
    }

    // ── Timezone ──
    if (fp.timezone) {
      const origDTF = Intl.DateTimeFormat;
      Intl.DateTimeFormat = function(locale, options) {
        options = options || {};
        if (!options.timeZone) options.timeZone = fp.timezone;
        return new origDTF(locale, options);
      };
      Intl.DateTimeFormat.prototype = origDTF.prototype;
      Intl.DateTimeFormat.supportedLocalesOf = origDTF.supportedLocalesOf;
    }

    // ── Permissions API (look normal) ──
    const origQuery = navigator.permissions?.query;
    if (origQuery) {
      navigator.permissions.query = (params) => {
        if (params.name === 'notifications') {
          return Promise.resolve({ state: 'prompt', onchange: null });
        }
        return origQuery.call(navigator.permissions, params);
      };
    }

  }, fp);

  await page.setUserAgent(userAgent);

  return { browser, page };
}

/**
 * Authenticate a page with proxy credentials via Puppeteer's request interception.
 * Call BEFORE any page.goto().
 *
 * @param {import('puppeteer').Page} page
 * @param {string} username
 * @param {string} password
 */
async function authenticateProxy(page, username, password) {
  await page.authenticate({ username, password });
}

module.exports = { launchBrowser, authenticateProxy };
