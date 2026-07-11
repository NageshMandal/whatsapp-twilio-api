const mongoose = require("mongoose");

// ---- High-level CRM funnel stages (your pipeline, top -> bottom) ----
const STATUS_STAGES = [
  "Lead",
  "Send quotes",
  "Submit application",
  "Pending application",
  "Accepted",
  "Sign docs/compliance/reserve car",
  "Buy car/payout confirmation",
  "Black pack",
  "Alloys",
  "Handover/compliance",
  "Order complete",
  "Aftersales",
];

// ---- Conversational steps the AI runs while the lead is still "Lead" ----
// intro              -> confirm full name + that they want finance
// finance_understanding -> ask if they understand how finance works
// finance_explainer  -> send HP/PCP + trading/mileage/balloon/docs explainer
// consent            -> ask consent for a soft search
// apply              -> send the enquiry form link
// confirm_form       -> wait for "done"/completed confirmation
// handoff            -> form completed, passed to Zavia (bot stops auto-replying)
const CONVERSATION_STEPS = [
  "intro",
  "finance_understanding",
  "finance_explainer",
  "consent",
  "apply",
  "confirm_form",
  "handoff",
];

const subMessageSchema = new mongoose.Schema(
  {
    text: String,
    direction: {
      type: String,
      enum: ["incoming", "outgoing"],
      default: "incoming",
    },
    // optional metadata so you can see what the bot was thinking
    stepAtSend: { type: String, default: null },
    isBot: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true }
);

const messageSchema = new mongoose.Schema(
  {
    phoneNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // --- captured during the conversation ---
    customerName: { type: String, default: null },
    financePreference: {
      type: String,
      enum: ["HP", "PCP", null],
      default: null,
    },

    // --- funnel status (manually/CRM advanced for later stages) ---
    status: {
      type: String,
      enum: STATUS_STAGES,
      default: "Lead",
    },

    // --- where the AI is in the lead conversation ---
    step: {
      type: String,
      enum: CONVERSATION_STEPS,
      default: "intro",
    },

    // when false, the AI stops auto-replying (e.g. handed to a human)
    botActive: { type: Boolean, default: true },

    // --- follow-up + notification bookkeeping ---
    // how many automated nudges we've sent since the lead last replied (0-3).
    // reset to 0 on every inbound message (see webhook).
    followUpCount: { type: Number, default: 0 },
    // ensures the sales-team handoff notification is sent exactly once.
    handoffNotified: { type: Boolean, default: false },
    partExSent: { type: Boolean, default: false },

    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },

    messages: [subMessageSchema],
  },
  { timestamps: true }
);

// expose the lists so other files share a single source of truth
messageSchema.statics.STATUS_STAGES = STATUS_STAGES;
messageSchema.statics.CONVERSATION_STEPS = CONVERSATION_STEPS;

module.exports = mongoose.model("Message", messageSchema);
module.exports.STATUS_STAGES = STATUS_STAGES;
module.exports.CONVERSATION_STEPS = CONVERSATION_STEPS;