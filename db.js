import mongoose from 'mongoose';
import { config } from './config.js';

let connecting = null;

export function connectDb() {
  connecting ??= mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 10_000 }).catch((err) => {
    connecting = null;
    throw err;
  });
  return connecting;
}

export async function disconnectDb() {
  connecting = null;
  await mongoose.disconnect();
}
