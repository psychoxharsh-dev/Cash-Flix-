const express = require('express');
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_ID = '7217447824';
const POSTBACK_TOKEN = process.env.POSTBACK_TOKEN || 'cash';

const offerConfig = {
  'Happy You': { installAmt: 0.1, trialAmt: 0, installBalance: false, trialBalance: true, installComment: 'Happy You Install', trialComment: 'Happy You Signup' }, // TODO: trialAmt me cashback amount daalo
  'Waves': { installAmt: 0.1, trialAmt: 3, installBalance: false, trialBalance: true, installComment: 'Waves Install', trialComment: 'Waves Signup' },
  'PolicyBazar': { installAmt: 0.1, trialAmt: 5, installBalance: false, trialBalance: true, installComment: 'PolicyBazar install', trialComment: 'PolicyBazar Register' },
  'Muthoot': { installAmt: 0.1, trialAmt: 15, installBalance: false, trialBalance: true, installComment: 'Muthoot Install', trialComment: 'Muthoot Register' },
  'QuickTv Fire': { installAmt: 0.1, trialAmt: 20, installBalance: false, trialBalance: true, installComment: 'QuickTv Install', trialComment: 'QuickTv Trail' },
  'Gyan Tv': { installAmt: 0.1, trialAmt: 15, installBalance: false, trialBalance: true, installComment: 'Gyan Install', trialComment: 'Gyan Trial' },
  'Bajaj Finserv': { installAmt: 0.1, trialAmt: 3, installBalance: false, trialBalance: true, installComment: 'BajajF Install', trialComment: 'BajajF Register' },
  'StoryTv Fire': { installAmt: 0.1, trialAmt: 20, installBalance: false, trialBalance: true, installComment: 'StoryTv Install', trialComment: 'StoryTv Trail' }
};

const rateLimitMap = {};
function rateLimit(ip, limit = 10, windowMs = 60000) {
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < windowMs);
  if (rateLimitMap[ip].length >= limit) return false;
  rateLimitMap[ip].push(now);
  return true;
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function maskPhone(phone) {
  if (!phone || phone.length < 8) return phone;
  return phone.slice(0, 4) + '****' + phone.slice(-4);
}

function getTime() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
}

function getRequestId() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

function isValidUPI(upi) {
  return /^[a-zA-Z0-9._-]+@[a-zA-Z]+$/.test(upi);
}

function isValidIFSC(ifsc) {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc.toUpperCase());
}

function sanitize(text) {
  if (!text) return '';
  return String(text).replace(/[<>]/g, '').trim().slice(0, 500);
}

async function sendMsg(chat_id, text, keyboard) {
  const body = { chat_id, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (res.ok) {
        const data = await res.json();
        return data.result?.message_id;
      }
    } catch(e) {
      if (i === 2) console.error('sendMsg failed:', e);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function editMsg(chat_id, message_id, text, inline_keyboard) {
  try {
    const body = { chat_id, message_id, text, parse_mode: 'HTML' };
    if (inline_keyboard !== undefined) body.reply_markup = { inline_keyboard };
    await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch(e) {}
}

async function sendInlineMsg(chat_id, text, inline_keyboard) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard } })
      });
      if (res.ok) {
        const data = await res.json();
        return data.result?.message_id;
      }
    } catch(e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function deleteMsg(chat_id, message_id) {
  try {
    await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, message_id })
    });
  } catch(e) {}
}

async function answerAlert(callback_query_id, text) {
  await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id, text, show_alert: text ? true : false })
  });
}

async function dbGet(table, filter) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return res.json();
}

async function dbPost(table, data) {
  await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
}

async function dbPatch(table, filter, data) {
  await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}


// ================= PAYMENT GATEWAY (AUTO PAYOUT) =================
const GW_BASE = 'https://pxqyeonymwlpiklfyjbb.supabase.co/functions/v1';
const GW_ID = process.env.GATEWAY_CLIENT_ID;
const GW_SECRET = process.env.GATEWAY_CLIENT_SECRET;
const WITHDRAW_FEE = parseFloat(process.env.WITHDRAW_FEE || '3');
const AUTO_PAYOUT_MAX = parseFloat(process.env.AUTO_PAYOUT_MAX || '200');

function gwHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Client-Id': GW_ID, 'X-Client-Secret': GW_SECRET, ...extra };
}

async function dbPatchReturn(table, filter, data) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(data)
  });
  try { const j = await res.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}

async function gwPayout(orderId, amount, upiId) {
  const res = await fetchWithTimeout(`${GW_BASE}/merchant-paynit-payout`, {
    method: 'POST',
    headers: gwHeaders({ 'X-Idempotency-Key': `idemp_${orderId}` }),
    body: JSON.stringify({ order_id: orderId, amount, payout_method: 'UPI', upi_id: upiId, note: 'CashFlix Withdrawal' })
  });
  let j = {}; try { j = await res.json(); } catch (e) {}
  console.log('GW PAYOUT', orderId, res.status, JSON.stringify(j));
  return { http: res.status, body: j };
}

async function gwStatus(orderId) {
  const res = await fetchWithTimeout(`${GW_BASE}/check-order-status`, {
    method: 'POST',
    headers: gwHeaders(),
    body: JSON.stringify({ order_id: orderId })
  });
  let j = {}; try { j = await res.json(); } catch (e) {}
  return { http: res.status, body: j };
}

function gwNorm(body) {
  const d = (body && body.data) ? body.data : (body || {});
  const st = String(d.status || body.status || '').toUpperCase();
  const utr = d.utr || d.rrn || body.utr || '';
  if (['SUCCESS', 'SUCCESSFUL', 'COMPLETED', 'PAID'].includes(st)) return { st: 'SUCCESS', utr };
  if (['FAILED', 'FAILURE', 'REJECTED', 'CANCELLED', 'CANCELED', 'REVERSED'].includes(st)) return { st: 'FAILED', utr };
  return { st: 'PROCESSING', utr };
}

// Settle once: only the call that flips processing -> final proceeds
async function settleWithdrawal(w, result, utr) {
  if (result === 'SUCCESS') {
    const rows = await dbPatchReturn('withdrawals', `request_id=eq.${w.request_id}&status=eq.processing`, { status: 'paid', utr: utr || null });
    if (!rows.length) return;
    await sendMsg(w.telegram_id, `<b>Your withdrawal request of ₹${parseFloat(w.amount).toFixed(2)} has been approved! ✅</b>`);
    await sendMsg(ADMIN_ID, `<b>✅ Auto payout done — ₹${parseFloat(w.amount).toFixed(2)} → ${w.upi_id}</b>\n<b>📊 Request ID: ${w.request_id}</b>${utr ? `\n<b>🧾 UTR: ${utr}</b>` : ''}`);
  } else {
    const rows = await dbPatchReturn('withdrawals', `request_id=eq.${w.request_id}&status=eq.processing`, { status: 'cancelled' });
    if (!rows.length) return;
    const users = await dbGet('users', `telegram_id=eq.${w.telegram_id}`);
    if (users.length > 0) {
      const refundBal = parseFloat(users[0].balance) + parseFloat(w.amount);
      await dbPatch('users', `telegram_id=eq.${w.telegram_id}`, { balance: refundBal });
    }
    await sendMsg(w.telegram_id, `<b>❌ Your withdraw request failed. Please contact CashFlix support.</b>\n\n<b>💰 ₹${parseFloat(w.amount).toFixed(2)} has been refunded to your wallet!</b>`);
    await sendMsg(ADMIN_ID, `<b>❌ Auto payout failed & refunded — ₹${parseFloat(w.amount).toFixed(2)} (${w.upi_id})</b>\n<b>📊 Request ID: ${w.request_id}</b>`);
  }
}

// returns true if handled automatically (no manual admin buttons needed)
async function startAutoPayout(w) {
  try {
    if (!GW_ID || !GW_SECRET) return false;
    const upi = String(w.upi_id || '');
    if (!upi.includes('@') || upi.includes('|')) return false;
    if (parseFloat(w.amount) > AUTO_PAYOUT_MAX) return false;
    const payAmt = parseFloat((parseFloat(w.amount) - WITHDRAW_FEE).toFixed(2));
    if (payAmt <= 0) return false;
    const orderId = `ord_${w.request_id}`;
    const claimed = await dbPatchReturn('withdrawals', `request_id=eq.${w.request_id}&status=eq.pending`, { status: 'processing', order_id: orderId });
    if (!claimed.length) return false;
    const r = await gwPayout(orderId, payAmt, upi);
    const n = gwNorm(r.body);
    if (n.st === 'SUCCESS') await settleWithdrawal(w, 'SUCCESS', n.utr);
    else if (n.st === 'FAILED' || (r.http >= 400 && r.http < 500)) await settleWithdrawal(w, 'FAILED');
    // else PROCESSING / 5xx / timeout: leave to poller (idempotency key prevents double pay)
    return true;
  } catch (e) {
    console.error('AUTO PAYOUT ERROR:', e.message);
    return true; // already claimed as processing; poller will resolve
  }
}

setInterval(async () => {
  try {
    if (!GW_ID || !GW_SECRET) return;
    const list = await dbGet('withdrawals', `status=eq.processing&order_id=not.is.null&limit=50`);
    if (!Array.isArray(list)) return;
    for (const w of list) {
      try {
        const r = await gwStatus(w.order_id);
        const n = gwNorm(r.body);
        if (n.st === 'SUCCESS') await settleWithdrawal(w, 'SUCCESS', n.utr);
        else if (n.st === 'FAILED') await settleWithdrawal(w, 'FAILED');
        else if (r.http === 404) {
          const age = Date.now() - new Date(w.created_at || Date.now()).getTime();
          if (age > 10 * 60 * 1000) await settleWithdrawal(w, 'FAILED');
        }
      } catch (e) { console.error('POLL ERROR', w.order_id, e.message); }
    }
  } catch (e) { console.error('POLLER ERROR', e.message); }
}, 60000);
// ================= END GATEWAY =================

const mainKeyboard = [['💰 Withdraw', '👤 Profile']];
const contactKeyboard = {
  keyboard: [[{ text: '📱 Share Contact', request_contact: true }]],
  resize_keyboard: true,
  one_time_keyboard: true
};
const userState = {};

setInterval(() => {
  const now = Date.now();
  for (const ip in rateLimitMap) {
    rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60000);
    if (rateLimitMap[ip].length === 0) delete rateLimitMap[ip];
  }
  for (const chat_id in userState) {
    if (userState[chat_id]?.timestamp && now - userState[chat_id].timestamp > 30 * 60 * 1000) {
      delete userState[chat_id];
    }
  }
  console.log('Memory cleanup done ✅');
}, 30 * 60 * 1000);

app.post('/webhook', async (req, res) => {
  try {
    const { message, callback_query } = req.body;

    if (callback_query) {
      const chat_id = callback_query.from.id.toString();
      const data = callback_query.data;
      const message_id = callback_query.message?.message_id;

      if (data === 'set_upi') {
        await answerAlert(callback_query.id, '');
        const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
        if (users.length > 0 && users[0].upi_id) {
          await editMsg(chat_id, message_id,
            `<b>💸 UPI Details:</b>\n\n<b>UPI ID: ${users[0].upi_id}</b>`,
            [[{ text: '✏️ Update', callback_data: 'update_upi' }]]
          );
        } else {
          // ✅ UPI nahi hai to no details message
          await editMsg(chat_id, message_id,
            `<b>💸 UPI Details:\n\nNo Upi Details saved.</b>`,
            [[{ text: '✏️ Update', callback_data: 'update_upi' }]]
          );
        }

      } else if (data === 'update_upi') {
        await answerAlert(callback_query.id, '');
        userState[chat_id] = { state: 'set_upi', message_id: null, timestamp: Date.now() };
        await sendMsg(chat_id, `<b>Please enter your UPI ID (format: alphanumeric@alphabets)\n\nExample: john.doe@okaxis</b>`);

      } else if (data === 'set_bank') {
        await answerAlert(callback_query.id, '');
        const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
        if (users.length > 0 && users[0].bank_account) {
          await editMsg(chat_id, message_id,
            `<b>🏦 Bank Details:</b>\n\n<b>Account Number: ${users[0].bank_account}</b>\n<b>IFSC Code: ${users[0].bank_ifsc}</b>`,
            [[{ text: '✏️ Update', callback_data: 'update_bank' }]]
          );
        } else {
          // ✅ Bank nahi hai to no details message
          await editMsg(chat_id, message_id,
            `<b>🏦 Bank Details:\n\nNo bank details saved.</b>`,
            [[{ text: '✏️ Update', callback_data: 'update_bank' }]]
          );
        }

      } else if (data === 'update_bank') {
        await answerAlert(callback_query.id, '');
        userState[chat_id] = { state: 'set_bank_account', message_id: null, timestamp: Date.now() };
        await sendMsg(chat_id, `<b>Please enter your account number:</b>`);

      } else if (data === 'withdraw_upi') {
        await answerAlert(callback_query.id, '');
        const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
        if (users.length > 0) {
          const u = users[0];
          if (!u.upi_id) {
            // ✅ UPI nahi hai
            await editMsg(chat_id, message_id,
              `<b>💸 UPI Details:\n\nNo UPI saved.</b>`,
              [[{ text: '✏️ Update', callback_data: 'update_upi' }]]
            );
          } else if (parseFloat(u.balance) >= 5) {
            userState[chat_id] = { state: 'withdraw_amount', method: 'upi', payment: u.upi_id, message_id, timestamp: Date.now() };
            await editMsg(chat_id, message_id, `<b>Please enter withdrawal amount (Minimum: ₹5.00):</b>`, []);
          } else {
            await sendMsg(chat_id, `<b>❌ Minimum ₹5 Required To Withdraw!</b>`, mainKeyboard);
          }
        }

      } else if (data === 'withdraw_bank') {
        await answerAlert(callback_query.id, '');
        const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
        if (users.length > 0) {
          const u = users[0];
          if (!u.bank_account) {
            // ✅ Bank nahi hai
            await editMsg(chat_id, message_id,
              `<b>🏦 Bank Details:\n\nNo bank details saved.</b>`,
              [[{ text: '✏️ Update', callback_data: 'update_bank' }]]
            );
          } else if (parseFloat(u.balance) >= 5) {
            userState[chat_id] = { state: 'withdraw_amount', method: 'bank', payment: `${u.bank_account} | ${u.bank_ifsc}`, message_id, timestamp: Date.now() };
            await editMsg(chat_id, message_id, `<b>Please enter withdrawal amount (Minimum: ₹5.00):</b>`, []);
          } else {
            await sendMsg(chat_id, `<b>❌ Minimum ₹5 Required To Withdraw!</b>`, mainKeyboard);
          }
        }

      } else if (data === 'approve_withdraw') {
        await answerAlert(callback_query.id, '');
        // ✅ Turant delete karo
        if (message_id) await deleteMsg(chat_id, message_id);
        const state = userState[chat_id];
        if (state && state.state === 'withdraw_confirm') {
          const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
          if (users.length > 0) {
            const u = users[0];
            if (parseFloat(u.balance) < parseFloat(state.amount)) {
              await sendMsg(chat_id, `<b>❌ Insufficient balance!</b>`, mainKeyboard);
              delete userState[chat_id];
              return res.send('OK');
            }
            const now = getTime();
            const requestId = getRequestId();
            const newBal = parseFloat(u.balance) - parseFloat(state.amount);
            await dbPost('withdrawals', { telegram_id: chat_id, amount: parseFloat(state.amount), upi_id: state.payment, status: 'pending', request_id: requestId });
            await dbPatch('users', `telegram_id=eq.${chat_id}`, { balance: newBal < 0 ? 0 : newBal });
            await sendInlineMsg(chat_id,
              `<b>⏳ Withdrawal Request Submitted for Menual Approval!</b>\n\n<b>📊 Request ID: ${requestId}</b>\n<b>💰 Amount: ₹${state.amount}</b>\n<b>📱 Method: ${state.method === 'upi' ? 'UPI' : 'Bank'}</b>\n<b>📅 Date: ${now}</b>`,
              [[{ text: '🔍 Check Status', callback_data: `status_${requestId}` }]]
            );
            const adminText = `<b>💸 New Withdraw Request!</b>\n\n<b>🧑 User: ${u.name}</b>\n<b>📱 Phone: ${u.phone}</b>\n<b>💰 Amount: ₹${state.amount}</b>\n<b>💳 Payment: ${state.payment}</b>\n<b>📅 Time: ${now}</b>\n<b>📊 Request ID: ${requestId}</b>`;
            const isUpiW = state.method === 'upi';
            const manualFeeNote = isUpiW ? `\n\n<b>💵 Pay: ₹${Math.max(parseFloat(state.amount) - WITHDRAW_FEE, 0).toFixed(2)} (after ₹${WITHDRAW_FEE} fee)</b>` : '';
            const auto = await startAutoPayout({ request_id: requestId, telegram_id: chat_id, amount: parseFloat(state.amount), upi_id: state.payment });
            if (auto) {
              await sendMsg(ADMIN_ID, adminText + `\n\n<b>⚡ Auto payout via gateway (₹${(parseFloat(state.amount) - WITHDRAW_FEE).toFixed(2)} after ₹${WITHDRAW_FEE} fee)</b>`);
            } else {
              await sendInlineMsg(ADMIN_ID, adminText + manualFeeNote,
                [[{ text: '✅ Approve', callback_data: `admin_approve_${requestId}` }, { text: '❌ Cancel', callback_data: `admin_cancel_${requestId}` }]]
              );
            }
            delete userState[chat_id];
          }
        }

      } else if (data === 'cancel_withdraw') {
        await answerAlert(callback_query.id, '');
        // ✅ Turant delete karo
        if (message_id) await deleteMsg(chat_id, message_id);
        delete userState[chat_id];
        await sendMsg(chat_id, `<b>❌ Withdrawal Cancelled!</b>`, mainKeyboard);

      } else if (data.startsWith('status_')) {
        const requestId = data.replace('status_', '');
        const withdrawals = await dbGet('withdrawals', `request_id=eq.${requestId}`);
        if (withdrawals.length > 0) {
          const w = withdrawals[0];
          if (w.telegram_id !== chat_id && chat_id !== ADMIN_ID) {
            await answerAlert(callback_query.id, '❌ Unauthorized!');
            return res.send('OK');
          }
          const statusEmoji = w.status === 'paid' ? '✅' : w.status === 'cancelled' ? '❌' : '🕐';
          const statusText = w.status === 'paid' ? 'Paid' : w.status === 'cancelled' ? 'Cancelled' : 'Pending';
          await answerAlert(callback_query.id, `Status: ${statusText} ${statusEmoji}`);
        }

      } else if (data.startsWith('admin_approve_')) {
        if (chat_id !== ADMIN_ID) {
          await answerAlert(callback_query.id, '❌ Unauthorized!');
          return res.send('OK');
        }
        const requestId = data.replace('admin_approve_', '');
        const withdrawals = await dbGet('withdrawals', `request_id=eq.${requestId}`);
        if (withdrawals.length > 0) {
          const w = withdrawals[0];
          if (w.status !== 'pending') {
            await answerAlert(callback_query.id, '⚠️ Already processed!');
            return res.send('OK');
          }
          await dbPatch('withdrawals', `request_id=eq.${requestId}`, { status: 'paid' });
          await editMsg(ADMIN_ID, message_id,
            `<b>💸 Withdraw Request</b>\n\n<b>📊 Request ID: ${requestId}</b>\n<b>💰 Amount: ₹${w.amount}</b>\n<b>💳 Payment: ${w.upi_id}</b>\n\n<b>✅ Approved</b>`, []
          );
          await sendMsg(w.telegram_id, `<b>Your withdrawal request of ₹${parseFloat(w.amount).toFixed(2)} has been approved! ✅</b>`);
          await answerAlert(callback_query.id, '✅ Approved!');
        }

      } else if (data.startsWith('admin_cancel_')) {
        if (chat_id !== ADMIN_ID) {
          await answerAlert(callback_query.id, '❌ Unauthorized!');
          return res.send('OK');
        }
        const requestId = data.replace('admin_cancel_', '');
        const withdrawals = await dbGet('withdrawals', `request_id=eq.${requestId}`);
        if (withdrawals.length > 0) {
          const w = withdrawals[0];
          if (w.status !== 'pending') {
            await answerAlert(callback_query.id, '⚠️ Already processed!');
            return res.send('OK');
          }
          await dbPatch('withdrawals', `request_id=eq.${requestId}`, { status: 'cancelled' });
          const users = await dbGet('users', `telegram_id=eq.${w.telegram_id}`);
          if (users.length > 0) {
            const refundBal = parseFloat(users[0].balance) + parseFloat(w.amount);
            await dbPatch('users', `telegram_id=eq.${w.telegram_id}`, { balance: refundBal });
          }
          await editMsg(ADMIN_ID, message_id,
            `<b>💸 Withdraw Request</b>\n\n<b>📊 Request ID: ${requestId}</b>\n<b>💰 Amount: ₹${w.amount}</b>\n<b>💳 Payment: ${w.upi_id}</b>\n\n<b>❌ Cancelled</b>`, []
          );
          await sendMsg(w.telegram_id, `<b>❌ Your withdraw request failed. Please contact CashFlix support.</b>\n\n<b>💰 ₹${parseFloat(w.amount).toFixed(2)} has been refunded to your wallet!</b>`);
          await answerAlert(callback_query.id, '❌ Cancelled!');
        }

      } else {
        await answerAlert(callback_query.id, '');
      }

      return res.send('OK');
    }

    if (!message) return res.send('OK');
    const chat_id = message.chat.id.toString();
    const name = sanitize(message.from.first_name || 'User');

    if (message.contact) {
      const phone = message.contact.phone_number.replace(/\D/g, '').replace(/^91/, '');
      if (message.contact.user_id && message.contact.user_id.toString() !== chat_id) {
        await sendMsg(chat_id, `<b>❌ Please share your own contact only!</b>`);
        return res.send('OK');
      }
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length === 0) {
        const existing = await dbGet('users', `phone=eq.${phone}`);
        if (existing.length > 0) {
          await sendMsg(chat_id, `<b>❌ This phone number is already registered!</b>`);
          return res.send('OK');
        }
        await dbPost('users', { telegram_id: chat_id, name, phone, balance: 0, lifetime_earnings: 0 });
        await sendMsg(chat_id, `<b>✅ Registration successful! You can now use the bot.</b>`, mainKeyboard);
        await sendMsg(chat_id, `<b>👤 Profile</b>\n\n<b>🙌🏻 User: ${name} ⚡</b>\n<b>💰 Balance: ₹0.00</b>\n<b>🪢 Lifetime Earnings: ₹0.00</b>\n<b>📱 Phone: ${phone}</b>`, mainKeyboard);
      } else {
        await sendMsg(chat_id, `<b>✅ Already registered!</b>`, mainKeyboard);
      }
      return res.send('OK');
    }

    const text = message.text || '';

    if (text === '👤 Profile' || text === '💰 Withdraw') {
      delete userState[chat_id];
    }

    if (userState[chat_id]) {
      const state = userState[chat_id].state;
      const mid = userState[chat_id].message_id;

      if (state === 'set_upi') {
        if (isValidUPI(text)) {
          await dbPatch('users', `telegram_id=eq.${chat_id}`, { upi_id: text });
          delete userState[chat_id];
          await sendMsg(chat_id, `<b>✅ UPI ID updated successfully!</b>\n\n<b>💳 UPI ID: ${text}</b>`, mainKeyboard);
        } else {
          await sendMsg(chat_id, `<b>❌ Invalid UPI format! Please try again.\n\nExample: john.doe@okaxis</b>`);
        }
        return res.send('OK');

      } else if (state === 'set_bank_account') {
        if (/^\d{9,18}$/.test(text)) {
          userState[chat_id] = { state: 'set_bank_ifsc', account: text, message_id: null, timestamp: Date.now() };
          await sendMsg(chat_id, `<b>🏦 Please enter your IFSC code:</b>`);
        } else {
          await sendMsg(chat_id, `<b>❌ Invalid account number! Please enter again:</b>`);
        }
        return res.send('OK');

      } else if (state === 'set_bank_ifsc') {
        if (isValidIFSC(text)) {
          const account = userState[chat_id].account;
          await dbPatch('users', `telegram_id=eq.${chat_id}`, { bank_account: account, bank_ifsc: text.toUpperCase() });
          delete userState[chat_id];
          await sendMsg(chat_id, `<b>✅ Bank Details updated successfully!</b>\n\n<b>🏦 Account: ${account}</b>\n<b>📋 IFSC: ${text.toUpperCase()}</b>`, mainKeyboard);
        } else {
          await sendMsg(chat_id, `<b>❌ Invalid IFSC code format. Please enter a valid IFSC code (e.g., SBIN0001234). Please try again</b>`);
        }
        return res.send('OK');

      } else if (state === 'withdraw_amount') {
        const amt = parseFloat(text);
        const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
        if (users.length > 0) {
          const u = users[0];
          if (isNaN(amt) || amt < 5) {
            await sendMsg(chat_id, `<b>❌ Minimum ₹5 required!</b>`);
          } else if (amt > parseFloat(u.balance)) {
            await sendMsg(chat_id, `<b>❌ Insufficient balance!</b>`);
          } else {
            const method = userState[chat_id].method;
            const payment = userState[chat_id].payment;
            userState[chat_id] = { state: 'withdraw_confirm', amount: amt, method, payment, message_id: mid, timestamp: Date.now() };
            const confirmMsgId = await sendInlineMsg(chat_id,
              `<b>⚠️ Withdrawal Confirmation</b>\n\n<b>💰 Amount: ₹${amt}</b>\n<b>📱 Method: ${method === 'upi' ? 'UPI' : 'Bank'}</b>\n<b>💸 ${method === 'upi' ? 'UPI ID' : 'Bank'}: ${payment}</b>`,
              [[{ text: '✅ Confirm', callback_data: 'approve_withdraw' }, { text: '❌ Cancel', callback_data: 'cancel_withdraw' }]]
            );
            userState[chat_id].confirmMsgId = confirmMsgId;
            // ✅ 60 sec baad auto delete
            setTimeout(async () => {
              if (confirmMsgId) await deleteMsg(chat_id, confirmMsgId);
              if (userState[chat_id]?.state === 'withdraw_confirm') {
                delete userState[chat_id];
              }
            }, 60000);
          }
        }
        return res.send('OK');
      }
    }

    if (text === '/start') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length === 0) {
        await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id,
            text: `<b>👋 Welcome! To use this bot, please share your phone number:</b>`,
            parse_mode: 'HTML',
            reply_markup: contactKeyboard
          })
        });
      } else {
        const u = users[0];
        await sendMsg(chat_id, `<b>👤 Profile</b>\n\n<b>🧑 User: ${u.name} ⚡</b>\n<b>💰 Balance: ₹${parseFloat(u.balance).toFixed(2)}</b>\n<b>🔁 Lifetime Earnings: ₹${parseFloat(u.lifetime_earnings).toFixed(2)}</b>\n<b>📱 Phone: ${u.phone}</b>`, mainKeyboard);
      }

    } else if (text === '👤 Profile') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0) {
        const u = users[0];
        await sendInlineMsg(chat_id,
          `<b>👤 Profile</b>\n\n<b>🙌🏻 User: ${u.name} ⚡</b>\n<b>💰 Balance: ₹${parseFloat(u.balance).toFixed(2)}</b>\n<b>🪢 Lifetime Earnings: ₹${parseFloat(u.lifetime_earnings).toFixed(2)}</b>\n<b>📱 Phone: ${u.phone}</b>`,
          [
            [{ text: '💸 UPI', callback_data: 'set_upi' }],
            [{ text: '🏦 Bank Details', callback_data: 'set_bank' }]
          ]
        );
      }

    } else if (text === '💰 Withdraw') {
      const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
      if (users.length > 0) {
        const u = users[0];
        if (parseFloat(u.balance) < 5) {
          await sendMsg(chat_id, `<b>❌ Minimum ₹5 Required To Withdraw!</b>`, mainKeyboard);
        } else if (u.upi_id && u.bank_account) {
          await sendInlineMsg(chat_id,
            `<b>Choose Payment Method:</b>`,
            [[{ text: '💸 UPI Transfer', callback_data: 'withdraw_upi' }], [{ text: '🏦 Bank Transfer', callback_data: 'withdraw_bank' }]]
          );
        } else if (u.upi_id) {
          userState[chat_id] = { state: 'withdraw_amount', method: 'upi', payment: u.upi_id, timestamp: Date.now() };
          await sendMsg(chat_id, `<b>Please enter withdrawal amount (Minimum: ₹5.00):</b>`);
        } else if (u.bank_account) {
          userState[chat_id] = { state: 'withdraw_amount', method: 'bank', payment: `${u.bank_account} | ${u.bank_ifsc}`, timestamp: Date.now() };
          await sendMsg(chat_id, `<b>Please enter withdrawal amount (Minimum: ₹5.00):</b>`);
        } else {
          // ✅ Koi bhi method nahi hai
          await sendInlineMsg(chat_id,
            `<b>Choose Payment Method:</b>`,
            [[{ text: '💸 UPI Transfer', callback_data: 'withdraw_upi' }], [{ text: '🏦 Bank Transfer', callback_data: 'withdraw_bank' }]]
          );
        }
      }

    } else if (/^\/(.+?)\s+(on|of|off)\s+turnstile$/i.test(text) && chat_id === ADMIN_ID) {
      const m = text.match(/^\/(.+?)\s+(on|of|off)\s+turnstile$/i);
      const typed = m[1].trim();
      const turnOn = m[2].toLowerCase() === 'on';
      const found = Object.values(OFFERS).find(o => o.name.toLowerCase() === typed.toLowerCase());
      if (!found) {
        await sendMsg(ADMIN_ID, `<b>❌ Offer nahi mila: ${typed}</b>\n\n<b>Available:</b> ${Object.values(OFFERS).map(o => o.name).join(', ')}`);
      } else {
        const existing = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(found.name)}`);
        if (!Array.isArray(existing)) {
          await sendMsg(ADMIN_ID, `<b>❌ Database error. Supabase me ye SQL chalao:</b>\nALTER TABLE offer_status ADD COLUMN IF NOT EXISTS captcha BOOLEAN DEFAULT true;`);
        } else {
          let ok = false;
          if (existing.length > 0) {
            const rows = await dbPatchReturn('offer_status', `offer_name=eq.${encodeURIComponent(found.name)}`, { captcha: turnOn });
            ok = rows.length > 0;
          } else {
            await dbPost('offer_status', { offer_name: found.name, is_active: true, captcha: turnOn });
            const chk = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(found.name)}`);
            ok = Array.isArray(chk) && chk.length > 0;
          }
          if (ok) {
            await sendMsg(ADMIN_ID, turnOn ? `<b>🛡️ ${found.name} — Turnstile ON (captcha wapas aa gaya)</b>` : `<b>⚡ ${found.name} — Turnstile OFF (sirf Submit button)</b>`);
          } else {
            await sendMsg(ADMIN_ID, `<b>❌ Save nahi hua. Supabase me ye SQL chalao:</b>\nALTER TABLE offer_status ADD COLUMN IF NOT EXISTS captcha BOOLEAN DEFAULT true;`);
          }
        }
      }

    } else if (text.startsWith('/pause ') && chat_id === ADMIN_ID) {
      const offerName = text.replace('/pause ', '').trim();
      const existing = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(offerName)}`);
      if (existing.length > 0) {
        await dbPatch('offer_status', `offer_name=eq.${encodeURIComponent(offerName)}`, { is_active: false });
      } else {
        await dbPost('offer_status', { offer_name: offerName, is_active: false });
      }
      await sendMsg(ADMIN_ID, `<b>⏸️ ${offerName} — Paused Successfully!</b>`);

    } else if (text.startsWith('/resume ') && chat_id === ADMIN_ID) {
      const offerName = text.replace('/resume ', '').trim();
      const existing = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(offerName)}`);
      if (existing.length > 0) {
        await dbPatch('offer_status', `offer_name=eq.${encodeURIComponent(offerName)}`, { is_active: true });
      } else {
        await dbPost('offer_status', { offer_name: offerName, is_active: true });
      }
      await sendMsg(ADMIN_ID, `<b>▶️ ${offerName} — Resumed Successfully!</b>`);

    } else if (text === '/offers' && chat_id === ADMIN_ID) {
      const offers = await dbGet('offer_status', `order=offer_name.asc`);
      if (offers.length === 0) {
        await sendMsg(ADMIN_ID, `<b>📋 No offers configured yet!</b>`);
      } else {
        let msg = `<b>📋 Offer Status:</b>\n\n`;
        offers.forEach(o => {
          msg += `${o.is_active ? '▶️' : '⏸️'} <b>${o.offer_name}</b> — ${o.is_active ? 'Active' : 'Paused'}\n`;
        });
        await sendMsg(ADMIN_ID, msg);
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
          await sendMsg(u.telegram_id, `<b>Your withdrawal request of ₹${parseFloat(w.amount).toFixed(2)} has been approved! ✅</b>`);
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
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimit(ip, 30, 60000)) return res.status(429).json({ success: false });
    const { click_id, offer_name } = req.body;
    if (!click_id || !offer_name) return res.json({ success: false });
    if (!/^[6-9]\d{9}[A-Za-z0-9]{0,30}$/.test(click_id)) return res.json({ success: false });
    console.log('CLICK RECEIVED:', { click_id, offer_name });
    await dbPost('clicks', { click_id, offer_name: sanitize(offer_name) });
    res.json({ success: true });
  } catch(e) {
    console.error(e);
    res.json({ success: false });
  }
});

app.get('/offer-status', async (req, res) => {
  try {
    const { offer } = req.query;
    if (!offer) return res.json({ is_active: true });
    const result = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(offer)}`);
    if (result.length > 0) {
      res.json({ is_active: result[0].is_active, captcha: result[0].captcha !== false });
    } else {
      res.json({ is_active: true });
    }
  } catch(e) {
    res.json({ is_active: true });
  }
});

// ================= SECURE OFFER ROUTING (CID + affiliate links stay on server) =================
// cid (public, in your shared link) -> offer key
const CID_MAP = {
  'TONG8X7K2': 'M',
  'BFNS9X3K1': 'bb',
  'STNS5X2K9': 'S',
  'HAPY7X4Q8': 'X'
};
// offer key -> real offer name (for tracking) + affiliate link (never sent to the browser source)
const OFFERS = {
  // param = click id ka parameter naam (p1, affsub, aff_sub, sub1 ... jo network bole)
  'M':  { name: 'Toing', param: 'p1', link: 'https://trackxmedia.swiftcashreward.com/go?cid=149&uid=249' },
  'bb': { name: 'bb',    param: 'p1', link: '' }, // TODO: apna affiliate link yaha daalo
  'S':  { name: 'S',     param: 'p1', link: '' }, // TODO: apna affiliate link yaha daalo
  'X':  { name: 'Happy You', param: 'sub_aff_id', link: 'https://publisher.apnacashy.site/c/?o=53&a=15' }
};

app.get('/route', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!rateLimit(ip, 60, 60000)) return res.status(429).json({ file: null });
  const key = CID_MAP[String(req.query.cid || '')];
  res.json({ file: key || null });
});

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET; // Cloudflare Turnstile secret key (Render env)
const TURNSTILE_SITEKEY = process.env.TURNSTILE_SITEKEY || '0x4AAAAAAFpbARXAqWUl1Tzl'; // public site key (widget ke liye)

app.get('/turnstile-key', (req, res) => res.json({ key: TURNSTILE_SITEKEY }));

async function verifyTurnstile(token, ip) {
  if (!TURNSTILE_SECRET) return true; // secret set nahi hai to verification skip
  if (!token) return false;
  try {
    const r = await fetchWithTimeout('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip })
    });
    const j = await r.json();
    return j.success === true;
  } catch (e) {
    console.error('TURNSTILE ERROR:', e.message);
    return false;
  }
}

app.post('/go', async (req, res) => {
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    if (!rateLimit(ip, 30, 60000)) return res.status(429).json({ success: false, reason: 'rate_limited' });
    const { click_id, offer_key, cf_token } = req.body || {};
    const offer = OFFERS[offer_key];
    if (!offer) return res.json({ success: false, reason: 'unknown_offer_key_' + offer_key });
    if (!offer.link) return res.json({ success: false, reason: 'offer_link_empty' });
    if (!click_id || !/^[6-9]\d{9}[A-Za-z0-9]{0,30}$/.test(click_id)) return res.json({ success: false, reason: 'bad_click_id' });
    let captchaOn = true;
    try {
      const st = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(offer.name)}`);
      if (Array.isArray(st) && st.length > 0 && st[0].is_active === false) return res.json({ success: false, paused: true, reason: 'offer_paused' });
      if (Array.isArray(st) && st.length > 0 && st[0].captcha === false) captchaOn = false;
    } catch (e) {}

    // 1) Human verification (Cloudflare Turnstile) - admin /<offer> off turnstile se band ho sakta hai
    if (captchaOn && !(await verifyTurnstile(cf_token, ip))) return res.json({ success: false, reason: 'verify_failed' });

    // 2) Ek IP se ek offer sirf ek baar
    let ipColumnOk = false;
    if (ip) {
      const prev = await dbGet('clicks', `ip=eq.${encodeURIComponent(ip)}&offer_name=eq.${encodeURIComponent(offer.name)}&select=click_id&limit=1`);
      if (Array.isArray(prev)) {
        ipColumnOk = true;
        if (prev.length > 0) return res.json({ success: false, reason: 'ip_used' });
      } else {
        console.error('IP CHECK FAILED (clicks.ip column missing?):', JSON.stringify(prev));
      }
    }

    const row = { click_id, offer_name: offer.name };
    if (ipColumnOk) row.ip = ip;
    await dbPost('clicks', row);
    const affiliate = offer.link + (offer.link.includes('?') ? '&' : '?') + (offer.param || 'p1') + '=' + encodeURIComponent(click_id);
    res.json({ success: true, url: 'https://publisher.cashflix.site/api/redirect?url=' + encodeURIComponent(affiliate) });
  } catch (e) {
    console.error('GO ERROR:', e);
    res.json({ success: false, reason: 'server_error' });
  }
});
// ================= END SECURE OFFER ROUTING =================

app.get('/postback', async (req, res) => {
  try {
    const { click_id = 'N/A', event = 'N/A', token } = req.query;

    if (token !== POSTBACK_TOKEN) {
      console.log('INVALID TOKEN:', token);
      return res.status(403).send('Forbidden');
    }

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!rateLimit(ip, 50, 60000)) return res.status(429).send('Too Many Requests');

    console.log('POSTBACK RECEIVED:', req.query);
    const phone = String(click_id).slice(0, 10); // click_id = phone + unique suffix

    let runTime = getTime();
    let offer = req.query.offer || 'Unknown';

    try {
      const clicks = await dbGet('clicks', `click_id=eq.${click_id}&order=created_at.desc&limit=1`);
      if (clicks.length > 0) {
        offer = clicks[0].offer_name;
        runTime = new Date(clicks[0].created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
      }
    } catch(e) {}

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

    if (['web', 'initial', 'install', 'e1', 'default'].includes(eventName)) {
      amount = config.installAmt || 0;
      comment = config.installComment;
      addBalance = config.installBalance;
    } else if (['trial', 'purchase', 'e2', 'gold_buy', 'signup', 'register', 'registration', 'deposit', 'af_subscribe'].includes(eventName)) {
      amount = config.trialAmt || 0;
      comment = config.trialComment;
      addBalance = config.trialBalance;
    } else {
      amount = parseFloat(req.query.amount || 0);
      comment = `${offer} Complete`;
      addBalance = true;
    }

    await dbPost('conversions', { telegram_id: phone, click_id, offer_name: offer, amount, event });

    const users = await dbGet('users', `phone=eq.${phone}`);
    const userPayment = users.length > 0 ? 'Success' : 'Failed';

    if (users.length > 0) {
      const u = users[0];
      if (addBalance && amount > 0) {
        const newBal = parseFloat(u.balance) + amount;
        const newLife = parseFloat(u.lifetime_earnings) + amount;
        await dbPatch('users', `phone=eq.${phone}`, { balance: newBal, lifetime_earnings: newLife });
        await sendMsg(u.telegram_id, `<b>🧿 Cashback Credited 🧿</b>\n\n<b>💶 Amount  = ${amount}</b>\n<b>💰 Updated Balance = ${newBal.toFixed(2)}</b>\n\n<b>💡 Comment = ${comment}</b>`);
      } else if (amount > 0) {
        await sendMsg(u.telegram_id, `<b>🧿 Cashback Credited 🧿</b>\n\n<b>💶 Amount  = ${amount}</b>\n<b>💰 Updated Balance = ${parseFloat(u.balance).toFixed(2)}</b>\n\n<b>💡 Comment = ${comment}</b>`);
      }
    }

    const trackTime = getTime();
    const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskPhone(phone)}</b>\n<b>User Amount : ₹${amount}</b>\n<b>🥳 User Payment : ${userPayment}</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - CashFlix</b>`;
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
  try { await fetchWithTimeout('https://cash-flix-dytv.onrender.com/'); } catch(e) {}
}, 14 * 60 * 1000);

  
