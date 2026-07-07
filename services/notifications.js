// services/notifications.js
// Feature 1: when a lead is qualified and handed off to Zavia, ping the sales
// team's WhatsApp with the key details + an AI-written summary of the chat.

const { summariseConversation } = require("./aiBrain");

// Who receives the "New qualified lead" alerts.
//
// Set ADMIN_NOTIFY_NUMBER to a single number, or a comma-separated list to fan
// the lead out to a whole team, e.g.
//   ADMIN_NOTIFY_NUMBER="+447508671223,+447700900123,+447700900456"
//
// NOTE ON GROUPS: Twilio's WhatsApp API can only message individual numbers, it
// cannot post into a WhatsApp group chat. So to get every qualified lead into a
// shared "Qualified Leads" space, list each team member's number above (each
// person gets their own copy of the alert). See the message I sent alongside
// these files for the full explanation and options.
const ADMIN_NUMBERS = (process.env.ADMIN_NOTIFY_NUMBER || "+447508671223")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

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
 * Send the qualified-lead notification.
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

  // Send to every configured recipient. One failing number must not stop the
  // others from getting the lead.
  const results = [];
  for (const number of ADMIN_NUMBERS) {
    try {
      results.push(await sendWhatsApp(number, body));
    } catch (err) {
      console.error(`❌ Qualified-lead alert to ${number} failed:`, err.message);
    }
  }
  return results;
}

module.exports = { notifyHandoff, ADMIN_NUMBERS };