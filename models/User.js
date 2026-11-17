import mongoose from 'mongoose';

// The bot's view of the backend's `users` collection (backend/models/User.js). Keep the two in
// step. The bot only reads sign-ins and records authError, so account fields are left out.
const userSchema = new mongoose.Schema(
  {
    youtube: {
      tokens: { type: mongoose.Schema.Types.Mixed, default: null },
      channel: { type: mongoose.Schema.Types.Mixed, default: null },
      authError: { type: String, default: null },
      connectedAt: { type: Date, default: null },
    },
  },
  { timestamps: true, minimize: false, strict: false },
);

export const User = mongoose.model('User', userSchema);
