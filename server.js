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

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function sendMsg(chat_id, text, keyboard, parse_mode) {
  const body = { chat_id, text };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  if (parse_mode) body.parse_mode = parse_mode;
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
        await sendMsg(chat_id, `*👋 Welcome ${esc(name)}\\!*\n\nBot use karne ke liye apna phone number bhejo:`, null, 'MarkdownV2');
      } else {
        const u = users[0];
        await sendMsg(chat_id, `*👤 Profile*\n\n*🧑 User:* ${esc(u.name)} ⚡\n*💰 Balance:* ₹${esc(String(u.balance))}\n*🔁 Lifetime Earnings:* ₹${esc(String(u.lifetime_earnings))}\n*📱 Phone:* ${esc(u.phone)}`, mainKeyboard, 'MarkdownV2');
      }
    } else if (/^[6-9]\d{9}$/.test(text)) {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length === 0) {
        await dbPost('users', { telegram_id: chat_id, name, phone: text, balance: 0, lifetime_earnings: 0 });
        await sendMsg(chat_id, `*✅ Registration successful\\!*\n\n*👤 Profile*\n\n*🧑 User:* ${esc(name)} ⚡\n*💰 Balance:* ₹0\\.00\n*🔁 Lifetime Earnings:* ₹0\\.00\n*📱 Phone:* ${esc(text)}`, mainKeyboard, 'MarkdownV2');
      } else {
        await sendMsg(chat_id, `*✅ Already registered\\!*`, mainKeyboard, 'MarkdownV2');
      }
    } else if (text === '👤 Profile') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0) {
        const u = users[0];
        await sendMsg(chat_id, `*👤 Profile*\n\n*🧑 User:* ${esc(u.name)} ⚡\n*💰 Balance:* ₹${esc(String(u.balance))}\n*🔁 Lifetime Earnings:* ₹${esc(String(u.lifetime_earnings))}\n*📱 Phone:* ${esc(u.phone)}`, mainKeyboard, 'MarkdownV2');
      }
    } else if (text === '💰 Withdraw') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0 && parseFloat(users[0].balance) >= 50) {
        userState[chat_id] = { state: 'withdraw_upi', amount: users[0].balance };
        await sendMsg(chat_id, `*💸 Apna UPI ID bhejo:*\n\n*💰 Available Balance:* ₹${esc(String(users[0].balance))}`, null, 'MarkdownV2');
      } else {
        await sendMsg(chat_id, `*❌ Minimum ₹50 chahiye withdraw karne ke liye\\!*`, mainKeyboard, 'MarkdownV2');
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
        await sendMsg(chat_id, `*⏳ Withdrawal Request Submitted for Manual Approval\\!*\n\n*📊 Request ID:* ${esc(String(requestId))}\n*💰 Amount:* ₹${esc(String(amount))}\n*📱 Method:* UPI\n*📅 Date:* ${esc(now)}`, mainKeyboard, 'MarkdownV2');
        await dbPatch('users', `telegram_id=eq.${chat_id}`, { balance: 0 });
        await sendMsg(ADMIN_ID, `*💸 New Withdraw Request\\!*\n\n*🧑 User:* ${esc(u.name)}\n*📱 Phone:* ${esc(u.phone)}\n*💰 Amount:* ₹${esc(String(amount))}\n*🏦 UPI:* ${esc(upi)}\n*📅 Time:* ${esc(now)}\n*📊 Request ID:* ${esc(String(requestId))}\n\nReply: /paid ${u.phone}`, null, 'MarkdownV2');
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
          await sendMsg(u.telegram_id, `*Your withdrawal request of ₹${esc(String(w.amount))} has been approved\\! ✅ CashFlix ⚡*`, null, 'MarkdownV2');
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
        await sendMsg(u.telegram_id, `*🧿 Cashback Credited 🧿*\n\n*💶 Amount  \\= ${esc(amount)}*\n*💰 Updated Balance \\= ${esc(String(newBal))}*\n\n*💡 Comment \\= Story Tv Trial*`, null, 'MarkdownV2');
      }
    } else if (event === 'initial') {
      const users = await dbGet('users', `phone=eq.${click_id}`);
      if (users.length > 0) {
        const u = users[0];
        await sendMsg(u.telegram_id, `*🧿 Cashback Credited 🧿*\n\n*💶 Amount  \\= ${esc(amount)}*\n*💰 Updated Balance \\= ${esc(String(u.balance))}*\n\n*💡 Comment \\= Story Tv Install*`, null, 'MarkdownV2');
      }
    }

    const trackTime = getTime();
    const msg = `*Conversation Count 💝*\n\n*🎁 Offer Name \\- ${esc(offer)}*\n\n*👤 User Id : ${esc(maskPhone(click_id))}*\n*💰 User Amount : ₹${esc(amount)}*\n*🤑 User Payment : Success*\n\n*⏱ Run Time \\- ${esc(runTime)}*\n*⏰ Track Time \\- ${esc(trackTime)}*\n\n*🤖 Powered By \\- TrackFlix*`;
    await sendMsg(CHAT_ID, msg, null, 'MarkdownV2');
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
