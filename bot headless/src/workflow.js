'use strict';

const WebSocket = require('ws');
const fetch = require('node-fetch');
const { state } = require('./config');

// ── Constants ─────────────────────────────────────────────────────────────────

const WS_ENDPOINT = 'wss://ufatez9oyf.execute-api.us-east-1.amazonaws.com/prod';
const BASE_URL = () =>
  `https://hiring.amazon.${state.domain}/application/api/candidate-application`;

// ── Auth headers ──────────────────────────────────────────────────────────────

function _authHeaders(accessToken) {
  return {
    authorization: accessToken,
    'content-type': 'application/json;charset=UTF-8',
    'bb-ui-version': 'bb-ui-v2',
    accept: 'application/json, text/plain, */*',
  };
}

// ── Task 9.1 — WebSocket URL builder ─────────────────────────────────────────

/**
 * Builds the WebSocket URL with URL-encoded query parameters.
 * @param {string} appId
 * @param {string} candidateId
 * @param {string} token
 * @returns {string}
 */
function buildWsUrl(appId, candidateId, token) {
  return (
    `${WS_ENDPOINT}` +
    `?applicationId=${encodeURIComponent(appId)}` +
    `&candidateId=${encodeURIComponent(candidateId)}` +
    `&authToken=${encodeURIComponent(token)}`
  );
}

// ── Task 9.3 — startWorkflow message builder ──────────────────────────────────

/**
 * Builds the startWorkflow WebSocket message object.
 * @param {object} ctx  WorkflowContext
 * @returns {object}
 */
function buildStartWorkflowMsg(ctx) {
  return {
    action: 'startWorkflow',
    applicationId: ctx.applicationId,
    candidateId: ctx.candidateId,
    jobId: ctx.jobId,
    scheduleId: ctx.scheduleId,
    isCsDomain: true,
    partitionAttributes: { countryCodes: [state.countryCode] },
    filteringSeasonal: false,
    filteringRegular: false,
  };
}

// ── Task 9.5 — mainScenario REST step functions ───────────────────────────────

async function getCandidateInfo(ctx) {
  console.log('[workflow] getCandidateInfo: fetching candidate info');
  const res = await fetch(`${BASE_URL()}/candidate`, {
    method: 'GET',
    headers: _authHeaders(ctx.accessToken),
  });
  if (!res.ok) throw new Error(`getCandidateInfo: HTTP ${res.status}`);
  const data = await res.json();
  ctx.candidate = data.data;
  ctx.eventSource = ctx.candidate && ctx.candidate.eventSource;
  console.log('[workflow] getCandidateInfo: done', ctx.candidate);
  return ctx;
}

async function updateStepBGC(ctx) {
  console.log('[workflow] updateStepBGC');
  const res = await fetch(`${BASE_URL()}/update-workflow-step-name`, {
    method: 'PUT',
    headers: _authHeaders(ctx.accessToken),
    body: JSON.stringify({ applicationId: ctx.applicationId, workflowStepName: 'bgc' }),
  });
  if (!res.ok) throw new Error(`updateStepBGC: HTTP ${res.status}`);
  ctx.bgc = (await res.json()).data;
  return ctx;
}

async function updateSocketBGC(ctx) {
  return updateSocketStep(ctx, 'bgc');
}

async function refreshCandidateInfo(ctx) {
  console.log('[workflow] refreshCandidateInfo');
  const res = await fetch(`${BASE_URL()}/candidate`, {
    method: 'GET',
    headers: _authHeaders(ctx.accessToken),
  });
  if (!res.ok) throw new Error(`refreshCandidateInfo: HTTP ${res.status}`);
  const data = await res.json();
  ctx.candidate = data.data;
  return ctx;
}

async function additionalBgcInfo(ctx) {
  console.log('[workflow] additionalBgcInfo');
  const res = await fetch(`${BASE_URL()}/update-application`, {
    method: 'PUT',
    headers: _authHeaders(ctx.accessToken),
    body: JSON.stringify({
      applicationId: ctx.applicationId,
      payload: { candidate: ctx.candidate },
      type: 'additional-bgc-info',
      dspEnabled: true,
    }),
  });
  ctx.bgcInfo = (await res.json()).data;
  return ctx;
}

async function updateSocketBGCInfo(ctx) {
  return updateSocketStep(ctx, 'additional-bgc-info');
}

async function updateStepNHE(ctx) {
  console.log('[workflow] updateStepNHE');
  const res = await fetch(`${BASE_URL()}/update-workflow-step-name`, {
    method: 'PUT',
    headers: _authHeaders(ctx.accessToken),
    body: JSON.stringify({ applicationId: ctx.applicationId, workflowStepName: 'nhe' }),
  });
  if (!res.ok) throw new Error(`updateStepNHE: HTTP ${res.status}`);
  ctx.nhe = await res.json();
  return ctx;
}

async function getAvailableTimeSlotsNew(ctx) {
  console.log('[workflow] getAvailableTimeSlotsNew');
  const res = await fetch(
    `https://hiring.amazon.${state.domain}/application/api/nhe/available-time-slots`,
    {
      method: 'POST',
      headers: _authHeaders(ctx.accessToken),
      body: JSON.stringify({
        locationCode: ctx.locationCode,
        applicationId: ctx.applicationId,
        locale: ctx.locale,
      }),
    }
  );
  const data = await res.json();
  ctx.timeSlots = data.data;
  console.log('[workflow] getAvailableTimeSlotsNew: slots', ctx.timeSlots);
  return ctx;
}

async function updateSocketNHE(ctx) {
  return updateSocketStep(ctx, 'nhe');
}

async function setTimeSlotForApplication(ctx) {
  console.log('[workflow] setTimeSlotForApplication');
  if (!Array.isArray(ctx.timeSlots) || ctx.timeSlots.length === 0) {
    throw new Error('No available time slots in ctx.timeSlots');
  }
  const res = await fetch(`${BASE_URL()}/update-application`, {
    method: 'PUT',
    headers: _authHeaders(ctx.accessToken),
    body: JSON.stringify({
      applicationId: ctx.applicationId,
      payload: { nheAppointment: ctx.timeSlots[0] },
      type: 'nhe',
      dspEnabled: true,
    }),
  });
  ctx.timeSlotsResponse = (await res.json()).data;
  return ctx;
}

async function updateStepReviewSubmit(ctx) {
  console.log('[workflow] updateStepReviewSubmit');
  const res = await fetch(`${BASE_URL()}/update-workflow-step-name`, {
    method: 'PUT',
    headers: _authHeaders(ctx.accessToken),
    body: JSON.stringify({ applicationId: ctx.applicationId, workflowStepName: 'review-submit' }),
  });
  if (!res.ok) throw new Error(`updateStepReviewSubmit: HTTP ${res.status}`);
  ctx.review = await res.json();
  return ctx;
}

async function updateSocketReviewSubmit(ctx) {
  return updateSocketStep(ctx, 'review-submit');
}

async function updateStepThankYou(ctx) {
  console.log('[workflow] updateStepThankYou');
  const res = await fetch(`${BASE_URL()}/update-workflow-step-name`, {
    method: 'PUT',
    headers: _authHeaders(ctx.accessToken),
    body: JSON.stringify({ applicationId: ctx.applicationId, workflowStepName: 'thank-you' }),
  });
  if (!res.ok) throw new Error(`updateStepThankYou: HTTP ${res.status}`);
  ctx.thankYou = await res.json();
  return ctx;
}

async function updateSocketThankYou(ctx) {
  return updateSocketStep(ctx, 'thank-you');
}

// ── Socket step helper ────────────────────────────────────────────────────────

/**
 * Sends a completeTask message for the given stepName and waits for the next
 * WS message (20s timeout).
 * @param {object} ctx
 * @param {string} stepName
 * @returns {Promise<object>} updated ctx
 */
async function updateSocketStep(ctx, stepName) {
  const {
    socket,
    applicationId,
    candidateId,
    jobId,
    currentTime,
    stateCode,
    eventSource,
    employmentType,
  } = ctx;

  console.log(`[workflow] updateSocketStep(${stepName})`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeListener('message', onMessage);
      reject(new Error(`updateSocketStep(${stepName}): timeout after 20s`));
    }, 20000);

    function onMessage(data) {
      let msg;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }
      if (msg.stepName && msg.stepName !== stepName) {
        clearTimeout(timer);
        socket.removeListener('message', onMessage);
        ctx.socketResponse = msg;
        resolve(ctx);
      }
    }

    socket.on('message', onMessage);

    const payload = {
      action: 'completeTask',
      applicationId,
      candidateId,
      requisitionId: '',
      jobId,
      state: stateCode,
      employmentType,
      eventSource,
      jobSelectedOn: currentTime,
      currentWorkflowStep: stepName,
      isCsDomain: true,
      workflowStepName: '',
      partitionAttributes: { countryCodes: [state.countryCode] },
      filteringSeasonal: false,
      filteringRegular: false,
    };

    socket.send(JSON.stringify(payload));
  });
}

// ── Task 9.9 — mainScenario ───────────────────────────────────────────────────

const SCENARIO_STEPS = [
  getCandidateInfo,
  updateStepBGC,
  updateSocketBGC,
  refreshCandidateInfo,
  additionalBgcInfo,
  updateSocketBGCInfo,
  updateStepNHE,
  getAvailableTimeSlotsNew,
  updateSocketNHE,
  setTimeSlotForApplication,
  updateStepReviewSubmit,
  updateSocketReviewSubmit,
  updateStepThankYou,
  updateSocketThankYou,
];

async function runScenario(steps, initialCtx) {
  let ctx = initialCtx;
  for (const step of steps) {
    ctx = await step(ctx);
  }
  return ctx;
}

/**
 * Chains all 14 step functions sequentially.
 * After completion, navigates state.layer2Page to the resume-application URL.
 * @param {object} ctx  WorkflowContext
 * @returns {Promise<object>} final ctx
 */
async function mainScenario(ctx) {
  try {
    const result = await runScenario(SCENARIO_STEPS, ctx);
    console.log('[workflow] mainScenario complete');

    if (state.layer2Page) {
      const { applicationId, jobId } = ctx;
      const resumeUrl =
        `https://hiring.amazon.${state.domain}/application/${state.smallCountryCode}/` +
        `?applicationId=${applicationId}&jobId=${jobId}` +
        `#/resume-application?applicationId=${applicationId}&jobId=${jobId}`;
      await state.layer2Page.goto(resumeUrl).catch(err =>
        console.warn('[workflow] navigate to resume-application failed:', err.message)
      );
    }

    return result;
  } catch (err) {
    console.error('[workflow] mainScenario failed:', err);
    return ctx;
  }
}

// ── Task 9.8 — runWorkflowWebSocket ──────────────────────────────────────────

/**
 * Opens a WebSocket connection, sends startWorkflow, and handles step messages.
 * Resolves when the socket closes.
 * @param {string} appId
 * @param {string} scheduleId
 * @param {string} jobId
 * @returns {Promise<void>}
 */
function runWorkflowWebSocket(appId, scheduleId, jobId) {
  return new Promise((resolve) => {
    const candidateId = state.userID;
    const accessToken = state.accessToken;
    const currentTime = new Date().toISOString();

    const url = buildWsUrl(appId, candidateId, accessToken);
    const ws = new WebSocket(url);

    let closed = false;

    function safeClose() {
      if (!closed) {
        closed = true;
        ws.close();
      }
    }

    function navigateResume() {
      if (state.layer2Page) {
        const resumeUrl =
          `https://hiring.amazon.${state.domain}/application/${state.smallCountryCode}/` +
          `?applicationId=${appId}&jobId=${jobId}` +
          `#/resume-application?applicationId=${appId}&jobId=${jobId}`;
        state.layer2Page.goto(resumeUrl).catch(err =>
          console.warn('[workflow] navigate to resume-application failed:', err.message)
        );
      }
    }

    // 8-second fallback timeout
    const fallbackTimer = setTimeout(() => {
      console.warn('[workflow] WebSocket 8s timeout — force closing');
      safeClose();
      navigateResume();
    }, 8000);

    ws.on('open', () => {
      console.log('[workflow] WS opened — sending startWorkflow');
      const ctx = { applicationId: appId, candidateId, jobId, scheduleId };
      ws.send(JSON.stringify(buildStartWorkflowMsg(ctx)));
    });

    ws.on('message', (data) => {
      let response;
      try {
        response = JSON.parse(typeof data === 'string' ? data : data.toString());
      } catch {
        return;
      }
      console.log('[workflow] WS message:', response);

      const stepName = response.stepName;

      if (stepName === 'job-opportunities') {
        ws.send(JSON.stringify({
          action: 'completeTask',
          applicationId: appId,
          candidateId,
          requisitionId: '',
          jobId,
          state: state.stateCode,
          employmentType: state.employmentType,
          eventSource: state.eventSource,
          jobSelectedOn: currentTime,
          currentWorkflowStep: 'job-opportunities',
          isCsDomain: true,
          workflowStepName: '',
          partitionAttributes: { countryCodes: [state.countryCode] },
          filteringSeasonal: false,
          filteringRegular: false,
        }));
        safeClose();
        return;
      }

      if (stepName === 'bgc') {
        clearTimeout(fallbackTimer);
        const ctx = {
          socket: ws,
          applicationId: appId,
          candidateId,
          jobId,
          scheduleId,
          accessToken,
          currentTime,
          stateCode: state.stateCode,
          locale: state.locale,
          locationCode: state.locationCode,
          employmentType: state.employmentType,
          eventSource: state.eventSource,
        };
        mainScenario(ctx).then(() => {
          safeClose();
          navigateResume();
        }).catch(err => {
          console.error('[workflow] mainScenario error:', err);
          safeClose();
          navigateResume();
        });
        return;
      }

      if (stepName === 'workflow-failed' || stepName === 'duplicate-window') {
        console.log(`[workflow] WS terminal step: ${stepName}`);
        safeClose();
        return;
      }

      // All other steps — send completeTask
      if (stepName) {
        ws.send(JSON.stringify({
          action: 'completeTask',
          applicationId: appId,
          candidateId,
          requisitionId: '',
          jobId,
          state: state.stateCode,
          employmentType: state.employmentType,
          eventSource: state.eventSource,
          jobSelectedOn: currentTime,
          currentWorkflowStep: stepName,
          isCsDomain: true,
          workflowStepName: '',
          partitionAttributes: { countryCodes: [state.countryCode] },
          filteringSeasonal: false,
          filteringRegular: false,
        }));
      }
    });

    ws.on('close', () => {
      clearTimeout(fallbackTimer);
      closed = true;
      console.log('[workflow] WS closed');
      resolve();
    });

    ws.on('error', (err) => {
      console.error('[workflow] WS error:', err.message);
    });
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  buildWsUrl,
  buildStartWorkflowMsg,
  runWorkflowWebSocket,
  mainScenario,
  // Step functions exported for testing
  getCandidateInfo,
  updateStepBGC,
  updateSocketBGC,
  refreshCandidateInfo,
  additionalBgcInfo,
  updateSocketBGCInfo,
  updateStepNHE,
  getAvailableTimeSlotsNew,
  updateSocketNHE,
  setTimeSlotForApplication,
  updateStepReviewSubmit,
  updateSocketReviewSubmit,
  updateStepThankYou,
  updateSocketThankYou,
  updateSocketStep,
  SCENARIO_STEPS,
};
