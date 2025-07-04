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

// In-memory session state for WhatsApp chat ordering
const userSessions = {};

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

// WhatsApp Cloud API webhook for status updates and conversational ordering
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
      const from = msg.from.replace(/\D/g, ''); // sender's WhatsApp number, digits only
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

      // Conversational ordering for users
      // Session state: { step, order: { dish, quantity, address, phone } }
      if (!userSessions[from]) {
        userSessions[from] = { step: 'init', order: {} };
      }
      const session = userSessions[from];
      const lowerText = text.toLowerCase();

      if (session.step === 'init') {
        if (lowerText === 'menu' || lowerText === 'order' || lowerText === 'hi' || lowerText === 'hello') {
          const menu = await fetchMenu();
          if (!menu.length) {
            await sendWhatsAppMessage(from, 'Sorry, the menu is currently unavailable. Please try again later.');
            continue;
          }
          let menuMsg = '🍽️ *ChopTime Menu*\n\n';
          menu.forEach((item, i) => {
            menuMsg += `${i + 1}. ${item.name} - ${item.price} FCFA\n`;
          });
          menuMsg += '\nReply with the number of the dish you want to order.';
          session.menu = menu;
          session.step = 'await_dish';
          await sendWhatsAppMessage(from, menuMsg);
        } else {
          await sendWhatsAppMessage(from, 'Welcome to ChopTime! Reply with "menu" to see today\'s menu and place an order.');
        }
        continue;
      }

      if (session.step === 'await_dish') {
        const menu = session.menu || [];
        const idx = parseInt(text) - 1;
        if (isNaN(idx) || idx < 0 || idx >= menu.length) {
          await sendWhatsAppMessage(from, 'Please reply with a valid number from the menu.');
          continue;
        }
        session.order.dish = menu[idx];
        session.step = 'await_quantity';
        await sendWhatsAppMessage(from, `How many portions of ${menu[idx].name} would you like?`);
        continue;
      }

      if (session.step === 'await_quantity') {
        const qty = parseInt(text);
        if (isNaN(qty) || qty < 1) {
          await sendWhatsAppMessage(from, 'Please reply with a valid quantity (e.g., 1, 2, 3).');
          continue;
        }
        session.order.quantity = qty;
        session.step = 'await_address';
        await sendWhatsAppMessage(from, 'Please provide your delivery address.');
        continue;
      }

      if (session.step === 'await_address') {
        session.order.address = text;
        session.step = 'await_phone';
        await sendWhatsAppMessage(from, 'What\'s your phone number?');
        continue;
      }

      if (session.step === 'await_phone') {
        // Basic phone validation
        const phone = normalizeCameroonPhone(text);
        if (!/^2376\d{8}$/.test(phone)) {
          await sendWhatsAppMessage(from, 'Please reply with a valid Cameroon phone number (e.g., 6XXXXXXXX).');
          continue;
        }
        session.order.phone = phone;
        // Save order to Supabase
        const orderRef = 'CHP-' + Math.floor(10000 + Math.random() * 90000);
        const orderMsg = `🍽️ *ChopTime Order*\n\n📋 *Order Reference:* ${orderRef}\n👤 *Customer:* WhatsApp User\n📱 *Phone:* ${phone}\n📍 *Address:* ${session.order.address}\n\n🛒 *Order Details:*\n• ${session.order.dish.name} x${session.order.quantity} - ${session.order.dish.price * session.order.quantity} FCFA\n\nThank you for your order!`;
        // Insert order into Supabase
        await supabase.from('orders').insert([
          {
            order_reference: orderRef,
            user_phone: phone,
            delivery_address: session.order.address,
            status: 'pending',
            items: [{
              dish: session.order.dish.name,
              quantity: session.order.quantity,
              price: session.order.dish.price
            }],
            total: session.order.dish.price * session.order.quantity
          }
        ]);
        // Notify admin and delivery
        await sendWhatsAppMessage(ADMIN_PHONE, orderMsg);
        for (const phone of Object.values(DELIVERY_PHONE_MAP)) {
          await sendWhatsAppMessage(phone, orderMsg);
        }
        // Confirm to user
        await sendWhatsAppMessage(from, `✅ Your order for ${session.order.dish.name} x${session.order.quantity} has been received! We will contact you soon to confirm delivery.`);
        // Clear session
        delete userSessions[from];
        continue;
      }

      // Fallback
      await sendWhatsAppMessage(from, 'To start a new order, reply with "menu".');
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
