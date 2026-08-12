// services/telegramAccess.js
// ---------------------------------------------------------------------------
// Who is allowed to use the bot. One env var:
//
//   TELEGRAM_ALLOWED_NUMBERS=+447508671223,+447700900123
//
// HOW THE NUMBER IS OBTAINED
//   A Telegram bot cannot read anyone's phone number on its own. What it CAN
//   do is ask, using a "Share my number" button — Telegram then sends the
//   number itself, from its own records. The user cannot type a fake one into
//   that button; it comes from the account, not from them.
//
//   The one way to cheat it is to forward SOMEBODY ELSE'S contact card into the
//   chat, which arrives in the same shape. That is why verifyContact() below
//   insists contact.user_id matches the id of the person who sent the message.
//   Without that check, anyone holding your number in their address book could
//   subscribe as you.
//
// FAIL CLOSED
//   An empty or unset TELEGRAM_ALLOWED_NUMBERS lets NOBODY in, rather than
//   defaulting to everybody. The allowlist is also re-checked on every
//   broadcast, so deleting a number from .env and restarting cuts that person
//   off immediately — there is no stale subscription left behind in the
//   database.
// ---------------------------------------------------------------------------

const DEFAULT_COUNTRY = (process.env.DEFAULT_COUNTRY_CODE || "+44").replace(/[^\d]/g, "");

/**
 * Reduce any phone number to bare digits in international form, so that
 * "+44 7700 900123", "07700900123" and "447700900123" all compare equal.
 *
 * A leading 0 is a national trunk prefix, not part of the number, so it is
 * swapped for the country code. Getting this wrong is the usual reason an
 * allowlist "doesn't work": the person typed 07... in .env and Telegram
 * reported 447...
 */
function normaliseNumber(raw, defaultCountry = DEFAULT_COUNTRY) {
  if (!raw) return null;

  let s = String(raw).trim();
  const hadPlus = s.startsWith("+");
  s = s.replace(/[^\d]/g, "");
  if (!s) return null;

  if (hadPlus) return s;
  if (s.startsWith("00")) return s.slice(2);
  if (s.startsWith("0")) return defaultCountry + s.slice(1);

  // No prefix at all. If it already starts with the country code, take it as
  // international; otherwise assume it is national and prepend.
  if (s.startsWith(defaultCountry)) return s;
  if (s.length <= 10) return defaultCountry + s;
  return s;
}

// Pretty form for logs and messages: "447700900123" -> "+447700900123"
const displayNumber = (digits) => (digits ? `+${digits}` : "unknown");

const RAW_ALLOWED = process.env.TELEGRAM_ALLOWED_NUMBERS || "";

const ALLOWED_NUMBERS = new Set(
  RAW_ALLOWED.split(",")
    .map((n) => normaliseNumber(n))
    .filter(Boolean)
);

/** Is this phone number on the list? */
const isAllowedNumber = (number) => {
  const n = normaliseNumber(number);
  return Boolean(n && ALLOWED_NUMBERS.has(n));
};

const hasAllowlist = () => ALLOWED_NUMBERS.size > 0;

/**
 * Resolve a number the user TYPED against the allowlist.
 *
 * Typing is ambiguous in a way that sharing a contact is not. Someone with an
 * Indian number who types "7281972289" gets +447281972289 under a UK
 * DEFAULT_COUNTRY_CODE — the right digits, the wrong country, no match.
 *
 * So after the exact check fails, fall back to matching on the national part:
 * find allowlist entries whose digits END with what was typed. This is only
 * accepted when it identifies exactly ONE entry — two matches is an ambiguity
 * we must not guess at, and the 9-digit floor stops a short string like "123"
 * matching half the list.
 *
 * @returns {string|null} the matching allowlist entry, or null.
 */
function resolveTypedNumber(raw) {
  const exact = normaliseNumber(raw);
  if (exact && ALLOWED_NUMBERS.has(exact)) return exact;

  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (digits.length < 9) return null;

  const national = digits.replace(/^0+/, "");
  const matches = [...ALLOWED_NUMBERS].filter(
    (allowed) => allowed.endsWith(national) || allowed === digits
  );

  return matches.length === 1 ? matches[0] : null;
}

const listAllowed = () => [...ALLOWED_NUMBERS].map(displayNumber);

/**
 * Validate a shared contact card.
 *
 * Telegram delivers a shared number and a forwarded contact card in exactly the
 * same shape. The difference is that a genuinely shared number carries the
 * sender's own user_id. Comparing the two is what stops someone subscribing
 * with a number they merely have saved in their phone.
 *
 * @returns {{ ok: boolean, number?: string, reason?: string }}
 */
function verifyContact(message) {
  const contact = message && message.contact;
  if (!contact) return { ok: false, reason: "no-contact" };

  if (!contact.user_id || String(contact.user_id) !== String(message.from?.id)) {
    return { ok: false, reason: "forwarded-contact" };
  }

  const number = normaliseNumber(contact.phone_number);
  if (!number) return { ok: false, reason: "unreadable-number" };

  return { ok: true, number };
}

// Startup visibility: an empty list is almost always a mistake, and it is
// silent otherwise — the bot would simply never respond to anyone.
function logAccessConfig() {
  if (!hasAllowlist()) {
    console.warn(
      "⚠️  TELEGRAM_ALLOWED_NUMBERS is empty — nobody can use the bot. Add your number to .env."
    );
    return;
  }
  console.log(
    `🔐 Telegram access limited to ${ALLOWED_NUMBERS.size} number(s): ${listAllowed().join(", ")}`
  );
}

module.exports = {
  normaliseNumber,
  displayNumber,
  isAllowedNumber,
  resolveTypedNumber,
  hasAllowlist,
  listAllowed,
  verifyContact,
  logAccessConfig,
  ALLOWED_NUMBERS,
};