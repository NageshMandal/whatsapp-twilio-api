// services/telegram.js
// ---------------------------------------------------------------------------
// Telegram transport for INTERNAL team alerts.
//
// RECIPIENT POLICY (the important part):
//   Alerts go ONLY to the chat IDs listed in TELEGRAM_CHAT_ID. Nothing else can
//   ever receive one. This is enforced in ONE place — resolveTargets() — which
//   every outbound message funnels through, so a bug or a bad caller elsewhere
//   in the app still cannot leak a lead's details to an unlisted chat. Anyone
//   who finds the bot and messages it gets silence.
//
//   The list is also fail-CLOSED: an empty or unset TELEGRAM_CHAT_ID sends to
//   nobody, rather than falling back to "everyone".
//
// A NOTE ON PHONE NUMBERS:
//   Telegram has no way to message a phone number. Unlike WhatsApp, a bot
//   cannot open a conversation with a person — the person must message the bot
//   first (or be in a group with it). What you put in TELEGRAM_CHAT_ID is a
//   numeric CHAT ID, not a phone number. Each teammate sends /myid to the bot
//   once, and you paste the number it replies with into .env. See
//   TELEGRAM_SETUP.md.
//
// Why Telegram and not another WhatsApp number:
//   1. Twilio's WhatsApp API cannot post into a group chat, so every internal
//      alert today has to be fanned out to individual phones (see
//      notifications.js). Telegram posts straight into a group or a topic
//      inside a supergroup, so the whole team sees one thread.
//   2. WhatsApp's 24-hour session window means a free-text alert to a teammate
//      only delivers if THEY messaged the bot in the last day — otherwise you
//      need a Meta-approved template. Telegram has no such window and no
//      template approval, which matters here because a "stuck lead" alert is
//      by definition fired at least 24h after anyone last spoke.
//
// Everything degrades gracefully: if TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are
// unset, every function here becomes a logged no-op.
//
// .env
//   TELEGRAM_BOT_TOKEN=123456:ABC-DEF...            (from @BotFather)
//   TELEGRAM_CHAT_ID=-1001234567890,987654321       (the ONLY recipients)
//   TELEGRAM_STUCK_CHAT_ID=-1001234567890:12        (optional; ":12" = topic id)
//   TELEGRAM_WEBHOOK_SECRET=some-long-random-string (for /webhook/telegram)
//   TELEGRAM_MIRROR_ALERTS=true                     (also mirror WA alerts here)
//   TELEGRAM_ALLOW_ID_LOOKUP=true                   (let anyone run /myid)
// ---------------------------------------------------------------------------

const axios = require("axios");

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const API_BASE = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// Telegram hard-caps a message at 4096 chars. Leave headroom for HTML tags.
const MAX_MESSAGE_CHARS = 3500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Recipient parsing
//
// Entry format:  [label=]chatId[:threadId]
//
//   -1001234567890                  a group
//   Sales=-1001234567890:12         a topic inside a supergroup, labelled
//   Josiah=987654321                one person (they must /start the bot first)
//
// The chat id can be negative, so the thread id is split from the RIGHT and
// only accepted when the tail is a plain integer.
// ---------------------------------------------------------------------------
function parseChatTargets(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      let label = null;
      let rest = entry;

      const eq = entry.indexOf("=");
      if (eq > 0) {
        label = entry.slice(0, eq).trim() || null;
        rest = entry.slice(eq + 1).trim();
      }

      let chatId = rest;
      let threadId = null;

      const idx = rest.lastIndexOf(":");
      if (idx > 0) {
        const head = rest.slice(0, idx).trim();
        const tail = rest.slice(idx + 1).trim();
        if (/^\d+$/.test(tail)) {
          chatId = head;
          threadId = parseInt(tail, 10);
        }
      }

      return { chatId: String(chatId).trim(), threadId, label: label || String(chatId).trim() };
    })
    .filter((t) => /^-?\d+$/.test(t.chatId)); // ids are numeric; drop typos loudly below
}

// Warn about entries that were dropped, so a typo'd id is visible at boot
// rather than showing up as silence three days later.
function reportBadEntries(value, parsed, varName) {
  const rawCount = (value || "").split(",").map((s) => s.trim()).filter(Boolean).length;
  if (rawCount > parsed.length) {
    console.warn(
      `⚠️  ${varName}: ${rawCount - parsed.length} entr${
        rawCount - parsed.length === 1 ? "y was" : "ies were"
      } ignored — a chat id must be numeric (e.g. -1001234567890), not a phone number or @username.`
    );
  }
}

const RAW_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const RAW_STUCK_CHAT_ID = process.env.TELEGRAM_STUCK_CHAT_ID || "";

// THE allowlist. Every outbound message is filtered against this.
const RECIPIENTS = parseChatTargets(RAW_CHAT_ID);
reportBadEntries(RAW_CHAT_ID, RECIPIENTS, "TELEGRAM_CHAT_ID");

// Optional narrower destination for stuck-lead alerts. Falls back to the main
// list, so the common single-group setup needs only TELEGRAM_CHAT_ID.
const STUCK_RECIPIENTS = RAW_STUCK_CHAT_ID
  ? parseChatTargets(RAW_STUCK_CHAT_ID)
  : RECIPIENTS;
if (RAW_STUCK_CHAT_ID) {
  reportBadEntries(RAW_STUCK_CHAT_ID, STUCK_RECIPIENTS, "TELEGRAM_STUCK_CHAT_ID");
}

// Every id that is allowed to receive anything: the union of both lists.
// Nothing outside this set is ever sent to.
const ALLOWED_IDS = new Set(
  [...RECIPIENTS, ...STUCK_RECIPIENTS].map((t) => String(t.chatId))
);

// Commands are restricted to the same set — the people who get the alerts are
// the people who can act on them. TELEGRAM_ALLOWED_CHAT_IDS can narrow it
// further (e.g. alerts to a big group, commands only from managers).
const COMMAND_IDS = process.env.TELEGRAM_ALLOWED_CHAT_IDS
  ? new Set(parseChatTargets(process.env.TELEGRAM_ALLOWED_CHAT_IDS).map((t) => String(t.chatId)))
  : ALLOWED_IDS;

const WEBHOOK_SECRET = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();

const MIRROR_ALERTS =
  String(process.env.TELEGRAM_MIRROR_ALERTS || "true").toLowerCase() !== "false";

// /myid has to work for people who are NOT yet in the list — that is the whole
// point of it, it is how they find the number to give you. It reveals nothing
// but the caller's own chat id. Set false to lock the bot down completely.
const ALLOW_ID_LOOKUP =
  String(process.env.TELEGRAM_ALLOW_ID_LOOKUP || "true").toLowerCase() !== "false";

const isConfigured = () => Boolean(TOKEN && RECIPIENTS.length);

// Fail CLOSED. An empty allowlist authorises nobody.
const isAllowedChat = (chatId) => ALLOWED_IDS.has(String(chatId));
const isAllowedCommandChat = (chatId) => COMMAND_IDS.has(String(chatId));

/**
 * The single choke point for "who may receive a message".
 * Anything not on the allowlist is dropped and logged.
 */
function resolveTargets(chatIds) {
  const requested = chatIds && chatIds.length ? chatIds : RECIPIENTS;

  const allowed = [];
  for (const target of requested) {
    if (isAllowedChat(target.chatId)) {
      allowed.push(target);
    } else {
      console.warn(
        `🚫 Telegram: refusing to send to ${target.chatId} — not in TELEGRAM_CHAT_ID.`
      );
    }
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

// We use parse_mode=HTML rather than MarkdownV2 because HTML needs only three
// characters escaped, whereas MarkdownV2 requires escaping 18 of them —
// including "-", "." and "+", all of which appear constantly in phone numbers,
// registrations and free-text customer messages.
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Split on paragraph then line boundaries so a long chat summary never gets
// cut mid-tag (which would make Telegram reject the whole message).
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

// Telegram's errors are terse. Translate the two that actually happen in this
// setup into something that says what to do about it.
function explainError(description, chatId) {
  const d = String(description || "");

  if (/bot can't initiate conversation/i.test(d)) {
    return `${chatId} has never messaged the bot. Telegram does not let a bot open a chat — ask them to send /start to the bot, then re-add their id.`;
  }
  if (/chat not found/i.test(d)) {
    return `${chatId} was not found. Check the id is the numeric chat id (negative for groups), and that the bot is a member of that group.`;
  }
  if (/bot was kicked|bot is not a member/i.test(d)) {
    return `The bot has been removed from ${chatId}. Re-add it as an admin.`;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Low-level API call
// ---------------------------------------------------------------------------
async function callApi(method, payload, { retryOn429 = true } = {}) {
  if (!API_BASE) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  try {
    const { data } = await axios.post(`${API_BASE}/${method}`, payload, {
      timeout: 15000,
    });
    return data.result;
  } catch (err) {
    const body = err.response?.data;

    // 429: Telegram tells us exactly how long to wait. Groups are limited to
    // ~20 messages/minute, which a large sweep can brush against.
    if (retryOn429 && err.response?.status === 429) {
      const wait = (body?.parameters?.retry_after || 1) * 1000;
      console.warn(`⏳ Telegram rate limited, retrying in ${wait}ms`);
      await sleep(wait + 250);
      return callApi(method, payload, { retryOn429: false });
    }

    throw new Error(body?.description || err.message);
  }
}

/**
 * Send a message to the configured recipients.
 *
 * @param {string} text        HTML-formatted body (escape user content first).
 * @param {object} [opts]
 * @param {Array}  [opts.chatIds]  Targets from parseChatTargets(). Filtered
 *                                 against the allowlist regardless. Defaults to
 *                                 TELEGRAM_CHAT_ID.
 * @param {Array}  [opts.buttons]  Inline keyboard rows.
 * @returns {Promise<Array>} one entry per chat: { chatId, ok, error? }
 */
async function sendTelegram(text, { chatIds, buttons, disablePreview = true } = {}) {
  if (!TOKEN) {
    console.warn("📵 Telegram not configured (TELEGRAM_BOT_TOKEN missing) — skipping alert.");
    return [];
  }

  const targets = resolveTargets(chatIds);
  if (!targets.length) {
    console.warn("📵 Telegram has no allowed recipient — set TELEGRAM_CHAT_ID. Skipping alert.");
    return [];
  }

  const parts = chunkText(text);
  const results = [];

  for (const target of targets) {
    try {
      for (let i = 0; i < parts.length; i++) {
        const payload = {
          chat_id: target.chatId,
          text: parts[i],
          parse_mode: "HTML",
          disable_web_page_preview: disablePreview,
        };
        if (target.threadId) payload.message_thread_id = target.threadId;
        // Buttons belong on the LAST chunk, next to the full context.
        if (buttons && buttons.length && i === parts.length - 1) {
          payload.reply_markup = { inline_keyboard: buttons };
        }
        await callApi("sendMessage", payload);
      }
      results.push({ chatId: target.chatId, label: target.label, ok: true });
    } catch (err) {
      const reason = explainError(err.message, target.chatId);
      console.error(`❌ Telegram send to ${target.label || target.chatId} failed: ${reason}`);
      results.push({ chatId: target.chatId, label: target.label, ok: false, error: reason });
    }
  }

  return results;
}

/**
 * Reply into a chat that just sent us a command. Goes through the same
 * allowlist as everything else, with one carve-out: /myid, which must answer
 * someone who is not yet listed (that is how they get their id).
 */
async function replyToChat(chatId, threadId, text, buttons, { bypassAllowlist = false } = {}) {
  if (bypassAllowlist && !isAllowedChat(chatId)) {
    if (!TOKEN) return [];
    try {
      const payload = {
        chat_id: chatId,
        text: chunkText(text)[0],
        parse_mode: "HTML",
        disable_web_page_preview: true,
      };
      if (threadId) payload.message_thread_id = threadId;
      await callApi("sendMessage", payload);
      return [{ chatId, ok: true }];
    } catch (err) {
      console.warn(`⚠️  Telegram id-lookup reply to ${chatId} failed:`, err.message);
      return [{ chatId, ok: false, error: err.message }];
    }
  }

  return sendTelegram(text, { chatIds: [{ chatId, threadId: threadId || null }], buttons });
}

// Acknowledge a button tap so the client stops showing its spinner. Telegram
// requires this within ~10s; a missed ack leaves the button looking hung.
async function answerCallback(callbackQueryId, text = "", showAlert = false) {
  if (!TOKEN || !callbackQueryId) return;
  try {
    await callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text: text.slice(0, 200),
      show_alert: showAlert,
    });
  } catch (err) {
    console.warn("⚠️  answerCallbackQuery failed:", err.message);
  }
}

/**
 * Check every configured recipient is actually reachable, at boot. This turns
 * the most common setup mistakes — a wrong id, a bot not added to the group, a
 * teammate who never pressed /start — into a startup warning instead of an
 * alert that quietly never arrives.
 */
async function verifyRecipients() {
  if (!isConfigured()) return [];

  const seen = new Map();
  for (const t of [...RECIPIENTS, ...STUCK_RECIPIENTS]) {
    if (!seen.has(String(t.chatId))) seen.set(String(t.chatId), t);
  }

  const report = [];
  for (const target of seen.values()) {
    try {
      const chat = await callApi("getChat", { chat_id: target.chatId });
      const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username;
      console.log(`   ✅ ${target.chatId} — ${name || "(unnamed)"} [${chat.type}]`);
      report.push({ chatId: target.chatId, ok: true, name, type: chat.type });
    } catch (err) {
      const reason = explainError(err.message, target.chatId);
      console.warn(`   ⚠️  ${target.chatId} — ${reason}`);
      report.push({ chatId: target.chatId, ok: false, error: reason });
    }
  }
  return report;
}

/**
 * Point Telegram at our /webhook/telegram route. Safe to call on every boot —
 * setWebhook is idempotent.
 */
async function setWebhook(publicBaseUrl) {
  if (!TOKEN || !publicBaseUrl) return null;
  const url = `${publicBaseUrl.replace(/\/+$/, "")}/webhook/telegram`;
  try {
    await callApi("setWebhook", {
      url,
      secret_token: WEBHOOK_SECRET || undefined,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    console.log(`🤖 Telegram webhook registered at ${url}`);
    return url;
  } catch (err) {
    console.error("❌ Telegram setWebhook failed:", err.message);
    return null;
  }
}

// Check the header Telegram echoes back on every update. Without this, anyone
// who guesses the route can post fake commands.
function verifyWebhookRequest(req) {
  if (!WEBHOOK_SECRET) return true; // not configured — accept (dev / local)
  return req.get("X-Telegram-Bot-Api-Secret-Token") === WEBHOOK_SECRET;
}

// A readable summary of who is configured, for logs and the debug endpoint.
function describeRecipients() {
  return {
    configured: isConfigured(),
    alertRecipients: RECIPIENTS.map((t) => ({
      chatId: t.chatId,
      label: t.label,
      threadId: t.threadId,
    })),
    stuckRecipients: STUCK_RECIPIENTS.map((t) => ({
      chatId: t.chatId,
      label: t.label,
      threadId: t.threadId,
    })),
    canRunCommands: [...COMMAND_IDS],
    mirrorWhatsAppAlerts: MIRROR_ALERTS,
    idLookupOpen: ALLOW_ID_LOOKUP,
  };
}

// ---------------------------------------------------------------------------
// Mirror of the existing WhatsApp team alerts.
// Fire-and-forget: a Telegram outage must never block or fail a WhatsApp alert.
// ---------------------------------------------------------------------------
function mirrorAlert(title, body, { buttons } = {}) {
  if (!MIRROR_ALERTS || !isConfigured()) return;
  const text = `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(body)}`;
  sendTelegram(text, { buttons }).catch((err) =>
    console.warn("⚠️  Telegram mirror failed:", err.message)
  );
}

module.exports = {
  isConfigured,
  sendTelegram,
  replyToChat,
  answerCallback,
  setWebhook,
  verifyWebhookRequest,
  verifyRecipients,
  describeRecipients,
  isAllowedChat,
  isAllowedCommandChat,
  resolveTargets,
  mirrorAlert,
  escapeHtml,
  chunkText,
  parseChatTargets,
  explainError,
  RECIPIENTS,
  STUCK_RECIPIENTS,
  MIRROR_ALERTS,
  ALLOW_ID_LOOKUP,
};