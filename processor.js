import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import {
  authClientFor,
  callOptions,
  deleteFromDrive,
  getDrive,
  getYouTube,
  googleErrorMessage,
  googleErrorReasons,
  isAuthError,
  isStorageReady,
  isYouTubeReady,
  listStoredVideos,
} from './google.js';
import { getSettings, updateSettings } from './models/Settings.js';
import { STATUS, Short } from './models/Short.js';
import { User } from './models/User.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const MAX_ATTEMPTS = 5;
const RETRY_DELAYS = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR];
const QUOTA_RETRY_DELAY = HOUR;
const PROCESSING_CHECK_INTERVAL = MINUTE;
// After this long a video still in YouTube's pipeline is treated as accepted.
const PROCESSING_GIVE_UP_AFTER = 6 * HOUR;
const JOB_TIMEOUT = 2 * HOUR;
const CANCEL_GIVE_UP_AFTER = 10 * MINUTE;
// An upload the browser never scheduled is left this long before the sweep deletes it.
export const ORPHAN_GRACE = 3 * HOUR;

const QUOTA_REASONS = new Set([
  'quotaExceeded',
  'dailyLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'uploadLimitExceeded',
  'downloadQuotaExceeded',
]);
// The Google Cloud project is out of quota. Every user shares it, so everyone's uploads pause,
// instead of each failing in turn. uploadLimitExceeded is a single channel's limit and isn't here.
const PROJECT_QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded']);
const REJECTED_UPLOAD_STATES = new Set(['failed', 'rejected', 'deleted']);

function classify(err) {
  if (isAuthError(err)) return 'auth';
  if (err?.status === 429 || googleErrorReasons(err).some((r) => QUOTA_REASONS.has(r))) return 'quota';
  // Client errors won't fix themselves. Everything else is network, timeout or a 5xx.
  if (err?.status >= 400 && err?.status < 500 && ![401, 408].includes(err.status)) return 'permanent';
  return 'transient';
}

// Notes which sign-in a failure came from: the site's storage, or the user's channel.
async function using(service, work) {
  try {
    return await work();
  } catch (err) {
    const tagged = err instanceof Error ? err : new Error(String(err));
    tagged.service = service;
    throw tagged;
  }
}

async function markSignInDead(err, userId) {
  const message = googleErrorMessage(err);
  if (err.service === 'drive') await updateSettings({ driveAuthError: message });
  else await User.updateOne({ _id: userId }, { 'youtube.authError': message });
}

async function platformReady() {
  const settings = await getSettings();
  if (!isStorageReady(settings)) return false;
  return !(settings.quotaPausedUntil && new Date(settings.quotaPausedUntil) > new Date());
}

// Users whose channel can't take uploads right now. Their shorts wait until they reconnect.
const pausedUsers = () =>
  User.distinct('_id', { $or: [{ 'youtube.tokens': null }, { 'youtube.authError': { $ne: null } }] });

async function downloadFromDrive(short, destination, signal) {
  const drive = await getDrive();
  const res = await drive.files.get(
    { fileId: short.driveFileId, alt: 'media' },
    callOptions({ responseType: 'stream', signal }),
  );
  await pipeline(res.data, fs.createWriteStream(destination), { signal });
  const { size } = await fs.promises.stat(destination);
  if (size !== short.sizeBytes) {
    throw new Error(`Downloaded ${size} bytes from Drive, expected ${short.sizeBytes}.`);
  }
}

async function uploadToYouTube(user, short, filePath, signal) {
  const youtube = getYouTube(authClientFor(user.youtube.tokens));
  const { data } = await youtube.videos.insert(
    {
      part: ['snippet', 'status'],
      notifySubscribers: true,
      requestBody: {
        snippet: { title: short.title, description: short.description, categoryId: '22' },
        status: { privacyStatus: short.privacy, selfDeclaredMadeForKids: short.madeForKids },
      },
      media: { mimeType: short.mimeType, body: fs.createReadStream(filePath) },
    },
    // A consumed stream can't be replayed, so retries go through the job's own backoff.
    callOptions({ signal, retry: false }),
  );
  if (!data.id) throw new Error('YouTube accepted the upload but returned no video id.');
  return data.id;
}

async function handleUploadError(short, err, log) {
  const kind = classify(err);
  const message = googleErrorMessage(err);
  log(`[${short.id}] ${err.service || 'upload'} error (${kind}): ${message}`);

  const reschedule = (delay, attempts = short.attempts) =>
    Short.updateOne(
      { _id: short._id },
      {
        status: STATUS.SCHEDULED,
        nextAttemptAt: new Date(Date.now() + delay),
        attempts,
        lastError: message,
      },
    );

  if (kind === 'auth') {
    // Not the short's fault: pause that sign-in's uploads and don't use up an attempt.
    await markSignInDead(err, short.user);
    await reschedule(0, short.attempts - 1);
  } else if (kind === 'quota') {
    if (googleErrorReasons(err).some((r) => PROJECT_QUOTA_REASONS.has(r))) {
      await updateSettings({ quotaPausedUntil: new Date(Date.now() + QUOTA_RETRY_DELAY), quotaError: message });
    }
    await reschedule(QUOTA_RETRY_DELAY, short.attempts - 1);
  } else if (kind === 'transient' && short.attempts < MAX_ATTEMPTS) {
    await reschedule(RETRY_DELAYS[Math.min(short.attempts - 1, RETRY_DELAYS.length - 1)]);
  } else {
    await Short.updateOne({ _id: short._id }, { status: STATUS.FAILED, lastError: message });
  }
}

// The account was deleted while this short was in flight.
async function discardOrphanedShort(short, log) {
  await deleteFromDrive(short.driveFileId).catch(() => {});
  await Short.deleteOne({ _id: short._id });
  log(`[${short.id}] owner's account is gone; removed`);
}

async function uploadShort(short, { jobTimeout, log }) {
  const user = await User.findById(short.user).lean();
  if (!user) return discardOrphanedShort(short, log);

  if (!isYouTubeReady(user)) {
    // Disconnected since the claim. It waits, without using an attempt, until they reconnect.
    await Short.updateOne({ _id: short._id }, { status: STATUS.SCHEDULED, attempts: short.attempts - 1 });
    return undefined;
  }
  const { channel } = user.youtube;
  if (short.channelId && channel?.id !== short.channelId) {
    await Short.updateOne(
      { _id: short._id },
      {
        status: STATUS.FAILED,
        attempts: short.attempts - 1,
        lastError: `This short was scheduled for “${short.channelTitle}”, but your account is now connected to “${channel?.title}”. Retry to publish it there instead, or delete it.`,
      },
    );
    log(`[${short.id}] not uploaded: the account's channel changed`);
    return undefined;
  }

  const signal = AbortSignal.timeout(jobTimeout);
  const tempFile = path.join(os.tmpdir(), `shorts-bot-${short.id}.video`);
  try {
    log(`[${short.id}] uploading "${short.title}" to ${channel.title} (attempt ${short.attempts})`);
    await using('drive', () => downloadFromDrive(short, tempFile, signal));
    const videoId = await using('youtube', () => uploadToYouTube(user, short, tempFile, signal));
    const now = new Date();
    await Short.updateOne(
      { _id: short._id },
      {
        status: STATUS.PROCESSING,
        youtubeVideoId: videoId,
        uploadedAt: now,
        nextAttemptAt: new Date(now.getTime() + PROCESSING_CHECK_INTERVAL),
        lastError: null,
      },
    );
    log(`[${short.id}] on YouTube as ${videoId}`);
  } catch (err) {
    await handleUploadError(short, err, log);
  } finally {
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
  }
  return undefined;
}

async function finishShort(short, log) {
  await using('drive', () => deleteFromDrive(short.driveFileId));
  await Short.updateOne(
    { _id: short._id },
    { status: STATUS.PUBLISHED, publishedAt: new Date(), lastError: null },
  );
  log(`[${short.id}] published as ${short.youtubeVideoId}; removed from Drive`);
}

async function checkProcessing(short, log) {
  const user = await User.findById(short.user).lean();
  if (!user) return discardOrphanedShort(short, log);

  const youtube = getYouTube(authClientFor(user.youtube?.tokens));
  const { data } = await using('youtube', () =>
    youtube.videos.list({ part: ['status'], id: [short.youtubeVideoId] }),
  );
  const status = data.items?.[0]?.status;
  const state = status?.uploadStatus;
  const timedOut = Date.now() - short.uploadedAt.getTime() > PROCESSING_GIVE_UP_AFTER;

  if (state === 'processed' || (status && timedOut && !REJECTED_UPLOAD_STATES.has(state))) {
    await finishShort(short, log);
  } else if (REJECTED_UPLOAD_STATES.has(state) || (!status && timedOut)) {
    const reason = status?.rejectionReason || status?.failureReason || state || 'video not found';
    log(`[${short.id}] rejected by YouTube: ${reason}`);
    // The Drive copy is the only one the site holds, so it stays for a retry.
    await Short.updateOne(
      { _id: short._id },
      { status: STATUS.FAILED, youtubeVideoId: null, lastError: `YouTube rejected the video: ${reason}` },
    );
  }
  return undefined;
}

// Claiming pushes the next check back first, so two workers never check the same short at once.
function claimProcessingCheck(paused) {
  return Short.findOneAndUpdate(
    { status: STATUS.PROCESSING, nextAttemptAt: { $lte: new Date() }, user: { $nin: paused } },
    { nextAttemptAt: new Date(Date.now() + PROCESSING_CHECK_INTERVAL) },
    { sort: { nextAttemptAt: 1 } },
  );
}

async function checkDueProcessing(log) {
  const paused = await pausedUsers();
  for (;;) {
    const short = await claimProcessingCheck(paused);
    if (!short) return;
    try {
      await checkProcessing(short, log);
    } catch (err) {
      log(`[${short.id}] processing check failed: ${googleErrorMessage(err)}`);
      if (isAuthError(err)) {
        await markSignInDead(err, short.user);
        if (err.service === 'drive') return;
        paused.push(short.user);
      } else {
        await Short.updateOne({ _id: short._id }, { lastError: googleErrorMessage(err) });
      }
    }
  }
}

async function claimNextDue() {
  const paused = await pausedUsers();
  const busy = await Short.distinct('user', { status: STATUS.UPLOADING });
  const claim = (excluded) =>
    Short.findOneAndUpdate(
      { status: STATUS.SCHEDULED, nextAttemptAt: { $lte: new Date() }, user: { $nin: excluded } },
      { status: STATUS.UPLOADING, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
  // Prefer someone with nothing uploading, so one user's big batch doesn't hold everyone else up.
  return (await claim([...paused, ...busy])) || claim(paused);
}

// The website can be stopped mid-delete: the Drive file may or may not still exist, so let the user redo it.
function releaseStuckDeletes() {
  return Short.updateMany(
    { status: STATUS.CANCELLING, updatedAt: { $lt: new Date(Date.now() - CANCEL_GIVE_UP_AFTER) } },
    { status: STATUS.FAILED, lastError: 'Deleting this short was interrupted. Try again.' },
  );
}

/** Runs everything that is due, with `concurrency` uploads at a time. */
export async function tick({ jobTimeout = JOB_TIMEOUT, log = console.log, concurrency = config.botConcurrency } = {}) {
  await releaseStuckDeletes();
  const worker = async () => {
    while (await platformReady()) {
      await checkDueProcessing(log);
      const short = await claimNextDue();
      if (!short) return;
      await uploadShort(short, { jobTimeout, log });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

/** Runs at startup: anything still "uploading" was cut off when the previous bot process died. */
export async function recoverInterrupted(log = console.log) {
  const message = 'The bot restarted during this upload.';
  const failed = await Short.updateMany(
    { status: STATUS.UPLOADING, attempts: { $gte: MAX_ATTEMPTS } },
    { status: STATUS.FAILED, lastError: message },
  );
  const requeued = await Short.updateMany(
    { status: STATUS.UPLOADING },
    { status: STATUS.SCHEDULED, nextAttemptAt: new Date(), lastError: message },
  );
  if (failed.modifiedCount || requeued.modifiedCount) {
    log(`Recovered interrupted uploads: ${requeued.modifiedCount} requeued, ${failed.modifiedCount} failed`);
  }
}

/**
 * Deletes stored videos no short refers to: uploads whose browser closed before scheduling
 * them, or files a failed delete left behind. Only this site's tagged files are considered.
 */
export async function sweepOrphans({ log = console.log, grace = ORPHAN_GRACE } = {}) {
  if (!isStorageReady(await getSettings())) return 0;
  const cutoff = Date.now() - grace;
  let removed = 0;
  try {
    const old = (await listStoredVideos()).filter((file) => new Date(file.createdTime).getTime() < cutoff);
    for (const file of old) {
      if (await Short.exists({ driveFileId: file.id })) continue;
      await deleteFromDrive(file.id);
      removed += 1;
    }
  } catch (err) {
    if (isAuthError(err)) await updateSettings({ driveAuthError: googleErrorMessage(err) });
    throw err;
  }
  if (removed) log(`Removed ${removed} abandoned upload(s) from Drive`);
  return removed;
}
