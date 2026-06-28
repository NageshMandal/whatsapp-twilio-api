// services/notifications.js
// Feature 1: when a lead is qualified and handed off to Zavia, ping the sales
// team's WhatsApp with the key details + an AI-written summary of the chat.

const { summariseConversation } = require("./aiBrain");

// Override via env if you like; otherwise defaults to the number you provided.
const ADMIN_NUMBER = process.env.ADMIN_NOTIFY_NUMBER || "+447508671223";

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

  return sendWhatsApp(ADMIN_NUMBER, body);
}

module.exports = { notifyHandoff, ADMIN_NUMBER };