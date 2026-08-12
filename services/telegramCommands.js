// services/telegramCommands.js
// ---------------------------------------------------------------------------
// Inbound half of the Telegram bot: the team can act on an alert without
// leaving the group.
//
// This exists because an alert nobody can act on just moves the problem. The
// single most important action is "stop the bot, I'm handling this" — without
// it, a salesperson rings the lead while Charlie is still sending automated
// nudges to the same person, which is worse than no alert at all.
//
// Commands
//   /stuck               list every currently stuck lead
//   /lead <number>       full state + AI summary for one lead
//   /takeover <number>   bot stops replying, lead is yours
//   /resume <number>     hand it back to the bot
//   /help
//
// Buttons on an alert card map to takeover / snooze.
// ---------------------------------------------------------------------------

const Message = require("../models/Message");
const telegram = require("./telegram");
const stuckLeads = require("./stuckLeads");
const { summariseConversation } = require("./aiBrain");

const e = telegram.escapeHtml;
const HOUR = 60 * 60 * 1000;

const SNOOZE_MS = 24 * HOUR;

// Accepts "+447700900123", "447700900123", "07700 900123" and normalises to
// E.164 the way the rest of the app stores numbers.
function normalisePhone(raw, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || "+44") {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[\s()\-.]/g, "");
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  if (s.startsWith("0")) return defaultCountry + s.slice(1);
  if (/^\d{8,15}$/.test(s)) return "+" + s;
  return null;
}

async function reply(chatId, threadId, text, buttons) {
  return telegram.sendTelegram(text, {
    chatIds: [{ chatId, threadId: threadId || null }],
    buttons,
  });
}

const HELP_TEXT = [
  "<b>Lead bot commands</b>",
  "",
  "/stuck — every lead with no reply for 24h+",
  "/lead <code>&lt;number&gt;</code> — full state and chat summary",
  "/takeover <code>&lt;number&gt;</code> — stop the bot, you handle it",
  "/resume <code>&lt;number&gt;</code> — hand it back to the bot",
  "/help — this message",
].join("\n");

// ---------------------------------------------------------------------------
// Actions (shared by commands and buttons)
// ---------------------------------------------------------------------------

async function takeoverLead(phone) {
  const convo = await Message.findOneAndUpdate(
    { phoneNumber: phone },
    {
      $set: {
        botActive: false,
        stuckNotified: true,
        stuckNotifiedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  if (!convo) return { ok: false, message: `No conversation found for ${phone}.` };

  return {
    ok: true,
    convo,
    message:
      `🙋 <b>Taken over</b> — <code>${e(phone)}</code>` +
      `\nThe bot will stop replying to ${e(convo.customerName || "this lead")}. ` +
      `Use /resume <code>${e(phone)}</code> to hand it back.`,
  };
}

async function resumeLead(phone) {
  const convo = await Message.findOneAndUpdate(
    { phoneNumber: phone },
    { $set: { botActive: true, stuckNotified: false, stuckSnoozedUntil: null } },
    { returnDocument: "after" }
  );
  if (!convo) return { ok: false, message: `No conversation found for ${phone}.` };

  return {
    ok: true,
    convo,
    message: `🤖 <b>Back with the bot</b> — <code>${e(phone)}</code>`,
  };
}

async function snoozeLead(phone, ms = SNOOZE_MS) {
  const until = new Date(Date.now() + ms);
  const convo = await Message.findOneAndUpdate(
    { phoneNumber: phone },
    { $set: { stuckSnoozedUntil: until, stuckNotified: true } },
    { returnDocument: "after" }
  );
  if (!convo) return { ok: false, message: `No conversation found for ${phone}.` };

  return {
    ok: true,
    convo,
    message: `😴 <b>Snoozed</b> — <code>${e(phone)}</code> won't be flagged again until ${e(
      until.toLocaleString("en-GB", { timeZone: "Europe/London" })
    )}.`,
  };
}

async function describeLead(phone) {
  const convo = await Message.findOne({ phoneNumber: phone });
  if (!convo) return `No conversation found for <code>${e(phone)}</code>.`;

  let summary = "";
  try {
    summary = await summariseConversation(convo.messages || []);
  } catch (_) {
    summary = "(summary unavailable)";
  }

  const quietFor = convo.lastInboundAt
    ? stuckLeads.formatDuration(Date.now() - new Date(convo.lastInboundAt).getTime())
    : "never replied";

  return [
    `<b>${e(convo.customerName || "Unknown")}</b> — <code>${e(convo.phoneNumber)}</code>`,
    "",
    `<b>Status:</b> ${e(convo.status)}`,
    `<b>Step:</b> ${e(convo.step)}`,
    `<b>Bot active:</b> ${convo.botActive === false ? "no (human has it)" : "yes"}`,
    `<b>Finance:</b> ${e(convo.financePreference || "Not specified")}`,
    `<b>Nudges sent:</b> ${convo.followUpCount || 0} of 5`,
    `<b>Quiet for:</b> ${e(quietFor)}`,
    `<b>Messages:</b> ${(convo.messages || []).length}`,
    "",
    "<b>Summary:</b>",
    e(summary),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Update router
// ---------------------------------------------------------------------------

/**
 * Handle one Telegram update. Never throws — a bad command must not take the
 * webhook down, because Telegram retries failed deliveries and would loop.
 * @param {object} update  The raw Telegram Update object.
 */
async function handleUpdate(update) {
  try {
    if (update.callback_query) return await handleCallback(update.callback_query);
    if (update.message) return await handleMessage(update.message);
  } catch (err) {
    console.error("❌ Telegram update handling failed:", err.message);
  }
}

async function handleCallback(query) {
  const chatId = query.message?.chat?.id;
  const threadId = query.message?.message_thread_id || null;

  if (!telegram.isAllowedCommandChat(chatId)) {
    return telegram.answerCallback(query.id, "This chat isn't authorised.", true);
  }

  const [action, phoneRaw] = String(query.data || "").split(":");
  const phone = normalisePhone(phoneRaw);
  if (!phone) return telegram.answerCallback(query.id, "Couldn't read that lead.", true);

  const who = query.from?.first_name || query.from?.username || "Someone";

  let result;
  if (action === "takeover") result = await takeoverLead(phone);
  else if (action === "snooze") result = await snoozeLead(phone);
  else return telegram.answerCallback(query.id, "Unknown action.");

  await telegram.answerCallback(query.id, result.ok ? "Done" : "Failed");

  const note = result.ok ? `${who}: ${result.message}` : result.message;
  await reply(chatId, threadId, note);
}

async function handleMessage(message) {
  const chatId = message.chat?.id;
  const threadId = message.message_thread_id || null;
  const text = (message.text || "").trim();

  if (!text.startsWith("/")) return; // ignore ordinary group chatter

  if (!telegram.isAllowedCommandChat(chatId)) {
    console.warn(`🚫 Telegram command from unauthorised chat ${chatId}`);
    return;
  }

  // Strip the "@BotName" suffix Telegram adds in groups.
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = args.join(" ").trim();

  switch (cmd) {
    case "/start":
    case "/help":
      return reply(chatId, threadId, HELP_TEXT);

    case "/stuck": {
      const digest = await stuckLeads.buildStuckDigest();
      return reply(chatId, threadId, digest);
    }

    case "/lead": {
      const phone = normalisePhone(arg);
      if (!phone) return reply(chatId, threadId, "Usage: <code>/lead +447700900123</code>");
      return reply(chatId, threadId, await describeLead(phone));
    }

    case "/takeover": {
      const phone = normalisePhone(arg);
      if (!phone) return reply(chatId, threadId, "Usage: <code>/takeover +447700900123</code>");
      const r = await takeoverLead(phone);
      return reply(chatId, threadId, r.message);
    }

    case "/resume": {
      const phone = normalisePhone(arg);
      if (!phone) return reply(chatId, threadId, "Usage: <code>/resume +447700900123</code>");
      const r = await resumeLead(phone);
      return reply(chatId, threadId, r.message);
    }

    default:
      return reply(chatId, threadId, `Unknown command. ${HELP_TEXT}`);
  }
}

module.exports = {
  handleUpdate,
  normalisePhone,
  takeoverLead,
  resumeLead,
  snoozeLead,
  describeLead,
  HELP_TEXT,
};
