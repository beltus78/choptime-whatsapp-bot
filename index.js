// UltraMsg WhatsApp Order Handler Bot (Node.js + Express, Railway-ready)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Use Railway environment variables
const ULTRA_INSTANCE_ID = process.env.ULTRA_INSTANCE_ID;
const ULTRA_TOKEN = process.env.ULTRA_TOKEN;
const DELIVERY_PHONE = process.env.DELIVERY_PHONE; // e.g. '2376xxxxxxx'
const ADMIN_PHONE = process.env.ADMIN_PHONE; // Optional: notify admin too

app.use(bodyParser.json());

app.post('/ultramsg-webhook', async (req, res) => {
  try {
    const message = req.body.body;

    // Process only ChopTime Order messages
    if (message && message.includes('ChopTime Order')) {
      // Extract relevant fields from message using regex
      const customer = message.match(/Customer: (.+)/)?.[1] || 'N/A';
      const phone = message.match(/Phone: (.+)/)?.[1] || 'N/A';
      const address = message.match(/Address: (.+)/)?.[1] || 'N/A';
      const food = message.match(/• (.+) -/i)?.[1] || 'Food item not found';

      // Create delivery message
      const forwardMessage = `🚴 *New Delivery Order*\n📦 ${food}\n🏠 ${address}\n👤 ${customer}\n📞 ${phone}`;

      // Send to delivery person
      await axios.post(`https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`, {
        token: ULTRA_TOKEN,
        to: DELIVERY_PHONE,
        body: forwardMessage,
        priority: 10
      }, {
        headers: { 'Content-Type': 'application/json' }
      });

      // Optionally, notify admin as well
      if (ADMIN_PHONE) {
        await axios.post(`https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`, {
          token: ULTRA_TOKEN,
          to: ADMIN_PHONE,
          body: `🛎️ New order received!\n${forwardMessage}`,
          priority: 10
        }, {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      console.log('Forwarded message to delivery and admin.');
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing webhook:', error.message);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('ChopTime Order Bot is running.');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
