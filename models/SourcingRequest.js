const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// One WhatsApp car brief, from the message that asked for it to the reply that
// says it is done.
//
// It is a stored record rather than an in-memory map for one reason: a scrape
// takes two to four minutes, and a service restart in that window would
// otherwise leave the sender waiting for a reply that can never arrive. On
// boot, anything still "scraping" can be reconciled or chased.
// ---------------------------------------------------------------------------
const sourcingRequestSchema = new mongoose.Schema(
  {
    // Who asked, and which of our senders they asked on. The reply must go
    // back out through the SAME sender.
    phoneNumber: { type: String, required: true, index: true },
    fromNumber: { type: String, default: null },

    rawText: { type: String, default: null },
    brief: { type: mongoose.Schema.Types.Mixed, default: null },

    // What the deal desk gave us back.
    chatId: { type: String, default: null },
    jobId: { type: String, default: null },
    runId: { type: String, default: null },
    dashboardUrl: { type: String, default: null },

    status: {
      type: String,
      enum: ["queued", "scraping", "done", "failed"],
      default: "queued",
      index: true,
    },

    carLabel: { type: String, default: null }, // "Audi Q2" — used in the reply
    matched: { type: Number, default: null },
    bySource: { type: mongoose.Schema.Types.Mixed, default: null },
    error: { type: String, default: null },

    // Exactly-once reply. The desk retries its callback, so without this a
    // flaky network turns into three "scraping done" messages.
    replySent: { type: Boolean, default: false },
    replySentAt: { type: Date, default: null },

    // Set when a deal desk picks the request up off the queue. Used to release
    // a request whose desk died mid-scrape, so it is retried instead of
    // sitting on "scraping" forever.
    claimedAt: { type: Date, default: null },
    claimedBy: { type: String, default: null },
    attempts: { type: Number, default: 0 },

    completedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SourcingRequest", sourcingRequestSchema);