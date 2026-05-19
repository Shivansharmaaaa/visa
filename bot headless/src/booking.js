'use strict';

const fetch = require('node-fetch');
const { state } = require('./config');

// ── Strategy A ────────────────────────────────────────────────────────────────

/**
 * Strategy A — POST ds/update-application
 * @param {string} scheduleId
 * @param {string} jobId
 * @param {string} appId
 * @returns {Promise<object|null>}
 */
async function strategyA(scheduleId, jobId, appId) {
  const url = `https://hiring.amazon.${state.domain}/application/api/candidate-application/ds/update-application/`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: _bookingHeaders(),
      body: JSON.stringify({
        applicationId: appId,
        scheduleId,
        jobId,
        locale: state.locale,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('[booking] strategyA error:', err.message);
    return null;
  }
}

// ── Strategy B ────────────────────────────────────────────────────────────────

/**
 * Strategy B — PUT update-application with job-confirm type
 * @param {string} scheduleId
 * @param {string} jobId
 * @param {string} appId
 * @returns {Promise<object|null>}
 */
async function strategyB(scheduleId, jobId, appId) {
  const url = `https://hiring.amazon.${state.domain}/application/api/candidate-application/update-application`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: _bookingHeaders(),
      body: JSON.stringify({
        applicationId: appId,
        dspEnabled: true,
        isCsRequest: true,
        payload: { jobId, scheduleId },
        type: 'job-confirm',
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('[booking] strategyB error:', err.message);
    return null;
  }
}

// ── Success detector ──────────────────────────────────────────────────────────

/**
 * Returns true iff at least one response is non-null and has no errorCode.
 * @param {object|null} responseA
 * @param {object|null} responseB
 * @returns {boolean}
 */
function isBookingSuccess(responseA, responseB) {
  const responses = [responseA, responseB];
  return responses.some(r => r != null && !r.errorCode);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _bookingHeaders() {
  return {
    authorization: state.accessToken,
    'content-type': 'application/json;charset=UTF-8',
    'bb-ui-version': 'bb-ui-v2',
    accept: 'application/json, text/plain, */*',
    origin: `https://hiring.amazon.${state.domain}`,
  };
}

// ── bookSchedule ──────────────────────────────────────────────────────────────

/**
 * Fires Strategy A and B in parallel for each scheduleId in the queue.
 * Falls through to the next schedule on SELECTED_SCHEDULE_NOT_AVAILABLE.
 * @param {string} scheduleId  — primary schedule to try first
 * @param {string} jobId
 * @param {Array<{scheduleId: string}>} scheduleCards — fallback cards
 * @returns {Promise<{ success: true, durationMs: number, scheduleId: string } | { success: false }>}
 */
async function bookSchedule(scheduleId, jobId, scheduleCards) {
  const startTime = Date.now();

  // Build ordered queue: primary first, then unique fallbacks
  const scheduleQueue = [
    scheduleId,
    ...(Array.isArray(scheduleCards) ? scheduleCards : [])
      .map(c => c.scheduleId)
      .filter(id => id && id !== scheduleId),
  ];

  const appId = state.appId;

  console.log(`[booking] STRIKE! Booking ${jobId} — ${scheduleQueue.length} schedule(s) queued`);

  for (const sid of scheduleQueue) {
    console.log(`[booking] Trying scheduleId: ${sid}`);

    const [resA, resB] = await Promise.all([
      strategyA(sid, jobId, appId),
      strategyB(sid, jobId, appId),
    ]);

    if (isBookingSuccess(resA, resB)) {
      const durationMs = Date.now() - startTime;
      console.log(`[booking] SUCCESS! Shift locked in ${durationMs}ms`);
      return { success: true, durationMs, scheduleId: sid };
    }

    // Check if both strategies returned SELECTED_SCHEDULE_NOT_AVAILABLE
    const errorCodes = [resA, resB].map(d => d && d.errorCode).filter(Boolean);
    const allUnavailable =
      errorCodes.length > 0 &&
      errorCodes.every(e => e === 'SELECTED_SCHEDULE_NOT_AVAILABLE');

    const isLast = sid === scheduleQueue[scheduleQueue.length - 1];

    if (allUnavailable && !isLast) {
      console.log(`[booking] Schedule ${sid} unavailable — trying next...`);
      continue;
    }

    const durationMs = Date.now() - startTime;
    console.log(`[booking] Booking failed: ${errorCodes.join(', ') || 'Unknown'} (${durationMs}ms)`);
    break;
  }

  return { success: false };
}

module.exports = { bookSchedule, isBookingSuccess, strategyA, strategyB };
