// UltraMsg WhatsApp Order Handler Bot (Node.js + Express)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 3000;

// Use environment variables for credentials and phone numbers
const ULTRA_INSTANCE_ID = process.env.ULTRA_INSTANCE_ID;
const ULTRA_TOKEN = process.env.ULTRA_TOKEN;
const DELIVERY_PHONE = process.env.DELIVERY_PHONE; // e.g. '2376xxxxxxx'
const ADMIN_PHONE = process.env.ADMIN_PHONE; // e.g. '2376xxxxxxx'

// Map towns to delivery phone numbers
const DELIVERY_PHONE_MAP = {
  'Buea': process.env.DELIVERY_PHONE_BUEA || DELIVERY_PHONE,
  'Limbe': process.env.DELIVERY_PHONE_LIMBE || DELIVERY_PHONE,
  // Add more towns as needed
};

app.use(bodyParser.json());
app.use(cors({
  origin: '*', // For development. For production, specify your frontend domain.
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// Helper to normalize Cameroon phone numbers to 2376xxxxxxxx
function normalizeCameroonPhone(phone) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.length === 9 && digits.startsWith('6')) {
    digits = '237' + digits;
  }
  if (digits.length === 12 && digits.startsWith('237')) {
    return digits;
  }
  return digits;
}

// API endpoint for frontend order submission
app.post('/api/place-order', async (req, res) => {
  try {
    const { message, user_phone, selectedTown, town } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Missing order message' });
    }

    // Determine delivery phone based on town
    const orderTown = selectedTown || town || '';
    const deliveryPhone = DELIVERY_PHONE_MAP[orderTown] || DELIVERY_PHONE;

    // Send to admin
    await axios.post(`https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`, {
      token: ULTRA_TOKEN,
      to: ADMIN_PHONE,
      body: message,
      priority: 10
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    // Send to delivery (town-specific)
    await axios.post(`https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`, {
      token: ULTRA_TOKEN,
      to: deliveryPhone,
      body: message,
      priority: 10
    }, {
      headers: { 'Content-Type': 'application/json' }
    });

    // Send confirmation to user
    if (user_phone) {
      const normalizedUserPhone = normalizeCameroonPhone(user_phone);
      const confirmationMessage =
        '✅ Thank you for your order! We have received it and will contact you soon to confirm delivery.\n\nIf you have any questions, reply to this message.';
      await axios.post(`https://api.ultramsg.com/${ULTRA_INSTANCE_ID}/messages/chat`, {
        token: ULTRA_TOKEN,
        to: normalizedUserPhone,
        body: confirmationMessage,
        priority: 10
      }, {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing order:', error.message);
    res.status(500).json({ error: 'Failed to send WhatsApp messages' });
  }
});

// Webhook for incoming WhatsApp messages (keep as is, but use env vars)
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
        token: ULTRA_TOKEN,
        to: DELIVERY_PHONE,
        body: forwardMessage,
        priority: 10
      }, {
        headers: { 'Content-Type': 'application/json' }
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
