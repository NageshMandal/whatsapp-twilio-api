const mongoose = require("mongoose");

// ---------------------------------------------------------------------------
// Staging queue for leads submitted by an admin ("name + number").
//
// The flow is two-stage on purpose:
//   1) Admin submits a lead  -> a row lands here with messageSent = false.
//   2) The bot sends the first (intro/template) message. ONLY when that send
//      succeeds do we flip messageSent = true and create the conversation
//      "card" in the messages collection (the Message model), which starts
//      Charlie's flow.
//
// This lets leads be collected even when the first message can't go out yet
// (e.g. a production sender still waiting on an approved WhatsApp template).
// ---------------------------------------------------------------------------
const leadToMessageSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },

    // E.164 number, e.g. +447700900123. Unique so the same lead can't be
    // queued twice.
    whatsappNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // false = still waiting to be messaged, true = first message delivered and
    // a conversation card has been created in the messages collection.
    messageSent: { type: Boolean, default: false },

    // bookkeeping
    sentAt: { type: Date, default: null },
    submittedBy: { type: String, default: null }, // which admin number added it
    lastError: { type: String, default: null },   // last send error, if any
  },
  { timestamps: true }
);

module.exports = mongoose.model("LeadToMessage", leadToMessageSchema);