// services/telegramAccess.js
// ---------------------------------------------------------------------------
// Who is allowed to use the bot. One env var:
//
//   TELEGRAM_ALLOWED_USERS=@nagesh_m,@zavia
//
// WHY USERNAMES AND NOT PHONE NUMBERS
//   Telegram attaches the sender's identity to every single message — user id,
//   username, first name. The bot already knows who is talking to it. There is
//   nothing to verify and nothing for the user to do beyond pressing /start.
//
//   A phone number is the one thing Telegram does NOT include. Getting it means
//   asking the user to share a contact card, which is an extra tap, only works
//   on mobile, and proves nothing the user id didn't already prove. So the
//   allowlist is built on what Telegram gives us for free.
//
// WHAT GOES IN THE LIST
//   @username   — easiest to read and to type
//   123456789   — the numeric user id, for anyone without a username set
//
//   Both are checked on every message. Usernames are compared case-insensitively
//   because Telegram treats @Nagesh_M and @nagesh_m as the same account.
//
// A CAVEAT WORTH KNOWING
//   A username can be changed by its owner and then claimed by someone else. The
//   numeric user id never changes and cannot be transferred, so it is the
//   stronger identifier. For a two-person internal bot the username is fine; if
//   you want it airtight, use ids.
//
// FAIL CLOSED
//   An empty or unset TELEGRAM_ALLOWED_USERS lets NOBODY in. The list is also
//   re-checked on every message and every broadcast, so removing someone from
//   .env and restarting cuts them off on the spot.
// ---------------------------------------------------------------------------

const RAW_ALLOWED = process.env.TELEGRAM_ALLOWED_USERS || "";

const ALLOWED_USERNAMES = new Set();
const ALLOWED_IDS = new Set();
const IGNORED_ENTRIES = [];

for (const entry of RAW_ALLOWED.split(",").map((s) => s.trim()).filter(Boolean)) {
  const cleaned = entry.replace(/^@/, "");

  if (/^\d+$/.test(cleaned)) {
    ALLOWED_IDS.add(cleaned);
  } else if (/^[A-Za-z0-9_]{4,32}$/.test(cleaned)) {
    // Telegram usernames: letters, digits and underscores, 5-32 chars.
    ALLOWED_USERNAMES.add(cleaned.toLowerCase());
  } else {
    // Almost always a phone number pasted in from the old setup. Flag it
    // loudly, because otherwise the bot just silently ignores everyone.
    IGNORED_ENTRIES.push(entry);
  }
}

const hasAllowlist = () => ALLOWED_USERNAMES.size > 0 || ALLOWED_IDS.size > 0;

/**
 * Is this person allowed? Takes the `from` object Telegram puts on every
 * message and every button press.
 */
function isAllowedUser(from) {
  if (!from) return false;
  if (from.id != null && ALLOWED_IDS.has(String(from.id))) return true;
  if (from.username && ALLOWED_USERNAMES.has(String(from.username).toLowerCase())) return true;
  return false;
}

// For logs: "@nagesh_m (id 8373043673)" — both, so whichever you want to paste
// into .env is right there.
function describeUser(from) {
  if (!from) return "unknown";
  const name = from.username ? `@${from.username}` : from.first_name || "no username";
  return `${name} (id ${from.id})`;
}

const listAllowed = () => [
  ...[...ALLOWED_USERNAMES].map((u) => `@${u}`),
  ...[...ALLOWED_IDS],
];

function logAccessConfig() {
  if (IGNORED_ENTRIES.length) {
    console.warn(
      `⚠️  TELEGRAM_ALLOWED_USERS: ignored ${IGNORED_ENTRIES.join(", ")} — ` +
        "this must be a Telegram @username or numeric user id, not a phone number."
    );
  }

  if (!hasAllowlist()) {
    console.warn(
      "⚠️  TELEGRAM_ALLOWED_USERS is empty — nobody can use the bot. " +
        "Add your Telegram @username to .env."
    );
    return;
  }

  console.log(`🔐 Telegram access: ${listAllowed().join(", ")}`);
}

module.exports = {
  isAllowedUser,
  describeUser,
  hasAllowlist,
  listAllowed,
  logAccessConfig,
  ALLOWED_USERNAMES,
  ALLOWED_IDS,
};