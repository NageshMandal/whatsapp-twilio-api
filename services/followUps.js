// services/followUps.js
// Feature 2: automated re-engagement. If a lead goes quiet AFTER we messaged
// them, nudge them at +30min, then +2h, then +1day. After 3 nudges we stop.
// Any inbound message resets the counter (handled in index.js webhook).
//
// Timing note: each delay is measured from the LAST outbound message, and
// lastOutboundAt is bumped every time we send a nudge. So the schedule is
// "30m after going quiet, then 2h after nudge #1, then 1 day after nudge #2".
// If you'd rather measure all three from the original quiet point, store a
// separate `wentQuietAt` and compare against [30m, 2h30m, 1d2h30m] instead.

const cron = require("node-cron");
const Message = require("../models/Message");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Delay (since the last outbound message) before each follow-up fires.
// index 0 -> 1st nudge, index 1 -> 2nd nudge, index 2 -> 3rd nudge.
const FOLLOW_UP_DELAYS = [30 * MIN, 2 * HOUR, 1 * DAY];
const MAX_FOLLOW_UPS = FOLLOW_UP_DELAYS.length;

// Warm, non-pushy nudges in Charlie's tone. Step-aware: a lead sitting on the
// form gets a form-flavoured nudge; everyone else gets a general one.
// No emojis (brand rule).
function buildFollowUp(convo, attempt) {
  const waitingOnForm = convo.step === "apply" || convo.step === "confirm_form";

  const formNudges = [
    "Hey, just checking in - were you able to get the enquiry form filled in? More than happy to help if you got stuck anywhere.",
    "No rush at all, just following up on that finance enquiry form. Let me know if you'd like me to resend the link or talk anything through.",
    "Last little nudge from me on this one - whenever you're ready to pick it back up just drop me a message and we'll get you sorted. No pressure at all.",
  ];

  const generalNudges = [
    "Hey, just following up on my last message - are you still keen to get something sorted? Happy to help whenever you're ready.",
    "No worries if you've been busy - just checking you're still interested in getting a car on finance? I'm here if you've got any questions.",
    "I'll leave it here for now so I'm not bombarding you, but the door is always open - give me a shout whenever you'd like to carry on. No pressure at all.",
  ];

  const list = waitingOnForm ? formNudges : generalNudges;
  return list[Math.min(attempt - 1, list.length - 1)];
}

/**
 * One pass over the DB: find quiet leads that are due a nudge and send it.
 * @param {{ sendWhatsApp: (phone:string, body:string)=>Promise<any> }} deps
 */
async function runFollowUpSweep({ sendWhatsApp }) {
  const now = Date.now();

  let candidates;
  try {
    candidates = await Message.find({
      botActive: true, // skip leads a human / handoff has taken over
      step: { $ne: "handoff" },
      followUpCount: { $lt: MAX_FOLLOW_UPS },
      lastOutboundAt: { $ne: null },
    });
  } catch (err) {
    console.error("❌ Follow-up sweep query failed:", err.message);
    return;
  }

  for (const convo of candidates) {
    const lastIn = convo.lastInboundAt ? convo.lastInboundAt.getTime() : 0;
    const lastOut = convo.lastOutboundAt ? convo.lastOutboundAt.getTime() : 0;

    // Only nudge when WE had the last word (customer is the one who went quiet).
    if (lastOut <= lastIn) continue;

    const attempt = convo.followUpCount; // 0, 1 or 2
    const delay = FOLLOW_UP_DELAYS[attempt];
    if (now - lastOut < delay) continue; // not due yet

    const text = buildFollowUp(convo, attempt + 1);
    try {
      await sendWhatsApp(convo.phoneNumber, text);
      await Message.findOneAndUpdate(
        { phoneNumber: convo.phoneNumber },
        {
          $push: {
            messages: {
              text,
              direction: "outgoing",
              isBot: true,
              stepAtSend: convo.step,
            },
          },
          $set: { lastOutboundAt: new Date(), followUpCount: attempt + 1 },
        }
      );
      console.log(
        `🔔 Follow-up #${attempt + 1} sent to ${convo.phoneNumber} (step: ${convo.step})`
      );
    } catch (err) {
      console.error(`❌ Follow-up to ${convo.phoneNumber} failed:`, err.message);
    }
  }
}

/**
 * Start the cron. Runs every minute; the per-lead thresholds (30m/2h/1d) are
 * checked inside the sweep, so minute granularity is plenty.
 */
function startFollowUpCron(deps) {
  let running = false; // simple lock so sweeps never overlap
  cron.schedule("* * * * *", async () => {
    if (running) return;
    running = true;
    try {
      await runFollowUpSweep(deps);
    } catch (err) {
      console.error("❌ Follow-up cron error:", err.message);
    } finally {
      running = false;
    }
  });
  console.log("⏰ Follow-up cron started (checks every minute; nudges at 30m / 2h / 1d).");
}

module.exports = {
  startFollowUpCron,
  runFollowUpSweep,
  buildFollowUp,
  FOLLOW_UP_DELAYS,
  MAX_FOLLOW_UPS,
};