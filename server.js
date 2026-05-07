const express = require('express');
const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = '7217447824';

const offerConfig = {
  'Waves': {
    installAmt: 0.1,
    trialAmt: 3,
    installBalance: false,
    trialBalance: true,
    installComment: 'Waves install',
    trialComment: 'Waves Singup'
  },
  'Colgate': {
    installAmt: 3,
    trialAmt: 0,
    installBalance: true,
    trialBalance: false,
    installComment: 'Colgate Register',
    trialComment: 'Colgate Register'
  }
};

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
        await sendMsg(chat_id, `<b>👋 Welcome ${name}!</b>\n\nBot use karne ke liye apna phone number bhejo:`);
      } else {
        const u = users[0];
        await sendMsg(chat_id, `<b>👤 Profile</b>\n\n<b>🧑 User: ${u.name} ⚡</b>\n<b>💰 Balance: ₹${u.balance}</b>\n<b>🔁 Lifetime Earnings: ₹${u.lifetime_earnings}</b>\n<b>📱 Phone: ${u.phone}</b>`, mainKeyboard);
      }
    } else if (/^[6-9]\d{9}$/.test(text)) {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length === 0) {
        await dbPost('users', { telegram_id: chat_id, name, phone: text, balance: 0, lifetime_earnings: 0 });
        await sendMsg(chat_id, `<b>✅ Registration successful!</b>\n\n<b>👤 Profile</b>\n\n<b>🙌🏻 User: ${name} ⚡</b>\n<b>💰 Balance: ₹0.00</b>\n<b>🪢 Lifetime Earnings: ₹0.00</b>\n<b>📱 Phone: ${text}</b>`, mainKeyboard);
      } else {
        await sendMsg(chat_id, `<b>✅ Already registered!</b>`, mainKeyboard);
      }
    } else if (text === '👤 Profile') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0) {
        const u = users[0];
        await sendMsg(chat_id, `<b>👤 Profile</b>\n\n<b>🙌🏻 User: ${u.name} ⚡</b>\n<b>💰 Balance: ₹${u.balance}</b>\n<b>🪢 Lifetime Earnings: ₹${u.lifetime_earnings}</b>\n<b>📱 Phone: ${u.phone}</b>`, mainKeyboard);
      }
    } else if (text === '💰 Withdraw') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0 && parseFloat(users[0].balance) >= 50) {
        userState[chat_id] = { state: 'withdraw_upi', amount: users[0].balance };
        await sendMsg(chat_id, `<b>💸 Apna UPI ID bhejo:</b>\n\n<b>💰 Available Balance: ₹${users[0].balance}</b>`);
      } else {
        await sendMsg(chat_id, `<b>❌ Minimum ₹50 chahiye withdraw karne ke liye!</b>`, mainKeyboard);
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
        await sendMsg(chat_id, `<b>⏳ Withdrawal Request Submitted for Manual Approval!</b>\n\n<b>📊 Request ID: ${requestId}</b>\n<b>💰 Amount: ₹${amount}</b>\n<b>📱 Method: UPI</b>\n<b>📅 Date: ${now}</b>`, mainKeyboard);
        await dbPatch('users', `telegram_id=eq.${chat_id}`, { balance: 0 });
        await sendMsg(ADMIN_ID, `<b>💸 New Withdraw Request!</b>\n\n<b>🧑 User: ${u.name}</b>\n<b>📱 Phone: ${u.phone}</b>\n<b>💰 Amount: ₹${amount}</b>\n<b>🏦 UPI: ${upi}</b>\n<b>📅 Time: ${now}</b>\n<b>📊 Request ID: ${requestId}</b>\n\nReply: /paid ${u.phone}`);
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
          await sendMsg(ADMIN_ID, `<b>✅ Payment sent to ${u.name} (${u.phone}) — ₹${w.amount}</b>`);
        } else {
          await sendMsg(ADMIN_ID, `<b>❌ Koi pending withdrawal nahi mila ${phone} ke liye!</b>`);
        }
      } else {
        await sendMsg(ADMIN_ID, `<b>❌ User nahi mila: ${phone}</b>`);
      }
    }
  } catch(e) {
    console.error(e);
  }
  res.send('OK');
});
app.post('/click', async (req, res) => {
  try {
    const { click_id, offer_name, amount, event } = req.body;

    await supabase
      .from('clicks')
      .insert([
        {
          click_id: click_id,
          offer_name: offer_name,
          amount: amount || 0,
          event: event || 'click'
        }
      ]);

    res.json({ success: true });

  } catch (e) {
    console.log(e);
    res.json({ success: false });
  }
});

app.get('/postback', async (req, res) => {
  try {
    const { click_id = 'N/A', event = 'N/A' } = req.query;

// Offer — URL se lo pehle, phir clicks table se
let offer = req.query.offer || 'Unknown';
if (offer === 'Unknown') {
  try {
    const clicks = await dbGet('clicks', `click_id=eq.${click_id}&order=created_at.desc&limit=1`);
    if (clicks.length > 0) offer = clicks[0].offer_name;
  } catch(e) {}
}

    const config = offerConfig[offer] || {
      installAmt: 0, trialAmt: 0,
      installBalance: false, trialBalance: false,
      installComment: `${offer} Install`,
      trialComment: `${offer} Trial`
    };

    let amount = 0;
    let comment = '';
    let addBalance = false;

    const eventName = event?.trim().toLowerCase();

if (eventName === 'web') {
  amount = config.installAmt || 0;
  comment = config.installComment;
  addBalance = config.installBalance;
} else if (eventName === 'trial') {
  amount = config.trialAmt || 0;
  comment = config.trialComment;
  addBalance = config.trialBalance;
} else {
      amount = parseFloat(req.query.amount || 0);
      comment = `${offer} Complete`;
      addBalance = true;
    }

    const runTime = getTime();

    await dbPost('conversions', { telegram_id: click_id, click_id, offer_name: offer, amount, event });

    const users = await dbGet('users', `phone=eq.${click_id}`);
    if (users.length > 0) {
      const u = users[0];
      if (addBalance && amount > 0) {
        const newBal = parseFloat(u.balance) + amount;
        const newLife = parseFloat(u.lifetime_earnings) + amount;
        await dbPatch('users', `phone=eq.${click_id}`, { balance: newBal, lifetime_earnings: newLife });
        await sendMsg(u.telegram_id, `<b>🧿 Cashback Credited 🧿</b>\n\n<b>💶 Amount  = ${amount}</b>\n<b>💰 Updated Balance = ${newBal}</b>\n\n<b>💡 Comment = ${comment}</b>`);
      } else if (amount > 0) {
        await sendMsg(u.telegram_id, `<b>🧿 Cashback Credited 🧿</b>\n\n<b>💶 Amount  = ${amount}</b>\n<b>💰 Updated Balance = ${u.balance}</b>\n\n<b>💡 Comment = ${comment}</b>`);
      }
    }

    const trackTime = getTime();
    const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskPhone(click_id)}</b>\n<b>User Amount : ₹${amount}</b>\n<b>🤑 User Payment : Success</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - TrackFlix</b>`;
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
