// services/senders.js
// ---------------------------------------------------------------------------
// The account now has more than one WhatsApp sender:
//
//   +14155238886  sandbox / existing lead nurture
//   +15553774265  "Zavia Zenith" — car sourcing  (80 msg/sec, Online)
//
// A reply MUST go out from the number the customer messaged. Sending from a
// different sender starts a SECOND conversation thread on the customer's
// phone, and on a production sender it will also fail the 24-hour session
// window because that window belongs to the number they wrote to.
//
// So nothing here hard-codes a "current" number. Twilio tells us which sender
// received the message in `req.body.To`; that value is carried through to the
// reply. TWILIO_WHATSAPP_FROM is only the fallback for messages WE start.
//
// .env:
//   TWILIO_WHATSAPP_FROM=whatsapp:+15553774265
//   WHATSAPP_SENDERS=+15553774265:Zavia Zenith:sourcing,+14155238886:Charlie:leads
// ---------------------------------------------------------------------------

const DEFAULT_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

// Parse "number:label:role" triples. Role is free text; "sourcing" is the one
// the car-brief flow looks for.
function parseSenders() {
  const raw = process.env.WHATSAPP_SENDERS || "";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [number, label, role] = entry.split(":").map((x) => (x || "").trim());
      return { number: normalise(number), label: label || number, role: (role || "").toLowerCase() };
    })
    .filter((s) => s.number);

  if (list.length) return list;

  // Nothing configured — fall back to whatever single sender is set, so an
  // existing deployment keeps working untouched.
  return [{ number: normalise(DEFAULT_FROM), label: "Default", role: "" }];
}

// "whatsapp:+15553774265" | "+15553774265" | "15553774265" -> "+15553774265"
function normalise(n) {
  if (!n) return "";
  const s = String(n).replace(/^whatsapp:/i, "").trim();
  if (!s) return "";
  return s.startsWith("+") ? s : "+" + s.replace(/[^\d]/g, "");
}

// Twilio wants the whatsapp: prefix on both ends.
const toTwilio = (n) => {
  const v = normalise(n);
  return v ? `whatsapp:${v}` : DEFAULT_FROM;
};

const SENDERS = parseSenders();

const listSenders = () => SENDERS.slice();

const findSender = (number) => {
  const n = normalise(number);
  return SENDERS.find((s) => s.number === n) || null;
};

const senderLabel = (number) => (findSender(number) || {}).label || normalise(number) || "unknown";

// The sender we use when WE start a conversation (follow-ups, notifications).
const defaultFrom = () => toTwilio(DEFAULT_FROM);

// The sender that handles car-sourcing briefs, if one is tagged for it.
const sourcingFrom = () => {
  const s = SENDERS.find((x) => x.role === "sourcing");
  return s ? toTwilio(s.number) : defaultFrom();
};

// Given Twilio's inbound `To`, return the value to reply FROM. Falls back to
// the default sender when the webhook did not include it (older payloads).
const replyFrom = (inboundTo) => (inboundTo ? toTwilio(inboundTo) : defaultFrom());

module.exports = {
  DEFAULT_FROM,
  normalise,
  toTwilio,
  listSenders,
  findSender,
  senderLabel,
  defaultFrom,
  sourcingFrom,
  replyFrom,
};