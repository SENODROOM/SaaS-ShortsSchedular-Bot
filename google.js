import { google } from 'googleapis';
import { config } from './config.js';
import { getInstanceId, getSettings } from './models/Settings.js';

// The bot's side of the backend's google.js: it only refreshes stored sign-ins, downloads and
// deletes videos on Drive, and uploads to YouTube. Connecting accounts is the backend's job.

// Written on every stored video by the backend. Keep in step with backend/google.js.
const INSTANCE_KEY = 'shortsSchedulerInstance';

const apiOptions = () => (config.googleApiRootUrl ? { rootUrl: `${config.googleApiRootUrl}/` } : {});

// For calls passing their own options: googleapis then ignores the client's rootUrl on media uploads.
export const callOptions = (options = {}) => ({ ...apiOptions(), ...options });

export const isGoogleConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);
export const hasTokens = (tokens) => Boolean(tokens?.refresh_token);
export const isStorageReady = (settings) => hasTokens(settings?.driveTokens) && !settings.driveAuthError;
export const isYouTubeReady = (user) => hasTokens(user?.youtube?.tokens) && !user.youtube.authError;

function createOAuthClient() {
  const root = config.googleApiRootUrl;
  const endpoints = root
    ? { oauth2TokenUrl: `${root}/token`, oauth2AuthBaseUrl: `${root}/auth`, oauth2RevokeUrl: `${root}/revoke` }
    : undefined;
  return new google.auth.OAuth2({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    ...(endpoints && { endpoints }),
  });
}

const MAX_CACHED_CLIENTS = 500;
const clients = new Map();

// One client per sign-in, so its access token is reused. A reconnect brings a new refresh
// token and with it a fresh client.
export function authClientFor(tokens) {
  if (!hasTokens(tokens)) throw new Error('Google account is not connected.');
  let client = clients.get(tokens.refresh_token);
  if (!client) {
    client = createOAuthClient();
    client.setCredentials(tokens);
    clients.set(tokens.refresh_token, client);
    if (clients.size > MAX_CACHED_CLIENTS) clients.delete(clients.keys().next().value);
  }
  return client;
}

async function storageAuth() {
  return authClientFor((await getSettings()).driveTokens);
}

export async function getDrive() {
  return google.drive({ version: 'v3', auth: await storageAuth(), ...apiOptions() });
}

export function getYouTube(auth) {
  return google.youtube({ version: 'v3', auth, ...apiOptions() });
}

/** Every video this site has stored, for the orphan sweep. */
export async function listStoredVideos() {
  const drive = await getDrive();
  const q = `appProperties has { key='${INSTANCE_KEY}' and value='${await getInstanceId()}' } and trashed = false`;
  const files = [];
  let pageToken;
  do {
    const { data } = await drive.files.list({
      q,
      fields: 'nextPageToken,files(id,createdTime,appProperties)',
      pageSize: 200,
      pageToken,
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

// Permanent delete, skipping the Drive trash so the storage is freed straight away.
export async function deleteFromDrive(fileId) {
  const drive = await getDrive();
  try {
    await drive.files.delete({ fileId });
  } catch (err) {
    if (err.status !== 404) throw err;
  }
}

export function googleErrorReasons(err) {
  const errors = err?.errors || err?.response?.data?.error?.errors || [];
  return errors.map((e) => e.reason).filter(Boolean);
}

export function googleErrorMessage(err) {
  return err?.response?.data?.error?.message || err?.message || String(err);
}

// True only when the stored credentials are dead and a person has to reconnect.
// A bare 401 doesn't count: it can be an access token expiring mid-transfer, which a retry fixes.
export function isAuthError(err) {
  const code = err?.response?.data?.error;
  return (
    ['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(code) ||
    String(err?.message).includes('invalid_grant')
  );
}
