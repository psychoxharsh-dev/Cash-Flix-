const express = require('express');
const util = require('util');
const r2 = n => Math.round((Number(n) || 0) * 100 + (n < 0 ? -1e-9 : 1e-9)) / 100; // paise tak sahi (3.50 + 3.50 = 7.00)
const fmtAmt = n => { n = r2(n); return Number.isInteger(n) ? String(n) : n.toFixed(2); };
// ---- live log buffer (admin panel me dikhta hai, secrets chhupa ke) ----
const LOGBUF = []; let logSeq = 0;
function redactLog(s) {
  s = String(s);
  [process.env.BOT_TOKEN, process.env.ADMIN_BOT_TOKEN, process.env.SUPABASE_KEY, process.env.POSTBACK_TOKEN, process.env.GATEWAY_CLIENT_SECRET, process.env.TURNSTILE_SECRET].forEach(v => { if (v && String(v).length >= 6) s = s.split(String(v)).join('***'); });
  return s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***').replace(/(token\W{1,4})[^\s'",}]{3,}/gi, '$1***').replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{10,}/g, '***');
}
['log', 'info', 'warn', 'error'].forEach(lvl => {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => {
    try {
      const msg = a.map(x => typeof x === 'string' ? x : (x instanceof Error ? (x.stack || x.message) : util.inspect(x, { depth: 3, breakLength: Infinity }))).join(' ');
      LOGBUF.push({ id: ++logSeq, t: Date.now(), l: (lvl === 'log' || lvl === 'info') ? 'info' : lvl, m: redactLog(msg).slice(0, 1500) });
      if (LOGBUF.length > 800) LOGBUF.splice(0, LOGBUF.length - 800);
    } catch (e) {}
    orig(...a);
  };
});
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-token');
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

// Telegram tak network kabhi kabhi timeout hota hai (ETIMEDOUT). Isliye: IPv4 pehle, zyada retry, aur fail hone par background queue me retry.
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) {}
try { require('net').setDefaultAutoSelectFamilyAttemptTimeout(2500); } catch (e) {}
const sendQueue = [];
let sendQueueRunning = false;
async function sendTry(body) {
  // returns {ok, id, retry, wait}
  try {
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (res.ok) { const data = await res.json(); return { ok: true, id: data.result?.message_id }; }
    let j = {}; try { j = await res.json(); } catch (e) {}
    if (res.status === 429) return { retry: true, wait: ((j.parameters && j.parameters.retry_after) || 3) * 1000 };
    if (res.status >= 500) return { retry: true, wait: 2000 };
    if (j.description && /parse entities/i.test(j.description) && body.parse_mode) { delete body.parse_mode; return { retry: true, wait: 0 }; }
    return { ok: false, retry: false, err: j.description || res.status };   // blocked / chat not found: retry bekar
  } catch (e) { return { retry: true, wait: 1500, err: e }; }
}
async function runSendQueue() {
  if (sendQueueRunning) return; sendQueueRunning = true;
  while (sendQueue.length) {
    const it = sendQueue[0];
    const r = await sendTry(it.body);
    if (r.ok || !r.retry) { sendQueue.shift(); continue; }
    it.tries++;
    if (it.tries >= 40) { sendQueue.shift(); console.error('sendMsg gave up after queue retries, chat', it.body.chat_id); continue; }
    await new Promise(r2 => setTimeout(r2, Math.min(30000, 3000 * it.tries)));
  }
  sendQueueRunning = false;
}
async function sendMsg(chat_id, text, keyboard) {
  const body = { chat_id, text, parse_mode: 'HTML' };
  if (keyboard) body.reply_markup = { keyboard, resize_keyboard: true };
  let last;
  for (let i = 0; i < 3; i++) {
    const r = await sendTry(body);
    if (r.ok) return r.id;
    if (!r.retry) return;
    last = r.err;
    await new Promise(r2 => setTimeout(r2, Math.max(r.wait || 0, 800 * (i + 1))));
  }
  console.error('sendMsg direct failed, background queue me daal diya:', last && last.message ? last.message : last);
  sendQueue.push({ body, tries: 0 }); runSendQueue();
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
let WITHDRAW_COOLDOWN_HOURS = parseFloat(process.env.WITHDRAW_COOLDOWN_HOURS || '8');
let MIN_WITHDRAW = parseFloat(process.env.MIN_WITHDRAW || '10');
let AUTO_PAYOUT_ENABLED = true;
let WITHDRAW_ENABLED = true;
let MAINTENANCE = false;
let TRACK_CHANNEL = true, IP_CHECK = true, CAPTCHA_GLOBAL = true, NOTIFY_USERS = true;
let offerFlags = {};
const offFlag = (name, k) => !(offerFlags[name] && offerFlags[name][k] === false);
let WITHDRAW_FEE = parseFloat(process.env.WITHDRAW_FEE || '0');
let AUTO_PAYOUT_MAX = parseFloat(process.env.AUTO_PAYOUT_MAX || '200');

function gwHeaders(extra = {}) {
  return { 'Content-Type': 'application/json', 'X-Client-Id': GW_ID, 'X-Client-Secret': GW_SECRET, ...extra };
}

async function dbPostOk(table, data) {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(data)
    });
    if (!res.ok) { console.error('DB INSERT FAILED', table, res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error('DB INSERT ERROR', table, e.message); return false; }
}

async function dbPatchReturn(table, filter, data) {
  const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(data)
  });
  try { const j = await res.json(); return Array.isArray(j) ? j : []; } catch (e) { return []; }
}


// Withdraw ke beech 8 ghante ka gap. Cancelled withdraw gina nahi jata.
async function withdrawCooldownMsg(chat_id) {
  if (!WITHDRAW_ENABLED) return '<b>⏸ Withdrawals are temporarily paused. Please try again later.</b>';
  try {
    const last = await dbGet('withdrawals', `telegram_id=eq.${chat_id}&status=neq.cancelled&order=created_at.desc&limit=1&select=created_at`);
    if (!Array.isArray(last) || last.length === 0 || !last[0].created_at) return '';
    const waitMs = WITHDRAW_COOLDOWN_HOURS * 3600000 - (Date.now() - new Date(last[0].created_at).getTime());
    if (waitMs <= 0) return '';
    const h = Math.floor(waitMs / 3600000);
    const m = Math.ceil((waitMs % 3600000) / 60000);
    return `<b>⏳ You can withdraw again after ${h > 0 ? h + 'h ' : ''}${m}m.</b>`;
  } catch (e) { return ''; }
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
      const refundBal = r2(parseFloat(users[0].balance) + parseFloat(w.amount));
      await dbPatch('users', `telegram_id=eq.${w.telegram_id}`, { balance: refundBal });
    }
    await sendMsg(w.telegram_id, `<b>❌ Your withdraw request failed. Please contact CashFlix support.</b>\n\n<b>💰 ₹${parseFloat(w.amount).toFixed(2)} has been refunded to your wallet!</b>`);
    await sendMsg(ADMIN_ID, `<b>❌ Auto payout failed & refunded — ₹${parseFloat(w.amount).toFixed(2)} (${w.upi_id})</b>\n<b>📊 Request ID: ${w.request_id}</b>`);
  }
}

// returns true if handled automatically (no manual admin buttons needed)
async function startAutoPayout(w, force) {
  try {
    if (!GW_ID || !GW_SECRET) return false;
    const upi = String(w.upi_id || '');
    if (!upi.includes('@') || upi.includes('|')) return false;
    if (!force && (!AUTO_PAYOUT_ENABLED || parseFloat(w.amount) > AUTO_PAYOUT_MAX)) return false;
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
          const cdMsg = await withdrawCooldownMsg(chat_id);
          if (cdMsg) { await sendMsg(chat_id, cdMsg, mainKeyboard); return res.send('OK'); }
          if (!u.upi_id) {
            // ✅ UPI nahi hai
            await editMsg(chat_id, message_id,
              `<b>💸 UPI Details:\n\nNo UPI saved.</b>`,
              [[{ text: '✏️ Update', callback_data: 'update_upi' }]]
            );
          } else if (parseFloat(u.balance) >= MIN_WITHDRAW) {
            userState[chat_id] = { state: 'withdraw_amount', method: 'upi', payment: u.upi_id, message_id, timestamp: Date.now() };
            await editMsg(chat_id, message_id, `<b>Please enter withdrawal amount (Minimum: ₹${MIN_WITHDRAW.toFixed(2)}):</b>`, []);
          } else {
            await sendMsg(chat_id, `<b>❌ Minimum ₹${MIN_WITHDRAW} Required To Withdraw!</b>`, mainKeyboard);
          }
        }

      } else if (data === 'withdraw_bank') {
        await answerAlert(callback_query.id, '');
        const users = await dbGet('users', `telegram_id=eq.${chat_id}`);
        if (users.length > 0) {
          const u = users[0];
          const cdMsg = await withdrawCooldownMsg(chat_id);
          if (cdMsg) { await sendMsg(chat_id, cdMsg, mainKeyboard); return res.send('OK'); }
          if (!u.bank_account) {
            // ✅ Bank nahi hai
            await editMsg(chat_id, message_id,
              `<b>🏦 Bank Details:\n\nNo bank details saved.</b>`,
              [[{ text: '✏️ Update', callback_data: 'update_bank' }]]
            );
          } else if (parseFloat(u.balance) >= MIN_WITHDRAW) {
            userState[chat_id] = { state: 'withdraw_amount', method: 'bank', payment: `${u.bank_account} | ${u.bank_ifsc}`, message_id, timestamp: Date.now() };
            await editMsg(chat_id, message_id, `<b>Please enter withdrawal amount (Minimum: ₹${MIN_WITHDRAW.toFixed(2)}):</b>`, []);
          } else {
            await sendMsg(chat_id, `<b>❌ Minimum ₹${MIN_WITHDRAW} Required To Withdraw!</b>`, mainKeyboard);
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
            if (u.blocked === true) {
              await sendMsg(chat_id, `<b>❌ Your account is blocked. Please contact CashFlix support.</b>`, mainKeyboard);
              delete userState[chat_id];
              return res.send('OK');
            }
            const cdMsg = await withdrawCooldownMsg(chat_id);
            if (cdMsg) {
              await sendMsg(chat_id, cdMsg, mainKeyboard);
              delete userState[chat_id];
              return res.send('OK');
            }
            if (parseFloat(u.balance) < parseFloat(state.amount)) {
              await sendMsg(chat_id, `<b>❌ Insufficient balance!</b>`, mainKeyboard);
              delete userState[chat_id];
              return res.send('OK');
            }
            const now = getTime();
            const requestId = getRequestId();
            const newBal = r2(parseFloat(u.balance) - parseFloat(state.amount));
            await dbPost('withdrawals', { telegram_id: chat_id, amount: parseFloat(state.amount), upi_id: state.payment, status: 'pending', request_id: requestId });
            await dbPatch('users', `telegram_id=eq.${chat_id}`, { balance: newBal < 0 ? 0 : newBal });
            await sendInlineMsg(chat_id,
              `<b>⏳ Withdrawal Request Submitted for Menual Approval!</b>\n\n<b>📊 Request ID: ${requestId}</b>\n<b>💰 Amount: ₹${state.amount}</b>\n<b>📱 Method: ${state.method === 'upi' ? 'UPI' : 'Bank'}</b>\n<b>📅 Date: ${now}</b>`,
              [[{ text: '🔍 Check Status', callback_data: `status_${requestId}` }]]
            );
            const adminText = `<b>💸 New Withdraw Request!</b>\n\n<b>🧑 User: ${u.name}</b>\n<b>📱 Phone: ${u.phone}</b>\n<b>💰 Amount: ₹${state.amount}</b>\n<b>💳 Payment: ${state.payment}</b>\n<b>📅 Time: ${now}</b>\n<b>📊 Request ID: ${requestId}</b>`;
            const isUpiW = state.method === 'upi';
            const manualFeeNote = (isUpiW && WITHDRAW_FEE > 0) ? `\n\n<b>💵 Pay: ₹${Math.max(parseFloat(state.amount) - WITHDRAW_FEE, 0).toFixed(2)} (after ₹${WITHDRAW_FEE} fee)</b>` : '';
            const auto = await startAutoPayout({ request_id: requestId, telegram_id: chat_id, amount: parseFloat(state.amount), upi_id: state.payment });
            if (auto) {
              await sendMsg(ADMIN_ID, adminText + `\n\n<b>⚡ Auto payout via gateway ${WITHDRAW_FEE > 0 ? `(₹${(parseFloat(state.amount) - WITHDRAW_FEE).toFixed(2)} after ₹${WITHDRAW_FEE} fee)` : ''}</b>`);
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
            const refundBal = r2(parseFloat(users[0].balance) + parseFloat(w.amount));
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
          if (isNaN(amt) || amt < MIN_WITHDRAW) {
            await sendMsg(chat_id, `<b>❌ Minimum ₹${MIN_WITHDRAW} required!</b>`);
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
        const cdMsg = await withdrawCooldownMsg(chat_id);
        if (u.blocked === true) {
          await sendMsg(chat_id, `<b>❌ Your account is blocked. Please contact CashFlix support.</b>`, mainKeyboard);
        } else if (cdMsg) {
          await sendMsg(chat_id, cdMsg, mainKeyboard);
        } else if (parseFloat(u.balance) < MIN_WITHDRAW) {
          await sendMsg(chat_id, `<b>❌ Minimum ₹${MIN_WITHDRAW} Required To Withdraw!</b>`, mainKeyboard);
        } else if (u.upi_id && u.bank_account) {
          await sendInlineMsg(chat_id,
            `<b>Choose Payment Method:</b>`,
            [[{ text: '💸 UPI Transfer', callback_data: 'withdraw_upi' }], [{ text: '🏦 Bank Transfer', callback_data: 'withdraw_bank' }]]
          );
        } else if (u.upi_id) {
          userState[chat_id] = { state: 'withdraw_amount', method: 'upi', payment: u.upi_id, timestamp: Date.now() };
          await sendMsg(chat_id, `<b>Please enter withdrawal amount (Minimum: ₹${MIN_WITHDRAW.toFixed(2)}):</b>`);
        } else if (u.bank_account) {
          userState[chat_id] = { state: 'withdraw_amount', method: 'bank', payment: `${u.bank_account} | ${u.bank_ifsc}`, timestamp: Date.now() };
          await sendMsg(chat_id, `<b>Please enter withdrawal amount (Minimum: ₹${MIN_WITHDRAW.toFixed(2)}):</b>`);
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
      const found = allOfferList().find(o => o.name.toLowerCase() === typed.toLowerCase());
      if (!found) {
        await sendMsg(ADMIN_ID, `<b>❌ Offer nahi mila: ${typed}</b>\n\n<b>Available:</b> ${allOfferList().map(o => o.name).join(', ')}`);
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
  const key = cidToKey(String(req.query.cid || ''));
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
    if (MAINTENANCE) return res.json({ success: false, paused: true, reason: 'offer_paused' });
    const offer = getOfferByKey(offer_key);
    if (!offer) return res.json({ success: false, reason: 'unknown_offer_key_' + offer_key });
    if (!offer.link) return res.json({ success: false, reason: 'offer_link_empty' });
    if (!click_id || !/^[6-9]\d{9}[A-Za-z0-9]{0,30}$/.test(click_id)) return res.json({ success: false, reason: 'bad_click_id' });
    try {
      const bu = await dbGet('users', `phone=eq.${click_id.slice(0, 10)}&select=*`);
      if (Array.isArray(bu) && bu[0] && bu[0].blocked === true) return res.json({ success: false, reason: 'blocked' });
    } catch (e) {}
    let captchaOn = true;
    try {
      const st = await dbGet('offer_status', `offer_name=eq.${encodeURIComponent(offer.name)}`);
      if (Array.isArray(st) && st.length > 0 && st[0].is_active === false) return res.json({ success: false, paused: true, reason: 'offer_paused' });
      if (Array.isArray(st) && st.length > 0 && st[0].captcha === false) captchaOn = false;
    } catch (e) {}

    // 1) Human verification (Cloudflare Turnstile) - admin /<offer> off turnstile se band ho sakta hai
    if (captchaOn && CAPTCHA_GLOBAL && !(await verifyTurnstile(cf_token, ip))) return res.json({ success: false, reason: 'verify_failed' });

    // 2) Ek IP se ek offer sirf ek baar
    let ipColumnOk = false;
    if (ip && IP_CHECK && offFlag(offer.name, 'ip')) {
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
    let saved = await dbPostOk('clicks', row);
    if (!saved) saved = await dbPostOk('clicks', row);
    if (!saved) return res.json({ success: false, reason: 'save_failed_try_again' });
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
    res.send('OK'); // network ko turant ack (timeout/retry se double credit na ho)
    const phone = String(click_id).slice(0, 10); // click_id = phone + unique suffix

    let runTime = getTime();
    let offer = req.query.offer || 'Unknown';

    try {
      let clicks = await dbGet('clicks', `click_id=eq.${encodeURIComponent(click_id)}&order=created_at.desc&limit=1`);
      if (!Array.isArray(clicks) || clicks.length === 0) {
        // exact click nahi mila (missing save / network ne id badli) -> same phone ka latest click
        clicks = await dbGet('clicks', `click_id=like.${encodeURIComponent(phone)}*&order=created_at.desc&limit=1`);
        console.log('POSTBACK FALLBACK LOOKUP:', click_id, Array.isArray(clicks) ? clicks.length : 'err');
      }
      if (Array.isArray(clicks) && clicks.length > 0) {
        offer = clicks[0].offer_name;
        runTime = new Date(clicks[0].created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(',', '');
      }
    } catch(e) {}

    const config = offerCfgByName(offer) || (hiddenNames.has(offer) ? null : offerConfig[offer]) || {
      installAmt: 0, trialAmt: 0,
      installBalance: false, trialBalance: false,
      installComment: `${offer} Install`,
      trialComment: `${offer} Trial`
    };

    let amount = 0;
    let comment = '';
    let addBalance = false;
    const eventName = event?.trim().toLowerCase();

    const customEv = Array.isArray(config.events) ? config.events.find(e => String(e.name).toLowerCase() === eventName) : null;
    if (customEv) {
      amount = r2(parseFloat(customEv.amount) || 0);
      comment = customEv.message || `${offer} ${customEv.name}`;
      addBalance = customEv.balance !== false;
    } else if (['web', 'initial', 'install', 'e1', 'default'].includes(eventName)) {
      amount = config.installAmt || 0;
      comment = config.installComment;
      addBalance = config.installBalance;
    } else if (['trial', 'purchase', 'e2', 'gold_buy', 'signup', 'register', 'registration', 'deposit', 'af_subscribe'].includes(eventName)) {
      amount = config.trialAmt || 0;
      comment = config.trialComment;
      addBalance = config.trialBalance;
    } else {
      amount = r2(parseFloat(req.query.amount || 0));
      comment = `${offer} Complete`;
      addBalance = true;
    }

    // duplicate postback (network retry) ho to dobara credit mat karo
    try {
      const dup = await dbGet('conversions', `click_id=eq.${encodeURIComponent(click_id)}&event=eq.${encodeURIComponent(event)}&select=click_id&limit=1`);
      if (Array.isArray(dup) && dup.length > 0) { console.log('DUPLICATE POSTBACK IGNORED:', click_id, event); return; }
    } catch (e) {}

    await dbPost('conversions', { telegram_id: phone, click_id, offer_name: offer, amount, event });

    const users = await dbGet('users', `phone=eq.${phone}`);
    const userPayment = users.length > 0 ? 'Success' : 'Failed';

    if (users.length > 0) {
      const u = users[0];
      if (addBalance && amount > 0) {
        const newBal = r2(parseFloat(u.balance) + amount);
        const newLife = r2(parseFloat(u.lifetime_earnings) + amount);
        await dbPatch('users', `phone=eq.${phone}`, { balance: newBal, lifetime_earnings: newLife });
        if (NOTIFY_USERS) await sendMsg(u.telegram_id, `<b>🧿 Cashback Credited 🧿</b>\n\n<b>💶 Amount  = ${fmtAmt(amount)}</b>\n<b>💰 Updated Balance = ${newBal.toFixed(2)}</b>\n\n<b>💡 Comment = ${comment}</b>`);
      } else if (amount > 0) {
        if (NOTIFY_USERS) await sendMsg(u.telegram_id, `<b>🧿 Cashback Credited 🧿</b>\n\n<b>💶 Amount  = ${fmtAmt(amount)}</b>\n<b>💰 Updated Balance = ${parseFloat(u.balance).toFixed(2)}</b>\n\n<b>💡 Comment = ${comment}</b>`);
      }
    }

    const trackTime = getTime();
    const msg = `<b>Conversation Count 💝</b>\n\n<b>🎁 Offer Name - ${offer}</b>\n\n<b>User Id : ${maskPhone(phone)}</b>\n<b>User Amount : ₹${amount}</b>\n<b>🥳 User Payment : ${userPayment}</b>\n\n<b>Run Time - ${runTime}</b>\n<b>Track Time - ${trackTime}</b>\n\n<b>Powered By - CashFlix</b>`;
    if (TRACK_CHANNEL && offFlag(offer, 'track')) await sendMsg(CHAT_ID, msg);
  } catch(e) {
    console.error(e);
  }
  if (!res.headersSent) res.send('OK');
});

// ================= ADMIN PANEL (API + DB-backed offers + runtime settings) =================
const crypto = require('crypto');
// Admin panel sirf Telegram mini app se khulta hai. Naye bot ka token yaha (BotFather wala).
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '';
const ADMIN_TOKEN_KEY = crypto.createHash('sha256').update('cfadmin|' + ADMIN_BOT_TOKEN + (process.env.ADMIN_TEST_PASSWORD || '') + (process.env.ADMIN_OPEN || '') + '|' + (process.env.SUPABASE_KEY || '')).digest();

// Telegram WebApp initData verify: signature + fresh + user == ADMIN_ID
function verifyAdminInitData(initData) {
  try {
    if (!ADMIN_BOT_TOKEN || !initData) return false;
    const params = new URLSearchParams(String(initData));
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dcs = [...params.entries()].map(([k, v]) => k + '=' + v).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(ADMIN_BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const authDate = parseInt(params.get('auth_date') || '0');
    if (!authDate || Date.now() / 1000 - authDate > 86400) return false;
    const user = JSON.parse(params.get('user') || '{}');
    return String(user.id) === String(ADMIN_ID);
  } catch (e) { return false; }
}

function adminMakeToken() {
  const exp = String(Date.now() + 12 * 3600 * 1000);
  return exp + '.' + crypto.createHmac('sha256', ADMIN_TOKEN_KEY).update(exp).digest('hex');
}
function adminCheckToken(tok) {
  if ((!ADMIN_BOT_TOKEN && !process.env.ADMIN_TEST_PASSWORD && process.env.ADMIN_OPEN !== 'true') || !tok) return false;
  const parts = String(tok).split('.');
  if (parts.length !== 2 || Number(parts[0]) < Date.now()) return false;
  const good = crypto.createHmac('sha256', ADMIN_TOKEN_KEY).update(parts[0]).digest('hex');
  const a = Buffer.from(parts[1]), b = Buffer.from(good);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function reqIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function adminRoute(method, path, handler) {
  app[method](path, async (req, res) => {
    try {
      if (!rateLimit('adm:' + reqIp(req), 240, 60000)) return res.status(429).json({ ok: false, error: 'Too many requests' });
      if (!adminCheckToken(req.headers['x-admin-token'])) return res.status(401).json({ ok: false, error: 'Unauthorized' });
      const out = await handler(req, res);
      if (method === 'post') { try { auditLog(path, req.body || {}); } catch (e) {} }
      if (!res.headersSent) res.json(Object.assign({ ok: true }, out || {}));
    } catch (e) {
      console.error('ADMIN ERROR', path, e.message);
      if (!res.headersSent) res.status(400).json({ ok: false, error: e.message || 'Server error' });
    }
  });
}
const enc = encodeURIComponent;
const SB_HEADERS = () => ({ 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` });

async function dbCount(table, filter) {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?select=*${filter ? '&' + filter : ''}`, {
      headers: Object.assign(SB_HEADERS(), { 'Prefer': 'count=exact', 'Range': '0-0' })
    });
    await res.text();
    const cr = res.headers.get('content-range');
    const n = cr ? parseInt(cr.split('/')[1]) : NaN;
    return isNaN(n) ? 0 : n;
  } catch (e) { return 0; }
}
async function dbSum(table, col, filter) {
  let total = 0;
  for (let page = 0; page < 100; page++) {
    const rows = await dbGet(table, `select=${col}${filter ? '&' + filter : ''}&limit=1000&offset=${page * 1000}`);
    if (!Array.isArray(rows)) break;
    rows.forEach(r => { total += parseFloat(r[col]) || 0; });
    if (rows.length < 1000) break;
  }
  return total;
}
async function dbUpsert(table, row, conflict) {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${conflict}`, {
      method: 'POST',
      headers: Object.assign(SB_HEADERS(), { 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(row)
    });
    if (!res.ok) { console.error('UPSERT FAILED', table, res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error('UPSERT ERROR', table, e.message); return false; }
}
async function dbDelete(table, filter) {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, { method: 'DELETE', headers: SB_HEADERS() });
    return res.ok;
  } catch (e) { return false; }
}
function istTodayStartISO() {
  const d = new Date(Date.now() + 19800000);
  d.setUTCHours(0, 0, 0, 0);
  return new Date(d.getTime() - 19800000).toISOString();
}
function pickUser(u) {
  return {
    telegram_id: u.telegram_id, name: u.name, phone: u.phone,
    balance: parseFloat(u.balance) || 0, lifetime_earnings: parseFloat(u.lifetime_earnings) || 0,
    upi_id: u.upi_id || '', bank_account: u.bank_account || '', bank_ifsc: u.bank_ifsc || '',
    blocked: u.blocked === true
  };
}

// ---------- Runtime settings (DB table `settings`) ----------
let settingsTableOk = false;
function settingsSnapshot() {
  return { min_withdraw: MIN_WITHDRAW, withdraw_fee: WITHDRAW_FEE, cooldown_hours: WITHDRAW_COOLDOWN_HOURS, auto_payout_max: AUTO_PAYOUT_MAX, auto_payout_enabled: AUTO_PAYOUT_ENABLED, withdraw_enabled: WITHDRAW_ENABLED, maintenance: MAINTENANCE, track_channel: TRACK_CHANNEL, ip_check: IP_CHECK, captcha_global: CAPTCHA_GLOBAL, notify_users: NOTIFY_USERS };
}
function applySettings(m) {
  const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  if (m.min_withdraw !== undefined) MIN_WITHDRAW = Math.max(1, num(m.min_withdraw, MIN_WITHDRAW));
  if (m.withdraw_fee !== undefined) WITHDRAW_FEE = Math.max(0, num(m.withdraw_fee, WITHDRAW_FEE));
  if (m.cooldown_hours !== undefined) WITHDRAW_COOLDOWN_HOURS = Math.max(0, num(m.cooldown_hours, WITHDRAW_COOLDOWN_HOURS));
  if (m.auto_payout_max !== undefined) AUTO_PAYOUT_MAX = Math.max(0, num(m.auto_payout_max, AUTO_PAYOUT_MAX));
  if (m.auto_payout_enabled !== undefined) AUTO_PAYOUT_ENABLED = String(m.auto_payout_enabled) !== 'false';
  if (m.withdraw_enabled !== undefined) WITHDRAW_ENABLED = String(m.withdraw_enabled) !== 'false';
  if (m.maintenance !== undefined) MAINTENANCE = String(m.maintenance) === 'true';
  if (m.track_channel !== undefined) TRACK_CHANNEL = String(m.track_channel) !== 'false';
  if (m.ip_check !== undefined) IP_CHECK = String(m.ip_check) !== 'false';
  if (m.captcha_global !== undefined) CAPTCHA_GLOBAL = String(m.captcha_global) !== 'false';
  if (m.notify_users !== undefined) NOTIFY_USERS = String(m.notify_users) !== 'false';
}
async function loadSettings() {
  try {
    const rows = await dbGet('settings', 'select=k,v');
    if (!Array.isArray(rows)) { settingsTableOk = false; return; }
    settingsTableOk = true;
    const m = {};
    rows.forEach(r => { m[r.k] = r.v; });
    applySettings(m);
    try { if (!adminLog.length && m.admin_log) adminLog = JSON.parse(m.admin_log) || []; } catch (e) {}
    try { offerFlags = JSON.parse(m.offer_flags || '{}') || {}; } catch (e) {}
    try { const hid = JSON.parse(m.hidden_offers || '{}'); hiddenKeys = new Set(hid.keys || []); hiddenNames = new Set(hid.names || []); } catch (e) {}
  } catch (e) {}
}

// ---------- Hidden (deleted) offers that live in this file ----------
let hiddenKeys = new Set();
let hiddenNames = new Set();
async function saveHidden() {
  return dbUpsert('settings', { k: 'hidden_offers', v: JSON.stringify({ keys: [...hiddenKeys], names: [...hiddenNames] }) }, 'k');
}

// ---------- DB-backed offers (merged with offers hard-coded in this file) ----------
let offersTableOk = false;
let dbOffers = {};   // key -> offer
function cfgFromRow(r) {
  return {
    installAmt: parseFloat(r.install_amt) || 0, trialAmt: parseFloat(r.trial_amt) || 0,
    installBalance: r.install_balance === true, trialBalance: r.trial_balance !== false,
    installComment: r.install_comment || `${r.name} Install`, trialComment: r.trial_comment || `${r.name} Trial`,
    events: Array.isArray(r.events) ? r.events.map(e => ({ name: String(e.name || ''), amount: parseFloat(e.amount) || 0, balance: e.balance !== false, message: String(e.message || '') })) : []
  };
}
async function loadOffers() {
  try {
    const rows = await dbGet('offers', 'select=*');
    if (!Array.isArray(rows)) { offersTableOk = false; return; }
    offersTableOk = true;
    const m = {};
    rows.forEach(r => { m[r.key] = { key: r.key, name: r.name, cid: r.cid, link: r.link || '', param: r.param || 'p1', cfg: cfgFromRow(r), source: 'db' }; });
    dbOffers = m;
  } catch (e) {}
}
function allOffersMap() {
  const out = {};
  const cidByKey = {};
  Object.keys(CID_MAP).forEach(c => { cidByKey[CID_MAP[c]] = c; });
  Object.keys(OFFERS).forEach(k => {
    if (hiddenKeys.has(k)) return;
    const o = OFFERS[k];
    out[k] = { key: k, name: o.name, cid: cidByKey[k] || '', link: o.link || '', param: o.param || 'p1', cfg: offerConfig[o.name] || { installAmt: 0, trialAmt: 0, installBalance: false, trialBalance: true, installComment: `${o.name} Install`, trialComment: `${o.name} Trial` }, source: 'code' };
  });
  Object.keys(dbOffers).forEach(k => { out[k] = dbOffers[k]; });
  return out;
}
function allOfferList() { return Object.values(allOffersMap()); }
function getOfferByKey(key) { return allOffersMap()[key] || null; }
function cidToKey(cid) {
  const hit = allOfferList().find(o => o.cid && o.cid === cid);
  return hit ? hit.key : null;
}
function offerCfgByName(name) {
  const hit = allOfferList().find(o => o.name === name);
  return hit ? hit.cfg : null;
}

// ---------- Auth ----------
app.post('/admin/login', (req, res) => {
  if (!rateLimit('admlogin:' + reqIp(req), 15, 60000)) return res.status(429).json({ ok: false, error: 'Bahut attempts. 1 minute baad try karo.' });
  // SIRF TEST KE LIYE: Render me ADMIN_TEST_PASSWORD set ho tabhi Chrome se password login chalta hai. Test ke baad env hata do.
  // SIRF TEST: ADMIN_OPEN=true ho to bina login ke panel khulta hai (khatarnak, test ke turant baad hata do)
  if (process.env.ADMIN_OPEN === 'true' && req.body && req.body.open === true) return res.json({ ok: true, token: adminMakeToken() });
  const testPw = process.env.ADMIN_TEST_PASSWORD || '';
  const givenPw = req.body && req.body.password;
  if (testPw && givenPw) {
    if (!safeEq(givenPw, testPw)) return res.status(401).json({ ok: false, error: 'Wrong password' });
    return res.json({ ok: true, token: adminMakeToken() });
  }
  if (!ADMIN_BOT_TOKEN) return res.status(503).json({ ok: false, error: 'ADMIN_BOT_TOKEN Render env me set nahi hai' });
  if (!verifyAdminInitData(req.body && req.body.initData)) return res.status(401).json({ ok: false, error: 'Sirf admin apne Telegram bot se khol sakta hai' });
  res.json({ ok: true, token: adminMakeToken() });
});

// ---------- Dashboard ----------
adminRoute('get', '/admin/stats', async () => {
  const today = enc(istTodayStartISO());
  const [users, blocked, pend, proc, paid, canc, clicks, clicksToday, conv, usersBal, paidAmt, pendAmt, procAmt] = await Promise.all([
    dbCount('users'), dbCount('users', 'blocked=eq.true'),
    dbCount('withdrawals', 'status=eq.pending'), dbCount('withdrawals', 'status=eq.processing'),
    dbCount('withdrawals', 'status=eq.paid'), dbCount('withdrawals', 'status=eq.cancelled'),
    dbCount('clicks'), dbCount('clicks', `created_at=gte.${today}`), dbCount('conversions'),
    dbSum('users', 'balance'), dbSum('withdrawals', 'amount', 'status=eq.paid'),
    dbSum('withdrawals', 'amount', 'status=eq.pending'), dbSum('withdrawals', 'amount', 'status=eq.processing')
  ]);
  return { stats: { users, blocked, pending: pend, processing: proc, paid, cancelled: canc, clicks, clicks_today: clicksToday, conversions: conv, wallet_balance: usersBal, paid_amount: paidAmt, pending_amount: pendAmt, processing_amount: procAmt } };
});

adminRoute('get', '/admin/health', async () => {
  const colOk = async (table, filter) => Array.isArray(await dbGet(table, filter));
  const checks = [
    { k: 'Bot token', ok: !!BOT_TOKEN, hint: 'Render env: BOT_TOKEN' },
    { k: 'Admin bot token', ok: !!ADMIN_BOT_TOKEN, hint: 'Render env: ADMIN_BOT_TOKEN (naye admin bot ka token)' },
    { k: 'Supabase connection', ok: await colOk('users', 'select=telegram_id&limit=1'), hint: 'SUPABASE_URL / SUPABASE_KEY' },
    { k: 'Postback token strong', ok: POSTBACK_TOKEN !== 'cash', hint: 'POSTBACK_TOKEN abhi default "cash" hai, strong token set karo' },
    { k: 'Gateway keys', ok: !!(GW_ID && GW_SECRET), hint: 'GATEWAY_CLIENT_ID / GATEWAY_CLIENT_SECRET' },
    { k: 'Turnstile secret', ok: !!TURNSTILE_SECRET, hint: 'TURNSTILE_SECRET' },
    { k: 'withdrawals.order_id / utr columns', ok: await colOk('withdrawals', 'select=order_id,utr&limit=1'), hint: 'SQL: ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS order_id TEXT, ADD COLUMN IF NOT EXISTS utr TEXT;' },
    { k: 'clicks.ip column', ok: await colOk('clicks', 'select=ip&limit=1'), hint: 'SQL: ALTER TABLE clicks ADD COLUMN IF NOT EXISTS ip TEXT;' },
    { k: 'offer_status.captcha column', ok: await colOk('offer_status', 'select=captcha&limit=1'), hint: 'SQL: ALTER TABLE offer_status ADD COLUMN IF NOT EXISTS captcha BOOLEAN DEFAULT true;' },
    { k: 'users.blocked column', ok: await colOk('users', 'select=blocked&limit=1'), hint: 'SQL: ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT false;' },
    { k: 'offers table (panel se offers)', ok: offersTableOk, hint: 'Setup SQL (Settings tab) chalao' },
    { k: 'offers.events column', ok: await colOk('offers', 'select=events&limit=1'), hint: 'SQL: ALTER TABLE offers ADD COLUMN IF NOT EXISTS events JSONB DEFAULT \'[]\'::jsonb;' },
    { k: 'settings table (panel se settings)', ok: settingsTableOk, hint: 'Setup SQL (Settings tab) chalao' }
  ];
  return { checks };
});

// ---------- Withdrawals ----------
async function attachUsers(rows) {
  const ids = [...new Set(rows.map(r => String(r.telegram_id)).filter(x => /^\d+$/.test(x)))];
  const map = {};
  if (ids.length) {
    const users = await dbGet('users', `telegram_id=in.(${ids.join(',')})&select=*`);
    if (Array.isArray(users)) users.forEach(u => { map[String(u.telegram_id)] = pickUser(u); });
  }
  return map;
}
adminRoute('get', '/admin/withdrawals', async (req) => {
  const status = String(req.query.status || 'pending');
  const off = Math.max(0, parseInt(req.query.offset) || 0);
  let f = `order=created_at.desc&limit=50&offset=${off}`;
  if (['pending', 'processing', 'paid', 'cancelled'].includes(status)) f += `&status=eq.${status}`;
  const rows = await dbGet('withdrawals', f);
  if (!Array.isArray(rows)) throw new Error('Withdrawals load nahi hue');
  const umap = await attachUsers(rows);
  let counts = null;
  if (off === 0) { const c = await Promise.all([dbCount('withdrawals'), dbCount('withdrawals', 'status=eq.pending'), dbCount('withdrawals', 'status=eq.processing'), dbCount('withdrawals', 'status=eq.paid'), dbCount('withdrawals', 'status=eq.cancelled')]); counts = { all: c[0], pending: c[1], processing: c[2], paid: c[3], cancelled: c[4] }; }
  return { counts, has_more: rows.length === 50, withdrawals: rows.map(w => ({
    request_id: w.request_id, telegram_id: w.telegram_id, amount: parseFloat(w.amount) || 0, payment: w.upi_id || '',
    status: w.status, created_at: w.created_at, utr: w.utr || '', order_id: w.order_id || '', user: umap[String(w.telegram_id)] || null
  })) };
});
const REQ_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
adminRoute('post', '/admin/withdrawal/approve', async (req) => {
  const id = String((req.body || {}).request_id || '');
  if (!REQ_ID_RE.test(id)) throw new Error('Invalid request id');
  const rows = await dbPatchReturn('withdrawals', `request_id=eq.${enc(id)}&status=eq.pending`, { status: 'paid' });
  if (!rows.length) throw new Error('Already processed ya request nahi mili');
  const w = rows[0];
  await sendMsg(w.telegram_id, `<b>Your withdrawal request of ₹${parseFloat(w.amount).toFixed(2)} has been approved! ✅</b>`);
  return { message: 'Marked paid, user ko message gaya' };
});
adminRoute('post', '/admin/withdrawal/cancel', async (req) => {
  const id = String((req.body || {}).request_id || '');
  if (!REQ_ID_RE.test(id)) throw new Error('Invalid request id');
  const rows = await dbPatchReturn('withdrawals', `request_id=eq.${enc(id)}&status=eq.pending`, { status: 'cancelled' });
  if (!rows.length) throw new Error('Already processed ya request nahi mili');
  const w = rows[0];
  const users = await dbGet('users', `telegram_id=eq.${w.telegram_id}`);
  if (Array.isArray(users) && users.length > 0) {
    await dbPatch('users', `telegram_id=eq.${w.telegram_id}`, { balance: r2(parseFloat(users[0].balance) + parseFloat(w.amount)) });
  }
  await sendMsg(w.telegram_id, `<b>❌ Your withdraw request failed. Please contact CashFlix support.</b>\n\n<b>💰 ₹${parseFloat(w.amount).toFixed(2)} has been refunded to your wallet!</b>`);
  return { message: 'Cancelled, amount refund ho gaya' };
});
adminRoute('post', '/admin/withdrawal/gateway', async (req) => {
  const id = String((req.body || {}).request_id || '');
  if (!REQ_ID_RE.test(id)) throw new Error('Invalid request id');
  const rows = await dbGet('withdrawals', `request_id=eq.${enc(id)}&status=eq.pending&limit=1`);
  if (!Array.isArray(rows) || !rows.length) throw new Error('Pending request nahi mili');
  const w = rows[0];
  const started = await startAutoPayout({ request_id: w.request_id, telegram_id: w.telegram_id, amount: parseFloat(w.amount), upi_id: w.upi_id }, true);
  if (!started) throw new Error('Gateway se nahi ho sakta (sirf UPI, aur gateway keys set honi chahiye)');
  return { message: 'Gateway payout shuru ho gaya' };
});

// ---------- Users ----------
adminRoute('get', '/admin/users', async (req) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  const off = Math.max(0, parseInt(req.query.offset) || 0);
  const sort = { balance: 'balance.desc', earnings: 'lifetime_earnings.desc', name: 'name.asc' }[String(req.query.sort || 'balance')] || 'balance.desc';
  let f = `select=*&limit=50&offset=${off}`;
  if (!q) f += `&order=${sort}`;
  else if (/^\d+$/.test(q)) f += `&or=(phone.eq.${q},telegram_id.eq.${q},phone.like.*${q}*)`;
  else f += `&name=ilike.*${enc(q.replace(/[^\w .@-]/g, ''))}*`;
  const rows = await dbGet('users', f);
  if (!Array.isArray(rows)) throw new Error('Users load nahi hue');
  const total = q ? rows.length : await dbCount('users');
  return { users: rows.map(pickUser), total, has_more: rows.length === 50 };
});
adminRoute('get', '/admin/user', async (req) => {
  const tid = String(req.query.telegram_id || '');
  if (!/^\d+$/.test(tid)) throw new Error('Invalid telegram id');
  const users = await dbGet('users', `telegram_id=eq.${tid}&select=*`);
  if (!Array.isArray(users) || !users.length) throw new Error('User nahi mila');
  const u = pickUser(users[0]);
  const [wd, conv, clk] = await Promise.all([
    dbGet('withdrawals', `telegram_id=eq.${tid}&order=created_at.desc&limit=20`),
    dbGet('conversions', `telegram_id=eq.${enc(u.phone || 'x')}&order=id.desc&limit=20`),
    dbGet('clicks', `click_id=like.${enc((u.phone || 'x') + '*')}&order=created_at.desc&limit=20&select=*`)
  ]);
  return { user: u, withdrawals: Array.isArray(wd) ? wd.map(w => ({ request_id: w.request_id, amount: parseFloat(w.amount) || 0, status: w.status, payment: w.upi_id, created_at: w.created_at })) : [],
    conversions: Array.isArray(conv) ? conv.map(c => ({ offer_name: c.offer_name, amount: c.amount, event: c.event, track_time: c.track_time })) : [],
    clicks: Array.isArray(clk) ? clk.map(c => ({ click_id: c.click_id, offer_name: c.offer_name, created_at: c.created_at, ip: c.ip || '' })) : [] };
});
adminRoute('post', '/admin/user/balance', async (req) => {
  const b = req.body || {};
  const tid = String(b.telegram_id || '');
  const amount = r2(parseFloat(b.amount));
  if (!/^\d+$/.test(tid) || isNaN(amount) || amount === 0 || Math.abs(amount) > 100000) throw new Error('Invalid telegram id ya amount');
  const users = await dbGet('users', `telegram_id=eq.${tid}`);
  if (!Array.isArray(users) || !users.length) throw new Error('User nahi mila');
  const u = users[0];
  const newBal = r2(Math.max(0, parseFloat(u.balance) + amount));
  const rows = await dbPatchReturn('users', `telegram_id=eq.${tid}`, { balance: newBal });
  if (!rows.length) throw new Error('Balance update fail');
  if (amount > 0) { try { await dbPatch('users', `telegram_id=eq.${tid}`, { lifetime_earnings: r2((parseFloat(u.lifetime_earnings) || 0) + amount) }); } catch (e) {} }
  const reason = sanitize(b.reason || '').slice(0, 80);
  await sendMsg(ADMIN_ID, `<b>🛠 Admin panel: balance ${amount > 0 ? '+' : ''}${amount} → ${u.name || tid} (${u.phone || ''})</b>\n<b>New balance: ₹${newBal.toFixed(2)}</b>${reason ? `\n<b>Reason: ${reason}</b>` : ''}`);
  if (b.notify) await sendMsg(tid, `<b>💰 Your wallet balance has been updated.</b>\n\n<b>Updated Balance = ${newBal.toFixed(2)}</b>`);
  return { balance: newBal, message: `Balance ab ₹${newBal.toFixed(2)}` };
});
adminRoute('post', '/admin/user/block', async (req) => {
  const b = req.body || {};
  const tid = String(b.telegram_id || '');
  if (!/^\d+$/.test(tid)) throw new Error('Invalid telegram id');
  const rows = await dbPatchReturn('users', `telegram_id=eq.${tid}`, { blocked: b.blocked === true });
  if (!rows.length) throw new Error('Save nahi hua. Supabase me chalao: ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN DEFAULT false;');
  return { message: b.blocked === true ? 'User blocked' : 'User unblocked' };
});

// ---------- Offers ----------
adminRoute('get', '/admin/offers', async () => {
  const st = await dbGet('offer_status', 'select=*');
  const stMap = {};
  if (Array.isArray(st)) st.forEach(r => { stMap[r.offer_name] = { is_active: r.is_active !== false, captcha: r.captcha !== false }; });
  const list = allOfferList().map(o => Object.assign({}, o, { status: stMap[o.name] || { is_active: true, captcha: true } }));
  const known = new Set(list.map(o => o.name));
  const legacy = Object.keys(offerConfig).filter(n => !known.has(n) && !hiddenNames.has(n)).map(n => ({ name: n, cfg: offerConfig[n], status: stMap[n] || { is_active: true, captcha: true } }));
  return { offers: list, legacy, offers_table_ok: offersTableOk, flags: offerFlags };
});
adminRoute('post', '/admin/offer/save', async (req) => {
  const b = req.body || {};
  const key = String(b.key || '').trim(), name = String(b.name || '').trim(), cid = String(b.cid || '').trim();
  const link = String(b.link || '').trim(), param = String(b.param || 'p1').trim();
  if (!/^[A-Za-z0-9]{1,10}$/.test(key)) throw new Error('Key: 1-10 letters/numbers');
  if (!/^[A-Za-z0-9 ._&+-]{1,40}$/.test(name)) throw new Error('Name: letters, numbers, space . _ & + - (max 40)');
  if (!/^[A-Za-z0-9]{4,30}$/.test(cid)) throw new Error('CID: 4-30 letters/numbers');
  if (!/^[A-Za-z0-9_]{1,30}$/.test(param)) throw new Error('Param naam galat');
  if (link && !/^https:\/\/[^\s<>"']+$/.test(link)) throw new Error('Link https:// se shuru hona chahiye');
  const clash = allOfferList().find(o => o.key !== key && (o.cid === cid || o.name === name));
  if (clash) throw new Error(`CID ya naam "${clash.name}" me pehle se use ho raha hai`);
  const n = (v, d) => { const x = parseFloat(v); return isNaN(x) || x < 0 ? d : x; };
  const events = [];
  const seenEv = new Set();
  const evIn = Array.isArray(b.events) ? b.events : [];
  if (evIn.length > 20) throw new Error('Maximum 20 events');
  for (const e of evIn) {
    const en = String((e && e.name) || '').trim();
    if (!en) continue;
    if (!/^[A-Za-z0-9_ .-]{1,40}$/.test(en)) throw new Error(`Event name galat: "${en}" (letters, numbers, space . _ - )`);
    const amt = parseFloat(e.amount);
    if (isNaN(amt) || amt < 0 || amt > 100000) throw new Error(`Event "${en}" ka amount galat hai`);
    if (seenEv.has(en.toLowerCase())) throw new Error(`Event "${en}" do baar likha hai`);
    seenEv.add(en.toLowerCase());
    events.push({ name: en, amount: r2(amt), balance: e.balance !== false, message: sanitize(e.message || '').slice(0, 60) });
  }
  const row = {
    key, name, cid, link, param,
    install_amt: 0, trial_amt: 0, install_balance: false, trial_balance: true,
    install_comment: `${name} Install`, trial_comment: `${name} Trial`,
    events
  };
  if (!(await dbUpsert('offers', row, 'key'))) throw new Error('Save nahi hua. Settings tab ka Setup SQL chalaya? (offers.events column bhi chahiye)');
  const ex = await dbGet('offer_status', `offer_name=eq.${enc(name)}`);
  if (Array.isArray(ex) && ex.length === 0) await dbPost('offer_status', { offer_name: name, is_active: true });
  await loadOffers();
  return { message: 'Offer save ho gaya' };
});
adminRoute('post', '/admin/offer/delete', async (req) => {
  const b = req.body || {};
  const key = String(b.key || ''), legacyName = String(b.name || '');
  // purane (payout-only) offers: naam se hide
  if (!key && legacyName) {
    if (!offerConfig[legacyName]) throw new Error('Offer nahi mila');
    hiddenNames.add(legacyName);
    if (!(await saveHidden())) { hiddenNames.delete(legacyName); throw new Error('Delete nahi hua. Settings table banayi hai? (Setup SQL)'); }
    await dbDelete('offer_status', `offer_name=eq.${enc(legacyName)}`);
    return { message: 'Offer delete ho gaya' };
  }
  if (!/^[A-Za-z0-9]{1,10}$/.test(key)) throw new Error('Invalid key');
  const inDb = !!dbOffers[key], inCode = !!OFFERS[key];
  if (!inDb && !inCode) throw new Error('Offer nahi mila');
  const name = (dbOffers[key] || OFFERS[key]).name;
  if (inDb && !(await dbDelete('offers', `key=eq.${enc(key)}`))) throw new Error('Delete nahi hua');
  if (inCode && !hiddenKeys.has(key)) {
    hiddenKeys.add(key); hiddenNames.add(OFFERS[key].name);
    if (!(await saveHidden())) { hiddenKeys.delete(key); hiddenNames.delete(OFFERS[key].name); throw new Error('Delete nahi hua. Settings table banayi hai? (Setup SQL)'); }
  }
  await dbDelete('offer_status', `offer_name=eq.${enc(name)}`);
  await loadOffers();
  return { message: 'Offer delete ho gaya. Uska share link ab kaam nahi karega.' };
});
adminRoute('post', '/admin/offer/flag', async (req) => {
  const b = req.body || {};
  const name = String(b.name || '');
  const known = allOfferList().some(o => o.name === name) || offerConfig[name];
  if (!known) throw new Error('Offer nahi mila');
  if (!['ip', 'track'].includes(b.flag) || typeof b.on !== 'boolean') throw new Error('Galat flag');
  offerFlags[name] = Object.assign({}, offerFlags[name], { [b.flag]: b.on });
  if (!(await dbUpsert('settings', { k: 'offer_flags', v: JSON.stringify(offerFlags) }, 'k'))) throw new Error('DB me save nahi hua (settings table)');
  return { flags: offerFlags[name] };
});
adminRoute('post', '/admin/offer/status', async (req) => {
  const b = req.body || {};
  const name = String(b.name || '');
  const known = allOfferList().some(o => o.name === name) || offerConfig[name];
  if (!known) throw new Error('Offer nahi mila');
  const patch = {};
  if (typeof b.is_active === 'boolean') patch.is_active = b.is_active;
  if (typeof b.captcha === 'boolean') patch.captcha = b.captcha;
  if (!Object.keys(patch).length) throw new Error('Kuch change nahi bheja');
  const ex = await dbGet('offer_status', `offer_name=eq.${enc(name)}`);
  if (!Array.isArray(ex)) throw new Error('offer_status table error');
  if (ex.length > 0) {
    const rows = await dbPatchReturn('offer_status', `offer_name=eq.${enc(name)}`, patch);
    if (!rows.length) throw new Error('Save nahi hua' + (patch.captcha !== undefined ? '. SQL: ALTER TABLE offer_status ADD COLUMN IF NOT EXISTS captcha BOOLEAN DEFAULT true;' : ''));
  } else {
    if (!(await dbPostOk('offer_status', Object.assign({ offer_name: name, is_active: true }, patch)))) throw new Error('Save nahi hua');
  }
  return { message: 'Updated' };
});

// ---------- Settings ----------
adminRoute('get', '/admin/settings', async () => ({ settings: settingsSnapshot(), persisted: settingsTableOk }));
adminRoute('post', '/admin/settings', async (req) => {
  const b = req.body || {};
  const clean = {};
  const rng = (key, lo, hi) => {
    if (b[key] === undefined) return;
    const v = parseFloat(b[key]);
    if (isNaN(v) || v < lo || v > hi) throw new Error(`${key} ${lo} se ${hi} ke beech hona chahiye`);
    clean[key] = v;
  };
  rng('min_withdraw', 1, 10000); rng('withdraw_fee', 0, 1000); rng('cooldown_hours', 0, 720); rng('auto_payout_max', 0, 100000);
  ['auto_payout_enabled', 'withdraw_enabled', 'maintenance', 'track_channel', 'ip_check', 'captcha_global', 'notify_users'].forEach(k => { if (b[k] !== undefined) clean[k] = b[k] === true; });
  applySettings(clean);
  let persisted = true;
  for (const k of Object.keys(clean)) {
    if (!(await dbUpsert('settings', { k, v: String(clean[k]) }, 'k'))) persisted = false;
  }
  if (persisted) settingsTableOk = true;
  return { settings: settingsSnapshot(), persisted, message: persisted ? 'Settings save ho gayi' : 'Abhi chalu ho gayi par DB me save nahi hui (restart pe wapas purani). Setup SQL chalao.' };
});

// ---------- Broadcast ----------
let broadcastState = { running: false, total: 0, sent: 0, failed: 0, done: false, errors: {}, stopped: false, audience: 'all' };
let broadcastStop = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const escHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function tgErrKind(desc) {
  const d = String(desc || '').toLowerCase();
  if (d.includes('blocked by the user')) return 'User ne bot block kiya';
  if (d.includes('deactivated')) return 'Account deactivated';
  if (d.includes('chat not found')) return 'Chat nahi mili (user ne bot start nahi kiya)';
  if (d.includes('parse entities')) return 'Formatting (HTML) galat';
  if (d.includes('too many requests')) return 'Telegram rate limit';
  return desc ? String(desc).slice(0, 60) : 'Network error';
}
async function tgSend(chat_id, text, opts) {
  opts = opts || {};
  const send = async (txt, html) => {
    const body = { chat_id, text: html ? txt : escHtml(txt), parse_mode: 'HTML', disable_web_page_preview: true };
    if (opts.button) body.reply_markup = { inline_keyboard: [[{ text: opts.button.text, url: opts.button.url }]] };
    const res = await fetchWithTimeout(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok && j.ok !== false, description: j.description || '', retry: j.parameters && j.parameters.retry_after };
  };
  try {
    let r = await send(text, opts.html === true);
    for (let i = 0; i < 3 && !r.ok && r.retry; i++) { await sleep((r.retry + 1) * 1000); r = await send(text, opts.html === true); }
    if (!r.ok && /parse entities/i.test(r.description) && opts.html === true) r = await send(text, false); // HTML galat ho to plain text bhej do
    return r;
  } catch (e) { return { ok: false, description: e.message || 'network' }; }
}
async function audienceSets() {
  let users = await fetchAll('users', 'select=telegram_id,balance,blocked&order=telegram_id.asc', 100000);
  if (!users.length) users = await fetchAll('users', 'select=telegram_id,balance&order=telegram_id.asc', 100000);
  const wds = await fetchAll('withdrawals', 'select=telegram_id,status&order=id.asc', 100000);
  const withdrew = new Set(wds.filter(w => w.status !== 'cancelled').map(w => String(w.telegram_id)));
  const live = users.filter(u => /^\d+$/.test(String(u.telegram_id)) && u.blocked !== true);
  const ids = f => live.filter(f).map(u => String(u.telegram_id));
  return {
    all: ids(() => true),
    balance: ids(u => parseFloat(u.balance) > 0),
    withdraw_ready: ids(u => parseFloat(u.balance) >= MIN_WITHDRAW),
    never_withdrew: ids(u => !withdrew.has(String(u.telegram_id))),
    withdrew: ids(u => withdrew.has(String(u.telegram_id)))
  };
}
adminRoute('get', '/admin/broadcast/audiences', async () => {
  const a = await audienceSets();
  const out = {}; Object.keys(a).forEach(k => { out[k] = a[k].length; });
  return { audiences: out };
});
adminRoute('post', '/admin/broadcast', async (req) => {
  const b = req.body || {};
  const text = String(b.text || '').trim();
  if (text.length < 1 || text.length > 3500) throw new Error('Message 1 se 3500 characters ka hona chahiye');
  const html = b.html === true;
  let button = null;
  if (b.button_text || b.button_url) {
    const bt = String(b.button_text || '').trim().slice(0, 40), bu = String(b.button_url || '').trim();
    if (!bt || !/^https:\/\/[^\s]{4,300}$/.test(bu)) throw new Error('Button ke liye text aur https:// link dono do');
    button = { text: bt, url: bu };
  }
  if (b.test === true) {
    const r = await tgSend(ADMIN_ID, text, { html, button });
    if (!r.ok) throw new Error('Test fail: ' + tgErrKind(r.description) + (r.description ? ' (' + r.description + ')' : '') + '. Agar aapne main bot ko /start nahi kiya to pehle karo.');
    return { message: 'Test message aapko bhej diya' };
  }
  if (broadcastState.running) throw new Error('Pehle ka broadcast abhi chal raha hai');
  const aud = String(b.audience || 'all');
  let ids = [];
  if (aud === 'single') {
    const t = String(b.telegram_id || '').trim();
    if (!/^\d+$/.test(t)) throw new Error('Valid Telegram ID do');
    ids = [t];
  } else {
    const sets = await audienceSets();
    if (!sets[aud]) throw new Error('Audience galat hai');
    ids = sets[aud];
  }
  if (!ids.length) throw new Error('Is group me koi user nahi mila');
  broadcastStop = false;
  broadcastState = { running: true, total: ids.length, sent: 0, failed: 0, done: false, errors: {}, stopped: false, audience: aud };
  (async () => {
    let idx = 0;
    const worker = async () => {
      while (idx < ids.length && !broadcastStop) {
        const id = ids[idx++];
        const r = await tgSend(id, text, { html, button });
        if (r.ok) broadcastState.sent++;
        else { broadcastState.failed++; const k = tgErrKind(r.description); broadcastState.errors[k] = (broadcastState.errors[k] || 0) + 1; }
        await sleep(110);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    broadcastState.running = false; broadcastState.done = true; broadcastState.stopped = broadcastStop;
    await sendMsg(ADMIN_ID, `<b>📣 Broadcast ${broadcastStop ? 'stopped' : 'done'}</b>\n\n<b>✅ Sent: ${broadcastState.sent}</b>\n<b>❌ Failed: ${broadcastState.failed}</b>`);
  })().catch(e => { broadcastState.running = false; console.error('BROADCAST ERROR', e); });
  return { message: `${ids.length} users ko bhejna shuru`, total: ids.length };
});
adminRoute('post', '/admin/broadcast/stop', async () => { broadcastStop = true; return { message: 'Broadcast rok rahe hain' }; });
adminRoute('get', '/admin/broadcast/status', async () => ({ broadcast: broadcastState }));


// ---------- Activity ----------
adminRoute('get', '/admin/activity', async (req) => {
  const type = String(req.query.type || 'conversions');
  const offer = String(req.query.offer || '').trim().slice(0, 40);
  const of = offer ? `&offer_name=ilike.*${enc(offer.replace(/[^\w .&+-]/g, ''))}*` : '';
  if (type === 'clicks') {
    const rows = await dbGet('clicks', `select=*&order=created_at.desc&limit=100${of}`);
    if (!Array.isArray(rows)) throw new Error('Clicks load nahi hue');
    return { type, rows: rows.map(r => ({ click_id: r.click_id, offer_name: r.offer_name, created_at: r.created_at, ip: r.ip || '' })) };
  }
  const rows = await dbGet('conversions', `select=*&order=id.desc&limit=100${of}`);
  if (!Array.isArray(rows)) throw new Error('Conversions load nahi hue');
  return { type: 'conversions', rows: rows.map(r => ({ click_id: r.click_id, offer_name: r.offer_name, amount: r.amount, event: r.event, phone: r.telegram_id, track_time: r.track_time })) };
});

// ---------- Helpers for reports ----------
async function fetchAll(table, filter, max) {
  max = max || 20000;
  const out = [];
  for (let off = 0; off < max; off += 1000) {
    const rows = await dbGet(table, `${filter}&limit=1000&offset=${off}`);
    if (!Array.isArray(rows)) break;
    for (const r of rows) out.push(r);
    if (rows.length < 1000) break;
  }
  return out;
}
const istDay = ms => new Date(ms + 19800000).toISOString().slice(0, 10);
function rowTime(r) {
  const v = r.created_at || r.track_time;
  if (!v) return NaN;
  let t = Date.parse(v);
  if (!isNaN(t)) return t;
  const m = String(v).match(/(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return NaN;
  let h = parseInt(m[4]); if (m[7]) { const pm = m[7].toLowerCase() === 'pm'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return Date.UTC(parseInt(m[3]), parseInt(m[2]) - 1, parseInt(m[1]), h, parseInt(m[5]), parseInt(m[6] || 0)) - 19800000;
}
const phoneOf = cid => String(cid || '').slice(0, 10);

// ---------- Audit log ----------
let adminLog = [];
let adminLogTimer = null;
function auditLog(path, b) {
  const d = {};
  ['request_id', 'telegram_id', 'amount', 'name', 'key', 'blocked', 'is_active', 'captcha', 'reason', 'audience', 'test', 'click_id', 'event', 'type',
    'min_withdraw', 'withdraw_fee', 'cooldown_hours', 'auto_payout_max', 'auto_payout_enabled', 'withdraw_enabled', 'maintenance', 'track_channel', 'ip_check', 'captcha_global', 'notify_users', 'flag', 'on'].forEach(k => { if (b[k] !== undefined) d[k] = String(b[k]).slice(0, 60); });
  if (b.text) d.text_len = String(b.text).length;
  adminLog.unshift({ t: new Date().toISOString(), a: path.replace('/admin/', ''), d });
  if (adminLog.length > 150) adminLog.length = 150;
  clearTimeout(adminLogTimer);
  adminLogTimer = setTimeout(() => { dbUpsert('settings', { k: 'admin_log', v: JSON.stringify(adminLog) }, 'k').catch(() => {}); }, 3000);
}
adminRoute('get', '/admin/log', async () => ({ log: adminLog }));

// ---------- Analytics (charts + offer report) ----------
adminRoute('get', '/admin/analytics', async (req) => {
  let days = Math.min(120, Math.max(1, parseInt(req.query.days) || 7));
  let startMs = Date.parse(istTodayStartISO()) - (days - 1) * 86400000;
  const dre = /^\d{4}-\d{2}-\d{2}$/;
  if (dre.test(String(req.query.from || '')) && dre.test(String(req.query.to || ''))) {
    const a = Date.parse(req.query.from + 'T00:00:00+05:30'), b2 = Date.parse(req.query.to + 'T00:00:00+05:30');
    if (!isNaN(a) && !isNaN(b2) && b2 >= a) { startMs = a; days = Math.min(120, Math.round((b2 - a) / 86400000) + 1); }
  }
  const endMs = startMs + days * 86400000;
  const since = enc(new Date(startMs).toISOString());
  const [clicks, convs, wds] = await Promise.all([
    fetchAll('clicks', `select=click_id,offer_name,created_at&created_at=gte.${since}&order=created_at.asc`),
    fetchAll('conversions', 'select=*&order=id.desc'),
    fetchAll('withdrawals', `select=amount,status,created_at&created_at=gte.${since}&order=created_at.asc`)
  ]);
  const series = {};
  for (let i = 0; i < days; i++) { const k = istDay(startMs + i * 86400000); series[k] = { d: k, clicks: 0, conversions: 0, payout: 0, withdrawn: 0 }; }
  const offers = {};
  const O = n => offers[n] || (offers[n] = { name: n, clicks: 0, converted: new Set(), conversions: 0, payout: 0, events: {} });
  const clickIds = new Set();
  let totalClicks = 0;
  clicks.forEach(c => { const t = rowTime(c); if (isNaN(t) || t < startMs || t >= endMs) return; const k = istDay(t); if (series[k]) series[k].clicks++; clickIds.add(c.click_id); O(c.offer_name || '?').clicks++; totalClicks++; });
  let totalConv = 0, totalPay = 0;
  convs.forEach(c => {
    const t = rowTime(c); if (isNaN(t) || t < startMs || t >= endMs) return;
    const amt = parseFloat(c.amount) || 0, k = istDay(t);
    if (series[k]) { series[k].conversions++; series[k].payout += amt; }
    const o = O(c.offer_name || '?'); o.conversions++; o.payout += amt; o.events[c.event || '?'] = (o.events[c.event || '?'] || 0) + 1;
    if (clickIds.has(c.click_id)) o.converted.add(c.click_id);
    totalConv++; totalPay += amt;
  });
  let totalWd = 0;
  wds.forEach(w => { if (w.status !== 'paid') return; const t = rowTime(w); if (isNaN(t) || t < startMs || t >= endMs) return; const k = istDay(t); const a = parseFloat(w.amount) || 0; if (series[k]) series[k].withdrawn += a; totalWd += a; });
  const offerRows = Object.values(offers).map(o => ({ name: o.name, clicks: o.clicks, converted: o.converted.size, conversions: o.conversions, payout: Math.round(o.payout * 100) / 100, rate: o.clicks ? Math.round(o.converted.size / o.clicks * 1000) / 10 : 0, events: o.events }))
    .sort((a, b) => b.payout - a.payout || b.clicks - a.clicks);
  const rows = Object.values(series).map(r => ({ d: r.d, clicks: r.clicks, conversions: r.conversions, payout: Math.round(r.payout * 100) / 100, withdrawn: Math.round(r.withdrawn * 100) / 100 }));
  return { days, series: rows, offers: offerRows, totals: { clicks: totalClicks, conversions: totalConv, payout: Math.round(totalPay * 100) / 100, withdrawn: Math.round(totalWd * 100) / 100 } };
});

// ---------- Fraud alerts ----------
adminRoute('get', '/admin/fraud', async () => {
  const since = enc(new Date(Date.now() - 7 * 86400000).toISOString());
  const dayAgo = Date.now() - 86400000;
  const getClicks = async () => { const r = await fetchAll('clicks', `select=*&created_at=gte.${since}&order=created_at.desc`, 10000); return r; };
  const [clicks, users] = await Promise.all([
    getClicks(),
    fetchAll('users', 'select=*&order=telegram_id.asc', 20000)
  ]);
  const byPhone = {};
  users.forEach(u => { if (u.phone) (byPhone[u.phone] = byPhone[u.phone] || []).push(u); });
  const uRef = u => ({ telegram_id: String(u.telegram_id), name: u.name || 'User', blocked: u.blocked === true });
  const alerts = [];
  const ipPhones = {}, phoneClicks = {};
  clicks.forEach(c => {
    const ph = phoneOf(c.click_id);
    if (c.ip) (ipPhones[c.ip] = ipPhones[c.ip] || new Set()).add(ph);
    if (rowTime(c) >= dayAgo) phoneClicks[ph] = (phoneClicks[ph] || 0) + 1;
  });
  Object.keys(ipPhones).forEach(ip => {
    const n = ipPhones[ip].size; if (n < 4) return;
    const us = []; ipPhones[ip].forEach(ph => (byPhone[ph] || []).forEach(u => us.push(uRef(u))));
    alerts.push({ id: 'ip:' + ip, type: 'shared_ip', severity: n >= 8 ? 'high' : 'med', title: n + ' different numbers from one network', detail: 'IP ' + ip + ' (last 7 days)', users: us.slice(0, 8) });
  });
  Object.keys(phoneClicks).forEach(ph => {
    const n = phoneClicks[ph]; if (n < 10) return;
    alerts.push({ id: 'ph:' + ph, type: 'click_spam', severity: n >= 25 ? 'high' : 'med', title: n + ' clicks in 24 hours', detail: 'Number ' + ph, users: (byPhone[ph] || []).map(uRef).slice(0, 3) });
  });
  const upiMap = {};
  users.forEach(u => { const k = String(u.upi_id || '').trim().toLowerCase(); if (k) (upiMap[k] = upiMap[k] || []).push(u); });
  Object.keys(upiMap).forEach(k => { const g = upiMap[k]; if (g.length < 2) return; alerts.push({ id: 'upi:' + k, type: 'shared_upi', severity: g.length >= 3 ? 'high' : 'med', title: g.length + ' accounts use the same UPI', detail: k, users: g.map(uRef).slice(0, 8) }); });
  Object.keys(byPhone).forEach(ph => { const g = byPhone[ph]; if (g.length < 2) return; alerts.push({ id: 'dup:' + ph, type: 'shared_phone', severity: 'med', title: g.length + ' Telegram accounts, same number', detail: 'Number ' + ph, users: g.map(uRef).slice(0, 8) }); });
  const rank = { high: 0, med: 1 };
  alerts.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { alerts: alerts.slice(0, 80), scanned: { clicks: clicks.length, users: users.length } };
});

// ---------- Missing conversions ----------
adminRoute('get', '/admin/missing', async (req) => {
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours) || 48));
  const minAgeMs = 30 * 60000;
  const since = enc(new Date(Date.now() - hours * 3600000).toISOString());
  const [clicks, convs] = await Promise.all([
    fetchAll('clicks', `select=click_id,offer_name,created_at&created_at=gte.${since}&order=created_at.desc`, 10000),
    fetchAll('conversions', 'select=click_id,event,offer_name&order=id.desc', 30000)
  ]);
  const got = {};
  convs.forEach(c => { (got[c.click_id] = got[c.click_id] || new Set()).add(String(c.event || '')); });
  const rows = [], sum = {};
  clicks.forEach(c => {
    const t = rowTime(c); if (isNaN(t) || Date.now() - t < minAgeMs) return;
    const s = sum[c.offer_name] || (sum[c.offer_name] = { name: c.offer_name, clicks: 0, none: 0, partial: 0 });
    s.clicks++;
    const ev = got[c.click_id];
    if (!ev) { s.none++; rows.push({ click_id: c.click_id, phone: phoneOf(c.click_id), offer: c.offer_name, created_at: c.created_at, status: 'none', got: [] }); return; }
    const cfg = offerCfgByName(c.offer_name);
    if (cfg && cfg.events && cfg.events.length > 1) {
      const names = cfg.events.map(e => e.name.toLowerCase());
      const have = [...ev].map(e => e.toLowerCase());
      if (names.some(n => !have.includes(n))) { s.partial++; rows.push({ click_id: c.click_id, phone: phoneOf(c.click_id), offer: c.offer_name, created_at: c.created_at, status: 'partial', got: [...ev] }); }
    }
  });
  const offers = Object.values(sum).map(s => Object.assign(s, { none_pct: s.clicks ? Math.round(s.none / s.clicks * 100) : 0 })).sort((a, b) => b.none - a.none);
  return { hours, offers, rows: rows.slice(0, 300), total_rows: rows.length };
});

// ---------- Postback tester ----------
adminRoute('get', '/admin/postback/lookup', async (req) => {
  const id = String(req.query.click_id || '').trim();
  if (!/^[A-Za-z0-9]{6,60}$/.test(id)) throw new Error('Click ID galat hai');
  const [cl, cv] = await Promise.all([
    dbGet('clicks', `click_id=eq.${enc(id)}&select=*&limit=1`),
    dbGet('conversions', `click_id=eq.${enc(id)}&select=event,amount,offer_name&order=id.desc&limit=20`)
  ]);
  const click = Array.isArray(cl) && cl[0] ? cl[0] : null;
  const cfg = click ? offerCfgByName(click.offer_name) : null;
  return { click, conversions: Array.isArray(cv) ? cv : [], events: cfg && cfg.events ? cfg.events : [] };
});
adminRoute('post', '/admin/postback/test', async (req) => {
  const b = req.body || {};
  const id = String(b.click_id || '').trim(), ev = String(b.event || '').trim();
  if (!/^[A-Za-z0-9]{6,60}$/.test(id)) throw new Error('Click ID galat hai');
  if (!/^[A-Za-z0-9_ .+-]{1,40}$/.test(ev)) throw new Error('Event naam galat hai');
  const before = await dbCount('conversions', `click_id=eq.${enc(id)}`);
  let url = `http://127.0.0.1:${process.env.PORT || 3000}/postback?click_id=${enc(id)}&event=${enc(ev)}&token=${enc(POSTBACK_TOKEN)}`;
  const amt = parseFloat(b.amount); if (!isNaN(amt) && amt > 0 && amt <= 10000) url += `&amount=${amt}`;
  let text = '';
  try { const r = await fetchWithTimeout(url); text = (await r.text()).slice(0, 120); } catch (e) { throw new Error('Postback chalane me error: ' + e.message); }
  await sleep(2000);
  const after = await dbCount('conversions', `click_id=eq.${enc(id)}`);
  const rows = await dbGet('conversions', `click_id=eq.${enc(id)}&select=event,amount,offer_name&order=id.desc&limit=5`);
  return { response: text, credited: after > before, conversions: Array.isArray(rows) ? rows : [], message: after > before ? 'Postback kaam kiya. Conversion save ho gaya.' : 'Postback gaya par naya conversion nahi bana (duplicate ya event match nahi hua).' };
});

// ---------- CSV export ----------
adminRoute('get', '/admin/export', async (req) => {
  const type = String(req.query.type || '');
  const cfg = { users: ['users', 'order=telegram_id.asc'], withdrawals: ['withdrawals', 'order=id.desc'], conversions: ['conversions', 'order=id.desc'], clicks: ['clicks', 'order=created_at.desc'] }[type];
  if (!cfg) throw new Error('Type galat hai');
  const rows = await fetchAll(cfg[0], `select=*&${cfg[1]}`, type === 'clicks' ? 5000 : 20000);
  const bad = /pass|secret|token|pin|hash/i;
  const keys = rows.length ? Object.keys(rows[0]).filter(k => !bad.test(k)) : [];
  const q = v => { const t = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csv = [keys.join(',')].concat(rows.map(r => keys.map(k => q(r[k])).join(','))).join('\n');
  return { filename: `cashflix-${type}-${istDay(Date.now())}.csv`, csv, rows: rows.length };
});



// ---------- Live logs ----------
adminRoute('get', '/admin/logs', async (req) => {
  const after = parseInt(req.query.after) || 0;
  let rows = LOGBUF.filter(l => l.id > after);
  if (!after) rows = rows.slice(-250);
  return { logs: rows.slice(-400), last: logSeq };
});

// ---------- Report (leads in a date range) ----------
adminRoute('get', '/admin/report', async (req) => {
  const dre = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(req.query.from || ''), to = String(req.query.to || '');
  if (!dre.test(from) || !dre.test(to)) throw new Error('Dates galat hain');
  const startMs = Date.parse(from + 'T00:00:00+05:30'), endMs = Date.parse(to + 'T00:00:00+05:30') + 86400000;
  if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs || endMs - startMs > 122 * 86400000) throw new Error('Date range 120 din se zyada nahi ho sakti');
  const offer = String(req.query.offer || '').trim().slice(0, 40);
  const cap = Math.min(20000, Math.max(50, parseInt(req.query.limit) || 300));
  const since = enc(new Date(startMs).toISOString());
  const [convs, clicks] = await Promise.all([
    fetchAll('conversions', 'select=*&order=id.desc', 50000),
    fetchAll('clicks', `select=click_id,offer_name,created_at&created_at=gte.${since}&order=created_at.asc`, 60000)
  ]);
  let nClicks = 0;
  clicks.forEach(c => { const t = rowTime(c); if (isNaN(t) || t < startMs || t >= endMs) return; if (offer && c.offer_name !== offer) return; nClicks++; });
  const rows = [], sum = {};
  let leads = 0, earned = 0;
  convs.forEach(c => {
    const t = rowTime(c); if (isNaN(t) || t < startMs || t >= endMs) return;
    if (offer && c.offer_name !== offer) return;
    const amt = parseFloat(c.amount) || 0;
    leads++; earned += amt;
    const k = (c.offer_name || '?') + '|' + (c.event || '?');
    const r = sum[k] || (sum[k] = { offer: c.offer_name || '?', event: c.event || '?', count: 0, amount: 0 });
    r.count++; r.amount += amt;
    rows.push({ t, time: new Date(t).toISOString(), offer: c.offer_name || '?', event: c.event || '?', phone: String(c.telegram_id || ''), amount: amt, click_id: c.click_id || '' });
  });
  rows.sort((a, b) => b.t - a.t);
  const summary = Object.values(sum).map(r => ({ offer: r.offer, event: r.event, count: r.count, amount: Math.round(r.amount * 100) / 100 })).sort((a, b) => b.amount - a.amount);
  return { from, to, offer, totals: { clicks: nClicks, leads, earned: Math.round(earned * 100) / 100, cvr: nClicks ? Math.round(leads / nClicks * 1000) / 10 : 0 }, summary, rows: rows.slice(0, cap).map(r => ({ time: r.time, offer: r.offer, event: r.event, phone: r.phone, amount: r.amount, click_id: r.click_id })), total_rows: rows.length };
});

loadOffers(); loadSettings();
setInterval(loadOffers, 60000);
setInterval(loadSettings, 120000);
// ================= END ADMIN PANEL =================

app.get('/', (req, res) => res.send('TrackFlix Wallet Bot Running! ✅'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on port ${PORT}`));

setInterval(async () => {
  try { await fetchWithTimeout('https://cash-flix-dytv.onrender.com/'); } catch(e) {}
}, 14 * 60 * 1000);

  
