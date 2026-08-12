const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// A person who pressed /start AND proved they hold a phone number listed in
// TELEGRAM_ALLOWED_NUMBERS.
//
// The row stores the verified number alongside the chat id, because the env
// allowlist is re-checked on every broadcast. Removing a number from .env and
// restarting therefore cuts that person off immediately — no stale row keeps
// sending them customer details.
// ---------------------------------------------------------------------------
const telegramSubscriberSchema = new mongoose.Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },

    // Bare international digits, e.g. "447700900123". Compared against the
    // allowlist, which is normalised the same way.
    phoneNumber: { type: String, required: true, index: true },

    firstName: { type: String, default: null },
    username: { type: String, default: null },

    // /stop sets this false without deleting the row, so /start turns it back
    // on without re-verifying the number.
    active: { type: Boolean, default: true },

    verifiedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TelegramSubscriber", telegramSubscriberSchema);
