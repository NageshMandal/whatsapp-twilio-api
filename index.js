require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const mongoose = require("mongoose");
const Message = require("./models/Message");
const { generateReply, MODEL } = require("./services/aiBrain");
const { notifyHandoff } = require("./services/notifications");
const { startFollowUpCron } = require("./services/followUps");
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
async function sendWhatsApp(toPhone, body) {
  return client.messages.create({
    from: WHATSAPP_FROM,
    to: `whatsapp:${toPhone}`,
    body,
  });
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

    // 1) Save the incoming message and read current state.
    //    Reset followUpCount to 0 — the lead just replied, so the nudge
    //    schedule (30m/2h/1d) starts fresh from our next outbound message.
    const convo = await Message.findOneAndUpdate(
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

    // 5) Ask the AI brain for the next reply(s)
    const ai = await generateReply({
      step: convo.step,
      customerName: convo.customerName,
      financePreference: convo.financePreference,
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
        await notifyHandoff(updatedConvo, { sendWhatsApp });
        await Message.findOneAndUpdate(
          { phoneNumber },
          { $set: { handoffNotified: true } }
        );
        console.log("📤 Handoff notification sent to the sales team.");
      } catch (notifyErr) {
        console.error("❌ Handoff notification failed:", notifyErr.message);
      }
    }
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    ackEmpty(); // never leave Twilio hanging
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