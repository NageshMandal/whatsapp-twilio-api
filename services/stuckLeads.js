// services/stuckLeads.js
// ---------------------------------------------------------------------------
// Feature: 24-hour stuck-lead alerts to Telegram.
//
// The problem this solves: followUps.js keeps nudging a quiet lead once a day
// for five days, but nobody on the team is told. A lead can sit in "Lead" for
// a week, absorb five automated nudges and never be seen by a human. This
// sweep watches for exactly that shape and pushes it into a Telegram group so
// someone can pick up the phone.
//
// A lead is STUCK when ALL of these hold:
//   - the bot is still driving it        (botActive !== false)
//   - it never reached handoff           (step !== "handoff")
//   - it never moved down the funnel     (status === "Lead")
//   - it is at least STUCK_LEAD_HOURS old
//   - the LEAD has been silent for at least STUCK_LEAD_HOURS
//
// The last two are separate on purpose. Age alone would flag a lead who
// arrived 25 hours ago and is mid-conversation right now; silence alone would
// flag a lead who was added ten minutes ago and hasn't answered the intro yet.
// Requiring both means the alert means what the team thinks it means: this one
// has gone cold and is not coming back on its own.
//
// Each lead alerts ONCE (stuckNotified). The flag is cleared whenever the lead
// replies (see the webhook in index.js), so a lead who re-engages and then goes
// quiet again will alert again — which is the behaviour you want, because that
// second silence is a different, later problem.
//
// .env
//   STUCK_LEAD_HOURS=24                 how long counts as stuck
//   STUCK_LEAD_CRON=*/15 * * * *        how often to sweep
//   STUCK_LEAD_MAX_AGE_DAYS=14          ignore ancient leads on first deploy
//   STUCK_LEAD_MAX_ALERTS=10            per-sweep cap, remainder is digested
//   STUCK_LEAD_INCLUDE_SUMMARY=true     AI summary on each alert card
// ---------------------------------------------------------------------------

const cron = require("node-cron");
const Message = require("../models/Message");
const telegram = require("./telegram");
const { summariseConversation } = require("./aiBrain");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const num = (value, fallback) => {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const STUCK_AFTER_MS = num(process.env.STUCK_LEAD_HOURS, 24) * HOUR;
const MAX_AGE_MS = num(process.env.STUCK_LEAD_MAX_AGE_DAYS, 14) * DAY;
const MAX_ALERTS_PER_SWEEP = num(process.env.STUCK_LEAD_MAX_ALERTS, 10);
const CRON_EXPR = process.env.STUCK_LEAD_CRON || "*/15 * * * *";
const INCLUDE_SUMMARY =
  String(process.env.STUCK_LEAD_INCLUDE_SUMMARY || "true").toLowerCase() !== "false";

// WhatsApp's free-text session window. Past this, a plain message to the lead
// will NOT deliver — the team needs an approved template or a phone call. The
// alert says so explicitly, because "just WhatsApp them" is the natural
// reaction and it silently fails.
const WA_SESSION_WINDOW_MS = 24 * HOUR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Pure classification — no DB, no network, so it is trivially testable.
// ---------------------------------------------------------------------------

const ms = (date) => (date ? new Date(date).getTime() : 0);

/**
 * Decide whether one conversation is stuck.
 * @param {object} convo  A Message document (or plain object).
 * @param {number} [now]  Epoch ms, injectable for tests.
 * @returns {null|object} null if healthy, otherwise the alert facts.
 */
function evaluateLead(convo, now = Date.now()) {
  if (!convo) return null;

  // A human already has it, or it already qualified — not our problem.
  if (convo.botActive === false) return null;
  if (convo.step === "handoff") return null;
  if (convo.status && convo.status !== "Lead") return null;

  // Snoozed from Telegram.
  if (convo.stuckSnoozedUntil && ms(convo.stuckSnoozedUntil) > now) return null;

  const createdAt = ms(convo.createdAt) || now;
  const lastIn = ms(convo.lastInboundAt);
  const lastOut = ms(convo.lastOutboundAt);

  // We have never messaged them, so there is nothing for them to be silent
  // about. That is a send-queue problem, not a stuck-lead problem.
  if (!lastOut) return null;

  // They spoke last — the bot owes them a reply and is probably mid-flight.
  // Flagging here would just be racing our own webhook.
  if (lastIn && lastIn > lastOut) return null;

  const ageMs = now - createdAt;
  if (ageMs < STUCK_AFTER_MS) return null;
  if (ageMs > MAX_AGE_MS) return null; // ancient backlog, don't spam on deploy

  // "Silent since" is their last inbound; if they never replied at all, count
  // from the first time we reached out.
  const silentSince = lastIn || firstOutboundAt(convo) || createdAt;
  const silentMs = now - silentSince;
  if (silentMs < STUCK_AFTER_MS) return null;

  return {
    phoneNumber: convo.phoneNumber,
    customerName: convo.customerName || null,
    step: convo.step || "intro",
    status: convo.status || "Lead",
    financePreference: convo.financePreference || null,
    followUpCount: convo.followUpCount || 0,
    reason: lastIn ? "went_quiet" : "never_replied",
    ageMs,
    silentMs,
    silentSince: new Date(silentSince),
    lastOutboundAt: lastOut ? new Date(lastOut) : null,
    // Past 24h of lead silence the WhatsApp session is shut.
    windowClosed: !lastIn || now - lastIn > WA_SESSION_WINDOW_MS,
    partExDetails: convo.partExDetails || null,
    lastMessage: lastMessageOf(convo),
    alreadyNotified: convo.stuckNotified === true,
  };
}

function firstOutboundAt(convo) {
  const first = (convo.messages || []).find((m) => m.direction === "outgoing");
  return first ? ms(first.timestamp) : 0;
}

function lastMessageOf(convo) {
  const list = convo.messages || [];
  const last = list[list.length - 1];
  if (!last) return null;
  return {
    text: (last.text || "").slice(0, 300),
    direction: last.direction,
    isBot: last.isBot === true,
    timestamp: last.timestamp,
  };
}

// "1 day 4 hrs" — reads better in an alert than "28.4 hours".
function formatDuration(milliseconds) {
  const totalMinutes = Math.max(0, Math.round(milliseconds / MIN));
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} hr${hours === 1 ? "" : "s"}`);
  if (!days && minutes) parts.push(`${minutes} min`);
  return parts.join(" ") || "just now";
}

function formatUkTime(date) {
  if (!date) return "unknown";
  return new Date(date).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

const REASON_LABEL = {
  never_replied: "Never replied to any message",
  went_quiet: "Replied before, then went silent",
};

// Human-readable conversation stage.
const STEP_LABEL = {
  intro: "Intro — confirming name & interest",
  finance_understanding: "Checking finance understanding",
  finance_explainer: "Finance explainer sent",
  consent: "Waiting on soft-search consent",
  apply: "Enquiry form link sent",
  confirm_form: "Waiting for form completion",
  handoff: "Handed off",
};

// ---------------------------------------------------------------------------
// Alert rendering
// ---------------------------------------------------------------------------

const e = telegram.escapeHtml;

function buildAlertText(facts, summary) {
  const lines = [
    "🚨 <b>Stuck lead — no reply for " + e(formatDuration(facts.silentMs)) + "</b>",
    "",
    `<b>Name:</b> ${e(facts.customerName || "Unknown")}`,
    `<b>Number:</b> <code>${e(facts.phoneNumber)}</code>`,
    `<b>Stage:</b> ${e(STEP_LABEL[facts.step] || facts.step)}`,
    `<b>Finance:</b> ${e(facts.financePreference || "Not specified")}`,
    `<b>Why flagged:</b> ${e(REASON_LABEL[facts.reason] || facts.reason)}`,
    `<b>Lead age:</b> ${e(formatDuration(facts.ageMs))}`,
    `<b>Last heard from them:</b> ${e(
      facts.reason === "never_replied" ? "never" : formatUkTime(facts.silentSince)
    )}`,
    `<b>Automated nudges sent:</b> ${facts.followUpCount} of 5`,
  ];

  if (facts.partExDetails) {
    lines.push("", `<b>Part-ex given:</b> ${e(facts.partExDetails.slice(0, 200))}`);
  }

  if (facts.lastMessage) {
    const who = facts.lastMessage.direction === "incoming" ? "Lead" : "Us";
    lines.push("", `<b>Last message (${e(who)}):</b>`, `<i>${e(facts.lastMessage.text)}</i>`);
  }

  if (summary) {
    lines.push("", "<b>Chat summary:</b>", e(summary));
  }

  if (facts.windowClosed) {
    lines.push(
      "",
      "⚠️ <b>WhatsApp 24h window is closed.</b> A plain message will not deliver — use an approved template or call them."
    );
  }

  return lines.join("\n");
}

// Inline keyboard. callback_data is capped at 64 bytes by Telegram; a phone
// number plus a short verb sits comfortably inside that.
function buildAlertButtons(facts) {
  const phone = facts.phoneNumber;
  return [
    [
      { text: "🙋 I'll take this one", callback_data: `takeover:${phone}` },
      { text: "😴 Snooze 24h", callback_data: `snooze:${phone}` },
    ],
    [
      {
        text: "💬 Open WhatsApp",
        url: `https://wa.me/${phone.replace(/[^\d]/g, "")}`,
      },
    ],
  ];
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/**
 * Find every stuck lead. Read-only — safe to call from an HTTP route.
 * @param {{ includeNotified?: boolean, now?: number }} [opts]
 */
async function findStuckLeads({ includeNotified = false, now = Date.now() } = {}) {
  const cutoff = new Date(now - STUCK_AFTER_MS);

  // Narrow in Mongo first so the sweep stays cheap as the collection grows;
  // evaluateLead() then applies the rules that need the full document.
  const query = {
    botActive: { $ne: false },
    step: { $ne: "handoff" },
    status: "Lead",
    lastOutboundAt: { $ne: null, $lte: cutoff },
    createdAt: { $lte: cutoff, $gte: new Date(now - MAX_AGE_MS) },
  };
  if (!includeNotified) query.stuckNotified = { $ne: true };

  const candidates = await Message.find(query).sort({ createdAt: 1 });

  return candidates
    .map((convo) => evaluateLead(convo, now))
    .filter(Boolean);
}

/**
 * One pass: find stuck leads, alert Telegram, mark them notified.
 * @param {{ dryRun?: boolean }} [opts]
 */
async function runStuckLeadSweep({ dryRun = false } = {}) {
  if (!telegram.isConfigured()) return { skipped: "telegram-not-configured", alerted: 0 };

  let stuck;
  try {
    stuck = await findStuckLeads();
  } catch (err) {
    console.error("❌ Stuck-lead query failed:", err.message);
    return { error: err.message, alerted: 0 };
  }

  if (!stuck.length) return { alerted: 0, digested: 0 };

  const detailed = stuck.slice(0, MAX_ALERTS_PER_SWEEP);
  const overflow = stuck.slice(MAX_ALERTS_PER_SWEEP);
  const notifiedNumbers = [];

  for (const facts of detailed) {
    let summary = null;
    if (INCLUDE_SUMMARY) {
      try {
        const convo = await Message.findOne({ phoneNumber: facts.phoneNumber });
        summary = await summariseConversation((convo && convo.messages) || []);
      } catch (err) {
        console.warn(`⚠️  Summary for ${facts.phoneNumber} failed:`, err.message);
      }
    }

    if (dryRun) {
      console.log("🧪 [dry run] would alert:", facts.phoneNumber, facts.reason);
      continue;
    }

    const results = await telegram.sendTelegram(buildAlertText(facts, summary), {
      chatIds: telegram.STUCK_CHATS,
      buttons: buildAlertButtons(facts),
    });

    // Only mark notified if it actually landed somewhere, otherwise a transient
    // Telegram outage would silently burn the one alert this lead ever gets.
    if (results.some((r) => r.ok)) {
      notifiedNumbers.push(facts.phoneNumber);
    }

    await sleep(400); // stay under the ~20 msg/min group limit
  }

  if (overflow.length && !dryRun) {
    const lines = [
      `📋 <b>${overflow.length} more stuck lead${overflow.length === 1 ? "" : "s"}</b>`,
      "",
      ...overflow.map(
        (f) =>
          `• <code>${e(f.phoneNumber)}</code> — ${e(f.customerName || "Unknown")}, quiet ${e(
            formatDuration(f.silentMs)
          )}`
      ),
      "",
      "<i>Send /stuck for the full list.</i>",
    ];
    const results = await telegram.sendTelegram(lines.join("\n"), {
      chatIds: telegram.STUCK_CHATS,
    });
    if (results.some((r) => r.ok)) {
      notifiedNumbers.push(...overflow.map((f) => f.phoneNumber));
    }
  }

  if (notifiedNumbers.length && !dryRun) {
    await Message.updateMany(
      { phoneNumber: { $in: notifiedNumbers } },
      { $set: { stuckNotified: true, stuckNotifiedAt: new Date() } }
    );
  }

  console.log(
    `🚨 Stuck-lead sweep: ${detailed.length} alert(s), ${overflow.length} digested.`
  );

  return { alerted: detailed.length, digested: overflow.length, total: stuck.length };
}

/**
 * A compact list for the /stuck Telegram command and the REST endpoint.
 * Includes already-notified leads, since the point is "what is outstanding".
 */
async function buildStuckDigest() {
  const stuck = await findStuckLeads({ includeNotified: true });

  if (!stuck.length) {
    return "✅ <b>No stuck leads.</b> Everything is either moving or already with a human.";
  }

  const lines = [
    `📋 <b>${stuck.length} stuck lead${stuck.length === 1 ? "" : "s"}</b>`,
    "",
  ];

  for (const f of stuck.slice(0, 40)) {
    lines.push(
      `• <code>${e(f.phoneNumber)}</code> — ${e(f.customerName || "Unknown")}`,
      `   quiet ${e(formatDuration(f.silentMs))} · ${e(f.step)} · ${f.followUpCount}/5 nudges${
        f.windowClosed ? " · ⚠️ window closed" : ""
      }`
    );
  }

  if (stuck.length > 40) lines.push("", `<i>…and ${stuck.length - 40} more.</i>`);
  return lines.join("\n");
}

/**
 * Start the sweep on a cron. Uses a lock so a slow sweep (summaries are LLM
 * calls) never overlaps itself.
 */
function startStuckLeadCron() {
  if (!telegram.isConfigured()) {
    console.log("📵 Stuck-lead alerts disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
    return;
  }

  let running = false;
  cron.schedule(CRON_EXPR, async () => {
    if (running) return;
    running = true;
    try {
      await runStuckLeadSweep();
    } catch (err) {
      console.error("❌ Stuck-lead cron error:", err.message);
    } finally {
      running = false;
    }
  });

  console.log(
    `⏰ Stuck-lead cron started (${CRON_EXPR}; flags leads quiet for ${
      STUCK_AFTER_MS / HOUR
    }h).`
  );
}

module.exports = {
  startStuckLeadCron,
  runStuckLeadSweep,
  findStuckLeads,
  buildStuckDigest,
  evaluateLead,
  buildAlertText,
  buildAlertButtons,
  formatDuration,
  STUCK_AFTER_MS,
};
