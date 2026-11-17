import mongoose from 'mongoose';

// The bot's copy of the backend's `shorts` collection (backend/models/Short.js). Keep the two in
// step: both apps read and write the same documents.
export const STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  CANCELLING: 'cancelling',
});

const PRIVACY = ['public', 'unlisted', 'private'];

const shortSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    channelId: { type: String, default: null },
    channelTitle: { type: String, default: null },

    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    privacy: { type: String, enum: PRIVACY, default: 'public' },
    madeForKids: { type: Boolean, default: false },
    scheduledAt: { type: Date, required: true },

    originalName: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    driveFileId: { type: String, required: true, unique: true },

    status: { type: String, enum: Object.values(STATUS), default: STATUS.SCHEDULED },
    nextAttemptAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },

    youtubeVideoId: { type: String, default: null },
    uploadedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

shortSchema.index({ status: 1, nextAttemptAt: 1 });
shortSchema.index({ user: 1, scheduledAt: -1 });

export const Short = mongoose.model('Short', shortSchema);
