// services/leadIntake.js
// Feature: "get lead and send message". An AUTHORIZED submitter (your client)
// sends the bot a WhatsApp message containing a lead's NAME and NUMBER. The bot
// parses it and starts the normal Charlie flow with that lead.
//
// Only numbers on the submitter allowlist are treated as admins. Every other
// number is handled as a normal inbound lead (unchanged behaviour).
//
// Add more authorized submitters via the env var (comma-separated), e.g.
//   LEAD_SUBMITTER_NUMBERS="+447508671223,+919430123456"
// If the env var is unset, it falls back to the built-in default list below.
//
// NOTE: numbers must be full E.164 (e.g. +447508671223, +919430123456) with no
// spaces or leading zero — they're matched exactly against what Twilio sends.
// >>> Replace +919430XXXXXX below with the real number (all 10 digits after +91).
const SUBMITTER_NUMBERS = (
  process.env.LEAD_SUBMITTER_NUMBERS || "+447508671223,+919430XXXXXX"
)
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

// Is this inbound number allowed to submit leads?
function isAuthorizedSubmitter(phone) {
  return SUBMITTER_NUMBERS.includes((phone || "").trim());
}

// Normalize a messy phone string to E.164. UK-first, but keeps anything already
// in +<country code> form. Returns null if it can't make sense of it.
function normalizePhone(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  const hadPlus = s.startsWith("+");
  const digits = s.replace(/[^\d]/g, ""); // drop spaces, dashes, brackets, dots
  if (!digits) return null;

  if (hadPlus) return "+" + digits;              // already international
  if (digits.startsWith("00")) return "+" + digits.slice(2); // 00 prefix -> +
  if (digits.startsWith("0")) return "+44" + digits.slice(1); // 07... -> +447...
  if (digits.startsWith("44")) return "+" + digits;           // 447... -> +447...
  if (digits.length === 10 && digits.startsWith("7")) return "+44" + digits; // bare UK mobile
  return "+" + digits; // fallback: assume full international number missing the +
}

// Extract { name, number } from an admin message. Finds the first phone-like
// token, uses it as the number, and treats the remaining words as the name.
// Returns { error } if no usable number is found.
function parseLeadSubmission(text) {
  if (!text || !text.trim()) return { error: "empty" };

  const cleaned = text.replace(/[\r\n]+/g, " ").trim();

  // phone-like: optional +, a digit, then 7+ more digit/separator chars, ending on a digit
  const phoneMatch = cleaned.match(/\+?\d[\d\s().-]{7,}\d/);
  if (!phoneMatch) return { error: "no_number" };

  const rawNumber = phoneMatch[0];
  const number = normalizePhone(rawNumber);
  if (!number || number.replace(/\D/g, "").length < 8) {
    return { error: "bad_number" };
  }

  // name = message with the number removed, stripped of common labels/punctuation
  let name = cleaned.replace(rawNumber, " ");
  name = name
    .replace(/\b(name|lead|number|no|mobile|phone|tel|num)\b\s*[:\-]?/gi, " ")
    .replace(/[,:;]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  return { name: name || null, number };
}

module.exports = {
  SUBMITTER_NUMBERS,
  isAuthorizedSubmitter,
  normalizePhone,
  parseLeadSubmission,
};