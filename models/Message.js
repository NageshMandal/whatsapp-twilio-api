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
    // A message a person sent from the CRM: who, and what Twilio said about it.
    // (Bot and Telegram messages leave these empty.)
    sentByName: { type: String, default: undefined },
    sentVia: { type: String, default: undefined },      // "crm"
    sid: { type: String, default: undefined },          // Twilio message SID
    deliveryStatus: { type: String, default: undefined }, // "failed" | "undelivered"
    deliveryError: { type: String, default: undefined },
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
    // the raw part-exchange details the customer sent (reg, mileage, etc.), and
    // a flag so the team alert for them goes out exactly once.
    partExDetails: { type: String, default: null },
    partExNotified: { type: Boolean, default: false },

    lastInboundAt: { type: Date, default: null },
    lastOutboundAt: { type: Date, default: null },

    // --- stuck-lead alert bookkeeping ---
    // These MUST be in the schema: Mongoose strict mode silently drops $set on
    // unknown fields, which is exactly why the same leads were re-alerted every
    // day — stuckNotified was never actually saved.
    // true once this lead has appeared in a Telegram alert; cleared on every
    // inbound message so a lead that revives and goes quiet again alerts again.
    stuckNotified: { type: Boolean, default: false },
    stuckNotifiedAt: { type: Date, default: null },
    // set by the 😴 snooze button / command; the lead is hidden until then.
    stuckSnoozedUntil: { type: Date, default: null },

    // --- the CRM's view of this lead (services/crmBridge.js) ---
    // The bot flagged a question it could not handle. `active` until someone
    // resolves it in the CRM (or replies from the CRM). Every flag is kept in
    // `escalations`, newest last, so the history survives a resolve.
    escalation: {
      active: { type: Boolean, default: false },
      note: { type: String, default: null },
      question: { type: String, default: null },
      at: { type: Date, default: null },
      resolvedAt: { type: Date, default: null },
      resolvedByName: { type: String, default: null },
      resolution: { type: String, default: null },
    },
    escalations: [
      {
        note: String,
        question: String,
        at: Date,
        _id: false,
      },
    ],
    // Whether the stuck-lead rules (services/stuckLeads.js#evaluateLead) say this
    // lead is stuck right now, refreshed by the CRM bridge's sweep and cleared
    // on every inbound message. null = not stuck.
    stuck: { type: mongoose.Schema.Types.Mixed, default: null },
    // Who took the lead over from the CRM (Telegram /takeover leaves it empty).
    humanOwner: {
      name: { type: String, default: null },
      userId: { type: String, default: null },
      at: { type: Date, default: null },
    },

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