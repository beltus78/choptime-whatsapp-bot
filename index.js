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

// Allowed WhatsApp numbers for status updates (admin and delivery)
const ALLOWED_STATUS_UPDATE_NUMBERS = [
  (process.env.ADMIN_PHONE || '').replace(/\D/g, ''),
  (process.env.DELIVERY_PHONE || '').replace(/\D/g, ''),
  (process.env.DELIVERY_PHONE_BUEA || '').replace(/\D/g, ''),
  (process.env.DELIVERY_PHONE_LIMBE || '').replace(/\D/g, ''),
  // Add more delivery/admin numbers as needed
].filter(Boolean);

// In-memory session state for WhatsApp chat onboarding
const userSessions = {};

const VENDOR_RIDER_PHONE = '237673289043';
const SUPPORT_EMAIL = 'choptime237@gmail.com';
const SUPPORT_PHONE = '237673289043';
const WEBSITE_LINK = 'https://choptime.vercel.app';

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
  try {
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
  } catch (error) {
    console.error('WhatsApp API error:', error.response?.data || error.message);
    throw error;
  }
}

// Helper to fetch menu from Supabase
async function fetchMenu() {
  // Fetch available dishes and their prices (first available restaurant per dish)
  const { data, error } = await supabase
    .from('restaurant_menus')
    .select(`id, price, dish:dishes(id, name, description, category, is_spicy, is_vegetarian, is_popular, active)`) 
    .eq('availability', true)
    .eq('dish.active', true);
  if (error) {
    console.error('Error fetching menu:', error.message);
    return [];
  }
  // Group by dish name, pick first price/restaurant
  const menuMap = {};
  for (const item of data) {
    if (item.dish && !menuMap[item.dish.name]) {
      menuMap[item.dish.name] = {
        name: item.dish.name,
        description: item.dish.description,
        price: item.price,
        category: item.dish.category,
        is_spicy: item.dish.is_spicy,
        is_vegetarian: item.dish.is_vegetarian,
        is_popular: item.dish.is_popular
      };
    }
  }
  return Object.values(menuMap);
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

    // Send to all delivery agents for the town (using WhatsApp Cloud API only)
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

// WhatsApp Cloud API webhook for new conversational onboarding
const originalWebhook = app._router.stack.find(r => r.route && r.route.path === '/webhook');
if (originalWebhook) {
  app._router.stack = app._router.stack.filter(r => !(r.route && r.route.path === '/webhook'));
}

app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const messages = changes?.value?.messages;
    if (!messages) return res.sendStatus(200);

    for (const msg of messages) {
      const from = msg.from.replace(/\D/g, '');
      const text = msg.text?.body?.trim();
      if (!text) continue;

      // Restrict status update commands to allowed numbers
      if (ALLOWED_STATUS_UPDATE_NUMBERS.includes(from)) {
        const upperText = text.toUpperCase();
        if (upperText.startsWith('CONFIRM') || upperText.startsWith('DELIVERED') || upperText.startsWith('CANCEL')) {
          const [status, orderRef] = upperText.split(' ');
          let newStatus = '';
          if (status === 'CONFIRM') newStatus = 'confirmed';
          else if (status === 'DELIVERED') newStatus = 'delivered';
          else if (status === 'CANCEL') newStatus = 'cancelled';
          if (orderRef && newStatus) {
            await supabase
              .from('orders')
              .update({ status: newStatus })
              .eq('order_reference', orderRef);
            // Notify user
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
          continue;
        }
      }

      // New onboarding menu
      if (!userSessions[from]) {
        userSessions[from] = { step: 'init', type: null, details: {} };
      }
      const session = userSessions[from];
      const lowerText = text.toLowerCase();

      if (session.step === 'init') {
        let menuMsg =
          '👋 Welcome to ChopTime!\n\n' +
          'Reply with a number to choose an option:\n' +
          '1. Order\n' +
          '2. Become a Vendor\n' +
          '3. Become a Rider\n' +
          '4. Contact Support';
        await sendWhatsAppMessage(from, menuMsg);
        session.step = 'await_main_choice';
        continue;
      }

      if (session.step === 'await_main_choice') {
        if (lowerText === '1' || lowerText.includes('order')) {
          await sendWhatsAppMessage(from, `You can place your order directly on our website: ${WEBSITE_LINK}`);
          delete userSessions[from];
          continue;
        } else if (lowerText === '2' || lowerText.includes('vendor')) {
          session.type = 'vendor';
          session.step = 'await_vendor_name';
          await sendWhatsAppMessage(from, 'Great! Please enter your full name to become a vendor.');
          continue;
        } else if (lowerText === '3' || lowerText.includes('rider')) {
          session.type = 'rider';
          session.step = 'await_rider_name';
          await sendWhatsAppMessage(from, 'Awesome! Please enter your full name to become a rider.');
          continue;
        } else if (lowerText === '4' || lowerText.includes('support')) {
          await sendWhatsAppMessage(from, `Contact Support:\nEmail: ${SUPPORT_EMAIL}\nPhone: ${SUPPORT_PHONE}`);
          delete userSessions[from];
          continue;
        } else {
          await sendWhatsAppMessage(from, 'Please reply with 1, 2, 3, or 4.');
          continue;
        }
      }

      // Vendor onboarding
      if (session.type === 'vendor') {
        if (session.step === 'await_vendor_name') {
          session.details.name = text;
          session.step = 'await_vendor_business';
          await sendWhatsAppMessage(from, 'What is your business name?');
          continue;
        }
        if (session.step === 'await_vendor_business') {
          session.details.business = text;
          session.step = 'await_vendor_location';
          await sendWhatsAppMessage(from, 'Where is your business located?');
          continue;
        }
        if (session.step === 'await_vendor_location') {
          session.details.location = text;
          session.step = 'await_vendor_phone';
          await sendWhatsAppMessage(from, 'What is your business phone number?');
          continue;
        }
        if (session.step === 'await_vendor_phone') {
          session.details.phone = text;
          // Send details to admin number
          const vendorMsg = `🛒 *New Vendor Application*\nName: ${session.details.name}\nBusiness: ${session.details.business}\nLocation: ${session.details.location}\nPhone: ${session.details.phone}\nWhatsApp: ${from}`;
          await sendWhatsAppMessage(VENDOR_RIDER_PHONE, vendorMsg);
          await sendWhatsAppMessage(from, 'Thank you! Your vendor application has been received. We will contact you soon.');
          delete userSessions[from];
          continue;
        }
      }

      // Rider onboarding
      if (session.type === 'rider') {
        if (session.step === 'await_rider_name') {
          session.details.name = text;
          session.step = 'await_rider_location';
          await sendWhatsAppMessage(from, 'Where are you based?');
          continue;
        }
        if (session.step === 'await_rider_location') {
          session.details.location = text;
          session.step = 'await_rider_phone';
          await sendWhatsAppMessage(from, 'What is your phone number?');
          continue;
        }
        if (session.step === 'await_rider_phone') {
          session.details.phone = text;
          // Send details to admin number
          const riderMsg = `🚴 *New Rider Application*\nName: ${session.details.name}\nLocation: ${session.details.location}\nPhone: ${session.details.phone}\nWhatsApp: ${from}`;
          await sendWhatsAppMessage(VENDOR_RIDER_PHONE, riderMsg);
          await sendWhatsAppMessage(from, 'Thank you! Your rider application has been received. We will contact you soon.');
          delete userSessions[from];
          continue;
        }
      }

      // Fallback: restart menu
      await sendWhatsAppMessage(from, 'To get started, reply with any message.');
      delete userSessions[from];
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('Error processing WhatsApp webhook:', error.message);
    if (error.response) {
      console.error('WhatsApp webhook error response data:', error.response.data);
      console.error('WhatsApp webhook error response status:', error.response.status);
      console.error('WhatsApp webhook error response headers:', error.response.headers);
    }
    res.sendStatus(500);
  }
});

app.get('/', (req, res) => {
  res.send('ChopTime Order Bot is running.');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}); 
