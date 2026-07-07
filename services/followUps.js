// services/followUps.js
// Feature 2: automated re-engagement. If a lead goes quiet AFTER we messaged
// them, nudge them ONCE A DAY, starting one day after they went quiet, up to
// day 5 (5 nudges total). After day 5 we stop.
// Any inbound message resets the counter (handled in index.js webhook).
//
// Timing note: each delay is measured from the LAST outbound message, and
// lastOutboundAt is bumped every time we send a nudge. Since every delay is one
// day, that gives one nudge per day: ~1 day after going quiet, then ~1 day after
// each nudge, so nudges land on roughly day 1, 2, 3, 4 and 5.

const cron = require("node-cron");
const Message = require("../models/Message");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Delay (since the last outbound message) before each follow-up fires. Every
// delay is one day, and lastOutboundAt is bumped after each nudge, so the lead
// gets one nudge per day: day 1, 2, 3, 4, 5. index 0 -> 1st nudge (day 1) ...
// index 4 -> 5th nudge (day 5).
const FOLLOW_UP_DELAYS = [1 * DAY, 1 * DAY, 1 * DAY, 1 * DAY, 1 * DAY];
const MAX_FOLLOW_UPS = FOLLOW_UP_DELAYS.length;

// Warm, non-pushy nudges in Charlie's tone. Step-aware: a lead sitting on the
// form gets a form-flavoured nudge; everyone else gets a general one.
// No emojis (brand rule).
function buildFollowUp(convo, attempt) {
  const waitingOnForm = convo.step === "apply" || convo.step === "confirm_form";

  const formNudges = [
    "Hey, just checking in - were you able to get the enquiry form filled in? More than happy to help if you got stuck anywhere.",
    "No rush at all, just following up on that finance enquiry form. Want me to resend the link or talk anything through?",
    "Still happy to help you get this sorted whenever you're ready - just let me know if anything's holding you up with the form.",
    "Just floating this back to the top for you - it only takes a couple of minutes on the enquiry form and I can get your quotes moving. Give me a shout if you'd like a hand.",
    "Last little nudge from me on this one - whenever you're ready to pick it back up just drop me a message and we'll get you sorted. No pressure at all.",
  ];

  const generalNudges = [
    "Hey, just following up on my last message - are you still keen to get something sorted? Happy to help whenever you're ready.",
    "No worries if you've been busy - just checking you're still interested in getting a car on finance? I'm here if you've got any questions.",
    "Still here whenever you'd like to carry on - just let me know and we'll pick up right where we left off.",
    "No pressure at all, just checking in again - happy to answer anything or get things moving whenever suits you.",
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
  console.log("⏰ Follow-up cron started (checks every minute; one nudge per day, up to day 5).");
}

module.exports = {
  startFollowUpCron,
  runFollowUpSweep,
  buildFollowUp,
  FOLLOW_UP_DELAYS,
  MAX_FOLLOW_UPS,
};