require("dotenv").config();
const express = require("express");
const twilio = require("twilio");
const mongoose = require("mongoose");
const Message = require("./models/Message");
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

app.get("/", (req, res) => {
  res.json({ success: true, message: "Twilio WhatsApp API is running 🚀" });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "UP",
    message: "Server is running",
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

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
      from: "whatsapp:+14155238886",
      to: `whatsapp:${to}`
    });

    await Message.findOneAndUpdate(
      { phoneNumber: to },
      { $push: { messages: { text: message, direction: "outgoing" } } },
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

// Webhook Route — receives message, saves it, replies with TwiML, saves the reply too
app.post("/webhook/whatsapp", async (req, res) => {
  try {
    const from = req.body.From;
    const message = req.body.Body;

    if (!message) {
      return res.sendStatus(200);
    }

    const phoneNumber = from.replace("whatsapp:", "");

    // Save incoming message
    await Message.findOneAndUpdate(
      { phoneNumber },
      { $push: { messages: { text: message, direction: "incoming" } } },
      { upsert: true, returnDocument: "after" }
    );

    console.log("\n=================================");
    console.log("📩 New WhatsApp Message Received & Saved");
    console.log("From:", from);
    console.log("Message:", message);
    console.log("Time:", new Date().toLocaleString());
    console.log("=================================\n");

    // Define your reply text here
    const replyText = "OK";

    // Save the outgoing reply
    await Message.findOneAndUpdate(
      { phoneNumber },
      { $push: { messages: { text: replyText, direction: "outgoing" } } },
      { upsert: true, returnDocument: "after" }
    );

    // Send TwiML response so Twilio actually sends replyText back to the user
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(replyText);

    res.type("text/xml");
    res.send(twiml.toString());

  } catch (error) {
    console.error("❌ Webhook Save Error:", error);
    res.sendStatus(200);
  }
});

app.get("/messages", async (req, res) => {
  try {
    const all = await Message.find().sort({ "messages.timestamp": -1 });
    res.json({ success: true, count: all.length, data: all });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("=================================");
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🏠 Home: http://localhost:${PORT}/`);
  console.log(`🏥 Health: http://localhost:${PORT}/health`);
  console.log(`📩 Webhook: http://localhost:${PORT}/webhook/whatsapp`);
  console.log("=================================");
});