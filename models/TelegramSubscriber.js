const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// A person who pressed /start and is on the TELEGRAM_ALLOWED_USERS list.
//
// The row exists only to remember WHERE to send (the chat id). It is not the
// authority on who is allowed — that is the env list, re-checked on every
// message and every broadcast. So removing someone from .env and restarting
// cuts them off immediately, with no stale row left forwarding lead data.
// ---------------------------------------------------------------------------
const telegramSubscriberSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },

    // Telegram's permanent id for the account. Never changes, never reused —
    // the reliable identifier when a username has been changed.
    userId: { type: String, default: null, index: true },

    username: { type: String, default: null },
    firstName: { type: String, default: null },

    // /stop sets this false without deleting the row.
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TelegramSubscriber", telegramSubscriberSchema);