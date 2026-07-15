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

// WhatsApp template variables must be SINGLE LINE. Meta rejects params that
// contain newlines, tabs, or 4+ consecutive spaces, and empty values. This
// flattens any value into a safe, non-empty, single-line string.
function tplVar(value, fallback = "-") {
  const s = String(value == null ? "" : value)
    .replace(/[\r\n\t]+/g, " · ") // newlines -> a visible separator
    .replace(/\s{2,}/g, " ")
    .trim();
  return s || fallback;
}

// Template SIDs for the two alert types. Leave unset to send plain free text
// (which only delivers if the recipient messaged the bot in the last 24h).
const LEADS_TEMPLATE_SID = (process.env.LEADS_TEMPLATE_SID || "").trim();
const ESCALATION_TEMPLATE_SID = (process.env.ESCALATION_TEMPLATE_SID || "").trim();
// Falls back to the qualified-leads template if you haven't made a separate one.
const PARTEX_TEMPLATE_SID = (
  process.env.PARTEX_TEMPLATE_SID ||
  process.env.LEADS_TEMPLATE_SID ||
  ""
).trim();

/**
 * Fan an alert out to every number for a destination. One failing recipient
 * never stops the others.
 *
 * If `templateSid` is set AND a sendWhatsAppTemplate function is provided, the
 * alert goes as an approved template (delivers regardless of the 24h window).
 * Otherwise it falls back to plain free text.
 */
async function dispatch({
  label,
  body,
  waNumbers,
  sendWhatsApp,
  sendWhatsAppTemplate,
  templateSid,
  templateVars,
}) {
  const useTemplate = Boolean(templateSid && sendWhatsAppTemplate);
  const results = [];

  for (const number of waNumbers) {
    try {
      if (useTemplate) {
        results.push(await sendWhatsAppTemplate(number, templateSid, templateVars));
      } else {
        results.push(await sendWhatsApp(number, body));
      }
    } catch (err) {
      console.error(`❌ ${label} alert to ${number} failed:`, err.message);
    }
  }
  return results;
}

/**
 * Qualified-lead notification -> "Qualified leads" destination.
 * @param {object} convo  The Mongoose conversation doc (after handoff).
 * @param {{ sendWhatsApp: Function, sendWhatsAppTemplate?: Function }} deps
 */
async function notifyHandoff(convo, { sendWhatsApp, sendWhatsAppTemplate }) {
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

  // Matches a 5-variable template, e.g.:
  //   New qualified lead ready for quotes.
  //   Name: {{1}}
  //   Number: {{2}}
  //   Finance: {{3}}
  //   Stage: {{4}}
  //   Summary: {{5}}
  const templateVars = {
    1: tplVar(convo.customerName, "Unknown"),
    2: tplVar(convo.phoneNumber),
    3: tplVar(convo.financePreference, "Not specified"),
    4: tplVar(convo.status, "Lead"),
    5: tplVar(summary, "See chat for details"),
  };

  return dispatch({
    label: "Qualified-lead",
    body,
    waNumbers: LEAD_NUMBERS,
    sendWhatsApp,
    sendWhatsAppTemplate,
    templateSid: LEADS_TEMPLATE_SID,
    templateVars,
  });
}

/**
 * Part-exchange details notification -> "Qualified leads" destination.
 * Fired the moment a customer sends their part-ex details, WITHOUT waiting for
 * them to complete the enquiry form. A lead who has handed over their reg,
 * mileage and settlement figure is worth chasing even if they never finish the
 * form, so this makes sure the team sees them.
 * @param {object} convo  The Mongoose conversation doc.
 * @param {{ sendWhatsApp: Function, sendWhatsAppTemplate?: Function, details?: string }} deps
 */
async function notifyPartEx(convo, { sendWhatsApp, sendWhatsAppTemplate, details }) {
  const body = [
    "Part exchange details received",
    "",
    `Name: ${convo.customerName || "Unknown"}`,
    `Number: ${convo.phoneNumber}`,
    `Finance preference: ${convo.financePreference || "Not specified"}`,
    `Lead arrived: ${formatArrival(convo)}`,
    "",
    "Their car:",
    details || "(see chat)",
    "",
    "Note: they have NOT completed the enquiry form yet.",
  ].join("\n");

  // Matches a 4-variable template, e.g.:
  //   Part exchange details received.
  //   Name: {{1}}
  //   Number: {{2}}
  //   Finance: {{3}}
  //   Their car: {{4}}
  const templateVars = {
    1: tplVar(convo.customerName, "Unknown"),
    2: tplVar(convo.phoneNumber),
    3: tplVar(convo.financePreference, "Not specified"),
    4: tplVar(details, "See chat"),
  };

  return dispatch({
    label: "Part-exchange",
    body,
    waNumbers: LEAD_NUMBERS,
    sendWhatsApp,
    sendWhatsAppTemplate,
    templateSid: PARTEX_TEMPLATE_SID,
    templateVars,
  });
}

/**
 * Escalation notification -> "Handle these leads" destination. Fired when the
 * bot flags an important question it can't handle, so a human can step in.
 * @param {object} convo  The Mongoose conversation doc.
 * @param {{ sendWhatsApp: Function, sendWhatsAppTemplate?: Function, question?: string, note?: string }} deps
 */
async function notifyEscalation(
  convo,
  { sendWhatsApp, sendWhatsAppTemplate, question, note }
) {
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

  // Matches a 4-variable template, e.g.:
  //   Lead needs a human.
  //   Name: {{1}}
  //   Number: {{2}}
  //   What they need: {{3}}
  //   Their message: {{4}}
  const templateVars = {
    1: tplVar(convo.customerName, "Unknown"),
    2: tplVar(convo.phoneNumber),
    3: tplVar(note, "Needs assistance"),
    4: tplVar(question, "See chat"),
  };

  return dispatch({
    label: "Escalation",
    body,
    waNumbers: ESCALATION_NUMBERS,
    sendWhatsApp,
    sendWhatsAppTemplate,
    templateSid: ESCALATION_TEMPLATE_SID,
    templateVars,
  });
}

module.exports = {
  notifyHandoff,
  notifyPartEx,
  notifyEscalation,
  LEAD_NUMBERS,
  ESCALATION_NUMBERS,
  LEADS_TEMPLATE_SID,
  ESCALATION_TEMPLATE_SID,
  PARTEX_TEMPLATE_SID,
};