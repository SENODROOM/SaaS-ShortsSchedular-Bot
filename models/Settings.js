import crypto from 'node:crypto';
import mongoose from 'mongoose';

const SETTINGS_ID = 'platform';

// The bot's copy of the backend's `settings` document (backend/models/Settings.js). Keep the two
// in step: it is one document for the whole site, shared by the backend and the bot.
const settingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: SETTINGS_ID },
    driveTokens: { type: mongoose.Schema.Types.Mixed, default: null },
    driveAccount: { type: mongoose.Schema.Types.Mixed, default: null },
    driveFolderId: { type: String, default: null },
    driveAuthError: { type: String, default: null },
    quotaPausedUntil: { type: Date, default: null },
    quotaError: { type: String, default: null },
    instanceId: { type: String, default: null },
    botHeartbeatAt: { type: Date, default: null },
  },
  { minimize: false },
);

export const Settings = mongoose.model('Settings', settingsSchema);

export async function getSettings() {
  return (await Settings.findById(SETTINGS_ID).lean()) || {};
}

export async function updateSettings(fields) {
  await Settings.updateOne({ _id: SETTINGS_ID }, { $set: fields }, { upsert: true });
}

export async function getInstanceId() {
  const existing = (await getSettings()).instanceId;
  if (existing) return existing;
  try {
    await Settings.updateOne(
      { _id: SETTINGS_ID, instanceId: null },
      { $set: { instanceId: crypto.randomUUID() } },
      { upsert: true },
    );
  } catch (err) {
    // Another process set it first, so the filter missed and the upsert hit the existing document.
    if (err.code !== 11000) throw err;
  }
  return (await getSettings()).instanceId;
}
