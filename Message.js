const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  messages: [
    {
      text: String,
      direction: {
        type: String,
        enum: ["incoming", "outgoing"],
        default: "incoming"
      },
      timestamp: {
        type: Date,
        default: Date.now
      }
    }
  ]
});

module.exports = mongoose.model("Message", messageSchema);