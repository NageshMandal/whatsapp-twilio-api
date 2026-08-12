// services/telegramCommands.js
// ---------------------------------------------------------------------------
// The bot's side of the conversation.
//
// ACCESS
//   Telegram identifies the sender on every message, so there is no signup
//   step: press /start and you are either on the TELEGRAM_ALLOWED_USERS list or
//   you are not. Nobody types a number, nobody taps a verification button.
//
//   Anyone not on the list gets NOTHING — no reply, no error, no hint the bot
//   is live. An error message would confirm to a stranger that they have found
//   a real, working bot worth probing.
//
// COMMANDS
//   /start      subscribe
//   /stuck      leads quiet 24h+ (last 14 days)
//   /backlog    same, but every old lead too
//   /takeover <number>   stop the bot on that lead, you are handling it
//   /resume <number>     hand it back to the bot
//   /stop       stop notifications
//   /who        who has access
//   /help
// ---------------------------------------------------------------------------

const Message = require("../models/Message");
const TelegramSubscriber = require("../models/TelegramSubscriber");
const telegram = require("./telegram");
const access = require("./telegramAccess");
const stuckLeads = require("./stuckLeads");

const e = telegram.escapeHtml;

const HELP = [
  "<b>What I do</b>",
  "",
  "Once a day I send you every lead that has gone quiet for 24h+ and never qualified.",
  "",
  "<b>Commands</b>",
  "/stuck — show them right now",
  "/backlog — same, plus every old lead (no 14-day limit)",
  "/takeover <code>+447...</code> — stop the bot, you're handling that lead",
  "/resume <code>+447...</code> — hand it back to the bot",
  "/stop — stop notifications",
  "/who — who has access",
].join("\n");

// Lead phone numbers, as typed into a command.
function normaliseLeadPhone(raw, defaultCountry = process.env.DEFAULT_COUNTRY_CODE || "+44") {
  if (!raw) return null;
  const s = String(raw).trim().replace(/[\s()\-.]/g, "");
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return "+" + s.slice(2);
  if (s.startsWith("0")) return defaultCountry + s.slice(1);
  if (/^\d{8,15}$/.test(s)) return "+" + s;
  return null;
}

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

/**
 * Record where to send this person's notifications. Called on /start once they
 * have already passed the allowlist check — this function does not gate access,
 * it only remembers the chat id.
 */
async function rememberChat(message) {
  const chatId = String(message.chat.id);
  const from = message.from || {};

  const existing = await TelegramSubscriber.findOne({ chatId });

  if (existing) {
    await TelegramSubscriber.updateOne(
      { chatId },
      {
        $set: {
          active: true,
          userId: String(from.id || existing.userId || ""),
          username: from.username || null,
          firstName: from.first_name || null,
        },
      }
    );
    return false; // already known
  }

  await TelegramSubscriber.create({
    chatId,
    userId: String(from.id || ""),
    username: from.username || null,
    firstName: from.first_name || null,
  });
  return true; // newly subscribed
}

async function unsubscribe(chatId) {
  await TelegramSubscriber.updateOne({ chatId: String(chatId) }, { $set: { active: false } });
  return "🔕 Stopped. Press /start whenever you want them back.";
}

async function whoHasAccess() {
  const subs = await TelegramSubscriber.find({ active: true });

  const lines = ["<b>Access</b>", "", "<i>Allowed in .env:</i>"];
  for (const entry of access.listAllowed()) lines.push(`• ${e(entry)}`);

  lines.push("", "<i>Signed in:</i>");
  if (!subs.length) {
    lines.push("(nobody yet — they need to press /start)");
  } else {
    for (const s of subs) {
      lines.push(`✅ ${e(s.username ? "@" + s.username : s.firstName || s.chatId)}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Lead actions
// ---------------------------------------------------------------------------

async function takeoverLead(phone) {
  const convo = await Message.findOneAndUpdate(
    { phoneNumber: phone },
    { $set: { botActive: false, stuckNotified: true, stuckNotifiedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!convo) return { ok: false, message: `No lead found for <code>${e(phone)}</code>.` };

  return {
    ok: true,
    message: `🙋 <b>Yours</b> — <code>${e(phone)}</code>. The bot will stop messaging ${e(
      convo.customerName || "them"
    )}.`,
  };
}

async function resumeLead(phone) {
  const convo = await Message.findOneAndUpdate(
    { phoneNumber: phone },
    { $set: { botActive: true, stuckNotified: false, stuckSnoozedUntil: null } },
    { returnDocument: "after" }
  );
  if (!convo) return { ok: false, message: `No lead found for <code>${e(phone)}</code>.` };
  return { ok: true, message: `🤖 Back with the bot — <code>${e(phone)}</code>.` };
}

async function snoozeLead(phone) {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const convo = await Message.findOneAndUpdate(
    { phoneNumber: phone },
    { $set: { stuckSnoozedUntil: until, stuckNotified: true } },
    { returnDocument: "after" }
  );
  if (!convo) return { ok: false, message: `No lead found for <code>${e(phone)}</code>.` };
  return { ok: true, message: `😴 Snoozed <code>${e(phone)}</code> for 24h.` };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

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

  if (!access.isAllowedUser(query.from)) {
    console.warn(`🚫 Telegram button press from ${access.describeUser(query.from)} — ignored.`);
    return telegram.answerCallback(query.id, "");
  }

  const [action, phoneRaw] = String(query.data || "").split(":");
  const phone = normaliseLeadPhone(phoneRaw);
  if (!phone) return telegram.answerCallback(query.id, "Couldn't read that lead.");

  let result;
  if (action === "takeover") result = await takeoverLead(phone);
  else if (action === "snooze") result = await snoozeLead(phone);
  else return telegram.answerCallback(query.id, "Unknown action.");

  await telegram.answerCallback(query.id, result.ok ? "Done" : "Failed");
  await telegram.sendToChat(chatId, result.message);
}

async function handleMessage(message) {
  const chatId = String(message.chat.id);
  const from = message.from || {};
  const text = (message.text || "").trim();

  // The single access check. Telegram already told us who this is.
  if (!access.isAllowedUser(from)) {
    // Logged with BOTH identifiers so whichever you want to paste into
    // TELEGRAM_ALLOWED_USERS is right there in the log.
    console.warn(
      `🚫 Telegram: ${access.describeUser(from)} is not in TELEGRAM_ALLOWED_USERS — ignored.`
    );
    return;
  }

  if (!text.startsWith("/")) return; // ignore ordinary chatter

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = args.join(" ").trim();

  switch (cmd) {
    case "/start": {
      const isNew = await rememberChat(message);
      return telegram.sendToChat(
        chatId,
        isNew
          ? `✅ <b>You're set up${from.first_name ? ", " + e(from.first_name) : ""}.</b>\n\n${HELP}`
          : HELP
      );
    }

    case "/help":
      return telegram.sendToChat(chatId, HELP);

    case "/stop":
      return telegram.sendToChat(chatId, await unsubscribe(chatId));

    case "/who":
      return telegram.sendToChat(chatId, await whoHasAccess());

    case "/stuck": {
      const digest = await stuckLeads.buildStuckDigest();
      return telegram.sendToChat(chatId, digest.text);
    }

    // Ignores STUCK_LEAD_MAX_AGE_DAYS. The daily message caps age so a fresh
    // deploy doesn't dump years of dead leads on you; this asks for all of it.
    case "/backlog": {
      const digest = await stuckLeads.buildStuckDigest({ maxAgeMs: Infinity });
      return telegram.sendToChat(chatId, digest.text);
    }

    case "/takeover": {
      const phone = normaliseLeadPhone(arg);
      if (!phone) return telegram.sendToChat(chatId, "Usage: <code>/takeover +447700900123</code>");
      const r = await takeoverLead(phone);
      return telegram.sendToChat(chatId, r.message);
    }

    case "/resume": {
      const phone = normaliseLeadPhone(arg);
      if (!phone) return telegram.sendToChat(chatId, "Usage: <code>/resume +447700900123</code>");
      const r = await resumeLead(phone);
      return telegram.sendToChat(chatId, r.message);
    }

    default:
      return telegram.sendToChat(chatId, HELP);
  }
}

module.exports = {
  handleUpdate,
  rememberChat,
  unsubscribe,
  whoHasAccess,
  normaliseLeadPhone,
  takeoverLead,
  resumeLead,
  snoozeLead,
  HELP,
};