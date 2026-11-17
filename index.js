import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { connectDb } from './db.js';
import { isGoogleConfigured } from './google.js';
import { updateSettings } from './models/Settings.js';
import { recoverInterrupted, sweepOrphans, tick } from './processor.js';

const HEARTBEAT_INTERVAL = 15_000;
const SWEEP_INTERVAL = 60 * 60 * 1000;

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);
const logError = (message, err) => console.error(`${new Date().toISOString()} ${message}:`, err);

async function heartbeat() {
  try {
    await updateSettings({ botHeartbeatAt: new Date() });
  } catch (err) {
    logError('Heartbeat failed', err);
  }
}

async function main() {
  if (!isGoogleConfigured()) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in bot/.env (see bot/.env.example).');
  }
  await connectDb();
  await recoverInterrupted(log);

  // Runs on its own timer so a long upload doesn't make the site report the bot as offline.
  await heartbeat();
  setInterval(heartbeat, HEARTBEAT_INTERVAL);

  log(`Bot started: checking every ${config.botPollSeconds}s, ${config.botConcurrency} upload(s) at a time`);
  let lastSweep = 0;
  for (;;) {
    try {
      await tick({ log });
    } catch (err) {
      logError('Tick failed', err);
    }
    if (Date.now() - lastSweep > SWEEP_INTERVAL) {
      lastSweep = Date.now();
      try {
        await sweepOrphans({ log });
      } catch (err) {
        logError('Orphan sweep failed', err);
      }
    }
    await sleep(config.botPollSeconds * 1000);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => process.exit(0));
}

main().catch((err) => {
  // pm2 restarts the process, which covers MongoDB being down at boot.
  logError('Bot failed to start', err);
  process.exit(1);
});
