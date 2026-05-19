'use strict';

const inquirer = require('inquirer');
const fetch = require('node-fetch');
const { state, setRegion, saveConfig } = require('./config');

// ── Task 5.1 helpers ──────────────────────────────────────────────────────────

const JOB_ID_PATTERN = /^JOB-[A-Z]{2}-\d+$/;

/**
 * Returns true if the given id matches the Job ID pattern.
 * Exported for unit/property tests.
 * @param {string} id
 * @returns {boolean}
 */
function validateJobId(id) {
  return typeof id === 'string' && JOB_ID_PATTERN.test(id);
}

/**
 * Prompts the user for Job ID and region via inquirer.
 * Re-prompts on invalid Job ID.
 * Calls setRegion(), stores state.jobId, calls saveConfig().
 * @returns {Promise<{ jobId: string, region: string }>}
 */
async function promptJobConfig() {
  const REGION_CHOICES = [
    { name: 'Canada', value: 'canada' },
    { name: 'USA', value: 'usa' },
    { name: 'United Kingdom', value: 'uk' },
  ];

  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'jobId',
      message: 'Job ID (e.g. JOB-AB-12345):',
      validate(val) {
        return validateJobId(val) || 'Invalid Job ID. Must match JOB-XX-#### (e.g. JOB-AB-12345).';
      },
    },
    {
      type: 'list',
      name: 'region',
      message: 'Select region:',
      choices: REGION_CHOICES,
    },
  ]);

  setRegion(answers.region);
  state.jobId = answers.jobId;
  saveConfig();

  return { jobId: state.jobId, region: state.region };
}

// ── Task 5.3 helpers ──────────────────────────────────────────────────────────

/**
 * Extracts the application ID from a ds/create-application response body.
 * Priority: data.applicationId → errorMetadata.applicationId → data.existingApplicationId
 * Exported for unit/property tests.
 * @param {object} responseData
 * @returns {string|null}
 */
function extractAppId(responseData) {
  if (!responseData || typeof responseData !== 'object') return null;

  const fromData = responseData.data && responseData.data.applicationId;
  if (fromData) return fromData;

  const fromErrorMeta = responseData.errorMetadata && responseData.errorMetadata.applicationId;
  if (fromErrorMeta) return fromErrorMeta;

  const fromExisting = responseData.data && responseData.data.existingApplicationId;
  if (fromExisting) return fromExisting;

  return null;
}

/**
 * POSTs to ds/create-application to obtain an application ID.
 * Stores result in state.appId and logs to console.
 * @param {string} jobId
 * @returns {Promise<string|null>}
 */
async function preCreateApplication(jobId) {
  const url = `https://hiring.amazon.${state.domain}/application/api/candidate-application/ds/create-application/`;

  const body = JSON.stringify({
    jobId,
    dspEnabled: true,
    scheduleId: null,
    candidateId: state.userID,
    activeApplicationCheckEnabled: false,
  });

  const headers = {
    authorization: state.accessToken,
    'content-type': 'application/json;charset=UTF-8',
    'bb-ui-version': 'bb-ui-v2',
    accept: 'application/json, text/plain, */*',
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
    });

    const data = await response.json();
    const appId = extractAppId(data);

    if (appId) {
      state.appId = appId;
      console.log('[setup] Application ID:', appId);
    } else {
      console.warn('[setup] preCreateApplication: no appId found in response', JSON.stringify(data));
    }

    return appId || null;
  } catch (err) {
    console.error('[setup] preCreateApplication failed:', err.message);
    return null;
  }
}

// ── Task 5.5 ──────────────────────────────────────────────────────────────────

/**
 * Advances the application to the select-schedule workflow step.
 * Step 1: PUT /update-application with job-confirm type
 * Step 2: PUT /update-workflow-step-name with select-schedule
 * @param {string} appId
 * @param {string} jobId
 * @returns {Promise<void>}
 */
async function advanceToSelectSchedule(appId, jobId) {
  const baseUrl = `https://hiring.amazon.${state.domain}/application/api/candidate-application`;

  const headers = {
    authorization: state.accessToken,
    'content-type': 'application/json;charset=UTF-8',
    'bb-ui-version': 'bb-ui-v2',
    accept: 'application/json, text/plain, */*',
  };

  // Step 1: clear scheduleId
  try {
    const step1Body = JSON.stringify({
      applicationId: appId,
      jobId,
      scheduleId: null,
    });

    const res1 = await fetch(`${baseUrl}/update-application`, {
      method: 'PUT',
      headers,
      body: step1Body,
    });

    const data1 = await res1.json().catch(() => ({}));
    console.log('[setup] update-application (scheduleId: null):', JSON.stringify(data1));
  } catch (err) {
    console.error('[setup] advanceToSelectSchedule step 1 failed:', err.message);
  }

  // Step 2: set workflow step to select-schedule
  try {
    const step2Body = JSON.stringify({
      applicationId: appId,
      workflowStepName: 'select-schedule',
    });

    const res2 = await fetch(`${baseUrl}/update-workflow-step-name`, {
      method: 'PUT',
      headers,
      body: step2Body,
    });

    const data2 = await res2.json().catch(() => ({}));
    console.log('[setup] update-workflow-step-name (select-schedule):', JSON.stringify(data2));
  } catch (err) {
    console.error('[setup] advanceToSelectSchedule step 2 failed:', err.message);
  }
}

module.exports = {
  promptJobConfig,
  preCreateApplication,
  advanceToSelectSchedule,
  validateJobId,
  extractAppId,
};
