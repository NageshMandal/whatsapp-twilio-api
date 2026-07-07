// services/notifications.js
// Internal team alerts, split into TWO destinations:
//   1) notifyHandoff    -> a lead is QUALIFIED and ready for quotes  ("Qualified leads")
//   2) notifyEscalation -> a lead asked something IMPORTANT the bot can't handle, so a
//                          human needs to jump in                    ("Handle these leads")
//
// ---------------------------------------------------------------------------
// Note on WhatsApp groups: Twilio's WhatsApp API can only send to an individual
// phone number, it cannot post into a WhatsApp group chat. So each destination
// below is one or more phone numbers (comma-separated) and every number listed
// gets its own copy of the alert.
//
//   LEADS_NOTIFY_NUMBER="+447508671223,+447700900123"        (Qualified leads)
//   ESCALATION_NOTIFY_NUMBER="+447508671223,+447700900456"   (Handle these leads)
//
// ESCALATION_NOTIFY_NUMBER falls back to LEADS_NOTIFY_NUMBER if not set, and
// LEADS_NOTIFY_NUMBER falls back to the legacy ADMIN_NOTIFY_NUMBER.
// ---------------------------------------------------------------------------

const { summariseConversation } = require("./aiBrain");

// --- helper: parse a comma-separated number list into a clean array ---
function numberList(value) {
  return (value || "")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
}

// Legacy single-var support: ADMIN_NOTIFY_NUMBER still works as the leads default.
const LEGACY_DEFAULT = process.env.ADMIN_NOTIFY_NUMBER || "+447508671223";

// Qualified-leads destination.
const LEAD_NUMBERS = numberList(process.env.LEADS_NOTIFY_NUMBER || LEGACY_DEFAULT);

// Escalation destination (falls back to the leads destination if not set).
const ESCALATION_NUMBERS = numberList(
  process.env.ESCALATION_NOTIFY_NUMBER || process.env.LEADS_NOTIFY_NUMBER || LEGACY_DEFAULT
);

// "Lead arrival day" = when the conversation document was first created.
function formatArrival(convo) {
  const when =
    convo.createdAt ||
    (convo.messages && convo.messages[0] && convo.messages[0].timestamp) ||
    new Date();

  return new Date(when).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });
}

/**
 * Fan an alert out to every number for a destination. One failing recipient
 * never stops the others.
 */
async function dispatch({ label, body, waNumbers, sendWhatsApp }) {
  const results = [];
  for (const number of waNumbers) {
    try {
      results.push(await sendWhatsApp(number, body));
    } catch (err) {
      console.error(`❌ ${label} alert to ${number} failed:`, err.message);
    }
  }
  return results;
}

/**
 * Qualified-lead notification -> "Qualified leads" destination.
 * @param {object} convo  The Mongoose conversation doc (after handoff).
 * @param {{ sendWhatsApp: (phone:string, body:string)=>Promise<any> }} deps
 */
async function notifyHandoff(convo, { sendWhatsApp }) {
  const summary = await summariseConversation(convo.messages || []);

  const body = [
    "New qualified lead - ready for quotes",
    "",
    `Name: ${convo.customerName || "Unknown"}`,
    `Number: ${convo.phoneNumber}`,
    `Finance preference: ${convo.financePreference || "Not specified"}`,
    `Current stage: ${convo.status}`,
    `Lead arrived: ${formatArrival(convo)}`,
    "",
    "Chat summary:",
    summary,
  ].join("\n");

  return dispatch({
    label: "Qualified-lead",
    body,
    waNumbers: LEAD_NUMBERS,
    sendWhatsApp,
  });
}

/**
 * Escalation notification -> "Handle these leads" destination. Fired when the
 * bot flags an important question it can't handle, so a human can step in.
 * @param {object} convo  The Mongoose conversation doc.
 * @param {{ sendWhatsApp: Function, question?: string, note?: string }} deps
 */
async function notifyEscalation(convo, { sendWhatsApp, question, note }) {
  const body = [
    "Lead needs a human - important question",
    "",
    `Name: ${convo.customerName || "Unknown"}`,
    `Number: ${convo.phoneNumber}`,
    `Current stage: ${convo.status || "Lead"}`,
    note ? `What they need: ${note}` : null,
    question ? `Their message: ${question}` : null,
    "",
    "Please jump in and help this lead.",
  ]
    .filter((line) => line !== null)
    .join("\n");

  return dispatch({
    label: "Escalation",
    body,
    waNumbers: ESCALATION_NUMBERS,
    sendWhatsApp,
  });
}

module.exports = {
  notifyHandoff,
  notifyEscalation,
  LEAD_NUMBERS,
  ESCALATION_NUMBERS,
};