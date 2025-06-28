// server.js
const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook Verified");
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  const message = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

  if (message && message.type === "text") {
    const from = message.from; // e.g., "237670416449"
    const text = message.text.body;

    console.log(`📩 New message from ${from}: ${text}`);

    const reply = generateReply(text);
    await sendReply(from, reply);
  }

  res.sendStatus(200);
});

function generateReply(text) {
  const lower = text.toLowerCase();
  if (lower.includes("eru") || lower.includes("order")) {
    const orderId = "CHP-" + Math.floor(1000 + Math.random() * 9000);
    return `🛒 Thanks for ordering with ChopTime!\nYour order ID is ${orderId}. We'll prepare it and send it to your location soon.`;
  }

  return "👋 Hi there! Welcome to ChopTime. You can type your order (e.g., '2 Eru, Molyko') and we’ll handle the rest.";
}

async function sendReply(to, message) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("❌ Failed to send reply:", err?.response?.data || err.message);
  }
}

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Webhook running...");
});
