import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Settings come from bot/.env, wherever the process is started from.
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true });

const env = process.env;

const positive = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);

export const config = {
  mongoUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shorts_scheduler_saas',
  googleClientId: env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: env.GOOGLE_CLIENT_SECRET || '',
  // Only the test suite sets this: it points the Google clients at a local fake.
  googleApiRootUrl: env.GOOGLE_API_ROOT_URL || '',
  botPollSeconds: positive(env.BOT_POLL_SECONDS, 30),
  botConcurrency: positive(env.BOT_CONCURRENCY, 2),
};
