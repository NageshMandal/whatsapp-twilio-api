// services/telegram.js
// ---------------------------------------------------------------------------
// Telegram transport.
//
// SETUP IS ONE LINE:
//
//   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
//
// That is all. No chat IDs, no webhook URL, no secret. You open the bot in
// Telegram, press /start, and you are subscribed — the bot reads your chat id
// off that message and stores it. Nothing to paste into .env, nothing to
// redeploy when someone else joins.
//
// HOW IT RECEIVES MESSAGES
//   By long polling (getUpdates), not a webhook. Polling needs no public URL,
//   no TLS certificate and no inbound firewall rule, which is what let the
//   whole PUBLIC_BASE_URL / webhook-secret setup go away. If PUBLIC_BASE_URL
//   is set the webhook route still works, but nothing requires it.
//
// WHO RECEIVES ALERTS
//   Only the accounts in TELEGRAM_ALLOWED_USERS. Telegram identifies the sender
//   on every message, so a person just presses /start — nothing to type, nothing
//   to verify. Everyone else gets silence.
//
//   The allowlist is re-checked on every broadcast, not just at /start — so
//   removing someone from .env and restarting cuts them off on the spot, with no
//   stale database row left quietly forwarding customer details.
// ---------------------------------------------------------------------------

const axios = require("axios");
const TelegramSubscriber = require("../models/TelegramSubscriber");
const access = require("./telegramAccess");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const API_BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// Telegram hard-caps a message at 4096 chars. Leave headroom for HTML tags.
const MAX_MESSAGE_CHARS = 3500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isConfigured = () => Boolean(TOKEN);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

// parse_mode=HTML rather than MarkdownV2: HTML needs three characters escaped,
// MarkdownV2 needs eighteen — including "-", "." and "+", which appear in every
// phone number and registration we send.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Split on paragraph then line boundaries so a long list never gets cut
// mid-tag, which would make Telegram reject the whole message.
function chunkText(text, max = MAX_MESSAGE_CHARS) {
  const out = [];
  let remaining = String(text || "");

  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) out.push(remaining);
  return out.length ? out : [""];
}

// Telegram's errors are terse. Translate the ones that actually happen.
function explainError(description, chatId) {
  const d = String(description || "");
  if (/bot was blocked by the user/i.test(d)) {
    return `${chatId} has blocked the bot. They need to unblock it and press /start again.`;
  }
  if (/chat not found/i.test(d)) {
    return `${chatId} no longer exists — the subscription will be deactivated.`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function callApi(method, payload, { retryOn429 = true, timeout = 15000 } = {}) {
  if (!API_BASE) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  try {
    const { data } = await axios.post(`${API_BASE}/${method}`, payload, { timeout });
    return data.result;
  } catch (err) {
    const body = err.response?.data;

    // Telegram tells us exactly how long to wait. Worth honouring: ignoring it
    // gets the bot temporarily throttled rather than just dropping one message.
    if (retryOn429 && err.response?.status === 429) {
      const wait = (body?.parameters?.retry_after || 1) * 1000;
      console.warn(`⏳ Telegram rate limited, retrying in ${wait}ms`);
      await sleep(wait + 250);
      return callApi(method, payload, { retryOn429: false, timeout });
    }

    throw new Error(body?.description || err.message);
  }
}

/**
 * Send to one specific chat.
 */
async function sendToChat(chatId, text, buttons) {
  const parts = chunkText(text);
  for (let i = 0; i < parts.length; i++) {
    const payload = {
      chat_id: chatId,
      text: parts[i],
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    // Buttons belong on the LAST chunk, next to the full context.
    if (buttons && buttons.length && i === parts.length - 1) {
      payload.reply_markup = { inline_keyboard: buttons };
    }
    await callApi("sendMessage", payload);
  }
}

/**
 * Broadcast to every active subscriber. This is the only way alerts go out, so
 * "who gets notified" has exactly one answer: whoever pressed /start and was
 * approved.
 */
async function broadcast(text, { buttons } = {}) {
  if (!TOKEN) {
    console.warn("📵 TELEGRAM_BOT_TOKEN not set — skipping notification.");
    return [];
  }

  let subscribers;
  try {
    subscribers = await TelegramSubscriber.find({ active: true });
  } catch (err) {
    console.error("❌ Could not load Telegram subscribers:", err.message);
    return [];
  }

  // Second gate: the env allowlist wins over whatever is in the database.
  const before = subscribers.length;
  subscribers = subscribers.filter((s) =>
    access.isAllowedUser({ id: s.userId, username: s.username })
  );
  if (before !== subscribers.length) {
    console.warn(
      `🔒 ${before - subscribers.length} subscriber(s) skipped — no longer in TELEGRAM_ALLOWED_USERS.`
    );
  }

  if (!subscribers.length) {
    console.warn("📭 No subscribers — an allowed user needs to press /start on the bot.");
    return [];
  }

  const results = [];
  for (const sub of subscribers) {
    try {
      await sendToChat(sub.chatId, text, buttons);
      results.push({ chatId: sub.chatId, name: sub.username || sub.firstName, ok: true });
    } catch (err) {
      const reason = explainError(err.message, sub.chatId);
      console.error(`❌ Telegram to ${sub.username || sub.firstName || sub.chatId} failed: ${reason}`);

      // A blocked or deleted chat never recovers on its own. Deactivating it
      // stops every future broadcast retrying a dead address forever.
      if (/blocked by the user|chat not found/i.test(err.message)) {
        await TelegramSubscriber.updateOne({ chatId: sub.chatId }, { $set: { active: false } });
      }
      results.push({ chatId: sub.chatId, name: sub.username || sub.firstName, ok: false, error: reason });
    }
    await sleep(120);
  }
  return results;
}

// Acknowledge a button tap so the client stops spinning. Telegram wants this
// within ~10s; a missed ack leaves the button looking hung.
async function answerCallback(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return;
  try {
    await callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text.slice(0, 200),
    });
  } catch (err) {
    console.warn("⚠️  answerCallbackQuery failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Long polling
//
// A 30-second long poll: Telegram holds the request open until an update
// arrives, so this is one idle HTTP connection, not a busy loop.
// ---------------------------------------------------------------------------
let pollingStopped = false;

// Diagnostics. Whether Telegram is reaching us at all is the first thing to
// know when "I pressed /start and nothing happened" — it splits the problem
// cleanly into "the bot never heard you" vs "it heard you and refused you".
const diag = {
  polling: false,
  botUsername: null,
  updatesReceived: 0,
  lastUpdateAt: null,
  lastUpdateFrom: null,
  lastError: null,
  startedAt: null,
};

async function startPolling(handleUpdate) {
  if (!TOKEN) {
    console.log("📵 Telegram off — set TELEGRAM_BOT_TOKEN to enable it.");
    return;
  }

  // Clear any webhook from a previous deploy; Telegram refuses getUpdates
  // while one is registered.
  try {
    await callApi("deleteWebhook", { drop_pending_updates: false });
  } catch (_) {}

  let me = null;
  try {
    me = await callApi("getMe", {});
    diag.botUsername = me.username;
    diag.polling = true;
    diag.startedAt = new Date();
    console.log(`🤖 Telegram bot @${me.username} is listening. Press /start in Telegram.`);
  } catch (err) {
    diag.lastError = err.message;
    console.error("❌ Telegram token rejected:", err.message);
    console.error("   Check TELEGRAM_BOT_TOKEN in .env — copy it whole from @BotFather.");
    return;
  }

  let offset = 0;
  let backoff = 1000;

  (async function loop() {
    while (!pollingStopped) {
      try {
        const updates = await callApi(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
          { timeout: 40000, retryOn429: true }
        );

        backoff = 1000; // healthy again

        for (const update of updates || []) {
          offset = update.update_id + 1;

          diag.updatesReceived++;
          diag.lastUpdateAt = new Date();
          const msg = update.message || update.callback_query?.message;
          diag.lastUpdateFrom = String(msg?.chat?.id || "unknown");
          // Logged unconditionally: without it, a rejected /start is invisible
          // and indistinguishable from the bot never receiving anything.
          console.log(
            `📥 Telegram update from chat ${diag.lastUpdateFrom}` +
              (update.message?.text ? `: ${update.message.text}` : "") +
              (update.message?.contact ? " [shared contact]" : "")
          );
          // Never let one bad update stop the loop — the bot going deaf is a
          // far worse failure than one dropped command.
          handleUpdate(update).catch((err) =>
            console.error("❌ Telegram update failed:", err.message)
          );
        }
      } catch (err) {
        diag.lastError = err.message;
        console.error("⚠️  Telegram polling error:", err.message);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60000); // ease off a struggling network
      }
    }
  })();

  return me;
}

function stopPolling() {
  pollingStopped = true;
  diag.polling = false;
}

const getDiagnostics = () => ({ ...diag });

module.exports = {
  isConfigured,
  broadcast,
  sendToChat,
  answerCallback,
  startPolling,
  stopPolling,
  getDiagnostics,
  escapeHtml,
  chunkText,
  explainError,
  callApi,
};