// UltraMsg WhatsApp Order Handler Bot (Node.js + Express)

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const app = express();
const PORT = process.env.PORT || 3000;

// Use environment variables for credentials and phone numbers
const ULTRA_INSTANCE_ID = process.env.ULTRA_INSTANCE_ID;
const ULTRA_TOKEN = process.env.ULTRA_TOKEN;
const DELIVERY_PHONE = process.env.DELIVERY_PHONE; // e.g. '2376xxxxxxx'
const ADMIN_PHONE = process.env.ADMIN_PHONE; // e.g. '2376xxxxxxx'

// WhatsApp Cloud API credentials
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// Map towns to delivery phone numbers
const DELIVERY_PHONE_MAP = {
  'Buea': process.env.DELIVERY_PHONE_BUEA || DELIVERY_PHONE,
  'Limbe': process.env.DELIVERY_PHONE_LIMBE || DELIVERY_PHONE,
  // Add more towns as needed
};

// Supabase client for backend usage
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

// Helper to send WhatsApp message via Cloud API
async function sendWhatsAppMessage(to, body) {
  if (!to) {
    console.error('No recipient phone number provided for WhatsApp message.');
    return;
  }
  console.log('Sending WhatsApp message to:', to, 'with body:', body);
  await axios.post(
    `https://graph.facebook.com/v18.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body }
    },
    {
      headers: {
        'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
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
    const deliveryPhones = DELIVERY_PHONE_MAP[orderTown] || [DELIVERY_PHONE];

    // Send to admin
    await sendWhatsAppMessage(ADMIN_PHONE, message);

    // Send to all delivery agents for the town
    for (const phone of Array.isArray(deliveryPhones) ? deliveryPhones : [deliveryPhones]) {
      await sendWhatsAppMessage(phone, message);
    }

    // Send confirmation to user
    if (user_phone) {
      const normalizedUserPhone = normalizeCameroonPhone(user_phone);
      const confirmationMessage =
        '✅ Thank you for your order! We have received it and will contact you soon to confirm delivery.\n\nIf you have any questions, reply to this message.';
      await sendWhatsAppMessage(normalizedUserPhone, confirmationMessage);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error processing order:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
      console.error('Response headers:', error.response.headers);
    }
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

// WhatsApp Cloud API webhook for status updates
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;
    if (!messages) return res.sendStatus(200);

    for (const msg of messages) {
      const from = msg.from; // sender's WhatsApp number
      const text = msg.text?.body?.trim().toUpperCase();

      // Example: "CONFIRM CHP-12345"
      if (text && (text.startsWith('CONFIRM') || text.startsWith('DELIVERED') || text.startsWith('CANCEL'))) {
        const [status, orderRef] = text.split(' ');
        let newStatus = '';
        if (status === 'CONFIRM') newStatus = 'confirmed';
        else if (status === 'DELIVERED') newStatus = 'delivered';
        else if (status === 'CANCEL') newStatus = 'cancelled';

        // Update order in Supabase
        if (orderRef && newStatus) {
          await supabase
            .from('orders')
            .update({ status: newStatus })
            .eq('order_reference', orderRef);

          // Optionally, notify the user
          // 1. Fetch user_phone from the order
          const { data: order } = await supabase
            .from('orders')
            .select('user_phone')
            .eq('order_reference', orderRef)
            .single();

          if (order?.user_phone) {
            const statusMessages = {
              confirmed: 'Your order has been confirmed! 🎉',
              delivered: 'Your order has been delivered. Enjoy your meal! 🍽️',
              cancelled: 'Your order has been cancelled. If you have questions, contact support.',
            };
            await sendWhatsAppMessage(
              normalizeCameroonPhone(order.user_phone),
              statusMessages[newStatus] || `Order status updated: ${newStatus}`
            );
          }
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing WhatsApp webhook:', error.message);
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('ChopTime Order Bot is running.');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}); 
