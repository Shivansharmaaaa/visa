'use strict';

const { state, loadConfig } = require('./config');
const { promptCredentials, login } = require('./login');
const { promptJobConfig, preCreateApplication, advanceToSelectSchedule } = require('./setup');
const { startSniper, stopSniper } = require('./sniper');
const { bookSchedule } = require('./booking');
const { runWorkflowWebSocket } = require('./workflow');
const { playAlert } = require('./audio');

async function main() {
  console.log('=== Amazon Hiring Shift Sniper ===');

  // 1. Load persisted config (jobId, region, interval, isProduction)
  loadConfig();

  // 2. Prompt for credentials
  const { email, pin } = await promptCredentials();

  // 3. Launch browser, login, capture token + candidateId
  console.log('[bot] Opening browser for login...');
  await login(email, pin);
  console.log(`[bot] Logged in. UserID: ${state.userID}`);

  // 4. Prompt for Job ID and region, pre-create application
  await promptJobConfig();
  console.log(`[bot] Job: ${state.jobId} | Region: ${state.region} | Domain: ${state.domain}`);

  const appId = await preCreateApplication(state.jobId);
  if (!appId) {
    console.error('[bot] Failed to create application. Exiting.');
    process.exit(1);
  }
  console.log(`[bot] AppID: ${appId}`);

  // 5. Advance application to select-schedule step
  await advanceToSelectSchedule(appId, state.jobId);

  // 6. Start sniper — opens Layer 2 page and begins polling
  console.log(`[bot] Starting sniper at ${state.sniperIntervalMs}ms interval...`);
  await startSniper(onScheduleFound);
}

/**
 * Called when a schedule is detected — either from the Layer 2 page response
 * or from the poll loop.
 * @param {string} scheduleId
 * @param {string} jobId
 * @param {Array} scheduleCards
 */
async function onScheduleFound(scheduleId, jobId, scheduleCards) {
  console.log(`[bot] SCHEDULE FOUND! scheduleId=${scheduleId}, jobId=${jobId}`);

  // Stop polling immediately
  await stopSniper();

  if (!state.isProduction) {
    console.log('[bot] Monitor mode — shift detected but isProduction=false. Enable to book.');
    await playAlert();
    return;
  }

  // Book the shift
  const result = await bookSchedule(scheduleId, jobId, scheduleCards);

  if (result.success) {
    console.log(`[bot] Booked in ${result.durationMs}ms!`);
    await playAlert();
    // Complete the post-booking workflow
    await runWorkflowWebSocket(state.appId, result.scheduleId, jobId);
  } else {
    console.log('[bot] Booking failed — resuming sniper...');
    // Re-start sniper to keep trying
    await startSniper(onScheduleFound);
  }
}

main().catch((err) => {
  console.error('[bot] Fatal error:', err);
  process.exit(1);
});
