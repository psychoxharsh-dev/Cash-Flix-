const express = require('express');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = '7217447824';

function maskPhone(phone) {
  if (!phone || phone.length < 8) return phone;
  return phone.slice(0, 4) + '****' + phone.slice(-4);
}

function getTime() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }).replace(',', '');
}

function getRequestId() {
  return Math.floor(10000 + Math.random() * 90000);
}

async function sendMsg(chat_id, text, keyboard) {
  const body = { chat_id, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function dbGet(table, filter) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

async function dbPost(table, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
}

async function dbPatch(table, filter, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

const mainKeyboard = [['💰 Withdraw', '👤 Profile']];
const userState = {};

app.post('/webhook', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.send('OK');
    const chat_id = message.chat.id.toString();
    const text = message.text || '';
    const name = message.from.first_name || 'User';

    if (text === '/start') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length === 0) {
        await sendMsg(chat_id, `👋 <b>Welcome ${name}!</b>\n\nBot use karne ke liye apna phone number bhejo:`);
      } else {
        const u = users[0];
        await sendMsg(chat_id, `👤 <b>Profile</b>\n\n🧑 <b>User:</b> ${u.name} ⚡\n💰 <b>Balance:</b> ₹${u.balance}\n🔁 <b>Lifetime Earnings:</b> ₹${u.lifetime_earnings}\n📱 <b>Phone:</b> ${u.phone}`, mainKeyboard);
      }
    } else if (/^[6-9]\d{9}$/.test(text)) {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length === 0) {
        await dbPost('users', { telegram_id: chat_id, name, phone: text, balance: 0, lifetime_earnings: 0 });
        await sendMsg(chat_id, `✅ <b>Registration successful!</b>\n\n👤 <b>Profile</b>\n\n🧑 <b>User:</b> ${name} ⚡\n💰 <b>Balance:</b> ₹0.00\n🔁 <b>Lifetime Earnings:</b> ₹0.00\n📱 <b>Phone:</b> ${text}`, mainKeyboard);
      } else {
        await sendMsg(chat_id, `✅ <b>Already registered!</b>`, mainKeyboard);
      }
    } else if (text === '👤 Profile') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0) {
        const u = users[0];
        await sendMsg(chat_id, `👤 <b>Profile</b>\n\n🧑 <b>User:</b> ${u.name} ⚡\n💰 <b>Balance:</b> ₹${u.balance}\n🔁 <b>Lifetime Earnings:</b> ₹${u.lifetime_earnings}\n📱 <b>Phone:</b> ${u.phone}`, mainKeyboard);
      }
    } else if (text === '💰 Withdraw') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0 && parseFloat(users[0].balance) >= 50) {
        userState[chat_id] = { state: 'withdraw_upi', amount: users[0].balance };
        await sendMsg(chat_id, `💸 <b>Apna UPI ID bhejo:</b>\n\n💰 <b>Available Balance:</b> ₹${users[0].balance}`);
      } else {
        await sendMsg(chat_id, `❌ <b>Minimum ₹50 chahiye withdraw karne ke liye!</b>`, mainKeyboard);
      }
    } else if (userState[chat_id] && userState[chat_id].state === 'withdraw_upi') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0) {
        const u = users[0];
        const amount = userState[chat_id].amount;
        const upi = text;
        const now = getTime();
        const requestId = getRequestId();
        await dbPost('withdrawals', { telegram_id: chat_id, amount: parseFloat(amount), upi_id: upi, status: 'pending' });
        await sendMsg(chat_id, `⏳ <b>Withdrawal Request Submitted for Manual Approval!</b>\n\n📊 <b>Request ID:</b> ${requestId}\n💰 <b>Amount:</b> ₹${amount}\n📱 <b>Method:</b> UPI\n📅 <b>Date:</b> ${now}`, mainKeyboard);
        await dbPatch('users', `telegram_id=eq.${chat_id}`, { balance: 0 });
        await sendMsg(ADMIN_ID, `💸 <b>New Withdraw Request!</b>\n\n🧑 <b>User:</b> ${u.name}\n📱 <b>Phone:</b> ${u.phone}\n💰 <b>Amount:</b> ₹${amount}\n🏦 <b>UPI:</b> ${upi}\n📅 <b>Time:</b> ${now}\n📊 <b>Request ID:</b> ${requestId}\n\nReply: /paid ${u.phone}`);
        delete userState[chat_id];
      }
    } else if (text.startsWith('/paid ') && chat_id === ADMIN_ID) {
      const phone = text.split(' ')[1];
      const users = await dbGet('users', `phone=eq.${phone}`);
      if (users.length > 0) {
        const u = users[0];
        const withdrawals = await dbGet('withdrawals', `telegram_id=eq.${u.telegram_id}&status=eq.pending&order=created_at.desc&limit=1`);
        if (withdrawals.length > 0) {
          const w = withdrawals[0];
          await dbPatch('withdrawals', `id=eq.${w.id}`, { status: 'paid' });
          await sendMsg(u.telegram_id, `<b>Your withdrawal request of ₹${w.amount} has been approved! ✅ CashFlix ⚡</b>`);
          await sendMsg(ADMIN_ID, `✅ Payment sent to ${u.name} (${u.phone}) — ₹${w.amount}`);
        } else {
          await sendMsg(ADMIN_ID, `❌ Koi pending withdrawal nahi mila ${phone} ke liye!`);
        }
      } else {
        await sendMsg(ADMIN_ID, `❌ User nahi mila: ${phone}`);
      }
    }
  } catch(e) {
    console.error(e);
  }
  res.send('OK');
});

app.get('/postback', async (req, res) => {
  try {
    const { click_id = 'N/A', event = 'N/A', offer = 'StoryTv2' } = req.query;

    let amount;
    if (event === 'initial') {
      amount = '0.1';
    } else if (event === 'Trial') {
      amount = '25';
    } else {
      amount = req.query.amount || '0';
    }

    const runTime = getTime();
    const amt = parseFloat(amount);

    await dbPost('conversions', { telegram_id: click_id, click_id, offer_name: offer, amount: amt, event });

    if (event === 'Trial') {
      const users = await dbGet('users', `phone=eq.${click_id}`);
      if (users.length > 0) {
        const u = users[0];
        const newBal = parseFloat(u.balance) + amt;
        const newLife = parseFloat(u.lifetime_earnings) + amt;
        await dbPatch('users', `phone=eq.${click_id}`, { balance: newBal, lifetime_earnings: newLife });
        await sendMsg(u.telegram_id, `🧿 <b>Cashback Credited</b> 🧿\n\n💶 <b>Amount  =</b> ${amount}\n💰 <b>Updated Balance =</b> ${newBal}\n\n💡 <b>Comment =</b> Story Tv Trial`);
      }
    } else if (event === 'initial') {
      const users = await dbGet('users', `phone=eq.${click_id}`);
      if (users.length > 0) {
        const u = users[0];
        await sendMsg(u.telegram_id, `🧿 <b>Cashback Credited</b> 🧿\n\n💶 <b>Amount  =</b> ${amount}\n💰 <b>Updated Balance =</b> ${u.balance}\n\n💡 <b>Comment =</b> Story Tv Install`);
      }
    }

    const trackTime = getTime();
    const msg = `<b>Conversation Count 💝</b>\n\n🎁 <b>Offer Name -</b> ${offer}\n\n<b>User Id :</b> ${maskPhone(click_id)}\n<b>User Amount :</b> ₹${amount}\n🤑 <b>User Payment :</b> Success\n\n<b>Run Time -</b> ${runTime}\n<b>Track Time -</b> ${trackTime}\n\n<b>Powered By - TrackFlix</b>`;
    await sendMsg(CHAT_ID, msg);
  } catch(e) {
    console.error(e);
  }
  res.send('OK');
});

app.get('/', (req, res) => res.send('TrackFlix Wallet Bot Running! ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));

setInterval(async () => {
  try { await fetch('https://cash-flix-dytv.onrender.com/'); } catch(e) {}
}, 14 * 60 * 1000);
