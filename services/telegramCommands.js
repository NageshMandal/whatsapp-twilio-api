// services/telegramCommands.js
// ---------------------------------------------------------------------------
// The bot's side of the conversation.
//
// ACCESS
//   Only the phone numbers in TELEGRAM_ALLOWED_NUMBERS can use this bot. On
//   /start the bot asks the person to share their number via Telegram's own
//   "Share my number" button, checks it against the list, and subscribes them
//   if it matches.
//
//   Anyone else — an unlisted number, a forwarded contact card, or someone who
//   just types at the bot — gets NOTHING. No reply, no error, no hint that the
//   bot is live. Silence is deliberate: an error message confirms to a stranger
//   that they have found a real, working bot worth probing.
//
// COMMANDS (subscribers only)
//   /start      subscribe
//   /stuck      show stuck leads now
//   /takeover <number>   stop the bot on that lead, you are handling it
//   /resume <number>     hand it back to the bot
//   /stop       stop notifications
//   /who        who else has access
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
  "/backlog — same, but every old lead too (no 14-day limit)",
  "/takeover <code>+447...</code> — stop the bot, you're handling that lead",
  "/resume <code>+447...</code> — hand it back to the bot",
  "/stop — stop notifications",
  "/who — who else has access",
].join("\n");

// Lead phone numbers, as typed into a command. Kept separate from
// access.normaliseNumber because leads are stored in E.164 with the plus.
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
// Access
// ---------------------------------------------------------------------------

/**
 * Is this chat a live, still-allowed subscriber?
 *
 * The env allowlist is re-checked here, not just at signup. That way pulling a
 * number out of .env locks that person out on the next restart, without anyone
 * having to remember to clean up the database.
 */
async function activeSubscriber(chatId) {
  const sub = await TelegramSubscriber.findOne({ chatId: String(chatId) });
  if (!sub || !sub.active) return null;
  if (!access.isAllowedNumber(sub.phoneNumber)) {
    console.warn(
      `🔒 ${access.displayNumber(sub.phoneNumber)} is no longer in TELEGRAM_ALLOWED_NUMBERS — access revoked.`
    );
    return null;
  }
  return sub;
}

/**
 * /start from someone we don't know yet: ask for their number using Telegram's
 * share-contact button. request_contact only works in a private chat, which is
 * fine — this bot is a direct message tool.
 */
async function askForNumber(chatId) {
  return telegram.callApi("sendMessage", {
    chat_id: chatId,
    text:
      "👋 To use this bot, tap the button below to confirm your number.\n\n" +
      "Only approved numbers can access lead data.",
    reply_markup: {
      keyboard: [[{ text: "📱 Share my number", request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

/**
 * A contact card arrived. Verify it really belongs to the sender, check the
 * number against the allowlist, and subscribe on success.
 */
async function handleContact(message) {
  const chatId = String(message.chat.id);
  const check = access.verifyContact(message);

  if (!check.ok) {
    // Forwarded someone else's contact, or something unreadable. Say nothing.
    console.warn(`🚫 Telegram contact rejected from chat ${chatId}: ${check.reason}`);
    return;
  }

  if (!access.isAllowedNumber(check.number)) {
    console.warn(
      `🚫 Telegram access denied for ${access.displayNumber(check.number)} (chat ${chatId}) — not in TELEGRAM_ALLOWED_NUMBERS.`
    );
    return; // silence
  }

  const existing = await TelegramSubscriber.findOne({ chatId });
  if (existing) {
    await TelegramSubscriber.updateOne(
      { chatId },
      { $set: { active: true, phoneNumber: check.number } }
    );
  } else {
    await TelegramSubscriber.create({
      chatId,
      phoneNumber: check.number,
      firstName: message.from?.first_name || null,
      username: message.from?.username || null,
    });
  }

  console.log(
    `✅ Telegram access granted to ${access.displayNumber(check.number)} (${
      message.from?.first_name || chatId
    })`
  );

  // Drop the share-number keyboard now that it has served its purpose.
  await telegram.callApi("sendMessage", {
    chat_id: chatId,
    text: [
      `✅ <b>Verified ${e(access.displayNumber(check.number))}</b>`,
      "",
      "You'll get the stuck-lead list once a day.",
      "",
      HELP,
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: { remove_keyboard: true },
  });
}

async function unsubscribe(chatId) {
  await TelegramSubscriber.updateOne({ chatId: String(chatId) }, { $set: { active: false } });
  return "🔕 Stopped. Press /start whenever you want them back.";
}

async function whoHasAccess() {
  const subs = await TelegramSubscriber.find({ active: true });
  const live = subs.filter((s) => access.isAllowedNumber(s.phoneNumber));

  const lines = ["<b>Access</b>", ""];

  if (live.length) {
    lines.push("<i>Signed in:</i>");
    for (const s of live) {
      lines.push(`✅ ${e(s.firstName || "")} ${e(access.displayNumber(s.phoneNumber))}`.trim());
    }
  }

  // Numbers allowed in .env that nobody has claimed yet — usually someone who
  // hasn't pressed /start, which is the common "why am I not getting these".
  const claimed = new Set(live.map((s) => access.displayNumber(s.phoneNumber)));
  const waiting = access.listAllowed().filter((n) => !claimed.has(n));
  if (waiting.length) {
    lines.push("", "<i>Allowed but not signed in yet:</i>");
    waiting.forEach((n) => lines.push(`⏳ ${e(n)}`));
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

  if (!(await activeSubscriber(chatId))) {
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
  const chat = message.chat || {};
  const chatId = String(chat.id);

  // A shared contact card — the answer to our /start prompt.
  if (message.contact) return handleContact(message);

  const text = (message.text || "").trim();
  if (!text.startsWith("/")) return;

  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = args.join(" ").trim();

  const sub = await activeSubscriber(chatId);

  // /start is the only thing an unknown chat can do, and all it gets is the
  // share-number prompt. If their number isn't on the list, that is where it
  // ends — silently.
  if (!sub) {
    if (cmd === "/start") {
      if (!access.hasAllowlist()) {
        console.warn("🚫 /start ignored — TELEGRAM_ALLOWED_NUMBERS is empty, nobody is allowed.");
        return;
      }
      return askForNumber(chatId);
    }
    console.warn(`🚫 Telegram "${cmd}" from unauthorised chat ${chatId} — ignored.`);
    return;
  }

  switch (cmd) {
    case "/start":
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

    // Same list, but ignoring STUCK_LEAD_MAX_AGE_DAYS. The daily message caps
    // age so a fresh deploy doesn't dump two years of dead leads on you; this
    // is the deliberate way to ask for all of it.
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
  handleContact,
  askForNumber,
  activeSubscriber,
  unsubscribe,
  whoHasAccess,
  normaliseLeadPhone,
  takeoverLead,
  resumeLead,
  snoozeLead,
  HELP,
};