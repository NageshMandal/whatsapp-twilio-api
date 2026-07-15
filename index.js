require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const mongoose = require("mongoose");
const Message = require("./models/Message");
const LeadToMessage = require("./models/LeadToMessage");
const { generateReply, MODEL, SCRIPTS } = require("./services/aiBrain");
const { notifyHandoff, notifyPartEx, notifyEscalation } = require("./services/notifications");
const { startFollowUpCron } = require("./services/followUps");
const { isAuthorizedSubmitter, parseLeadSubmission } = require("./services/leadIntake");
const app = express();

mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.error("❌ MongoDB Error:", err));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

const axios = require("axios");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Inbound debounce / coalescing.
// WhatsApp users often fire several messages in a row ("HP" then "I want to own
// the car"). Twilio delivers each as a SEPARATE webhook call, and with no
// coalescing each call independently reads the SAME conversation state and
// generates its own reply — which is why Charlie was asking the same question
// (full name, HP vs PCP, soft-search consent) twice.
//
// Fix: each inbound stamps the conversation with an incrementing token, then
// waits a short window. If a NEWER inbound lands during the wait, this (older)
// call bows out and lets the newest one respond. Only the last message of a
// burst proceeds — and it re-reads the full history — so the customer gets ONE
// reply that takes all of their messages into account.
//
// NOTE: this token map is in-process, i.e. it assumes a single app instance (as
// currently deployed). If you ever scale to multiple instances, move the token
// into the DB / a shared store (e.g. Redis) so the coalescing still holds.
const INBOUND_DEBOUNCE_MS = parseInt(process.env.INBOUND_DEBOUNCE_MS || "7000", 10);
const latestInbound = new Map(); // phoneNumber -> latest inbound token
let inboundSeq = 0;

// Stamp this inbound as the most recent for the number and return its token.
function stampInbound(phoneNumber) {
  const token = ++inboundSeq;
  latestInbound.set(phoneNumber, token);
  return token;
}

// Wait out the burst window. Returns true if THIS call is still the newest
// inbound afterwards (so it should generate the reply), false if it was
// superseded by a later message.
async function waitForBurstToSettle(phoneNumber, token) {
  if (INBOUND_DEBOUNCE_MS <= 0) return latestInbound.get(phoneNumber) === token;
  await sleep(INBOUND_DEBOUNCE_MS);
  return latestInbound.get(phoneNumber) === token;
}

// Best-effort WhatsApp typing indicator. Sending it ALSO marks the referenced
// inbound message as read (blue ticks) for the user. Public Beta — may not work
// on the sandbox, so failures are swallowed and never break the flow.
async function sendTyping(messageSid) {
  if (!messageSid) return;
  try {
    await axios.post(
      "https://messaging.twilio.com/v2/Indicators/Typing.json",
      new URLSearchParams({ messageId: messageSid, channel: "whatsapp" }),
      {
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID,
          password: process.env.TWILIO_AUTH_TOKEN,
        },
      }
    );
  } catch (err) {
    console.warn(
      "⌨️  Typing indicator not sent:",
      err.response?.data?.message || err.message
    );
  }
}

// Send one WhatsApp message via the REST API.
// Attaches a statusCallback (when PUBLIC_BASE_URL is set) so that ANY message that
// fails to deliver - including team alerts sent to your own number - shows up in the
// logs instead of silently vanishing.
async function sendWhatsApp(toPhone, body) {
  const params = { from: WHATSAPP_FROM, to: `whatsapp:${toPhone}`, body };
  if (process.env.PUBLIC_BASE_URL) {
    params.statusCallback = `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/message-status`;
  }
  return client.messages.create(params);
}

// Send an approved WhatsApp TEMPLATE. Unlike free text, this delivers even when
// the recipient hasn't messaged the bot in the last 24h. `vars` is an object like
// { 1: "Josiah", 2: "+447..." } matching the template's {{1}}, {{2}} placeholders.
async function sendWhatsAppTemplate(toPhone, contentSid, vars) {
  const params = { from: WHATSAPP_FROM, to: `whatsapp:${toPhone}`, contentSid };
  if (vars && Object.keys(vars).length) {
    params.contentVariables = JSON.stringify(vars);
  }
  if (process.env.PUBLIC_BASE_URL) {
    params.statusCallback = `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/message-status`;
  }
  return client.messages.create(params);
}

// Open a conversation with a brand-new (cold) lead.
//
// IMPORTANT: WhatsApp does not allow free-text business-initiated messages to a
// user who hasn't messaged you in the last 24h. To message a cold lead on a
// PRODUCTION sender you must use a Meta-approved TEMPLATE. Set its Content SID in
// TWILIO_INTRO_CONTENT_SID and this sends the template. If that env var is not
// set, we fall back to sending the plain intro text, which only delivers inside
// an open 24h window or on the Twilio sandbox (where the lead has joined). Make
// the template's wording match SCRIPTS.intro so the flow reads the same.
async function sendLeadIntro(toPhone, name) {
  const contentSid = process.env.TWILIO_INTRO_CONTENT_SID;
  // If PUBLIC_BASE_URL is set, ask Twilio to POST delivery updates (delivered /
  // failed / undelivered) to /message-status so we can catch cold-send failures
  // like 63016 instead of trusting the initial "queued" response.
  const statusCallback = process.env.PUBLIC_BASE_URL
    ? `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, "")}/message-status`
    : undefined;

  const params = { from: WHATSAPP_FROM, to: `whatsapp:${toPhone}` };
  if (statusCallback) params.statusCallback = statusCallback;

  if (contentSid) {
    params.contentSid = contentSid;
    // If your approved template has a {{1}} placeholder for the name, opt in:
    if (name && process.env.TWILIO_INTRO_TEMPLATE_HAS_NAME === "true") {
      params.contentVariables = JSON.stringify({ 1: name });
    }
  } else {
    params.body = stripEmojis(SCRIPTS.intro);
  }
  return client.messages.create(params);
}

// Stage 2: send a queued lead's first message. ONLY on a successful send do we
// mark it messageSent = true AND create the conversation card in the messages
// collection (which starts Charlie's flow). Returns { sent, error? }.
async function sendQueuedLead(lead) {
  const leadNumber = lead.whatsappNumber;
  const leadName = lead.name;

  try {
    await sendLeadIntro(leadNumber, leadName);
  } catch (err) {
    console.error("❌ Failed to message queued lead:", leadNumber, err.message);
    await LeadToMessage.findOneAndUpdate(
      { whatsappNumber: leadNumber },
      { $set: { messageSent: false, lastError: err.message } }
    );
    return { sent: false, error: err.message };
  }

  // Mark the queue row as sent.
  await LeadToMessage.findOneAndUpdate(
    { whatsappNumber: leadNumber },
    { $set: { messageSent: true, sentAt: new Date(), lastError: null } }
  );

  // Create the conversation card in the messages collection.
  await Message.findOneAndUpdate(
    { phoneNumber: leadNumber },
    {
      $push: {
        messages: {
          text: SCRIPTS.intro,
          direction: "outgoing",
          isBot: true,
          stepAtSend: "intro",
        },
      },
      $set: {
        customerName: leadName || null,
        step: "intro",
        status: "Lead",
        botActive: true,
        lastOutboundAt: new Date(),
        followUpCount: 0,
      },
      $setOnInsert: { handoffNotified: false },
    },
    { upsert: true, returnDocument: "after" }
  );

  console.log(`👤 First message sent + card created: ${leadName || "(no name)"} ${leadNumber}`);
  return { sent: true };
}

// Handle a lead submitted by an authorized admin ("name + number").
// Stage 1: parse, dedupe, and store the lead in the leadsToMessage queue
// (messageSent = false). Then (unless AUTO_SEND_QUEUED_LEADS=false) immediately
// attempt stage 2. Everything is reported back to the admin.
async function handleLeadSubmission({ adminPhone, text }) {
  const reply = (msg) => sendWhatsApp(adminPhone, msg);

  const parsed = parseLeadSubmission(text);
  if (parsed.error) {
    if (parsed.error === "bad_number") {
      return reply("That number didn't look right. Please double-check it and resend.");
    }
    return reply(
      "To add a lead, send me their name and number, like this:\n\nJohn Smith\n07700 900123"
    );
  }

  const leadNumber = parsed.number;
  const leadName = parsed.name;

  // Don't let an admin/submitter number be added as a lead.
  if (isAuthorizedSubmitter(leadNumber)) {
    return reply("That's an admin number, so I haven't started a lead flow for it.");
  }

  // Duplicate handling (1): already an active conversation in messages?
  const existingConvo = await Message.findOne({ phoneNumber: leadNumber });
  if (existingConvo) {
    const when = existingConvo.createdAt
      ? new Date(existingConvo.createdAt).toLocaleDateString("en-GB")
      : "previously";
    return reply(
      `${leadName || "That lead"} (${leadNumber}) is already in the system ` +
        `(added ${when}, currently: ${existingConvo.status}). Leaving it as it is, ` +
        `so they won't get a duplicate message.`
    );
  }

  // Duplicate handling (2): already sitting in the queue?
  const existingQueued = await LeadToMessage.findOne({ whatsappNumber: leadNumber });
  if (existingQueued && existingQueued.messageSent) {
    return reply(`${leadName || "That lead"} (${leadNumber}) has already been messaged.`);
  }

  // Stage 1: store (or update) the lead in the leadsToMessage queue.
  const lead = await LeadToMessage.findOneAndUpdate(
    { whatsappNumber: leadNumber },
    {
      $set: { name: leadName || (existingQueued && existingQueued.name) || null, submittedBy: adminPhone },
      $setOnInsert: { messageSent: false },
    },
    { upsert: true, returnDocument: "after" }
  );

  // If auto-send is off, stop after queuing.
  if (process.env.AUTO_SEND_QUEUED_LEADS === "false") {
    return reply(
      `Saved ${leadName || "the lead"} (${leadNumber}) to the queue. It'll be messaged when you run the send step.`
    );
  }

  // Stage 2: try to send the first message now.
  const result = await sendQueuedLead(lead);
  if (result.sent) {
    return reply(
      `Done. I've messaged ${leadName || "the lead"} on ${leadNumber} and started the flow. ` +
        `I'll follow up daily if they go quiet, and ping you when they're qualified.`
    );
  }

  return reply(
    `Saved ${leadName || "the lead"} (${leadNumber}) to the queue, but I couldn't send the ` +
      `first message yet: ${result.error}. It's marked unsent and I'll retry when you run the ` +
      `send step (this usually means the WhatsApp template isn't live yet).`
  );
}

// Remove emojis from outgoing text (hard guarantee on top of the prompt rule).
// Keeps plain punctuation like :) and symbols like £.
function stripEmojis(text) {
  if (!text) return text;
  return text
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, "") // flag letters
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "") // skin-tone modifiers
    .replace(/[\u{FE00}-\u{FE0F}]/gu, "")   // variation selectors
    .replace(/\u200D/gu, "")                 // zero-width joiner
    // de-robotify punctuation: em/en dashes -> comma, like a human texting
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/\.{3}|…/g, "...")              // smart ellipsis -> plain dots
    .replace(/[“”]/g, '"')                   // curly double quotes -> straight
    .replace(/[‘’]/g, "'")                   // curly single quotes -> straight
    .replace(/,\s*,/g, ",")                  // tidy any accidental double commas
    .replace(/[ \t]{2,}/g, " ")              // tidy double spaces left behind
    .trim();
}

// WhatsApp rejects message bodies over 1600 chars. Split long text on natural
// boundaries (paragraph -> line -> sentence -> hard slice) into safe chunks.
function chunkMessage(text, max = 1500) {
  if (!text || text.length <= max) return [text];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(". ", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(" ", max);
    if (cut <= 0) cut = max; // no good boundary -> hard slice
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

app.get("/", (req, res) => {
  res.json({ success: true, message: "Twilio WhatsApp API is running 🚀" });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "UP",
    message: "Server is running",
    model: MODEL,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ---------------------------------------------------------------------------
// Manual outbound send (unchanged behaviour, now also tags the message as human)
// ---------------------------------------------------------------------------
app.post("/send-whatsapp", async (req, res) => {
  try {
    const { to, message } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Phone number and message are required"
      });
    }

    const result = await client.messages.create({
      body: message,
      from: WHATSAPP_FROM,
      to: `whatsapp:${to}`
    });

    await Message.findOneAndUpdate(
      { phoneNumber: to },
      {
        $push: { messages: { text: message, direction: "outgoing", isBot: false } },
        $set: { lastOutboundAt: new Date() }
      },
      { upsert: true, returnDocument: "after" }
    );

    res.status(200).json({
      success: true,
      message: "WhatsApp message sent successfully",
      sid: result.sid
    });

  } catch (error) {
    console.error("Send Message Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Voice call forwarding: both a normal phone call to a voice-enabled Twilio
// number AND an inbound WhatsApp Business Calling call hit this endpoint. We
// forward the caller to a human. Point your number's Voice webhook here.
//   .env: CALL_FORWARD_NUMBER=+447508671223   (the human to ring)
//         TWILIO_VOICE_CALLER_ID=+447576598461 (a Twilio number you own)
// Twilio sends both GET and POST to voice webhooks, so we handle both.
// ---------------------------------------------------------------------------
function voiceForwardTwiML() {
  const forwardTo = process.env.CALL_FORWARD_NUMBER;
  const callerId = process.env.TWILIO_VOICE_CALLER_ID;
  const callerAttr = callerId ? ` callerId="${callerId}"` : "";
  const inner = forwardTo
    ? `<Say>Please hold while we connect you to the team.</Say>` +
      `<Dial timeout="25"${callerAttr}>${forwardTo}</Dial>`
    : `<Say>Sorry, we can't take your call right now. Please message us on WhatsApp and we'll get right back to you.</Say>`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

app.all("/voice", (req, res) => {
  res.type("text/xml").send(voiceForwardTwiML());
});

// ---------------------------------------------------------------------------
// Delivery status callback. Twilio POSTs here for each message we sent with a
// statusCallback (currently the cold lead intro). When a send actually FAILS to
// deliver (e.g. 63016 "outside messaging window / use a template"), we flip the
// queued lead back to messageSent=false so it's not lost, record the reason, and
// remove the conversation card we optimistically created - as long as the lead
// never actually engaged. Then it can be cleanly retried once a template is live.
// ---------------------------------------------------------------------------
app.post("/message-status", async (req, res) => {
  res.sendStatus(204); // ack Twilio immediately; process below

  try {
    const status = req.body.MessageStatus || req.body.SmsStatus; // failed | undelivered | delivered | ...
    const to = (req.body.To || "").replace("whatsapp:", "").trim();
    const errorCode = req.body.ErrorCode || "";
    if (!to) return;

    if (status === "failed" || status === "undelivered") {
      const reason = `Delivery ${status}${errorCode ? ` (error ${errorCode})` : ""}`;

      // Only treat this as a lead if it's actually in the queue. Otherwise it's
      // an outbound message to a team member / admin (e.g. a qualified-lead
      // alert) and must NOT be re-queued or have a card deleted.
      const queued = await LeadToMessage.findOne({ whatsappNumber: to });
      if (!queued) {
        console.error(
          `❌ Message to ${to} - ${reason}. (Not a queued lead: this is likely a team ` +
            `alert blocked by WhatsApp's 24h window - that number must message the bot first.)`
        );
        return;
      }

      // 1) Put the lead back in the queue as unsent, with the real reason.
      await LeadToMessage.findOneAndUpdate(
        { whatsappNumber: to },
        { $set: { messageSent: false, sentAt: null, lastError: reason } }
      );

      // 2) Remove the card we created on the (false) success, but only if the
      //    lead never replied - so we never wipe a real, active conversation.
      const card = await Message.findOne({ phoneNumber: to });
      if (card && !card.lastInboundAt) {
        await Message.deleteOne({ phoneNumber: to });
      }

      console.error(`❌ ${to} - ${reason}. Lead flipped back to pending for retry.`);
    }
  } catch (err) {
    console.error("message-status handler error:", err.message);
  }
});

// ---------------------------------------------------------------------------
// Webhook: receive -> save -> ask the AI brain (based on DB state) -> reply -> save reply
// ---------------------------------------------------------------------------
app.post("/webhook/whatsapp", async (req, res) => {
  // Acknowledge Twilio immediately with an empty TwiML response. We send all
  // replies ourselves via the REST API so we can show typing + pace bubbles.
  const ackEmpty = () => {
    if (!res.headersSent) {
      res.type("text/xml").send("<Response></Response>");
    }
  };

  try {
    const from = req.body.From;
    const body = (req.body.Body || "").trim();
    const numMedia = parseInt(req.body.NumMedia || "0", 10);
    const inboundSid = req.body.MessageSid; // needed for typing / read receipt

    if (!from) return res.sendStatus(200);

    const phoneNumber = from.replace("whatsapp:", "");
    const incomingText = body || (numMedia > 0 ? "[media message]" : "");

    // 0) Admin lead injection. If the message is from an AUTHORIZED submitter,
    //    treat it as a "name + number" lead command, not a normal conversation.
    //    Everyone else falls through to the standard lead flow below.
    if (isAuthorizedSubmitter(phoneNumber)) {
      console.log("👤 Admin lead submission from", phoneNumber, "|", incomingText);
      ackEmpty();
      try {
        await handleLeadSubmission({ adminPhone: phoneNumber, text: body });
      } catch (adminErr) {
        console.error("❌ Lead submission failed:", adminErr.message);
        try {
          await sendWhatsApp(
            phoneNumber,
            "Sorry, something went wrong adding that lead. Please try again."
          );
        } catch (_) {}
      }
      return;
    }

    // Stamp this inbound as the newest for the number BEFORE anything async, so
    // burst ordering reflects true arrival order (see waitForBurstToSettle).
    const inboundToken = stampInbound(phoneNumber);

    // 1) Save the incoming message and read current state.
    //    Reset followUpCount to 0 — the lead just replied, so the daily nudge
    //    schedule starts fresh from our next outbound message.
    let convo = await Message.findOneAndUpdate(
      { phoneNumber },
      {
        $push: { messages: { text: incomingText, direction: "incoming", isBot: false } },
        $set: { lastInboundAt: new Date(), followUpCount: 0 },
        $setOnInsert: { step: "intro", status: "Lead", botActive: true },
      },
      { upsert: true, returnDocument: "after" }
    );

    console.log("\n=================================");
    console.log("📩 Incoming WhatsApp Message");
    console.log("From:", from, "| step:", convo.step, "| status:", convo.status);
    console.log("Message:", incomingText);
    console.log("=================================\n");

    // Ack Twilio now; everything below runs async and sends via REST.
    ackEmpty();

    // 2) If a human has taken over, the bot stays silent
    if (convo.botActive === false) {
      console.log("🤖 Bot inactive for this contact — leaving for a human.");
      return;
    }

    // 3) Mark the inbound as read + show typing while we think (best effort)
    await sendTyping(inboundSid);

    // 4) Edge case: media-only message — ask for text, don't advance the step
    if (!body && numMedia > 0) {
      const askText =
        "Thanks! I can't open attachments here — could you pop your reply in a quick text message so I can help?";
      await sendWhatsApp(phoneNumber, askText);
      await Message.findOneAndUpdate(
        { phoneNumber },
        {
          $push: { messages: { text: askText, direction: "outgoing", isBot: true, stepAtSend: convo.step } },
          $set: { lastOutboundAt: new Date() },
        }
      );
      return;
    }
    if (!body) return; // genuinely empty inbound

    // 4b) Coalesce message bursts. Wait a short window; if the customer sent
    //     another message while we waited, THIS call bows out and the newer one
    //     replies. This is what stops Charlie asking the same question twice when
    //     someone fires off "HP" then "I want to own the car" back-to-back.
    const stillLatest = await waitForBurstToSettle(phoneNumber, inboundToken);
    if (!stillLatest) {
      console.log("⏳ Superseded by a newer message from", phoneNumber, "— skipping this reply.");
      return;
    }

    // Re-read state now that the burst has settled, so the reply is based on the
    // FULL set of messages (and any name / step / bot-takeover updates that
    // landed during the window), not just the first message of the burst.
    const refreshed = await Message.findOne({ phoneNumber });
    if (refreshed) convo = refreshed;

    // A human may have taken over while we were waiting — respect that.
    if (convo.botActive === false) {
      console.log("🤖 Bot went inactive during the burst window — leaving for a human.");
      return;
    }

    // 5) Ask the AI brain for the next reply(s)
    const ai = await generateReply({
      step: convo.step,
      customerName: convo.customerName,
      financePreference: convo.financePreference,
      partExSent: convo.partExSent === true,
      history: convo.messages,
    });

    const replies = ai.replies && ai.replies.length ? ai.replies : [];

    // Expand each reply into WhatsApp-safe chunks (guards the 1600-char limit)
    // and strip any emojis the model may have added.
    const bubbles = [];
    for (const r of replies) {
      for (const c of chunkMessage(stripEmojis(r))) {
        if (c && c.trim()) bubbles.push(c);
      }
    }

    // 6) Send each bubble as its own message, with typing + a small pause between
    //    so it feels like a real person typing. Track what actually delivered.
    const sentBubbles = [];
    let allSent = true;
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0) {
        await sendTyping(inboundSid);
        await sleep(1200);
      }
      try {
        await sendWhatsApp(phoneNumber, bubbles[i]);
        sentBubbles.push(bubbles[i]);
      } catch (sendErr) {
        console.error("❌ Failed to send reply:", sendErr.message);
        allSent = false;
        break; // stop; we'll retry this step on the next inbound
      }
    }

    // 7) Persist ONLY the bubbles that actually sent. Advance the conversation
    //    state only if everything delivered — otherwise stay put so the next
    //    message re-runs this step (prevents "I already sent that" when we didn't).
    const sentDocs = sentBubbles.map((text) => ({
      text,
      direction: "outgoing",
      isBot: true,
      stepAtSend: ai.step,
    }));

    const update = {
      $set: { lastOutboundAt: new Date() },
    };
    if (sentDocs.length) {
      update.$push = { messages: { $each: sentDocs } };
    }

    let isHandoff = false;
    if (!ai.error && allSent) {
      update.$set.step = ai.step;
      if (ai.customerName) update.$set.customerName = ai.customerName;
      if (ai.financePreference) update.$set.financePreference = ai.financePreference;
      if (ai.partExSent) update.$set.partExSent = true;
      // Capture the part-ex details the customer just sent so the team alert
      // (below) and the CRM both have them.
      if (ai.partExDetailsProvided) update.$set.partExDetails = incomingText;

      if (ai.handoff || ai.step === "handoff") {
        update.$set.botActive = false;
        update.$set.status = "Send quotes";
        isHandoff = true;
        console.log("✅ Lead qualified & form completed — handed off to Zavia.");
      }
    }

    const updatedConvo = await Message.findOneAndUpdate(
      { phoneNumber },
      update,
      { returnDocument: "after" }
    );

    // Feature 1: notify the sales team (once) when the lead is handed off.
    if (isHandoff && updatedConvo && !updatedConvo.handoffNotified) {
      try {
        await notifyHandoff(updatedConvo, { sendWhatsApp, sendWhatsAppTemplate });
        await Message.findOneAndUpdate(
          { phoneNumber },
          { $set: { handoffNotified: true } }
        );
        console.log("📤 Handoff notification sent to the sales team.");
      } catch (notifyErr) {
        console.error("❌ Handoff notification failed:", notifyErr.message);
      }
    }

    // Part-exchange details: forward them to the sales team the moment they land,
    // WITHOUT waiting for the enquiry form to be completed. A lead who's handed
    // over their reg / mileage / settlement figure is worth chasing even if they
    // never finish the form. Sent once per conversation (partExNotified).
    if (
      !ai.error &&
      allSent &&
      ai.partExDetailsProvided &&
      updatedConvo &&
      !updatedConvo.partExNotified
    ) {
      try {
        await notifyPartEx(updatedConvo, {
          sendWhatsApp,
          sendWhatsAppTemplate,
          details: incomingText,
        });
        await Message.findOneAndUpdate(
          { phoneNumber },
          { $set: { partExNotified: true } }
        );
        console.log("🚗 Part-exchange details forwarded to the team.");
      } catch (pxErr) {
        console.error("❌ Part-exchange notification failed:", pxErr.message);
      }
    }

    // Escalation: the lead asked something important the bot can't handle. Ping the
    // "handle these leads" destination so a human can jump in. Independent of the
    // handoff flow — this can fire at any step, and every distinct question notifies.
    if (!ai.error && allSent && ai.escalate) {
      try {
        await notifyEscalation(updatedConvo || convo, {
          sendWhatsApp,
          sendWhatsAppTemplate,
          question: incomingText,
          note: ai.escalationNote,
        });
        console.log("🚨 Escalation sent to the team:", ai.escalationNote || incomingText);
      } catch (escErr) {
        console.error("❌ Escalation notification failed:", escErr.message);
      }
    }
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    ackEmpty(); // never leave Twilio hanging
  }
});

// ---------------------------------------------------------------------------
// Lead queue (leadsToMessage): view the queue and trigger sending of pending leads
// ---------------------------------------------------------------------------
app.get("/leads-to-message", async (req, res) => {
  try {
    const filter = {};
    if (req.query.pending === "true") filter.messageSent = false;
    if (req.query.pending === "false") filter.messageSent = true;
    const leads = await LeadToMessage.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, count: leads.length, data: leads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send the first message to every lead still pending (messageSent = false).
// Use this to flush the queue once the WhatsApp template is live, or on a schedule.
app.post("/leads-to-message/process", async (req, res) => {
  try {
    const pending = await LeadToMessage.find({ messageSent: false });
    const results = { attempted: pending.length, sent: 0, failed: 0, errors: [] };

    for (const lead of pending) {
      const r = await sendQueuedLead(lead);
      if (r.sent) {
        results.sent += 1;
      } else {
        results.failed += 1;
        results.errors.push({ number: lead.whatsappNumber, error: r.error });
      }
    }

    res.json({ success: true, ...results });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Read all conversations
// ---------------------------------------------------------------------------
app.get("/messages", async (req, res) => {
  try {
    const all = await Message.find().sort({ updatedAt: -1 });
    res.json({ success: true, count: all.length, data: all });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Read one conversation
app.get("/messages/:phoneNumber", async (req, res) => {
  try {
    const convo = await Message.findOne({ phoneNumber: req.params.phoneNumber });
    if (!convo) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: convo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Status management — manually advance the funnel & toggle the bot
// ---------------------------------------------------------------------------
app.get("/statuses", (req, res) => {
  res.json({ success: true, stages: Message.STATUS_STAGES });
});

app.patch("/messages/:phoneNumber/status", async (req, res) => {
  try {
    const { status, botActive } = req.body;
    const set = {};

    if (status !== undefined) {
      if (!Message.STATUS_STAGES.includes(status)) {
        return res.status(400).json({
          success: false,
          error: "Invalid status",
          allowed: Message.STATUS_STAGES,
        });
      }
      set.status = status;
    }
    if (botActive !== undefined) set.botActive = !!botActive;

    if (Object.keys(set).length === 0) {
      return res.status(400).json({ success: false, error: "Nothing to update" });
    }

    const convo = await Message.findOneAndUpdate(
      { phoneNumber: req.params.phoneNumber },
      { $set: set },
      { returnDocument: "after" }
    );
    if (!convo) return res.status(404).json({ success: false, error: "Not found" });

    res.json({ success: true, data: convo });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("=================================");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🧠 AI model: ${MODEL}`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`📩 Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log("=================================");

  // Feature 2: start the follow-up cron (nudges quiet leads at 30m / 2h / 1d).
  startFollowUpCron({ sendWhatsApp });
});