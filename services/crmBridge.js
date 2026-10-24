// services/crmBridge.js
// ---------------------------------------------------------------------------
// The CRM's way in to the WhatsApp leads.
//
// The CRM (admin_crm) reads the leads straight from this service's database —
// the `messages` collection the webhook already writes. Anything it wants DONE
// (send a message as a person, take a lead over, hand it back, snooze it,
// change its funnel stage, resolve an escalation, retry a first message) it
// writes as a command into `crm_lead_commands`; this module runs each command
// with the SAME functions Telegram's /takeover, /resume and 😴 use, so there is
// one copy of every rule. MongoDB is the only channel: no new inbound route.
//
// It also keeps two things up to date on each lead for the CRM's
// "Needs attention" page:
//   escalation  set by the webhook when the AI flags a question it can't handle
//               (recordEscalation, below) — until someone resolves it
//   stuck       the stuck-lead rules (stuckLeads.evaluateLead) applied to every
//               lead every few minutes, with no age limit so the backlog shows
//
// Collections (this service's database):
//   crm_lead_commands     CRM → here; status pending → running → done | failed
//   crm_lead_audit        append-only: who did what to which lead, and when
//   crm_messaging_worker  heartbeat + what the CRM needs to label things
//
// .env (all optional)
//   CRM_BRIDGE=off              don't take CRM commands
//   CRM_POLL_MS=1500            how often commands are checked
//   CRM_STUCK_SWEEP_MS=300000   how often the stuck flags are refreshed
// ---------------------------------------------------------------------------

const os = require("os");
const mongoose = require("mongoose");
const Message = require("../models/Message");
const LeadToMessage = require("../models/LeadToMessage");
const stuckLeads = require("./stuckLeads");
const { takeoverLead, resumeLead } = require("./telegramCommands");

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
const POLL_MS = () => num(process.env.CRM_POLL_MS, 1500);
const SWEEP_MS = () => num(process.env.CRM_STUCK_SWEEP_MS, 5 * 60 * 1000);
const HEARTBEAT_MS = () => num(process.env.CRM_HEARTBEAT_MS, 10000);

const COLLECTIONS = {
  commands: "crm_lead_commands",
  audit: "crm_lead_audit",
  worker: "crm_messaging_worker",
};

const MAX_TEXT = 1500; // one WhatsApp bubble (Twilio refuses > 1600)
const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

const col = (name) => mongoose.connection.collection(COLLECTIONS[name]);

async function ensureIndexes() {
  await Promise.all([
    col("commands").createIndex({ status: 1, createdAt: 1 }, { name: "crm_cmd_queue" }),
    col("commands").createIndex({ phoneNumber: 1, createdAt: -1 }, { name: "crm_cmd_lead" }),
    col("commands").createIndex(
      { "requestedBy.userId": 1, idempotencyKey: 1 },
      { name: "crm_cmd_idem", unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
    ),
    col("audit").createIndex({ phoneNumber: 1, at: -1 }, { name: "crm_audit_lead" }),
    col("audit").createIndex({ at: -1 }, { name: "crm_audit_recent" }),
  ]);
}

async function audit({ phoneNumber, action, actor = null, summary = "", ok = true }) {
  await col("audit")
    .insertOne({
      phoneNumber,
      action,
      actor: actor || { type: "system", userId: null, name: "WhatsApp service" },
      summary: String(summary || "").slice(0, 500),
      ok,
      at: new Date(),
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Escalations — called by the webhook when the AI sets `escalate`.
// ---------------------------------------------------------------------------
async function recordEscalation(phoneNumber, { note = null, question = null } = {}) {
  const at = new Date();
  await Message.updateOne(
    { phoneNumber },
    {
      $set: {
        "escalation.active": true,
        "escalation.note": note ? String(note).slice(0, 500) : null,
        "escalation.question": question ? String(question).slice(0, 1000) : null,
        "escalation.at": at,
        "escalation.resolvedAt": null,
        "escalation.resolvedByName": null,
        "escalation.resolution": null,
      },
      $push: {
        escalations: {
          $each: [{ note: note || null, question: question ? String(question).slice(0, 1000) : null, at }],
          $slice: -20,
        },
      },
    }
  );
  await audit({ phoneNumber, action: "escalated", summary: note || "The bot asked for a human" });
}

// ---------------------------------------------------------------------------
// Stuck flags.
// ---------------------------------------------------------------------------
function stuckFacts(f) {
  const stage = stuckLeads.stageOf(f.step);
  return {
    reason: f.reason, // never_replied | went_quiet
    since: f.silentSince,
    silentMs: f.silentMs,
    stage: stage.label,
    stageOrder: stage.order,
    totalStages: stuckLeads.TOTAL_STAGES,
    what: f.reason === "never_replied" ? "never replied to a single message" : stage.stuck,
    followUpCount: f.followUpCount,
    windowClosed: f.windowClosed,
    alreadyNotified: f.alreadyNotified,
    checkedAt: new Date(),
  };
}

/** Apply the stuck rules to every lead: flag the stuck ones, clear the rest. */
async function sweepStuck({ now = Date.now() } = {}) {
  const stuck = await stuckLeads.findStuckLeads({ includeNotified: true, now, maxAgeMs: Infinity });
  const phones = stuck.map((f) => f.phoneNumber);
  const wasStuck = new Set(
    (await Message.find({ stuck: { $ne: null }, phoneNumber: { $in: phones } }, { phoneNumber: 1 }).lean()).map((d) => d.phoneNumber)
  );
  for (const f of stuck) {
    // timestamps:false — a flag refresh is not activity on the lead.
    await Message.updateOne({ phoneNumber: f.phoneNumber }, { $set: { stuck: stuckFacts(f) } }, { timestamps: false });
    if (!wasStuck.has(f.phoneNumber)) {
      await audit({ phoneNumber: f.phoneNumber, action: "became_stuck", summary: stuckFacts(f).what });
    }
  }
  const cleared = await Message.updateMany(
    { stuck: { $ne: null }, phoneNumber: { $nin: phones } },
    { $set: { stuck: null } },
    { timestamps: false }
  );
  return { stuck: stuck.length, cleared: cleared.modifiedCount || 0 };
}

/** Re-check one lead now (after a takeover, resume or snooze). */
async function refreshStuck(phoneNumber, now = Date.now()) {
  const convo = await Message.findOne({ phoneNumber });
  if (!convo) return;
  const f = stuckLeads.evaluateLead(convo, now, Infinity);
  await Message.updateOne({ phoneNumber }, { $set: { stuck: f ? stuckFacts(f) : null } }, { timestamps: false });
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------
const actorOf = (cmd) => ({ type: "user", userId: cmd.requestedBy?.userId || null, name: cmd.requestedBy?.name || "CRM user" });

async function takeOver(phoneNumber, cmd) {
  const r = await takeoverLead(phoneNumber);
  if (!r.ok) throw new Error("No lead with that number.");
  await Message.updateOne(
    { phoneNumber },
    { $set: { "humanOwner.name": cmd.requestedBy?.name || null, "humanOwner.userId": cmd.requestedBy?.userId || null, "humanOwner.at": new Date() } }
  );
  await refreshStuck(phoneNumber);
}

const HANDLERS = {
  // Send a WhatsApp message as a person. Taking the lead over first is what
  // stops the bot answering the customer's reply on top of the person.
  async send_message(cmd, deps) {
    const text = String(cmd.args?.text || "").trim();
    if (!text) throw new Error("The message is empty.");
    if (text.length > MAX_TEXT) throw new Error(`Keep a message under ${MAX_TEXT} characters.`);
    const convo = await Message.findOne({ phoneNumber: cmd.phoneNumber });
    if (!convo) throw new Error("No lead with that number.");

    if (convo.botActive !== false) await takeOver(cmd.phoneNumber, cmd);

    const sent = await deps.sendWhatsApp(cmd.phoneNumber, text);
    const at = new Date();
    await Message.updateOne(
      { phoneNumber: cmd.phoneNumber },
      {
        $push: {
          messages: {
            text, direction: "outgoing", isBot: false, stepAtSend: convo.step || null, timestamp: at,
            sentByName: cmd.requestedBy?.name || null, sentVia: "crm", sid: sent?.sid || undefined,
          },
        },
        $set: { lastOutboundAt: at },
      }
    );
    // A person replying is an answer to the escalation.
    if (convo.escalation?.active) {
      await Message.updateOne(
        { phoneNumber: cmd.phoneNumber },
        { $set: { "escalation.active": false, "escalation.resolvedAt": at, "escalation.resolvedByName": cmd.requestedBy?.name || null, "escalation.resolution": "Replied from the CRM" } }
      );
    }
    const closed = !convo.lastInboundAt || Date.now() - new Date(convo.lastInboundAt).getTime() > WHATSAPP_WINDOW_MS;
    return {
      summary: `Sent a WhatsApp message (${text.length} characters)`,
      result: { sid: sent?.sid || null, windowClosed: closed },
    };
  },

  async takeover(cmd) {
    await takeOver(cmd.phoneNumber, cmd);
    return { summary: "Took the lead over — the bot stops replying" };
  },

  async resume(cmd) {
    const r = await resumeLead(cmd.phoneNumber);
    if (!r.ok) throw new Error("No lead with that number.");
    await Message.updateOne({ phoneNumber: cmd.phoneNumber }, { $set: { "humanOwner.name": null, "humanOwner.userId": null, "humanOwner.at": null } });
    await refreshStuck(cmd.phoneNumber);
    return { summary: "Handed the lead back to the bot" };
  },

  async snooze(cmd) {
    const hours = Math.min(Math.max(Number(cmd.args?.hours) || 24, 1), 24 * 14);
    const until = new Date(Date.now() + hours * 3600 * 1000);
    // As the 😴 button does, for any length.
    const r = await Message.updateOne({ phoneNumber: cmd.phoneNumber }, { $set: { stuckSnoozedUntil: until, stuckNotified: true } });
    if (!r.matchedCount) throw new Error("No lead with that number.");
    await refreshStuck(cmd.phoneNumber);
    return { summary: `Snoozed for ${hours}h`, result: { until } };
  },

  async set_status(cmd) {
    const status = String(cmd.args?.status || "");
    if (!Message.STATUS_STAGES.includes(status)) throw new Error("That is not a funnel stage.");
    const before = await Message.findOneAndUpdate({ phoneNumber: cmd.phoneNumber }, { $set: { status } });
    if (!before) throw new Error("No lead with that number.");
    await refreshStuck(cmd.phoneNumber);
    return { summary: `Stage: ${before.status || "Lead"} → ${status}` };
  },

  async resolve_escalation(cmd) {
    const note = String(cmd.args?.note || "").trim().slice(0, 500) || null;
    const r = await Message.updateOne(
      { phoneNumber: cmd.phoneNumber, "escalation.active": true },
      { $set: { "escalation.active": false, "escalation.resolvedAt": new Date(), "escalation.resolvedByName": cmd.requestedBy?.name || null, "escalation.resolution": note || "Resolved" } }
    );
    if (!r.matchedCount) throw new Error("This lead has no open escalation.");
    return { summary: note ? `Resolved the escalation: ${note}` : "Resolved the escalation" };
  },

  // A first message that did not go out (no template yet, or delivery failed).
  async retry_intro(cmd, deps) {
    const lead = await LeadToMessage.findOne({ whatsappNumber: cmd.phoneNumber });
    if (!lead) throw new Error("That number is not in the lead queue.");
    if (lead.messageSent) throw new Error("Its first message has already gone out.");
    if (!deps.sendQueuedLead) throw new Error("Sending is not available.");
    const r = await deps.sendQueuedLead(lead);
    if (!r.sent) throw new Error(r.error || "The first message could not be sent.");
    return { summary: "Sent the first message" };
  },
};

async function runCommand(cmd, deps) {
  const handler = HANDLERS[cmd.command];
  let outcome = null;
  let error = null;
  try {
    if (!handler) throw new Error(`Unknown command ${cmd.command}`);
    outcome = await handler(cmd, deps);
  } catch (err) {
    error = err?.message || String(err);
  }
  // Audit first, then close the command: anyone who sees it done can also see
  // who did it.
  await audit({
    phoneNumber: cmd.phoneNumber,
    action: cmd.command,
    actor: actorOf(cmd),
    summary: error ? `Failed: ${error}` : outcome?.summary || cmd.command,
    ok: !error,
  });
  await col("commands").updateOne(
    { _id: cmd._id },
    { $set: { status: error ? "failed" : "done", finishedAt: new Date(), result: outcome?.result || null, error } }
  );
  return { ok: !error, error };
}

// What the CRM needs to label leads, so it never keeps its own copy.
function publicStatus() {
  return {
    statusStages: Message.STATUS_STAGES,
    steps: Object.fromEntries(
      Object.entries(stuckLeads.STAGES).map(([k, v]) => [k, { order: v.order, label: v.label, stuck: v.stuck }])
    ),
    totalStages: stuckLeads.TOTAL_STAGES,
    stuckAfterHours: stuckLeads.STUCK_AFTER_MS / 3600000,
    sweepEveryMs: SWEEP_MS(),
    commands: Object.keys(HANDLERS),
  };
}

/**
 * Start taking CRM commands and refreshing the stuck flags.
 * @param {{ sendWhatsApp: Function, sendQueuedLead?: Function }} deps
 */
function startCrmBridge(deps, { log = console, workerId = `${os.hostname()}:${process.pid}` } = {}) {
  const state = { stopped: false, workerId };
  if (process.env.CRM_BRIDGE === "off") {
    log.log("🔌 CRM bridge off (CRM_BRIDGE=off).");
    return { state, stop: async () => {} };
  }

  const run = async () => {
    // Wait for Mongoose; the service connects without awaiting.
    while (!state.stopped && mongoose.connection.readyState !== 1) await sleep(500);
    if (state.stopped) return;
    await ensureIndexes().catch((err) => log.error("CRM bridge: indexes —", err.message));

    let nextSweep = 0;
    let nextBeat = 0;
    while (!state.stopped) {
      try {
        if (Date.now() >= nextBeat) {
          nextBeat = Date.now() + HEARTBEAT_MS();
          await col("worker").updateOne(
            { _id: "primary" },
            { $set: { workerId, heartbeatAt: new Date(), status: publicStatus() }, $setOnInsert: { startedAt: new Date() } },
            { upsert: true }
          );
        }
        if (Date.now() >= nextSweep) {
          nextSweep = Date.now() + SWEEP_MS();
          await sweepStuck().catch((err) => log.error("CRM bridge: stuck sweep —", err.message));
        }
        for (let i = 0; i < 10 && !state.stopped; i++) {
          const r = await col("commands").findOneAndUpdate(
            { status: "pending" },
            { $set: { status: "running", startedAt: new Date(), workerId } },
            { sort: { createdAt: 1 }, returnDocument: "after" }
          );
          const cmd = r && Object.prototype.hasOwnProperty.call(r, "value") ? r.value : r;
          if (!cmd) break;
          await runCommand(cmd, deps);
        }
      } catch (err) {
        log.error("CRM bridge: poll failed —", err.message);
      }
      await sleep(POLL_MS());
    }
  };
  const running = run();
  log.log("🔌 CRM bridge started — taking CRM commands, refreshing stuck flags.");
  return {
    state,
    async stop() {
      state.stopped = true;
      await running.catch(() => {});
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The status callback said a CRM-sent message did not deliver. */
async function markDeliveryFailed(sid, status, errorCode) {
  if (!sid) return false;
  const r = await Message.updateOne(
    { "messages.sid": sid },
    { $set: { "messages.$.deliveryStatus": status, "messages.$.deliveryError": errorCode ? `error ${errorCode}` : null } },
    { timestamps: false }
  );
  return r.matchedCount > 0;
}

module.exports = {
  startCrmBridge,
  recordEscalation,
  sweepStuck,
  refreshStuck,
  runCommand,
  markDeliveryFailed,
  publicStatus,
  ensureIndexes,
  COLLECTIONS,
  MAX_TEXT,
};
