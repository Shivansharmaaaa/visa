'use strict';

const fetch = require('node-fetch');
const { state } = require('./config');
const { preCreateApplication, advanceToSelectSchedule } = require('./setup');

// ── Task 6.1 — buildScheduleSearchBody ───────────────────────────────────────

/**
 * Constructs the searchScheduleCards GraphQL request body.
 * @param {string} jobId
 * @returns {string} JSON string
 */
function buildScheduleSearchBody(jobId) {
  const today = new Date().toISOString().split('T')[0];

  return JSON.stringify({
    operationName: 'searchScheduleCards',
    variables: {
      searchScheduleRequest: {
        jobId,
        locale: state.locale,
        country: state.country,
        keyWords: '',
        equalFilters: [],
        containFilters: [
          { key: 'isPrivateSchedule', val: ['false'] },
          { key: 'scheduleShift', val: [] },
        ],
        rangeFilters: [],
        orFilters: [],
        dateFilters: [
          {
            key: 'firstDayOnSite',
            range: { startDate: today },
          },
        ],
        excludeFilters: [],
        sorters: [{ fieldName: 'totalPayRateMax', ascending: 'false' }],
        pageSize: 100,
        consolidateSchedule: true,
      },
    },
    query: `query searchScheduleCards($searchScheduleRequest: SearchScheduleRequest!) {
        searchScheduleCards(searchScheduleRequest: $searchScheduleRequest) {
            nextToken
            scheduleCards {
                hireStartDate address basePay bonusSchedule city currencyCode dataSource
                distance employmentType externalJobTitle featuredSchedule firstDayOnSite
                hoursPerWeek image jobId jobPreviewVideo language postalCode priorityRank
                scheduleBannerText scheduleId scheduleText scheduleType signOnBonus state
                surgePay tagLine geoClusterId geoClusterName siteId scheduleBusinessCategory
                totalPayRate financeWeekStartDate laborDemandAvailableCount
                scheduleBusinessCategoryL10N firstDayOnSiteL10N financeWeekStartDateL10N
                scheduleTypeL10N employmentTypeL10N basePayL10N signOnBonusL10N
                totalPayRateL10N distanceL10N requiredLanguage monthlyBasePay
                monthlyBasePayL10N payFrequency vendorKamName vendorId vendorName
                kamPhone kamCorrespondenceEmail kamStreet kamCity kamDistrict kamState
                kamCountry kamPostalCode locationType __typename
            }
            __typename
        }
    }`,
  });
}

// ── Task 6.3 — buildLayer2Url ─────────────────────────────────────────────────

/**
 * Constructs the select-schedule Layer 2 URL.
 * @param {string} appId
 * @param {string} jobId
 * @returns {string}
 */
function buildLayer2Url(appId, jobId) {
  return (
    `https://hiring.amazon.${state.domain}/application/${state.smallCountryCode}/` +
    `?applicationId=${appId}&jobId=${jobId}` +
    `#/select-schedule?applicationId=${appId}&jobId=${jobId}`
  );
}

// ── Task 6.5 — classifyUrl ────────────────────────────────────────────────────

/**
 * Classifies a page URL as 'error', 'redirect', or 'normal'.
 * Error takes precedence over redirect.
 * @param {string} url
 * @returns {'error'|'redirect'|'normal'}
 */
function classifyUrl(url) {
  if (
    url.includes('error-404') ||
    url.includes('error-403') ||
    url.includes('/error?') ||
    url.includes('#/error')
  ) {
    return 'error';
  }
  if (url.includes('resume-application') || url.includes('no-available-shift')) {
    return 'redirect';
  }
  return 'normal';
}

// ── Task 6.7 — parseJobIds ────────────────────────────────────────────────────

/**
 * Splits a comma-separated job ID string into a trimmed, non-empty array.
 * @param {string} str
 * @returns {string[]}
 */
function parseJobIds(str) {
  if (!str) return [];
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ── Task 6.9 — shouldCaptureHeaders ──────────────────────────────────────────

/**
 * Returns true if the request is a schedule search GraphQL call whose headers
 * should be captured for use in the poll loop.
 * @param {string} url
 * @param {string} bodyStr
 * @returns {boolean}
 */
function shouldCaptureHeaders(url, bodyStr) {
  if (!url.includes('graphql')) return false;
  try {
    const parsed = JSON.parse(bodyStr);
    const op = parsed && parsed.operationName;
    return op === 'searchScheduleCards' || op === 'searchJobCardsByLocation';
  } catch (_) {
    return false;
  }
}

// ── Task 6.11 — startSniper ───────────────────────────────────────────────────

/**
 * Opens the Layer 2 Puppeteer page, attaches request/response/navigation
 * handlers, and starts the poll loop.
 * @param {Function} onScheduleFound  Called with (scheduleId, jobId, cards)
 * @returns {Promise<void>}
 */
async function startSniper(onScheduleFound) {
  // Store callback so executePoll can reach it
  _onScheduleFoundRef = onScheduleFound;
  const browser = state.browser;
  const page = await browser.newPage();
  state.layer2Page = page;

  // Enable request interception so we can capture headers
  await page.setRequestInterception(true);

  // ── request handler ───────────────────────────────────────────────────────
  page.on('request', (req) => {
    const url = req.url();
    const postData = req.postData() || '';
    if (shouldCaptureHeaders(url, postData)) {
      state.lastHeaders = req.headers();
    }
    req.continue();
  });

  // ── response handler ──────────────────────────────────────────────────────
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('graphql')) return;

    let body;
    try {
      body = await res.json();
    } catch (_) {
      return;
    }

    const cards = _extractScheduleCards(body);
    if (cards && cards.length > 0 && state.sniperActive) {
      const card = cards[0];
      _applyCardState(card);
      onScheduleFound(card.scheduleId, card.jobId || state.jobId, cards);
    }
  });

  // ── framenavigated handler ────────────────────────────────────────────────
  page.on('framenavigated', async (frame) => {
    if (frame.url() !== page.url()) return;
    const url = frame.url();
    const classification = classifyUrl(url);

    if (classification === 'error') {
      console.log('[sniper] Error page detected, re-creating application…');
      state.appId = null;
      const newAppId = await preCreateApplication(state.jobId);
      if (newAppId) {
        await advanceToSelectSchedule(newAppId, state.jobId);
        await page.goto(buildLayer2Url(newAppId, state.jobId)).catch(() => {});
      }
    } else if (classification === 'redirect') {
      console.log('[sniper] Redirect page detected, resetting to select-schedule…');
      await _resetToSelectSchedule();
      await page
        .goto(buildLayer2Url(state.appId, state.jobId))
        .catch(() => {});
    }
  });

  // Navigate to Layer 2
  await page.goto(buildLayer2Url(state.appId, state.jobId));

  state.sniperActive = true;

  // Start poll loop
  state.pollTimer = setTimeout(executePoll, Math.max(state.sniperIntervalMs, 1));
}

// ── Task 6.13 / 6.14 — executePoll ───────────────────────────────────────────

/**
 * Fires one poll cycle: POST searchScheduleCards for each job ID.
 * Reschedules itself when done.
 */
async function executePoll() {
  if (!state.sniperActive) return;

  const jobIds = parseJobIds(state.jobId);

  for (const jobId of jobIds) {
    // Build headers from captured state — keep only the fields AppSync needs
    const raw = state.lastHeaders || {};
    const pollHeaders = {};
    if (raw.accesstoken) pollHeaders.accesstoken = raw.accesstoken;
    if (raw.authorization) pollHeaders.authorization = raw.authorization;
    if (raw.country) pollHeaders.country = raw.country;
    pollHeaders['content-type'] = 'application/json';

    const body = buildScheduleSearchBody(jobId);

    try {
      console.log(`[sniper] Polling for jobId=${jobId}…`);
      const res = await fetch(state.appSyncUrl, {
        method: 'POST',
        headers: pollHeaders,
        body,
      });

      const data = await res.json();
      const cards = _extractScheduleCards(data);

      if (cards && cards.length > 0 && state.sniperActive) {
        const card = cards[0];
        _applyCardState(card);
        // onScheduleFound is not directly accessible here; it is captured via
        // closure in the module-level variable set by startSniper.
        if (_onScheduleFoundRef) {
          _onScheduleFoundRef(card.scheduleId, card.jobId || jobId, cards);
        }
      }
    } catch (err) {
      console.error(`[sniper] Poll network error for jobId=${jobId}:`, err.message);
      // continue to next jobId
    }
  }

  // Reschedule
  if (state.sniperActive) {
    state.pollTimer = setTimeout(executePoll, Math.max(state.sniperIntervalMs, 1));
  }
}

// ── Task 6.17 — stopSniper ────────────────────────────────────────────────────

/**
 * Stops the sniper: deactivates flag, clears timer, closes Layer 2 page.
 * @returns {Promise<void>}
 */
async function stopSniper() {
  state.sniperActive = false;
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (state.layer2Page) {
    await state.layer2Page.close().catch(() => {});
    state.layer2Page = null;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Module-level reference so executePoll can call back. */
let _onScheduleFoundRef = null;

/**
 * Extracts scheduleCards array from a GraphQL response body.
 * @param {object} body
 * @returns {Array|null}
 */
function _extractScheduleCards(body) {
  try {
    return (
      body &&
      body.data &&
      body.data.searchScheduleCards &&
      body.data.searchScheduleCards.scheduleCards
    );
  } catch (_) {
    return null;
  }
}

/**
 * Updates state fields from a schedule card if the fields are present.
 * @param {object} card
 */
function _applyCardState(card) {
  if (card.state) state.stateCode = card.state;
  if (card.employmentType) state.employmentType = card.employmentType;
  if (card.siteId) state.locationCode = card.siteId;
}

/**
 * Resets the application to the select-schedule step via two PUT calls.
 * @returns {Promise<void>}
 */
async function _resetToSelectSchedule() {
  const baseUrl = `https://hiring.amazon.${state.domain}/application/api/candidate-application`;
  const headers = {
    authorization: state.accessToken,
    'content-type': 'application/json;charset=UTF-8',
    'bb-ui-version': 'bb-ui-v2',
    accept: 'application/json, text/plain, */*',
  };

  // Step 1: clear scheduleId
  try {
    await fetch(`${baseUrl}/update-application`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        applicationId: state.appId,
        dspEnabled: true,
        isCsRequest: true,
        payload: { jobId: state.jobId, scheduleId: null, scheduleDetails: null },
        type: 'job-confirm',
      }),
    });
  } catch (err) {
    console.error('[sniper] reset step 1 failed:', err.message);
  }

  // Step 2: set workflow step back to select-schedule
  try {
    await fetch(`${baseUrl}/update-workflow-step-name`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        applicationId: state.appId,
        workflowStepName: 'select-schedule',
      }),
    });
  } catch (err) {
    console.error('[sniper] reset step 2 failed:', err.message);
  }
}

module.exports = {
  startSniper,
  stopSniper,
  buildScheduleSearchBody,
  buildLayer2Url,
  classifyUrl,
  parseJobIds,
  shouldCaptureHeaders,
};
