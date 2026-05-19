'use strict';

const fs = require('fs');
const path = require('path');

// ── Config file path ──────────────────────────────────────────────────────────
// When running as a pkg exe, write config.json next to the .exe
// When running as node, write config.json in the current working directory
function getConfigPath() {
  if (process.pkg) {
    return path.join(path.dirname(process.execPath), 'config.json');
  }
  return path.join(process.cwd(), 'config.json');
}

// ── Region map ────────────────────────────────────────────────────────────────
const REGION_MAP = {
  canada: {
    domain: 'ca',
    locale: 'en-CA',
    country: 'Canada',
    countryCode: 'CA',
    smallCountryCode: 'ca',
    appSyncUrl: 'https://hiring.amazon.ca/graphql',
  },
  usa: {
    domain: 'com',
    locale: 'en-US',
    country: 'USA',
    countryCode: 'US',
    smallCountryCode: 'us',
    appSyncUrl: 'https://e5mquma77feepi2bdn4d6h3mpu.appsync-api.us-east-1.amazonaws.com/graphql',
  },
  uk: {
    domain: 'co.uk',
    locale: 'en-GB',
    country: 'UK',
    countryCode: 'GB',
    smallCountryCode: 'uk',
    appSyncUrl: 'https://hiring.amazon.co.uk/graphql',
  },
};

// ── State singleton ───────────────────────────────────────────────────────────
const state = {
  // Credentials (never persisted)
  email: null,
  pin: null,
  accessToken: null,
  userID: null,
  userSFId: null,
  fullName: null,
  lastHeaders: null,

  // Job config (persisted)
  jobId: null,
  region: 'canada',
  sniperIntervalMs: 200,
  isProduction: false,
  testMode: false,
  stopWorkflow: false,
  stopWorkflowStep: 'bgc',

  // Derived from region (defaults match 'canada')
  domain: 'ca',
  locale: 'en-CA',
  country: 'Canada',
  countryCode: 'CA',
  smallCountryCode: 'ca',
  appSyncUrl: 'https://hiring.amazon.ca/graphql',

  // Runtime sniper state (never persisted)
  appId: null,
  sniperActive: false,
  locationCode: '1I28',
  stateCode: 'ON',
  employmentType: 'Regular',
  eventSource: 'HVH-CA-UI',
  browser: null,
  layer2Page: null,
  pollTimer: null,
};

// ── setRegion ─────────────────────────────────────────────────────────────────
function setRegion(r) {
  const mapping = REGION_MAP[r];
  if (!mapping) {
    throw new Error(`Unknown region: ${r}. Must be 'canada', 'usa', or 'uk'.`);
  }
  state.region = r;
  state.domain = mapping.domain;
  state.locale = mapping.locale;
  state.country = mapping.country;
  state.countryCode = mapping.countryCode;
  state.smallCountryCode = mapping.smallCountryCode;
  state.appSyncUrl = mapping.appSyncUrl;
}

// ── loadConfig ────────────────────────────────────────────────────────────────
function loadConfig() {
  const configPath = getConfigPath();
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);

    // Merge only persisted fields
    if (parsed.jobId !== undefined) state.jobId = parsed.jobId;
    if (parsed.sniperIntervalMs !== undefined) state.sniperIntervalMs = parsed.sniperIntervalMs;
    if (parsed.isProduction !== undefined) state.isProduction = parsed.isProduction;

    // region triggers derived field update
    if (parsed.region !== undefined) {
      try {
        setRegion(parsed.region);
      } catch (_) {
        // ignore unknown region in file, keep default
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[config] Could not read config.json:', err.message);
    }
    // First run — file doesn't exist yet, use defaults
  }
}

// ── saveConfig ────────────────────────────────────────────────────────────────
function saveConfig() {
  const configPath = getConfigPath();
  const data = {
    jobId: state.jobId,
    region: state.region,
    sniperIntervalMs: state.sniperIntervalMs,
    isProduction: state.isProduction,
  };
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[config] Could not write config.json:', err.message);
  }
}

module.exports = { state, loadConfig, saveConfig, setRegion, getConfigPath, REGION_MAP };
