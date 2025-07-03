// UltraMsg WhatsApp Order Handler Bot (Node.js + Express)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// Replace with your UltraMsg credentials
const ULTRA_INSTANCE_ID = 'your_instance_id';
const ULTRA_TOKEN = 'your_ultramsg_token';
const DELIVERY_PHONE = 'delivery_number'; // e.g. '2376xxxxxxx'

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

      // Forward to delivery person via UltraMsg
      await axios.post(`https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`, {
        to: DELIVERY_PHONE,
        body: forwardMessage,
        priority: 10
      }, {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ULTRA_TOKEN}`
        }
      });

      console.log('Forwarded message to delivery number.');
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
