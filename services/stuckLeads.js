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
// DELIVERY: one message a day, to whoever pressed /start on the bot. Not one
// ping per lead — a list. Each lead is alerted ONCE: after a successful send
// it is marked stuckNotified and drops off future daily messages. The daily
// message therefore only contains NEW stuck leads; if nothing new got stuck,
// nothing is sent. /stuck and /backlog still show the FULL list on demand.
//
// .env (all optional; defaults are fine)
//   STUCK_LEAD_DAILY_TIME=09:00         when the daily list is sent
//   STUCK_LEAD_TIMEZONE=Europe/London   what that time means
//   STUCK_LEAD_HOURS=24                 how long counts as stuck
//   STUCK_LEAD_MAX_AGE_DAYS=14          ignore ancient leads on first deploy
// ---------------------------------------------------------------------------

const cron = require("node-cron");
const Message = require("../models/Message");
const telegram = require("./telegram");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const num = (value, fallback) => {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const STUCK_AFTER_MS = num(process.env.STUCK_LEAD_HOURS, 24) * HOUR;
// 0 (or "off") means no age limit at all — include the whole backlog.
const RAW_MAX_AGE = process.env.STUCK_LEAD_MAX_AGE_DAYS;
const MAX_AGE_MS =
  RAW_MAX_AGE === "0" || String(RAW_MAX_AGE).toLowerCase() === "off"
    ? Infinity
    : num(RAW_MAX_AGE, 14) * DAY;
const TIMEZONE = process.env.STUCK_LEAD_TIMEZONE || "Europe/London";

// "09:00" -> the cron expression "0 9 * * *".
function dailyCronExpr(timeStr) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(timeStr || "").trim());
  if (!m) return "0 9 * * *";
  const hour = Math.min(23, parseInt(m[1], 10));
  const minute = Math.min(59, parseInt(m[2], 10));
  return `${minute} ${hour} * * *`;
}

const DAILY_TIME = process.env.STUCK_LEAD_DAILY_TIME || "09:00";
const CRON_EXPR = dailyCronExpr(DAILY_TIME);

// WhatsApp's free-text session window. Past this, a plain message to the lead
// will NOT deliver — the team needs an approved template or a phone call. The
// alert says so explicitly, because "just WhatsApp them" is the natural
// reaction and it silently fails.
const WA_SESSION_WINDOW_MS = 24 * HOUR;

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
function evaluateLead(convo, now = Date.now(), maxAgeMs = MAX_AGE_MS) {
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
  if (ageMs > maxAgeMs) return null; // too old to be worth chasing

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
// The qualification funnel, in order. `order` drives the "Stage 4 of 6" badge
// so you can see at a glance how far a lead actually got — "consent" means
// nothing on its own, "Stage 4 of 6" tells you they were nearly there.
//
// `stuck` says what the lead did NOT do. That is the line that tells whoever
// picks up the phone what to open with, which is the whole point of the alert.
const STAGES = {
  intro: {
    order: 1,
    label: "Intro",
    stuck: "never confirmed their name or that they still want a car",
  },
  finance_understanding: {
    order: 2,
    label: "Finance check",
    stuck: "didn't say whether they understand how car finance works",
  },
  finance_explainer: {
    order: 3,
    label: "Finance explained",
    stuck: "got the finance explainer, never replied to it",
  },
  consent: {
    order: 4,
    label: "Soft-search consent",
    stuck: "won't confirm consent for the soft credit search",
  },
  apply: {
    order: 5,
    label: "Form sent",
    stuck: "was sent the enquiry form link and never opened or returned it",
  },
  confirm_form: {
    order: 6,
    label: "Form completion",
    stuck: "said they'd complete the form but hasn't finished it",
  },
  handoff: { order: 7, label: "Handed off", stuck: "already qualified" },
};

// Stages a lead passes through before qualifying (handoff is the finish line,
// not a stage), so the badge reads "Stage 4 of 6" rather than "4 of 7".
const TOTAL_STAGES = Object.values(STAGES).filter((st) => st.order < 7).length;

const stageOf = (step) =>
  STAGES[step] || { order: 0, label: step || "unknown", stuck: "stopped responding" };

// Kept for anything still importing the old name.
const STEP_LABEL = Object.fromEntries(
  Object.entries(STAGES).map(([k, v]) => [k, v.label])
);

const e = telegram.escapeHtml;

// ---------------------------------------------------------------------------
// Finding stuck leads
// ---------------------------------------------------------------------------

/**
 * Find every stuck lead. Read-only — safe to call from an HTTP route.
 * @param {{ includeNotified?: boolean, now?: number }} [opts]
 */
async function findStuckLeads({
  includeNotified = false,
  now = Date.now(),
  maxAgeMs = MAX_AGE_MS,
} = {}) {
  const cutoff = new Date(now - STUCK_AFTER_MS);

  // Narrow in Mongo first so the sweep stays cheap as the collection grows;
  // evaluateLead() then applies the rules that need the full document.
  const query = {
    botActive: { $ne: false },
    step: { $ne: "handoff" },
    status: "Lead",
    lastOutboundAt: { $ne: null, $lte: cutoff },
    createdAt: Number.isFinite(maxAgeMs)
      ? { $lte: cutoff, $gte: new Date(now - maxAgeMs) }
      : { $lte: cutoff },
  };
  if (!includeNotified) query.stuckNotified = { $ne: true };

  const candidates = await Message.find(query).sort({ createdAt: 1 });

  return candidates
    .map((convo) => evaluateLead(convo, now, maxAgeMs))
    .filter(Boolean);
}

/**
 * Build the once-a-day message: every stuck lead, in one list.
 *
 * Deliberately NOT one alert per lead. Ten separate pings at 9am is noise
 * people learn to swipe away; one list is something you read.
 */
const DIVIDER = "─".repeat(18);

async function buildStuckDigest({
  now = Date.now(),
  maxAgeMs = MAX_AGE_MS,
  // false (the daily default): only leads never alerted before, so nobody
  // sees the same lead twice. true: the full list, for /stuck and /backlog.
  includeNotified = false,
} = {}) {
  const stuck = await findStuckLeads({ includeNotified, now, maxAgeMs });

  if (!stuck.length) {
    return {
      empty: true,
      text: includeNotified
        ? "✅ <b>No stuck leads.</b> Everything is either moving or already with a human."
        : "✅ <b>No new stuck leads.</b> Nothing new has gone quiet since the last alert.",
      leads: [],
      buttons: [],
    };
  }

  const plural = stuck.length === 1 ? "" : "s";
  const lines = [
    includeNotified
      ? `🚨 <b>${stuck.length} stuck lead${plural}</b> <i>(full list)</i>`
      : `🚨 <b>${stuck.length} new stuck lead${plural}</b>`,
    `<i>No reply for ${Math.round(STUCK_AFTER_MS / HOUR)}h+, never qualified. Sent once — you won't see these again.</i>`,
  ];

  stuck.slice(0, 40).forEach((f, i) => {
    const stage = stageOf(f.step);
    const waLink = `https://wa.me/${f.phoneNumber.replace(/[^\d]/g, "")}`;
    const name = f.customerName || "No name captured";

    lines.push(
      DIVIDER,
      `<b>${i + 1}. ${e(name)}</b>`,
      // <code> makes the number tap-to-copy in Telegram; the link opens the chat.
      `📞 <code>${e(f.phoneNumber)}</code> · <a href="${waLink}">Open WhatsApp</a>`,
      `📍 Stage <b>${stage.order}/${TOTAL_STAGES}</b> — ${e(stage.label)}`,
      `⛔ ${e(
        f.reason === "never_replied"
          ? "never replied to a single message"
          : stage.stuck
      )}`,
      `⏱ Quiet <b>${e(formatDuration(f.silentMs))}</b> · ${f.followUpCount}/5 nudges` +
        (f.windowClosed ? `\n☎️ WhatsApp window shut — <b>call them</b>` : "")
    );
  });

  lines.push(DIVIDER);
  if (stuck.length > 40) lines.push(`<i>…and ${stuck.length - 40} more.</i>`);

  // Be explicit when the buttons don't cover the whole list, otherwise it reads
  // as leads silently missing their buttons.
  lines.push(
    stuck.length > 10
      ? `<i>Buttons cover the first 10 leads. /takeover +447… to handle one yourself.</i>`
      : `<i>📋 copies the lead · 🙋 you take it over · 😴 hides it for 24h.</i>`
  );

  return {
    empty: false,
    text: lines.join("\n"),
    leads: stuck,
    buttons: buildLeadButtons(stuck),
  };
}

/**
 * One "copy" button per lead. Telegram's copy_text button puts the payload
 * straight on the clipboard in a single tap — no long-press, no text selection,
 * which is the difference between usable and not on a phone.
 *
 * Two hard limits shape this: copy_text.text caps at 256 characters, and a tall
 * keyboard buries the message itself, so the buttons cover the first ten leads
 * and the rest are reachable via the list above.
 */
function buildLeadButtons(leads, max = 10) {
  return leads.slice(0, max).map((f) => {
    const stage = stageOf(f.step);
    const name = f.customerName || "No name captured";

    const payload = [
      name,
      f.phoneNumber,
      `Stage ${stage.order}/${TOTAL_STAGES} — ${stage.label}`,
      `Stuck: ${
        f.reason === "never_replied" ? "never replied to any message" : stage.stuck
      }`,
      `Quiet ${formatDuration(f.silentMs)}, ${f.followUpCount}/5 nudges${
        f.windowClosed ? ", WhatsApp window closed — call them" : ""
      }`,
    ].join("\n");

    // One row per lead: copy the details, take it over, or snooze it — the
    // last two go straight to the existing callback handlers in
    // telegramCommands.js ("takeover:<phone>" / "snooze:<phone>").
    return [
      {
        // Button labels are capped too, and a wrapped label looks broken.
        text: `📋 ${name.slice(0, 16)}`,
        copy_text: { text: payload.slice(0, 256) },
      },
      { text: "🙋 Take", callback_data: `takeover:${f.phoneNumber}`.slice(0, 64) },
      { text: "😴 24h", callback_data: `snooze:${f.phoneNumber}`.slice(0, 64) },
    ];
  });
}

// Kept for anything still importing the old name.
const buildCopyButtons = buildLeadButtons;

/**
 * Flag leads as alerted so tomorrow's message doesn't repeat them. Called only
 * AFTER at least one subscriber actually received the message — if delivery
 * fails, the leads stay eligible and go out next run instead of being lost.
 */
async function markLeadsNotified(leads, when = new Date()) {
  const phones = (leads || []).map((l) => l.phoneNumber).filter(Boolean);
  if (!phones.length) return 0;
  const res = await Message.updateMany(
    { phoneNumber: { $in: phones } },
    { $set: { stuckNotified: true, stuckNotifiedAt: when } }
  );
  return res.modifiedCount || 0;
}


/**
 * Send the daily list to every subscriber.
 * @param {{ force?: boolean }} [opts]  force = send even when there is nothing,
 *                                      so a manual /stuck always gets a reply.
 */
async function sendDailyDigest({ force = false, maxAgeMs = MAX_AGE_MS } = {}) {
  if (!telegram.isConfigured()) {
    return { skipped: "no-telegram-token", sent: 0 };
  }

  let digest;
  try {
    // Only leads that have never been alerted — no repeats.
    digest = await buildStuckDigest({ maxAgeMs, includeNotified: false });
  } catch (err) {
    console.error("❌ Stuck-lead digest failed:", err.message);
    return { error: err.message, sent: 0 };
  }

  // Nothing NEW to report: stay quiet rather than sending "all clear" every
  // morning, which is how a daily notification becomes background noise.
  if (digest.empty && !force) {
    console.log("✅ Daily stuck-lead check: no new stuck leads.");
    return { sent: 0, leads: 0 };
  }

  const results = await telegram.broadcast(digest.text, { buttons: digest.buttons });
  const delivered = results.filter((r) => r.ok).length;

  // Only mark them once someone has actually seen the alert. If every send
  // failed (or nobody has pressed /start yet), the leads remain eligible and
  // will go out on the next run instead of vanishing unseen.
  if (delivered > 0 && digest.leads.length) {
    try {
      const flagged = await markLeadsNotified(digest.leads);
      console.log(`🏷️  Marked ${flagged} lead(s) as notified — they won't repeat.`);
    } catch (err) {
      console.error("⚠️  Could not mark leads as notified:", err.message);
    }
  }

  console.log(
    `📨 Stuck-lead alert: ${digest.leads.length} new lead(s) to ${delivered} subscriber(s).`
  );

  return { sent: delivered, leads: digest.leads.length };
}

/**
 * Schedule the daily message. One lock so a slow run never overlaps itself.
 */
function startStuckLeadCron() {
  if (!telegram.isConfigured()) {
    console.log("📵 Daily lead alerts off — set TELEGRAM_BOT_TOKEN to enable.");
    return;
  }

  let running = false;
  cron.schedule(
    CRON_EXPR,
    async () => {
      if (running) return;
      running = true;
      try {
        await sendDailyDigest();
      } catch (err) {
        console.error("❌ Daily digest error:", err.message);
      } finally {
        running = false;
      }
    },
    { timezone: TIMEZONE }
  );

  console.log(
    `⏰ Daily stuck-lead list scheduled for ${DAILY_TIME} ${TIMEZONE} (leads quiet ${
      STUCK_AFTER_MS / HOUR
    }h+).`
  );
}

module.exports = {
  startStuckLeadCron,
  sendDailyDigest,
  findStuckLeads,
  buildStuckDigest,
  evaluateLead,
  formatDuration,
  buildLeadButtons,
  buildCopyButtons,
  markLeadsNotified,
  stageOf,
  STAGES,
  TOTAL_STAGES,
  dailyCronExpr,
  STUCK_AFTER_MS,
  MAX_AGE_MS,
  CRON_EXPR,
  DAILY_TIME,
  TIMEZONE,
};