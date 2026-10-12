import {
  normalizeDomain, parseRdap, daysUntil, formatInTimezone, validTimezone,
  detectDnsProvider, detectHostingProvider, analyzeSeoHtml, analyzeGeoAeo, parseRobots, parseSitemap,
  parseCertSpotter, fallbackKeywords, normalizeTxtRecord, parsePageSpeed, scheduleIntervalMs, buildReportPdf
} from './lib.js';

const VERSION = '1.3.0';
const DEVELOPER = 'Nadeem';
const GITHUB_URL = 'https://github.com/nadeemmhdm/webdoctorpro';
const PUBLIC_BASE_URL = 'https://webdoctorpro.nadeemmhdm-ai.workers.dev';
const LAST_UPDATED_AT = '2026-10-12T18:32:00+05:30';
const ALERT_DAYS = [30, 14, 7, 3, 1, 0];
const TELEGRAM_API = 'https://api.telegram.org';
const MAX_HTML_BYTES = 700_000;
const MAX_LINK_CHECKS = 20;
const VERIFY_TTL_MS = 24 * 3600000;
const OAUTH_TTL_MS = 10 * 60000;
const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly'
];
const SPINNER = ['◐', '◓', '◑', '◒'];

const PLAN_CONFIG = Object.freeze({
  free: { label: 'Free', stars: 0, dailyScans: 5, dailyReports: 1, maxDomains: 1, schedules: ['weekly'], adEvery: 1 },
  starter: { label: 'Starter', stars: 49, dailyScans: 25, dailyReports: 5, maxDomains: 5, schedules: ['daily', 'weekly'], adEvery: 5 },
  pro: { label: 'Pro', stars: 129, dailyScans: 100, dailyReports: 20, maxDomains: 25, schedules: ['daily', 'weekly', 'monthly'], adEvery: 0 }
});
const SUBSCRIPTION_PERIOD = 2592000;
const REFERRAL_REFERRER_COINS = 25;
const REFERRAL_NEW_USER_COINS = 10;
const AD_VISIBLE_MS = 60000;
const BROADCAST_BATCH = 20;

function planRank(plan) { return plan === 'pro' ? 2 : plan === 'starter' ? 1 : 0; }
function activePlan(user) {
  const plan = PLAN_CONFIG[user?.plan] ? user.plan : 'free';
  if (plan === 'free') return 'free';
  if (!user?.plan_expires_at) return plan;
  return new Date(user.plan_expires_at).getTime() > Date.now() ? plan : 'free';
}
function planConfig(user) { return PLAN_CONFIG[activePlan(user)] || PLAN_CONFIG.free; }
function localDayKey(tz = 'UTC') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    const get = (type) => parts.find((x) => x.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch { return new Date().toISOString().slice(0, 10); }
}
function addDays(baseIso, days) {
  const base = baseIso && new Date(baseIso).getTime() > Date.now() ? new Date(baseIso).getTime() : Date.now();
  return new Date(base + Number(days || 0) * 86400000).toISOString();
}
function parseDateEnd(value) {
  if (!value || ['none','never','null','-'].includes(String(value).toLowerCase())) return null;
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T23:59:59.999Z` : String(value);
  const d = new Date(raw); return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function parseButtonsSpec(spec) {
  const out = [];
  for (const piece of String(spec || '').split(';').map((x) => x.trim()).filter(Boolean).slice(0, 8)) {
    const i = piece.indexOf('|'); if (i <= 0) continue;
    const text = piece.slice(0, i).trim(), url = piece.slice(i + 1).trim();
    if (!text || !/^https?:\/\//i.test(url)) continue;
    out.push({ text: short(text, 40), url: short(url, 500) });
  }
  return out;
}
function buttonsMarkup(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) return undefined;
  const rows = []; for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}
function extractStoredContent(msg) {
  if (msg.photo?.length) return { contentType: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id, text: msg.caption || '' };
  if (msg.video?.file_id) return { contentType: 'video', fileId: msg.video.file_id, text: msg.caption || '' };
  if (msg.voice?.file_id) return { contentType: 'voice', fileId: msg.voice.file_id, text: msg.caption || '' };
  if (msg.text) return { contentType: 'text', fileId: null, text: msg.text };
  return null;
}


function signature() { return `WEB-DOCTOR-PRO/${VERSION}; developer=${DEVELOPER}; repo=${GITHUB_URL}`; }
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-web-doctor-signature': signature(),
      'cache-control': 'no-store'
    }
  });
}
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function short(s, max = 500) { const x = String(s ?? '').trim(); return x.length > max ? `${x.slice(0, max - 1)}…` : x; }
function scoreLabel(score) { return score >= 85 ? '🟢 Excellent' : score >= 70 ? '🟡 Good' : score >= 50 ? '🟠 Needs work' : '🔴 Critical'; }
function nowIso() { return new Date().toISOString(); }
function randomHex(bytes = 18) { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return [...a].map((x) => x.toString(16).padStart(2, '0')).join(''); }
function dateOnly(daysAgo = 0) { return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10); }

async function tg(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram token is not configured.');
  const r = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || r.status}`);
  return data.result;
}
async function send(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}
async function edit(env, chatId, messageId, text, extra = {}) {
  try { return await tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch { return null; }
}
async function chatAction(env, chatId, action = 'typing') {
  try { await tg(env, 'sendChatAction', { chat_id: chatId, action }); } catch { /* ignore */ }
}
async function answerCb(env, id, text) {
  try { await tg(env, 'answerCallbackQuery', { callback_query_id: id, text: short(text, 180) }); } catch { /* ignore */ }
}
async function reactToMessage(env, msg, emoji = '👀') {
  try {
    if (!msg?.chat?.id || !msg?.message_id) return;
    await tg(env, 'setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji }], is_big: false });
  } catch { /* reactions are best effort */ }
}
async function deleteTelegramMessage(env, chatId, messageId) {
  try { await tg(env, 'deleteMessage', { chat_id: chatId, message_id: messageId }); return true; } catch { return false; }
}
async function sendStoredMedia(env, chatId, contentType, fileId, textContent = '', buttons = []) {
  const reply_markup = buttonsMarkup(buttons);
  if (contentType === 'photo') return tg(env, 'sendPhoto', { chat_id: chatId, photo: fileId, caption: textContent || undefined, parse_mode: 'HTML', reply_markup });
  if (contentType === 'video') return tg(env, 'sendVideo', { chat_id: chatId, video: fileId, caption: textContent || undefined, parse_mode: 'HTML', reply_markup });
  if (contentType === 'voice') return tg(env, 'sendVoice', { chat_id: chatId, voice: fileId, caption: textContent || undefined, parse_mode: 'HTML', reply_markup });
  return send(env, chatId, textContent || '📣', { reply_markup });
}
async function appMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key=?').bind(key).first();
  return row?.value ?? null;
}
async function setAppMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key, String(value), nowIso()).run();
}
async function isAdmin(env, user) {
  const id = await appMeta(env, 'admin_user_id');
  return Boolean(id && String(id) === String(user?.telegram_user_id));
}
async function getAdminTelegramId(env) { return appMeta(env, 'admin_user_id'); }

async function ensureReferralCode(env, user) {
  if (user?.referral_code) return user.referral_code;
  for (let i = 0; i < 4; i++) {
    const code = randomHex(5).toUpperCase();
    try {
      await env.DB.prepare('UPDATE users SET referral_code=?,updated_at=? WHERE id=? AND referral_code IS NULL').bind(code, nowIso(), user.id).run();
      const row = await env.DB.prepare('SELECT referral_code FROM users WHERE id=?').bind(user.id).first();
      if (row?.referral_code) return row.referral_code;
    } catch { /* retry on rare collision */ }
  }
  return null;
}
async function refreshExpiredPlan(env, user) {
  if (!user || activePlan(user) !== 'free' || user.plan === 'free') return user;
  await env.DB.prepare(`UPDATE users SET plan='free',plan_expires_at=NULL,subscription_auto_renew=0,updated_at=? WHERE id=?`).bind(nowIso(), user.id).run();
  return { ...user, plan: 'free', plan_expires_at: null, subscription_auto_renew: 0 };
}
async function extendPlan(env, userId, plan, days, { autoRenew = false, chargeId = null, absoluteExpiry = null } = {}) {
  if (!PLAN_CONFIG[plan] || plan === 'free') throw new Error('Invalid paid plan.');
  const row = await env.DB.prepare('SELECT plan,plan_expires_at FROM users WHERE id=?').bind(userId).first();
  const current = row?.plan || 'free';
  const target = planRank(current) > planRank(plan) && row?.plan_expires_at && new Date(row.plan_expires_at).getTime() > Date.now() ? current : plan;
  const expiry = absoluteExpiry || addDays(target === current ? row?.plan_expires_at : null, days);
  await env.DB.prepare(`UPDATE users SET plan=?,plan_expires_at=?,subscription_auto_renew=?,subscription_charge_id=COALESCE(?,subscription_charge_id),updated_at=? WHERE id=?`)
    .bind(target, expiry, autoRenew ? 1 : 0, chargeId, nowIso(), userId).run();
  return expiry;
}
async function dailyUsage(env, user) {
  const dayKey = localDayKey(user.timezone_configured ? user.timezone : 'UTC');
  const row = await env.DB.prepare('SELECT * FROM usage_daily WHERE user_id=? AND day_key=?').bind(user.id, dayKey).first();
  return { dayKey, row: row || { scan_count: 0, report_count: 0, ad_eligible_count: 0 } };
}
async function consumeUsage(env, user, { report = false, incrementAd = false } = {}) {
  const fresh = await refreshExpiredPlan(env, user), cfg = planConfig(fresh), { dayKey, row } = await dailyUsage(env, fresh);
  if (Number(row.scan_count || 0) >= cfg.dailyScans) return { ok: false, reason: `Daily scan limit reached (${cfg.dailyScans}).`, plan: activePlan(fresh), cfg };
  if (report && Number(row.report_count || 0) >= cfg.dailyReports) return { ok: false, reason: `Daily PDF report limit reached (${cfg.dailyReports}).`, plan: activePlan(fresh), cfg };
  await env.DB.prepare(`INSERT INTO usage_daily(user_id,day_key,scan_count,report_count,ad_eligible_count,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id,day_key) DO UPDATE SET scan_count=scan_count+excluded.scan_count,report_count=report_count+excluded.report_count,ad_eligible_count=ad_eligible_count+excluded.ad_eligible_count,updated_at=excluded.updated_at`)
    .bind(fresh.id, dayKey, 1, report ? 1 : 0, incrementAd ? 1 : 0, nowIso()).run();
  return { ok: true, plan: activePlan(fresh), cfg, user: fresh };
}
function plansText(user) {
  const current = activePlan(user), until = user?.plan_expires_at && current !== 'free' ? ` until ${user.plan_expires_at.slice(0, 10)}` : '';
  return `💎 <b>WEB DOCTOR PRO Plans</b>\n\n🆓 <b>Free</b>\n• 5 checks/day • 1 PDF/day • 1 monitored site\n• Weekly reports • Ads after scans\n\n⭐ <b>Starter — 49 Stars / 30 days</b>\n• 25 checks/day • 5 PDFs/day • 5 monitored sites\n• Daily + weekly reports • Fewer ads\n\n👑 <b>Pro — 129 Stars / 30 days</b>\n• 100 checks/day • 20 PDFs/day • 25 monitored sites\n• Daily/weekly/monthly reports • No ads\n\n📌 Current plan: <b>${PLAN_CONFIG[current].label}${esc(until)}</b>\n\nTelegram handles recurring Star subscription payments.`;
}
function plansMarkup() {
  return { inline_keyboard: [[{ text: '⭐ Starter — 49 Stars', callback_data: 'buyplan:starter' }], [{ text: '👑 Pro — 129 Stars', callback_data: 'buyplan:pro' }], [{ text: '🎟 Redeem Coupon', callback_data: 'couponhelp:show' }]] };
}
async function sendPlanInvoice(env, chatId, user, plan) {
  const cfg = PLAN_CONFIG[plan]; if (!cfg || !cfg.stars) throw new Error('Invalid paid plan.');
  const payload = `sub:${plan}:${user.id}:${randomHex(6)}`;
  return tg(env, 'sendInvoice', {
    chat_id: chatId,
    title: `WEB DOCTOR PRO ${cfg.label}`,
    description: `${cfg.label} access for 30 days with recurring Telegram Stars billing.`,
    payload,
    currency: 'XTR',
    prices: [{ label: `${cfg.label} — 30 days`, amount: cfg.stars }],
    subscription_period: SUBSCRIPTION_PERIOD
  });
}
async function handlePreCheckout(env, q) {
  const payload = String(q.invoice_payload || ''), m = /^sub:(starter|pro):(\d+):/.exec(payload);
  if (!m) return tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: false, error_message: 'Invalid subscription invoice.' });
  const user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(q.from?.id || '')).first();
  const ok = Boolean(user && !user.blocked && Number(user.id) === Number(m[2]) && Number(q.total_amount) === PLAN_CONFIG[m[1]].stars && q.currency === 'XTR');
  return tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message: 'This subscription invoice is no longer valid.' }) });
}
async function handleSuccessfulPayment(env, msg, user) {
  const p = msg.successful_payment, m = /^sub:(starter|pro):(\d+):/.exec(String(p?.invoice_payload || ''));
  if (!m || Number(m[2]) !== Number(user.id) || p.currency !== 'XTR') return;
  const plan = m[1], cfg = PLAN_CONFIG[plan]; if (Number(p.total_amount) !== cfg.stars) return;
  const expiry = p.subscription_expiration_date ? new Date(Number(p.subscription_expiration_date) * 1000).toISOString() : addDays(user.plan_expires_at, 30);
  await env.DB.prepare(`INSERT OR IGNORE INTO star_payments(user_id,plan,amount,currency,invoice_payload,telegram_charge_id,provider_charge_id,subscription_expiration_date,is_recurring,is_first_recurring,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(user.id, plan, p.total_amount, p.currency, p.invoice_payload, p.telegram_payment_charge_id, p.provider_payment_charge_id || null, expiry, p.is_recurring ? 1 : 0, p.is_first_recurring ? 1 : 0, nowIso()).run();
  await extendPlan(env, user.id, plan, 30, { autoRenew: Boolean(p.is_recurring), chargeId: p.telegram_payment_charge_id, absoluteExpiry: expiry });
  await reactToMessage(env, msg, '🎉');
  await send(env, msg.chat.id, `🎉 <b>${cfg.label} activated</b>\n\n⭐ Payment: ${cfg.stars} Stars\n📅 Access until: ${esc(formatInTimezone(expiry, user.timezone_configured ? user.timezone : 'UTC'))}\n${p.is_recurring ? '🔁 Recurring subscription is active.' : ''}\n\nUse /plans anytime to view your plan.`);
}
async function applyReferral(env, user, code) {
  if (!code || user.referred_by) return false;
  if (user.created_at && Date.now() - new Date(user.created_at).getTime() > 30 * 60000) return false;
  const referrer = await env.DB.prepare('SELECT id FROM users WHERE referral_code=?').bind(String(code).toUpperCase()).first();
  if (!referrer || Number(referrer.id) === Number(user.id)) return false;
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET referred_by=?,coins=coins+?,referral_rewarded_at=?,updated_at=? WHERE id=? AND referred_by IS NULL').bind(referrer.id, REFERRAL_NEW_USER_COINS, now, now, user.id),
    env.DB.prepare('UPDATE users SET coins=coins+?,updated_at=? WHERE id=?').bind(REFERRAL_REFERRER_COINS, now, referrer.id)
  ]);
  return true;
}
async function referralText(env, user) {
  const code = await ensureReferralCode(env, user), stats = await env.DB.prepare('SELECT COUNT(*) c FROM users WHERE referred_by=?').bind(user.id).first();
  const coins = (await env.DB.prepare('SELECT coins FROM users WHERE id=?').bind(user.id).first())?.coins || 0;
  return `🎁 <b>Referral Program</b>\n\n🔗 Your invite link:\n<code>https://t.me/webdoctorpro_bot?start=ref_${esc(code || '')}</code>\n\n👥 Successful invites: <b>${stats?.c || 0}</b>\n🪙 Coins: <b>${coins}</b>\n\nRewards\n• You get ${REFERRAL_REFERRER_COINS} coins per new user\n• New user gets ${REFERRAL_NEW_USER_COINS} coins\n\nRedeem coins to extend plan access with /coins.`;
}
function coinsMarkup(coins) {
  const rows = [];
  if (coins >= 100) rows.push([{ text: '⭐ 100 coins → +7 Starter days', callback_data: 'redeem:starter7' }]);
  if (coins >= 250) rows.push([{ text: '👑 250 coins → +7 Pro days', callback_data: 'redeem:pro7' }]);
  if (coins >= 600) rows.push([{ text: '👑 600 coins → +30 Pro days', callback_data: 'redeem:pro30' }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}
async function redeemCoins(env, chatId, user, option) {
  const offers = { starter7: { cost: 100, plan: 'starter', days: 7 }, pro7: { cost: 250, plan: 'pro', days: 7 }, pro30: { cost: 600, plan: 'pro', days: 30 } };
  const o = offers[option]; if (!o) return;
  const current = await env.DB.prepare('SELECT coins FROM users WHERE id=?').bind(user.id).first();
  if (Number(current?.coins || 0) < o.cost) return send(env, chatId, `🪙 You need ${o.cost} coins for this reward.`);
  await env.DB.prepare('UPDATE users SET coins=coins-?,updated_at=? WHERE id=? AND coins>=?').bind(o.cost, nowIso(), user.id, o.cost).run();
  const expiry = await extendPlan(env, user.id, o.plan, o.days);
  return send(env, chatId, `✅ <b>Coins redeemed</b>\n\n🪙 Used: ${o.cost}\n💎 Plan: ${PLAN_CONFIG[o.plan].label}\n📅 Added: ${o.days} day(s)\n⏳ Access until: ${esc(formatInTimezone(expiry, user.timezone_configured ? user.timezone : 'UTC'))}`);
}
async function redeemCoupon(env, chatId, user, codeRaw) {
  const code = String(codeRaw || '').trim().toUpperCase();
  if (!code) return send(env, chatId, '🎟 Usage: <code>/coupon CODE</code>');
  const c = await env.DB.prepare(`SELECT * FROM coupons WHERE code=? AND active=1`).bind(code).first();
  if (!c) return send(env, chatId, '❌ This coupon is invalid or inactive.');
  if (c.expires_at && new Date(c.expires_at).getTime() <= Date.now()) { await env.DB.prepare('DELETE FROM coupons WHERE id=?').bind(c.id).run(); return send(env, chatId, '⌛ This coupon has expired.'); }
  if (c.max_uses != null && Number(c.uses_count) >= Number(c.max_uses)) return send(env, chatId, '🚫 This coupon has reached its usage limit.');
  const used = await env.DB.prepare('SELECT COUNT(*) c FROM coupon_redemptions WHERE coupon_id=? AND user_id=?').bind(c.id, user.id).first();
  if (Number(used?.c || 0) >= Number(c.per_user_limit || 1)) return send(env, chatId, 'ℹ️ You already used this coupon.');
  const expiry = Number(c.bonus_days) > 0 ? await extendPlan(env, user.id, c.plan, Number(c.bonus_days)) : user.plan_expires_at;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO coupon_redemptions(coupon_id,user_id,redeemed_at) VALUES(?,?,?)').bind(c.id, user.id, nowIso()),
    env.DB.prepare('UPDATE coupons SET uses_count=uses_count+1,updated_at=? WHERE id=?').bind(nowIso(), c.id),
    env.DB.prepare('UPDATE users SET coins=coins+?,updated_at=? WHERE id=?').bind(Number(c.bonus_coins || 0), nowIso(), user.id)
  ]);
  return send(env, chatId, `🎉 <b>Coupon redeemed</b>\n\n🎟 <code>${esc(code)}</code>\n💎 ${esc(PLAN_CONFIG[c.plan]?.label || c.plan)}${Number(c.bonus_days) ? ` +${c.bonus_days} day(s)` : ''}${Number(c.bonus_coins) ? `\n🪙 +${c.bonus_coins} coins` : ''}${expiry ? `\n📅 Access until: ${esc(formatInTimezone(expiry, user.timezone_configured ? user.timezone : 'UTC'))}` : ''}`);
}


async function sendDocument(env, chatId, bytes, filename, caption, replyMarkup = null) {
  await chatAction(env, chatId, 'upload_document');
  const form = new FormData();
  form.set('chat_id', String(chatId));
  form.set('caption', caption);
  form.set('parse_mode', 'HTML');
  form.set('document', new Blob([bytes], { type: 'application/pdf' }), filename);
  if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
  const r = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description || r.status}`);
  return data.result;
}

async function maybeServeAd(env, user, chatId) {
  const plan = activePlan(user), cfg = PLAN_CONFIG[plan];
  if (!cfg || cfg.adEvery <= 0) return null;
  const enabled = await appMeta(env, 'ads_enabled'); if (enabled === '0') return null;
  const { dayKey, row } = await dailyUsage(env, user);
  const nextCount = Number(row.ad_eligible_count || 0) + 1;
  await env.DB.prepare(`INSERT INTO usage_daily(user_id,day_key,scan_count,report_count,ad_eligible_count,updated_at) VALUES(?,?,0,0,1,?)
    ON CONFLICT(user_id,day_key) DO UPDATE SET ad_eligible_count=ad_eligible_count+1,updated_at=excluded.updated_at`).bind(user.id, dayKey, nowIso()).run();
  if (nextCount % cfg.adEvery !== 0) return null;
  const ad = await env.DB.prepare(`SELECT * FROM ads WHERE active=1 ORDER BY RANDOM() LIMIT 1`).first();
  if (!ad) return null;
  let buttons = []; try { buttons = JSON.parse(ad.buttons_json || '[]'); } catch { buttons = []; }
  const sponsoredText = `📣 <b>Sponsored</b>${ad.text_content ? `\n\n${ad.text_content}` : ''}`;
  const sent = await sendStoredMedia(env, chatId, ad.content_type, ad.telegram_file_id, sponsoredText, buttons);
  await env.DB.batch([
    env.DB.prepare('INSERT INTO ad_views(ad_id,user_id,viewed_at) VALUES(?,?,?)').bind(ad.id, user.id, nowIso()),
    env.DB.prepare('UPDATE ads SET impressions=impressions+1,updated_at=? WHERE id=?').bind(nowIso(), ad.id),
    env.DB.prepare('INSERT INTO pending_message_deletes(chat_id,message_id,delete_at,created_at) VALUES(?,?,?,?)').bind(String(chatId), sent.message_id, new Date(Date.now() + AD_VISIBLE_MS).toISOString(), nowIso())
  ]);
  return sent;
}
async function cleanupTemporaryMessages(env) {
  const due = await env.DB.prepare('SELECT * FROM pending_message_deletes WHERE delete_at<=? ORDER BY id LIMIT 50').bind(nowIso()).all();
  for (const row of due.results) {
    await deleteTelegramMessage(env, row.chat_id, row.message_id);
    await env.DB.prepare('DELETE FROM pending_message_deletes WHERE id=?').bind(row.id).run();
  }
}
async function cleanupCoupons(env) {
  await env.DB.prepare('DELETE FROM coupons WHERE (expires_at IS NOT NULL AND expires_at<=?) OR (max_uses IS NOT NULL AND uses_count>=max_uses)').bind(nowIso()).run();
}
async function setAdminSession(env, adminUserId, state, payload = {}) {
  await env.DB.prepare(`INSERT INTO admin_sessions(admin_user_id,state,payload_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(admin_user_id) DO UPDATE SET state=excluded.state,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .bind(adminUserId, state, JSON.stringify(payload), nowIso()).run();
}
async function getAdminSession(env, adminUserId) { return env.DB.prepare('SELECT * FROM admin_sessions WHERE admin_user_id=?').bind(adminUserId).first(); }
async function clearAdminSession(env, adminUserId) { await env.DB.prepare('DELETE FROM admin_sessions WHERE admin_user_id=?').bind(adminUserId).run(); }
function adminMenuMarkup() {
  return { inline_keyboard: [
    [{ text: '📊 Stats', callback_data: 'admin:stats' }, { text: '👥 Users', callback_data: 'admin:users' }],
    [{ text: '🎟 Coupons', callback_data: 'admin:coupons' }, { text: '📣 Ads', callback_data: 'admin:ads' }],
    [{ text: '📢 Broadcasts', callback_data: 'admin:broadcasts' }, { text: '💎 Plans', callback_data: 'admin:plans' }],
    [{ text: '➕ Create Ad', callback_data: 'admin:adcreate' }, { text: '➕ Broadcast', callback_data: 'admin:broadcastcreate' }],
    [{ text: '🔄 Refresh', callback_data: 'admin:home' }]
  ] };
}
async function adminStatsText(env) {
  const [users, paid, blocked, verified, ads, broadcasts, revenue] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) c FROM users').first(),
    env.DB.prepare("SELECT COUNT(*) c FROM users WHERE plan IN ('starter','pro') AND (plan_expires_at IS NULL OR plan_expires_at>?)").bind(nowIso()).first(),
    env.DB.prepare('SELECT COUNT(*) c FROM users WHERE blocked=1').first(),
    env.DB.prepare("SELECT COUNT(*) c FROM domain_verifications WHERE status='verified'").first(),
    env.DB.prepare('SELECT COUNT(*) c FROM ads WHERE active=1').first(),
    env.DB.prepare("SELECT COUNT(*) c FROM broadcasts WHERE status IN ('queued','sending')").first(),
    env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM star_payments WHERE currency='XTR'").first()
  ]);
  return `🛠 <b>WEB DOCTOR PRO Admin</b>\n\n👥 Users: <b>${users?.c || 0}</b>\n💎 Paid users: <b>${paid?.c || 0}</b>\n🚫 Blocked: <b>${blocked?.c || 0}</b>\n🛡 Verified domains: <b>${verified?.c || 0}</b>\n📣 Active ads: <b>${ads?.c || 0}</b>\n📢 Active broadcasts: <b>${broadcasts?.c || 0}</b>\n⭐ Stars received: <b>${revenue?.s || 0}</b>\n\nUse the buttons below or admin commands.`;
}
async function adminUsersView(env) {
  const rows = await env.DB.prepare(`SELECT id,telegram_user_id,username,first_name,plan,plan_expires_at,coins,blocked FROM users ORDER BY id DESC LIMIT 12`).all();
  if (!rows.results.length) return { text: '👥 No users yet.', markup: adminMenuMarkup() };
  const lines = rows.results.map((u) => `• <b>#${u.id}</b> ${esc(u.first_name || u.username || 'User')} — ${esc(activePlan(u))}${u.blocked ? ' 🚫' : ''} • 🪙${u.coins || 0}`).join('\n');
  const buttons = rows.results.map((u) => [{ text: `${u.blocked ? '🚫' : '👤'} #${u.id} ${short(u.first_name || u.username || 'User', 18)}`, callback_data: `adminuser:${u.id}` }]);
  buttons.push([{ text: '⬅️ Admin Home', callback_data: 'admin:home' }]);
  return { text: `👥 <b>Recent Users</b>\n\n${lines}`, markup: { inline_keyboard: buttons } };
}
async function adminUserDetail(env, dbUserId) {
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(dbUserId).first();
  if (!u) return { text: '❌ User not found.', markup: adminMenuMarkup() };
  const watched = await env.DB.prepare('SELECT COUNT(*) c FROM watches WHERE user_id=? AND active=1').bind(u.id).first();
  const text = `👤 <b>User #${u.id}</b>\n\nTelegram ID: <code>${esc(u.telegram_user_id)}</code>\nName: ${esc(u.first_name || '—')}\nUsername: ${u.username ? `@${esc(u.username)}` : '—'}\nPlan: <b>${esc(activePlan(u))}</b>\nExpires: ${esc(u.plan_expires_at || '—')}\nCoins: <b>${u.coins || 0}</b>\nSites: <b>${watched?.c || 0}</b>\nStatus: ${u.blocked ? '🚫 Blocked' : '✅ Active'}`;
  return { text, markup: { inline_keyboard: [
    [{ text: u.blocked ? '✅ Unblock' : '🚫 Block', callback_data: `${u.blocked ? 'adminunblock' : 'adminblock'}:${u.id}` }],
    [{ text: '⭐ +30d Starter', callback_data: `admingrantstarter:${u.id}` }, { text: '👑 +30d Pro', callback_data: `admingrantpro:${u.id}` }],
    [{ text: '🪙 +100 Coins', callback_data: `admincoins100:${u.id}` }],
    [{ text: '⬅️ Users', callback_data: 'admin:users' }]
  ] } };
}
async function adminCouponsText(env) {
  const rows = await env.DB.prepare('SELECT * FROM coupons ORDER BY id DESC LIMIT 20').all();
  const lines = rows.results.length ? rows.results.map((c) => `• <code>${esc(c.code)}</code> → ${esc(c.plan)} +${c.bonus_days}d${c.bonus_coins ? ` +🪙${c.bonus_coins}` : ''} • ${c.uses_count}/${c.max_uses ?? '∞'} • ${c.active ? 'ON' : 'OFF'}${c.expires_at ? ` • exp ${c.expires_at.slice(0,10)}` : ''}`).join('\n') : 'No coupons.';
  return `🎟 <b>Coupons</b>\n\n${lines}\n\n<b>Create</b>\n<code>/admin_coupon_create CODE pro 7 100 2026-12-31 0</code>\nplan days maxUses expiry bonusCoins\n\n<b>Edit</b>\n<code>/admin_coupon_edit CODE days=14 max=200 active=1</code>\n\n<b>Delete</b>\n<code>/admin_coupon_delete CODE</code>`;
}
async function adminAdsText(env) {
  const rows = await env.DB.prepare('SELECT * FROM ads ORDER BY id DESC LIMIT 20').all();
  const lines = rows.results.length ? rows.results.map((a) => `• #${a.id} ${a.active ? '🟢' : '⚪'} ${esc(a.content_type)} • views ${a.impressions || 0} • ${esc(short(a.title || a.text_content || 'Ad', 40))}`).join('\n') : 'No ads.';
  return `📣 <b>Ads Manager</b>\n\n${lines}\n\nCreate: /admin_ad_create\nEdit content: /admin_ad_edit ID\nButtons: <code>/admin_ad_buttons ID Label|https://url; More|https://url</code>\nEnable/disable: /admin_ad_on ID • /admin_ad_off ID\nDelete: /admin_ad_delete ID\nGlobal: /admin_ads_on • /admin_ads_off\n\nMedia files are referenced by Telegram file_id only; WEB DOCTOR PRO does not store the image/video/voice bytes.`;
}
async function adminBroadcastsText(env) {
  const rows = await env.DB.prepare('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 15').all();
  const lines = rows.results.length ? rows.results.map((b) => `• #${b.id} ${esc(b.status)} • sent ${b.sent_count || 0} • failed ${b.failed_count || 0} • ${esc(b.content_type)}`).join('\n') : 'No broadcasts.';
  return `📢 <b>Broadcast Manager</b>\n\n${lines}\n\nCreate: /admin_broadcast\nButtons: <code>/admin_broadcast_buttons ID Label|https://url; More|https://url</code>\nSend: /admin_broadcast_send ID\nDelete draft: /admin_broadcast_delete ID\n\nMedia stays on Telegram; only Telegram file_id references are saved.`;
}
async function handleAdminMediaSession(env, msg, user) {
  const session = await getAdminSession(env, user.id); if (!session) return false;
  const content = extractStoredContent(msg); if (!content) { await send(env, msg.chat.id, '❌ Send text, image, video, or voice.'); return true; }
  let payload = {}; try { payload = JSON.parse(session.payload_json || '{}'); } catch { payload = {}; }
  if (session.state === 'ad_create') {
    const r = await env.DB.prepare(`INSERT INTO ads(title,content_type,text_content,telegram_file_id,buttons_json,active,created_at,updated_at) VALUES(?,?,?,?, '[]',0,?,?)`)
      .bind(short(content.text || `${content.contentType} ad`, 80), content.contentType, content.text || '', content.fileId, nowIso(), nowIso()).run();
    await clearAdminSession(env, user.id);
    await send(env, msg.chat.id, `✅ <b>Ad draft #${r.meta.last_row_id} created</b>\n\nAdd buttons with:\n<code>/admin_ad_buttons ${r.meta.last_row_id} Visit|https://example.com</code>\n\nThen enable:\n<code>/admin_ad_on ${r.meta.last_row_id}</code>`);
    return true;
  }
  if (session.state === 'ad_edit') {
    const id = Number(payload.id); await env.DB.prepare('UPDATE ads SET content_type=?,text_content=?,telegram_file_id=?,updated_at=? WHERE id=?').bind(content.contentType, content.text || '', content.fileId, nowIso(), id).run();
    await clearAdminSession(env, user.id); await send(env, msg.chat.id, `✅ Ad #${id} content updated.`); return true;
  }
  if (session.state === 'broadcast_create') {
    const r = await env.DB.prepare(`INSERT INTO broadcasts(content_type,text_content,telegram_file_id,buttons_json,status,created_at,updated_at) VALUES(?,?,?,'[]','draft',?,?)`)
      .bind(content.contentType, content.text || '', content.fileId, nowIso(), nowIso()).run();
    await clearAdminSession(env, user.id);
    await send(env, msg.chat.id, `✅ <b>Broadcast draft #${r.meta.last_row_id} created</b>\n\nOptional buttons:\n<code>/admin_broadcast_buttons ${r.meta.last_row_id} Open|https://example.com</code>\n\nSend it with:\n<code>/admin_broadcast_send ${r.meta.last_row_id}</code>`);
    return true;
  }
  return false;
}
async function processBroadcasts(env) {
  const b = await env.DB.prepare(`SELECT * FROM broadcasts WHERE status IN ('queued','sending') ORDER BY id LIMIT 1`).first(); if (!b) return;
  let buttons = []; try { buttons = JSON.parse(b.buttons_json || '[]'); } catch { buttons = []; }
  const users = await env.DB.prepare('SELECT id,chat_id FROM users WHERE blocked=0 AND id>? ORDER BY id LIMIT ?').bind(Number(b.cursor_user_id || 0), BROADCAST_BATCH).all();
  let cursor = Number(b.cursor_user_id || 0), sent = 0, failed = 0;
  for (const u of users.results) {
    cursor = Number(u.id);
    try { await sendStoredMedia(env, u.chat_id, b.content_type, b.telegram_file_id, b.text_content || '', buttons); sent++; }
    catch { failed++; }
  }
  const done = users.results.length < BROADCAST_BATCH;
  await env.DB.prepare(`UPDATE broadcasts SET status=?,cursor_user_id=?,sent_count=sent_count+?,failed_count=failed_count+?,updated_at=? WHERE id=?`)
    .bind(done ? 'done' : 'sending', cursor, sent, failed, nowIso(), b.id).run();
}


function domainButtons(domain, monitoring = false, verified = false) {
  if (domain.length > 45) return undefined;
  const rows = [
    [{ text: '🧪 Full Scan + PDF', callback_data: `scan:${domain}` }, { text: '📈 SEO / GEO / AEO', callback_data: `seo:${domain}` }],
    [{ text: '⚡ Performance', callback_data: `performance:${domain}` }, { text: '🔐 SSL', callback_data: `ssl:${domain}` }],
    [{ text: '🏢 Provider', callback_data: `provider:${domain}` }, { text: '🔗 Broken Links', callback_data: `links:${domain}` }],
    [{ text: '✨ Keywords', callback_data: `keywords:${domain}` }, { text: '📄 Robots / Sitemap', callback_data: `robots:${domain}` }]
  ];
  if (monitoring) rows.push([{ text: '✅ Verified & Monitoring', callback_data: `statusdomain:${domain}` }]);
  else if (verified) rows.push([{ text: '➕ Enable Monitoring', callback_data: `add:${domain}` }]);
  else rows.push([{ text: '🛡 Verify & Monitor', callback_data: `add:${domain}` }]);
  return { inline_keyboard: rows };
}
function verifyButtons(domain) {
  return { inline_keyboard: [[{ text: '🔄 Verify DNS Now', callback_data: `verify:${domain}` }], [{ text: '❌ Cancel', callback_data: `cancelverify:${domain}` }]] };
}
function scheduleButtons(domain) {
  if (domain.length > 45) return undefined;
  return { inline_keyboard: [[
    { text: '📅 Daily', callback_data: `schedule_daily:${domain}` },
    { text: '🗓 Weekly', callback_data: `schedule_weekly:${domain}` }
  ], [
    { text: '📆 Monthly', callback_data: `schedule_monthly:${domain}` },
    { text: '⏹ Off', callback_data: `schedule_off:${domain}` }
  ]] };
}

async function startProgress(env, chatId, title, detail = 'Preparing secure checks…') {
  await chatAction(env, chatId, 'typing');
  return send(env, chatId, `🩺 <b>${esc(title)}</b>\n\n${SPINNER[0]} ${esc(detail)}\n▱▱▱▱▱▱▱ 0%`);
}
async function updateProgress(env, chatId, messageId, title, step, total, detail) {
  const pct = Math.max(1, Math.min(100, Math.round((step / total) * 100)));
  const blocks = 7, filled = Math.round((pct / 100) * blocks);
  const bar = `${'▰'.repeat(filled)}${'▱'.repeat(blocks - filled)}`;
  return edit(env, chatId, messageId, `🩺 <b>${esc(title)}</b>\n\n${SPINNER[step % SPINNER.length]} ${esc(detail)}\n${bar} ${pct}%`);
}
async function finishProgress(env, chatId, messageId, title, detail = 'Report ready.') {
  return edit(env, chatId, messageId, `✅ <b>${esc(title)}</b>\n\n${esc(detail)}\n▰▰▰▰▰▰▰ 100%`);
}

async function syncBotProfile(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key='telegram_profile_version'").first();
    if (row?.value === VERSION) return;
    const commands = [
      { command: 'check', description: '🌐 Quick website health check' },
      { command: 'scan', description: '🧪 Full audit + signed PDF report' },
      { command: 'seo', description: '📈 SEO, GEO & AEO audit' },
      { command: 'performance', description: '⚡ PageSpeed performance report' },
      { command: 'ssl', description: '🔐 Check certificate expiry' },
      { command: 'provider', description: '🏢 Hosting, DNS & registrar info' },
      { command: 'links', description: '🔗 Detect broken internal links' },
      { command: 'robots', description: '📄 Robots.txt & sitemap analysis' },
      { command: 'keywords', description: '✨ Keyword opportunities' },
      { command: 'add', description: '🛡 Verify ownership & monitor' },
      { command: 'verify', description: '🔄 Verify DNS ownership record' },
      { command: 'schedule', description: '🗓 Schedule signed PDF reports' },
      { command: 'google', description: '🔗 Connect your Google account data' },
      { command: 'plans', description: '💎 Plans & Telegram Stars' },
      { command: 'invite', description: '🎁 Invite friends & earn coins' },
      { command: 'coins', description: '🪙 Coins & plan rewards' },
      { command: 'coupon', description: '🎟 Redeem a coupon' },
      { command: 'list', description: '📋 View monitored websites' },
      { command: 'status', description: '🩺 Bot status & version' },
      { command: 'settings', description: '⚙️ Your settings & plan' },
      { command: 'help', description: '❓ Help & examples' }
    ];
    await tg(env, 'setMyCommands', { commands });
    const adminId = await getAdminTelegramId(env);
    if (adminId) {
      const adminCommands = [...commands,
        { command: 'admin', description: '🛠 Admin dashboard' },
        { command: 'admin_users', description: '👥 Manage users' },
        { command: 'admin_coupons', description: '🎟 Manage coupons' },
        { command: 'admin_ads', description: '📣 Manage ads' },
        { command: 'admin_broadcasts', description: '📢 Manage broadcasts' },
        { command: 'admin_ad_create', description: '➕ Create an ad' },
        { command: 'admin_broadcast', description: '➕ Create a broadcast' },
        { command: 'admin_cancel', description: '✖️ Cancel admin draft mode' }
      ];
      await tg(env, 'setMyCommands', { commands: adminCommands, scope: { type: 'chat', chat_id: Number(adminId) } });
    }
    await tg(env, 'setMyDescription', { description: '🩺 Your Website Doctor — verify ownership, monitor uptime/domain/certificate health, audit SEO/GEO/AEO, and receive signed PDF reports and alerts.' });
    await tg(env, 'setMyShortDescription', { short_description: '🩺 Your Website Doctor — monitor, audit, improve.' });
    await env.DB.prepare("INSERT INTO app_meta(key,value,updated_at) VALUES('telegram_profile_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(VERSION, nowIso()).run();
  } catch (e) { console.error(JSON.stringify({ event: 'profile_sync_failed', error: e.message })); }
}

async function upsertUser(env, from, chatId) {
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO users (telegram_user_id, chat_id, username, first_name, created_at, updated_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id, username=excluded.username, first_name=excluded.first_name, updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at`)
    .bind(String(from.id), String(chatId), from.username || null, from.first_name || null, now, now, now).run();
  let user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(from.id)).first();
  await ensureReferralCode(env, user);
  user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  return refreshExpiredPlan(env, user);
}

async function rdapLookup(domain) {
  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  const r = await fetch(url, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` }, redirect: 'follow' });
  if (r.status === 404) return { domain, found: false, rdapUrl: r.url || url };
  if (!r.ok) throw new Error(`RDAP returned HTTP ${r.status}`);
  const data = await r.json();
  return { domain, found: true, rdapUrl: r.url || url, ...parseRdap(data) };
}

async function sslLookup(domain) {
  const url = `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(domain)}&include_subdomains=false&expand=dns_names&expand=issuer`;
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` } });
  if (!r.ok) throw new Error(`Certificate service returned HTTP ${r.status}`);
  return { domain, ...parseCertSpotter(await r.json(), domain) };
}

async function dnsLookup(domain, type) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.Answer || []).filter((x) => x?.data).map((x) => type === 'TXT' ? normalizeTxtRecord(x.data) : String(x.data).replace(/\.$/, ''));
  } catch { return []; }
}

async function readTextLimited(response, maxBytes = MAX_HTML_BYTES) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0, out = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); break; }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally { try { reader.releaseLock(); } catch { /* ignore */ } }
}
async function fetchText(url, maxBytes = MAX_HTML_BYTES, opts = {}) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': `WEB-DOCTOR-PRO/${VERSION}`, ...(opts.headers || {}) }, signal: opts.signal });
  const text = await readTextLimited(r, maxBytes);
  return { status: r.status, url: r.url, text, headers: Object.fromEntries(r.headers.entries()) };
}
async function websiteSnapshot(domain) {
  const [page, ns, cname] = await Promise.all([
    fetchText(`https://${domain}`), dnsLookup(domain, 'NS'), dnsLookup(domain, 'CNAME')
  ]);
  return { domain, page, dnsProvider: detectDnsProvider(ns), hostingProvider: detectHostingProvider({ headers: page.headers, cnames: cname }), nsRecords: ns, cnameRecords: cname };
}
async function robotsSitemapLlms(domain) {
  const robotsRes = await fetchText(`https://${domain}/robots.txt`, 200_000).catch(() => ({ status: 0, text: '', url: '' }));
  const robots = parseRobots(robotsRes.text, robotsRes.status || 599);
  const sitemapUrl = robots.sitemapUrls[0] || `https://${domain}/sitemap.xml`;
  const [sitemapRes, llmsRes] = await Promise.all([
    fetchText(sitemapUrl, 500_000).catch(() => ({ status: 0, text: '', url: sitemapUrl })),
    fetchText(`https://${domain}/llms.txt`, 180_000).catch(() => ({ status: 0, text: '', url: '' }))
  ]);
  return { robots, sitemap: parseSitemap(sitemapRes.text, sitemapRes.status || 599), sitemapUrl, llmsTxt: llmsRes.status >= 200 && llmsRes.status < 400 && llmsRes.text.trim().length > 0 };
}
async function brokenLinks(snapshot) {
  const audit = analyzeSeoHtml(snapshot.page.text, snapshot.page.url || `https://${snapshot.domain}`);
  const originHost = new URL(snapshot.page.url || `https://${snapshot.domain}`).hostname;
  const links = audit.links.filter((x) => new URL(x).hostname === originHost).slice(0, MAX_LINK_CHECKS);
  const results = await Promise.all(links.map(async (url) => {
    try {
      let r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` }, signal: AbortSignal.timeout(8000) });
      if ([405, 501].includes(r.status)) r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0', 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` }, signal: AbortSignal.timeout(8000) });
      return { url, status: r.status, broken: r.status >= 400 };
    } catch { return { url, status: 0, broken: true }; }
  }));
  return { checked: results.length, broken: results.filter((x) => x.broken), results };
}

async function pageSpeedLookup(env, domain, strategy = 'mobile') {
  const q = new URLSearchParams({ url: `https://${domain}`, strategy });
  for (const cat of ['performance', 'seo', 'accessibility', 'best-practices']) q.append('category', cat);
  const r = await fetch(`https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error(`PageSpeed returned HTTP ${r.status}`);
  return parsePageSpeed(await r.json());
}

async function saveDomain(env, info, extra = {}) {
  const now = nowIso();
  const next = new Date(Date.now() + 12 * 3600000).toISOString();
  await env.DB.prepare(`INSERT INTO domains (name, expires_at, registered_at, registrar, rdap_url, status, last_checked_at, next_check_at, last_error, created_at,
      ssl_expires_at, ssl_issuer, ssl_last_checked_at, ssl_next_check_at, hosting_provider, dns_provider, last_http_status, last_audit_at,
      last_seo_score, last_geo_score, last_aeo_score, last_pagespeed_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at, registered_at=excluded.registered_at, registrar=excluded.registrar,
      rdap_url=excluded.rdap_url, status=excluded.status, last_checked_at=excluded.last_checked_at, next_check_at=excluded.next_check_at, last_error=NULL,
      ssl_expires_at=COALESCE(excluded.ssl_expires_at,domains.ssl_expires_at), ssl_issuer=COALESCE(excluded.ssl_issuer,domains.ssl_issuer),
      ssl_last_checked_at=COALESCE(excluded.ssl_last_checked_at,domains.ssl_last_checked_at), ssl_next_check_at=COALESCE(excluded.ssl_next_check_at,domains.ssl_next_check_at),
      hosting_provider=COALESCE(excluded.hosting_provider,domains.hosting_provider), dns_provider=COALESCE(excluded.dns_provider,domains.dns_provider),
      last_http_status=COALESCE(excluded.last_http_status,domains.last_http_status), last_audit_at=COALESCE(excluded.last_audit_at,domains.last_audit_at),
      last_seo_score=COALESCE(excluded.last_seo_score,domains.last_seo_score), last_geo_score=COALESCE(excluded.last_geo_score,domains.last_geo_score),
      last_aeo_score=COALESCE(excluded.last_aeo_score,domains.last_aeo_score), last_pagespeed_score=COALESCE(excluded.last_pagespeed_score,domains.last_pagespeed_score)`)
    .bind(info.domain, info.expiresAt || null, info.registeredAt || null, info.registrar || null, info.rdapUrl || null,
      info.found ? (info.status || 'active') : 'not-found', now, next, now,
      extra.sslExpiresAt || null, extra.sslIssuer || null, extra.sslCheckedAt || null, extra.sslNextCheckAt || null,
      extra.hostingProvider || null, extra.dnsProvider || null, extra.httpStatus ?? null, extra.auditAt || null,
      extra.seoScore ?? null, extra.geoScore ?? null, extra.aeoScore ?? null, extra.pageSpeedScore ?? null).run();
  return env.DB.prepare('SELECT * FROM domains WHERE name=?').bind(info.domain).first();
}
function expiryLabel(iso) {
  const d = daysUntil(iso);
  if (d === null) return 'Unknown';
  if (d < 0) return `Expired ${Math.abs(d)} day(s) ago`;
  if (d === 0) return 'Expires today';
  return `${d} day(s) remaining`;
}

async function isVerified(env, userId, domain) {
  const row = await env.DB.prepare(`SELECT id,verified_at FROM domain_verifications WHERE user_id=? AND domain=? AND status='verified'`).bind(userId, domain).first();
  return row || null;
}
async function requestVerification(env, user, domain) {
  const existing = await isVerified(env, user.id, domain);
  if (existing) return { alreadyVerified: true, verification: existing };
  const current = await env.DB.prepare(`SELECT * FROM domain_verifications WHERE user_id=? AND domain=? AND status='pending' AND expires_at>? ORDER BY id DESC LIMIT 1`).bind(user.id, domain, nowIso()).first();
  if (current) return { alreadyVerified: false, verification: current };
  const token = `webdoctorpro-verification=${randomHex(20)}`;
  const recordName = `_webdoctorpro.${domain}`;
  const created = nowIso(), expires = new Date(Date.now() + VERIFY_TTL_MS).toISOString();
  await env.DB.prepare(`INSERT INTO domain_verifications(user_id,domain,record_name,token,status,created_at,expires_at) VALUES(?,?,?,?, 'pending',?,?)
    ON CONFLICT(user_id,domain) DO UPDATE SET record_name=excluded.record_name,token=excluded.token,status='pending',created_at=excluded.created_at,expires_at=excluded.expires_at,verified_at=NULL`)
    .bind(user.id, domain, recordName, token, created, expires).run();
  return { alreadyVerified: false, verification: await env.DB.prepare(`SELECT * FROM domain_verifications WHERE user_id=? AND domain=?`).bind(user.id, domain).first() };
}
async function verifyOwnership(env, user, domain) {
  const v = await env.DB.prepare(`SELECT * FROM domain_verifications WHERE user_id=? AND domain=? ORDER BY id DESC LIMIT 1`).bind(user.id, domain).first();
  if (!v) return { ok: false, reason: 'No pending verification. Use /add first.' };
  if (v.status === 'verified') return { ok: true, already: true, verification: v };
  if (new Date(v.expires_at).getTime() < Date.now()) return { ok: false, reason: 'Verification token expired. Use /add again for a new record.' };
  const txt = await dnsLookup(v.record_name, 'TXT');
  const found = txt.some((x) => normalizeTxtRecord(x) === v.token);
  if (!found) return { ok: false, reason: 'TXT record is not visible yet. DNS propagation can take a few minutes.', observed: txt };
  const verifiedAt = nowIso();
  await env.DB.prepare(`UPDATE domain_verifications SET status='verified',verified_at=? WHERE id=?`).bind(verifiedAt, v.id).run();
  return { ok: true, verification: { ...v, status: 'verified', verified_at: verifiedAt } };
}
async function activateWatch(env, user, domain, verification) {
  const rdap = await rdapLookup(domain).catch(() => ({ domain, found: false, status: 'lookup-error' }));
  const row = await saveDomain(env, rdap);
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO watches(user_id,domain_id,active,created_at,updated_at,verified_at,verification_id,uptime_state,report_schedule)
    VALUES(?,?,1,?,?,?,?, 'unknown','off')
    ON CONFLICT(user_id,domain_id) DO UPDATE SET active=1,updated_at=excluded.updated_at,verified_at=excluded.verified_at,verification_id=excluded.verification_id`)
    .bind(user.id, row.id, now, now, verification.verified_at || now, verification.id).run();
  return env.DB.prepare(`SELECT w.*,d.name FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=?`).bind(user.id, domain).first();
}

function quickCheckText(domain, tz, data) {
  const siteState = data.snap ? (data.snap.page.status < 500 ? `🟢 Reachable (HTTP ${data.snap.page.status})` : `🔴 HTTP ${data.snap.page.status}`) : '🔴 Unreachable';
  return `🩺 <b>WEB DOCTOR PRO — Quick Check</b>\n\n🌐 <b>${esc(domain)}</b>\n${siteState}\n\n📅 <b>Domain expiry</b>\n${data.rdap?.expiresAt ? `${esc(formatInTimezone(data.rdap.expiresAt, tz))}\n⏳ ${esc(expiryLabel(data.rdap.expiresAt))}` : '⚪ Expiry date not published'}\n\n🔐 <b>Certificate</b>\n${data.ssl?.expiresAt ? `${esc(formatInTimezone(data.ssl.expiresAt, tz))}\n⏳ ${esc(expiryLabel(data.ssl.expiresAt))}` : '⚪ Expiry date unavailable'}\n\n🏢 <b>Hosting:</b> ${esc(data.snap?.hostingProvider || 'Unknown')}\n🧭 <b>DNS:</b> ${esc(data.snap?.dnsProvider || 'Unknown')}\n🏷 <b>Registrar:</b> ${esc(data.rdap?.registrar || 'Not published')}\n\n💡 <i>Use Full Scan for SEO, GEO, AEO, performance, broken links and a signed PDF report.</i>`;
}
async function quickCheck(env, domain, tz) {
  const [rdapR, sslR, snapR] = await Promise.allSettled([rdapLookup(domain), sslLookup(domain), websiteSnapshot(domain)]);
  const rdap = rdapR.status === 'fulfilled' ? rdapR.value : { domain, found: false, status: 'lookup-error' };
  const ssl = sslR.status === 'fulfilled' ? sslR.value : { expiresAt: null, issuer: null };
  const snap = snapR.status === 'fulfilled' ? snapR.value : null;
  await saveDomain(env, rdap, {
    sslExpiresAt: ssl.expiresAt, sslIssuer: ssl.issuer, sslCheckedAt: ssl.expiresAt ? nowIso() : null,
    sslNextCheckAt: ssl.expiresAt ? new Date(Date.now() + 24 * 3600000).toISOString() : null,
    hostingProvider: snap?.hostingProvider, dnsProvider: snap?.dnsProvider, httpStatus: snap?.page?.status, auditAt: snap ? nowIso() : null
  }).catch(() => {});
  return { rdap, ssl, snap, text: quickCheckText(domain, tz, { rdap, ssl, snap }) };
}

async function smartText(env, prompt, max = 3200) {
  if (!env.OLLAMA_API_KEY || !env.OLLAMA_MODEL) return null;
  try {
    const r = await fetch('https://ollama.com/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OLLAMA_API_KEY}` },
      body: JSON.stringify({ model: env.OLLAMA_MODEL, stream: false, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(35000)
    });
    if (!r.ok) return null;
    return short((await r.json())?.message?.content || '', max) || null;
  } catch { return null; }
}
async function keywordSuggestions(env, domain, audit, searchConsole = null) {
  const fallback = fallbackKeywords(audit, domain);
  const searchTerms = (searchConsole?.topQueries || []).slice(0, 10).map((x) => x.query).join(', ');
  const prompt = `Suggest 12 concise SEO keyword phrases using only the provided evidence. Do not invent locations, services, awards, pricing, or claims. Return one phrase per line with no introduction.\nDomain: ${domain}\nTitle: ${short(audit.title, 180)}\nDescription: ${short(audit.description, 320)}\nExisting search queries: ${short(searchTerms, 600)}`;
  const generated = await smartText(env, prompt, 1800);
  if (!generated) return fallback;
  const list = generated.split(/\r?\n/).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 12);
  return list.length >= 4 ? list : fallback;
}
function deterministicRecommendations(report) {
  const out = [];
  for (const x of report.seo?.suggestions || []) if (!out.includes(x)) out.push(x);
  for (const x of report.geoAeo?.geoSuggestions || []) if (!out.includes(x)) out.push(x);
  for (const x of report.geoAeo?.aeoSuggestions || []) if (!out.includes(x)) out.push(x);
  if ((report.links?.broken?.length || 0) > 0) out.unshift(`Fix ${report.links.broken.length} broken/problem internal link(s).`);
  if (report.robots && !report.robots.exists) out.push('Publish a valid robots.txt file.');
  if (report.sitemap && !report.sitemap.exists) out.push('Publish and reference an XML sitemap.');
  if (report.pageSpeed?.performance != null && report.pageSpeed.performance < 70) out.unshift('Improve mobile performance, prioritizing LCP, blocking time and heavy assets.');
  return [...new Set(out)].slice(0, 12);
}
async function smartRecommendations(env, report) {
  const fallback = deterministicRecommendations(report);
  const prompt = `Create a prioritized website improvement plan. Use only the evidence below. Return 8 short numbered recommendations. Do not mention tools, models, providers, or that you are automated. Avoid invented claims.\nDomain: ${report.domain}\nSEO score: ${report.seo?.score}\nGEO score: ${report.geoAeo?.geoScore}\nAEO score: ${report.geoAeo?.aeoScore}\nPageSpeed: ${report.pageSpeed?.performance ?? 'n/a'}\nSEO issues: ${(report.seo?.issues || []).map((x) => x.issue).join('; ')}\nBroken links: ${report.links?.broken?.length || 0}\nrobots: ${report.robots?.exists ? 'present' : 'missing'}\nsitemap: ${report.sitemap?.exists ? 'present' : 'missing'}\nSearch queries: ${(report.searchConsole?.topQueries || []).slice(0, 8).map((x) => x.query).join(', ')}`;
  const generated = await smartText(env, prompt, 2400);
  if (!generated) return fallback;
  const list = generated.split(/\r?\n/).map((x) => x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean).slice(0, 12);
  return list.length >= 4 ? list : fallback;
}

function bytesFromB64(s) { const raw = atob(s); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); }
function b64FromBytes(a) { let s = ''; for (const b of a) s += String.fromCharCode(b); return btoa(s); }
async function googleCryptoKey(env) {
  if (!env.GOOGLE_TOKEN_KEY) throw new Error('Google token encryption key is not configured.');
  const raw = bytesFromB64(env.GOOGLE_TOKEN_KEY);
  if (raw.byteLength !== 32) throw new Error('Google token encryption key must be 32 bytes.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function encryptGoogle(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await googleCryptoKey(env);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value))));
  const out = new Uint8Array(iv.length + cipher.length); out.set(iv); out.set(cipher, iv.length); return b64FromBytes(out);
}
async function decryptGoogle(env, value) {
  const all = bytesFromB64(value), iv = all.slice(0, 12), cipher = all.slice(12);
  const key = await googleCryptoKey(env);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher)));
}
async function googleUserConfig(env, userId) {
  const row = await env.DB.prepare('SELECT * FROM google_user_configs WHERE user_id=?').bind(userId).first();
  if (!row) return null;
  try {
    return {
      clientId: await decryptGoogle(env, row.client_id_cipher),
      clientSecret: await decryptGoogle(env, row.client_secret_cipher)
    };
  } catch { return null; }
}
async function saveGoogleUserConfig(env, userId, clientId, clientSecret) {
  const clientIdCipher = await encryptGoogle(env, String(clientId).trim());
  const clientSecretCipher = await encryptGoogle(env, String(clientSecret).trim());
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO google_user_configs(user_id,client_id_cipher,client_secret_cipher,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET client_id_cipher=excluded.client_id_cipher,client_secret_cipher=excluded.client_secret_cipher,updated_at=excluded.updated_at`)
      .bind(userId, clientIdCipher, clientSecretCipher, nowIso(), nowIso()),
    env.DB.prepare('DELETE FROM google_connections WHERE user_id=?').bind(userId)
  ]);
}
async function googleConfigured(env, userId) { return Boolean(env.GOOGLE_TOKEN_KEY && await googleUserConfig(env, userId)); }
async function googleConnection(env, userId) { return env.DB.prepare('SELECT * FROM google_connections WHERE user_id=?').bind(userId).first(); }
async function saveGoogleTokens(env, userId, tokenData, email = null) {
  const encrypted = await encryptGoogle(env, tokenData);
  await env.DB.prepare(`INSERT INTO google_connections(user_id,token_cipher,scopes,email,created_at,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token_cipher=excluded.token_cipher,scopes=excluded.scopes,email=COALESCE(excluded.email,google_connections.email),updated_at=excluded.updated_at`)
    .bind(userId, encrypted, tokenData.scope || '', email, nowIso(), nowIso()).run();
}
async function getGoogleAccessToken(env, userId) {
  const row = await googleConnection(env, userId); if (!row) return null;
  const cfg = await googleUserConfig(env, userId); if (!cfg) return null;
  let t = await decryptGoogle(env, row.token_cipher);
  if (t.access_token && Number(t.expires_at || 0) > Date.now() + 60000) return t.access_token;
  if (!t.refresh_token) return null;
  const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Google token refresh failed (${r.status})`);
  const fresh = await r.json();
  t = { ...t, ...fresh, refresh_token: fresh.refresh_token || t.refresh_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 };
  await saveGoogleTokens(env, userId, t, row.email);
  return t.access_token;
}
async function createGoogleConnectUrl(env, user) {
  const cfg = await googleUserConfig(env, user.id); if (!cfg || !env.GOOGLE_TOKEN_KEY) return null;
  const state = randomHex(24), expires = new Date(Date.now() + OAUTH_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO oauth_states(state,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(state, user.id, nowIso(), expires).run();
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: `${PUBLIC_BASE_URL}/google/callback`, response_type: 'code', access_type: 'offline',
    prompt: 'consent', include_granted_scopes: 'true', scope: GOOGLE_SCOPES.join(' '), state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function searchConsoleData(env, userId, domain) {
  const token = await getGoogleAccessToken(env, userId).catch(() => null); if (!token) return null;
  const sitesRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { authorization: `Bearer ${token}` } });
  if (!sitesRes.ok) return null;
  const sites = (await sitesRes.json()).siteEntry || [];
  const site = sites.find((x) => x.siteUrl === `sc-domain:${domain}`) || sites.find((x) => {
    try { return new URL(x.siteUrl).hostname.replace(/^www\./, '') === domain.replace(/^www\./, ''); } catch { return false; }
  });
  if (!site) return null;
  const body = { startDate: dateOnly(28), endDate: dateOnly(1), dimensions: ['query'], rowLimit: 20, dataState: 'final' };
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site.siteUrl)}/searchAnalytics/query`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) return null;
  const data = await r.json(), rows = data.rows || [];
  const totals = rows.reduce((a, x) => { a.clicks += x.clicks || 0; a.impressions += x.impressions || 0; a.weightedPosition += (x.position || 0) * (x.impressions || 0); return a; }, { clicks: 0, impressions: 0, weightedPosition: 0 });
  return {
    siteUrl: site.siteUrl, clicks: totals.clicks, impressions: totals.impressions,
    ctr: totals.impressions ? totals.clicks / totals.impressions : 0,
    position: totals.impressions ? totals.weightedPosition / totals.impressions : null,
    topQueries: rows.slice(0, 12).map((x) => ({ query: x.keys?.[0] || '', clicks: x.clicks || 0, impressions: x.impressions || 0, ctr: x.ctr || 0, position: x.position || 0 }))
  };
}
async function analyticsData(env, userId, propertyId) {
  if (!propertyId) return null;
  const token = await getGoogleAccessToken(env, userId).catch(() => null); if (!token) return null;
  const body = { dateRanges: [{ startDate: '28daysAgo', endDate: 'yesterday' }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'engagementRate' }] };
  const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) return null;
  const data = await r.json(), values = data.rows?.[0]?.metricValues || [];
  return { propertyId, activeUsers: Number(values[0]?.value || 0), sessions: Number(values[1]?.value || 0), engagementRate: Number(values[2]?.value || 0) };
}

async function fullScanData(env, user, domain, onProgress = async () => {}) {
  const total = 7;
  await onProgress(1, total, 'Checking website, domain and certificate health…');
  const [rdapR, sslR, snapR] = await Promise.allSettled([rdapLookup(domain), sslLookup(domain), websiteSnapshot(domain)]);
  const rdap = rdapR.status === 'fulfilled' ? rdapR.value : { domain, found: false, status: 'lookup-error' };
  const ssl = sslR.status === 'fulfilled' ? sslR.value : { expiresAt: null, issuer: null };
  if (snapR.status !== 'fulfilled') throw new Error('Website could not be reached for the full scan.');
  const snap = snapR.value;

  await onProgress(2, total, 'Auditing on-page SEO, GEO and AEO signals…');
  const aux = await robotsSitemapLlms(domain);
  const seo = analyzeSeoHtml(snap.page.text, snap.page.url || `https://${domain}`);
  const geoAeo = analyzeGeoAeo(snap.page.text, seo, { llmsTxt: aux.llmsTxt });

  await onProgress(3, total, 'Checking robots.txt, sitemap and internal links…');
  const links = await brokenLinks(snap);

  await onProgress(4, total, 'Measuring mobile performance signals…');
  const pageSpeed = await pageSpeedLookup(env, domain, 'mobile').catch(() => null);

  await onProgress(5, total, 'Reading connected search and traffic data when available…');
  const watch = await env.DB.prepare(`SELECT w.* FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=? AND w.active=1`).bind(user.id, domain).first();
  const [searchConsole, analytics] = await Promise.all([
    searchConsoleData(env, user.id, domain).catch(() => null),
    watch?.ga_property_id ? analyticsData(env, user.id, watch.ga_property_id).catch(() => null) : Promise.resolve(null)
  ]);

  await onProgress(6, total, 'Preparing prioritized improvements and keyword opportunities…');
  const base = {
    version: VERSION, domain, verified: Boolean(await isVerified(env, user.id, domain)), generatedAt: nowIso(), generatedLocal: formatInTimezone(nowIso(), user.timezone || 'UTC'),
    siteStatus: snap.page.status < 500 ? `Reachable - HTTP ${snap.page.status}` : `HTTP ${snap.page.status}`,
    hostingProvider: snap.hostingProvider, dnsProvider: snap.dnsProvider, registrar: rdap.registrar,
    domainExpiryLocal: rdap.expiresAt ? formatInTimezone(rdap.expiresAt, user.timezone || 'UTC') : null,
    sslExpiryLocal: ssl.expiresAt ? formatInTimezone(ssl.expiresAt, user.timezone || 'UTC') : null,
    sslIssuer: ssl.issuer, rdap, ssl, snap, seo, geoAeo, robots: aux.robots, sitemap: aux.sitemap, sitemapUrl: aux.sitemapUrl, links, pageSpeed, searchConsole, analytics
  };
  base.keywords = await keywordSuggestions(env, domain, seo, searchConsole);
  base.recommendations = await smartRecommendations(env, base);

  await saveDomain(env, rdap, {
    sslExpiresAt: ssl.expiresAt, sslIssuer: ssl.issuer, sslCheckedAt: nowIso(), sslNextCheckAt: new Date(Date.now() + 24 * 3600000).toISOString(),
    hostingProvider: snap.hostingProvider, dnsProvider: snap.dnsProvider, httpStatus: snap.page.status, auditAt: nowIso(), seoScore: seo.score,
    geoScore: geoAeo.geoScore, aeoScore: geoAeo.aeoScore, pageSpeedScore: pageSpeed?.performance
  }).catch(() => {});
  await onProgress(7, total, 'Building the signed WEB DOCTOR PRO PDF report…');
  const pdf = buildReportPdf(base); base.reportId = pdf.reportId; base.pdfBytes = pdf.bytes;
  return base;
}
function fullScanSummary(report) {
  const speed = report.pageSpeed?.performance == null ? 'N/A' : `${report.pageSpeed.performance}/100`;
  return `🧪 <b>Full Scan Complete</b>\n\n🌐 <b>${esc(report.domain)}</b>\n📈 SEO: <b>${report.seo.score}/100</b> — ${scoreLabel(report.seo.score)}\n🌍 GEO: <b>${report.geoAeo.geoScore}/100</b>\n💬 AEO: <b>${report.geoAeo.aeoScore}/100</b>\n⚡ Mobile performance: <b>${speed}</b>\n🔗 Broken links: <b>${report.links.broken.length}</b> / ${report.links.checked} checked\n📄 robots.txt: ${report.robots.exists ? '✅' : '❌'}  •  Sitemap: ${report.sitemap.exists ? '✅' : '❌'}\n\n📑 <b>Signed PDF report:</b> ${esc(report.reportId)}\n💡 The PDF includes prioritized improvements, keyword opportunities, provider details, expiry data and connected Google metrics when available.`;
}
async function runFullScan(env, chatId, user, domain, { silentProgress = false, scheduled = false } = {}) {
  let msg = null;
  if (!silentProgress) msg = await startProgress(env, chatId, `Scanning ${domain}`, 'Starting full website audit…');
  const onProgress = silentProgress ? async () => {} : async (step, total, detail) => updateProgress(env, chatId, msg.message_id, `Scanning ${domain}`, step, total, detail);
  try {
    const report = await fullScanData(env, user, domain, onProgress);
    if (!silentProgress) await finishProgress(env, chatId, msg.message_id, `Scanning ${domain}`, 'Audit complete. Preparing your PDF…');
    const filename = `WEB-DOCTOR-PRO-${domain.replace(/[^a-z0-9.-]/gi, '-')}-${report.reportId}.pdf`;
    await sendDocument(env, chatId, report.pdfBytes, filename, `📑 <b>WEB DOCTOR PRO ${scheduled ? 'Scheduled ' : ''}Report</b>\n🌐 ${esc(domain)}\n🆔 ${esc(report.reportId)}\n🕒 ${esc(report.generatedLocal)}`, domainButtons(domain, Boolean(await isVerified(env, user.id, domain)), Boolean(await isVerified(env, user.id, domain))));
    await send(env, chatId, fullScanSummary(report), { reply_markup: scheduleButtons(domain) });
    return report;
  } catch (e) {
    if (msg) await edit(env, chatId, msg.message_id, `⚠️ <b>Scan could not finish</b>\n\n🌐 ${esc(domain)}\n${esc(short(e.message, 500))}\n\nTry again in a moment or use /check for a lighter health check.`);
    else await send(env, chatId, `⚠️ <b>Scheduled scan could not finish</b>\n🌐 ${esc(domain)}\n${esc(short(e.message, 500))}`);
    throw e;
  }
}

async function seoText(env, domain) {
  const snap = await websiteSnapshot(domain), aux = await robotsSitemapLlms(domain);
  const seo = analyzeSeoHtml(snap.page.text, snap.page.url || `https://${domain}`), ga = analyzeGeoAeo(snap.page.text, seo, { llmsTxt: aux.llmsTxt });
  const issues = seo.issues.slice(0, 8).map((x) => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟠' : '🟡'} ${esc(x.issue)}`).join('\n') || '✅ No major on-page issues detected.';
  const recs = [...seo.suggestions, ...ga.geoSuggestions, ...ga.aeoSuggestions].slice(0, 8).map((x) => `• ${esc(x)}`).join('\n');
  return `📈 <b>SEO / GEO / AEO — ${esc(domain)}</b>\n\n📈 <b>SEO:</b> ${seo.score}/100 — ${scoreLabel(seo.score)}\n🌍 <b>GEO:</b> ${ga.geoScore}/100\n💬 <b>AEO:</b> ${ga.aeoScore}/100\n🧩 <b>Structured data:</b> ${ga.schemaTypes.length ? esc(ga.schemaTypes.join(', ')) : 'Not detected'}\n📝 <b>Words:</b> ${seo.wordCount}\n🔠 <b>H1 / H2:</b> ${seo.h1Count} / ${seo.h2Count}\n🔗 <b>Links:</b> ${seo.internalLinkCount} internal • ${seo.externalLinkCount} external\n\n<b>Issues</b>\n${issues}\n\n<b>Priority improvements</b>\n${recs}`;
}
async function performanceText(env, domain) {
  const msg = `⚡ <b>Google PageSpeed — ${esc(domain)}</b>`;
  const [mobile, desktop] = await Promise.all([pageSpeedLookup(env, domain, 'mobile'), pageSpeedLookup(env, domain, 'desktop')]);
  const line = (label, x) => `${label}: ${x?.performance == null ? 'N/A' : `${x.performance}/100`}  •  LCP ${x?.lcpMs == null ? 'N/A' : `${x.lcpMs}ms`}  •  CLS ${x?.cls ?? 'N/A'}`;
  return `${msg}\n\n📱 <b>${line('Mobile', mobile)}</b>\n🖥 <b>${line('Desktop', desktop)}</b>\n\nMobile SEO: ${mobile?.seo ?? 'N/A'}/100\nMobile accessibility: ${mobile?.accessibility ?? 'N/A'}/100\nMobile best practices: ${mobile?.bestPractices ?? 'N/A'}/100`;
}
async function providerText(domain) {
  const [rdap, snap] = await Promise.all([rdapLookup(domain).catch(() => ({ domain })), websiteSnapshot(domain)]);
  return `🏢 <b>Provider Report — ${esc(domain)}</b>\n\n☁️ <b>Hosting/CDN:</b> ${esc(snap.hostingProvider)}\n🧭 <b>DNS provider:</b> ${esc(snap.dnsProvider)}\n🏷 <b>Domain registrar:</b> ${esc(rdap.registrar || 'Not published')}\n🌐 <b>Final URL:</b> ${esc(snap.page.url || `https://${domain}`)}\n📡 <b>HTTP status:</b> ${snap.page.status}\n🖥 <b>Server:</b> ${esc(snap.page.headers.server || 'Hidden / not sent')}`;
}
async function sslText(domain, tz) {
  const ssl = await sslLookup(domain);
  return ssl.expiresAt ? `🔐 <b>Certificate Report — ${esc(domain)}</b>\n\n📅 <b>Expiry:</b> ${esc(formatInTimezone(ssl.expiresAt, tz))}\n⏳ <b>${esc(expiryLabel(ssl.expiresAt))}</b>\n🏛 <b>Issuer:</b> ${esc(ssl.issuer || 'Not available')}\n\n<i>Expiry is estimated from public certificate transparency records.</i>` : `🔐 <b>Certificate Report — ${esc(domain)}</b>\n\n⚪ No active public certificate expiry record was available.`;
}
async function robotsText(domain) {
  const x = await robotsSitemapLlms(domain);
  return `📄 <b>Robots, Sitemap & llms.txt — ${esc(domain)}</b>\n\n📄 <b>robots.txt:</b> ${x.robots.exists ? `✅ Found (HTTP ${x.robots.status})` : '❌ Missing'}\n🚫 <b>Blocks all crawling:</b> ${x.robots.blocksAll ? '🔴 Yes' : '🟢 No'}\n📌 <b>Disallow rules:</b> ${x.robots.disallowCount}\n🗺 <b>Sitemap declared:</b> ${x.robots.sitemapUrls.length ? '✅ Yes' : '⚠️ No'}\n\n🗺 <b>XML sitemap:</b> ${x.sitemap.exists ? `✅ Found (${x.sitemap.type})` : '❌ Missing'}\n🔢 <b>URLs detected:</b> ${x.sitemap.urlCount}\n📚 <b>Child sitemaps:</b> ${x.sitemap.sitemapCount}\n🧠 <b>llms.txt:</b> ${x.llmsTxt ? '✅ Found' : '⚪ Not found'}`;
}
async function linksText(domain) {
  const snap = await websiteSnapshot(domain), x = await brokenLinks(snap);
  const detail = x.broken.slice(0, 10).map((r) => `❌ ${r.status || 'ERR'} — ${esc(short(r.url, 120))}`).join('\n');
  return `🔗 <b>Broken Link Check — ${esc(domain)}</b>\n\n🔍 <b>Internal links checked:</b> ${x.checked}/${MAX_LINK_CHECKS}\n${x.broken.length ? `🚨 <b>Broken/problem links:</b> ${x.broken.length}\n\n${detail}` : '✅ <b>No broken links found in the checked sample.</b>'}`;
}
async function keywordsText(env, user, domain) {
  const snap = await websiteSnapshot(domain), audit = analyzeSeoHtml(snap.page.text, snap.page.url || `https://${domain}`), sc = await searchConsoleData(env, user.id, domain).catch(() => null);
  const words = await keywordSuggestions(env, domain, audit, sc);
  return `✨ <b>Keyword Opportunities — ${esc(domain)}</b>\n\n${words.map((x, i) => `${i + 1}. ${esc(x)}`).join('\n')}\n\n💡 <i>Use these as research starting points; confirm intent and competition before publishing.</i>`;
}

async function runTool(env, chatId, user, action, domain) {
  if (!(await requireTimezone(env, chatId, user))) return;
  const usage = await consumeUsage(env, user, { report: action === 'scan' });
  if (!usage.ok) return send(env, chatId, `🚦 <b>Daily limit reached</b>\n\n${esc(usage.reason)}\nCurrent plan: <b>${esc(PLAN_CONFIG[usage.plan].label)}</b>\n\nUse /plans to compare limits or upgrade.` , { reply_markup: plansMarkup() });
  user = usage.user || user;
  if (action === 'scan') {
    const result = await runFullScan(env, chatId, user, domain);
    await maybeServeAd(env, user, chatId).catch(() => null);
    return result;
  }
  const titleMap = { check: 'Quick website check', seo: 'SEO / GEO / AEO audit', performance: 'Performance analysis', ssl: 'Certificate check', provider: 'Provider detection', links: 'Broken-link scan', robots: 'Robots and sitemap analysis', keywords: 'Keyword research' };
  const msg = await startProgress(env, chatId, `${titleMap[action] || 'Website check'} — ${domain}`, 'Collecting website signals…');
  try {
    await updateProgress(env, chatId, msg.message_id, `${titleMap[action] || 'Website check'} — ${domain}`, 1, 3, 'Checking live website data…');
    let text;
    if (action === 'check') text = (await quickCheck(env, domain, user.timezone)).text;
    if (action === 'seo') text = await seoText(env, domain);
    if (action === 'performance') text = await performanceText(env, domain);
    if (action === 'ssl') text = await sslText(domain, user.timezone);
    if (action === 'provider') text = await providerText(domain);
    if (action === 'links') text = await linksText(domain);
    if (action === 'robots') text = await robotsText(domain);
    if (action === 'keywords') {
      await updateProgress(env, chatId, msg.message_id, `${titleMap[action]} — ${domain}`, 2, 3, 'Preparing focused keyword opportunities…');
      text = await keywordsText(env, user, domain);
    }
    await updateProgress(env, chatId, msg.message_id, `${titleMap[action] || 'Website check'} — ${domain}`, 3, 3, 'Finalizing the result…');
    const verified = Boolean(await isVerified(env, user.id, domain));
    const watch = verified ? await env.DB.prepare(`SELECT w.active FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=?`).bind(user.id, domain).first() : null;
    await edit(env, chatId, msg.message_id, text, { reply_markup: domainButtons(domain, Boolean(watch?.active), verified) });
    await maybeServeAd(env, user, chatId).catch(() => null);
    return text;
  } catch (e) {
    await edit(env, chatId, msg.message_id, `⚠️ <b>Check could not finish</b>\n\n🌐 ${esc(domain)}\n${esc(short(e.message, 500))}`);
    return null;
  }
}

async function requireTimezone(env, chatId, user) {
  if (user.timezone_configured) return true;
  await send(env, chatId, '🕒 <b>Choose your timezone</b>\n\nWEB DOCTOR PRO uses it for accurate expiry times, alerts and report timestamps.\n\n👇 Select one or use <code>/timezone Area/City</code>.', {
    reply_markup: { inline_keyboard: [
      [{ text: '🇮🇳 India', callback_data: 'tz:Asia/Kolkata' }, { text: '🇦🇪 UAE', callback_data: 'tz:Asia/Dubai' }],
      [{ text: '🇬🇧 UK', callback_data: 'tz:Europe/London' }, { text: '🇺🇸 US Eastern', callback_data: 'tz:America/New_York' }],
      [{ text: '🌍 UTC', callback_data: 'tz:UTC' }]
    ] }
  });
  return false;
}
async function setTimezone(env, userId, tz) {
  if (!validTimezone(tz)) return false;
  await env.DB.prepare('UPDATE users SET timezone=?,timezone_configured=1,updated_at=? WHERE id=?').bind(tz, nowIso(), userId).run();
  return true;
}
function welcome(firstName = '') {
  const hi = firstName ? `Hi ${esc(firstName)}! 👋` : 'Welcome! 👋';
  return `🩺 <b>WEB DOCTOR PRO</b>\n<b>Your Website Doctor.</b>\n\n${hi}\n\n🌐 Check website health\n⏱ Monitor uptime\n📅 Track domain expiry\n🔐 Watch certificate expiry\n📈 Audit SEO / GEO / AEO\n📑 Get signed PDF reports\n\n<b>Fastest way</b>\nSend a domain directly:\n<code>example.com</code>\n\n<b>Monitor your website</b>\n<code>/add example.com</code>\nA one-time DNS TXT verification protects ownership-sensitive monitoring.\n\n💎 Use /plans for Free, Starter and Pro.\n🎁 Use /invite to earn coins.\n\nUse /help for all commands.`;
}
async function statusText(env, user) {
  const [count, conn, usage, coins] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) c FROM watches WHERE user_id=? AND active=1`).bind(user.id).first(),
    googleConnection(env, user.id).catch(() => null),
    dailyUsage(env, user),
    env.DB.prepare('SELECT coins FROM users WHERE id=?').bind(user.id).first()
  ]);
  const plan = activePlan(user), cfg = PLAN_CONFIG[plan];
  return `🩺 <b>WEB DOCTOR PRO Status</b>\n\n🟢 <b>Bot status:</b> Online\n📦 <b>Version:</b> v${VERSION}\n👨‍💻 <b>Developer:</b> ${DEVELOPER}\n🔗 <b>GitHub:</b> ${GITHUB_URL}\n🗄 <b>Database:</b> Connected\n⏱ <b>Uptime checks:</b> Every minute\n🌐 <b>Your monitored sites:</b> ${count?.c || 0}/${cfg.maxDomains}\n💎 <b>Your plan:</b> ${cfg.label}\n📊 <b>Today:</b> ${usage.row.scan_count || 0}/${cfg.dailyScans} checks • ${usage.row.report_count || 0}/${cfg.dailyReports} PDFs\n🪙 <b>Coins:</b> ${coins?.coins || 0}\n🔗 <b>Google data:</b> ${conn ? '✅ Connected' : '⚪ Optional / not connected'}\n🕒 <b>Last update:</b> ${esc(formatInTimezone(LAST_UPDATED_AT, user.timezone_configured ? user.timezone : 'Asia/Kolkata'))}`;
}
async function settingsText(env, user) {
  const [conn, gcfg, usage] = await Promise.all([
    googleConnection(env, user.id).catch(() => null),
    googleUserConfig(env, user.id).catch(() => null),
    dailyUsage(env, user)
  ]);
  const plan = activePlan(user), cfg = PLAN_CONFIG[plan];
  return `⚙️ <b>Your Settings</b>\n\n💎 <b>Plan:</b> ${cfg.label}${user.plan_expires_at && plan !== 'free' ? `\n📅 <b>Plan until:</b> ${esc(formatInTimezone(user.plan_expires_at, user.timezone_configured ? user.timezone : 'UTC'))}` : ''}\n📊 <b>Daily usage:</b> ${usage.row.scan_count || 0}/${cfg.dailyScans} checks • ${usage.row.report_count || 0}/${cfg.dailyReports} PDFs\n📣 <b>Ads:</b> ${cfg.adEvery === 0 ? 'Off' : cfg.adEvery === 1 ? 'After eligible scans' : `Every ${cfg.adEvery} eligible scans`}\n🕒 <b>Timezone:</b> <code>${esc(user.timezone_configured ? user.timezone : 'Not configured')}</code>\n📅 <b>Domain alerts:</b> ${ALERT_DAYS.join(', ')} days\n🔐 <b>Certificate alerts:</b> ${ALERT_DAYS.join(', ')} days\n⏱ <b>Uptime alerts:</b> Enabled for verified monitored sites\n📑 <b>Scheduled PDF reports:</b> ${cfg.schedules.join(', ')}\n🔗 <b>Google account:</b> ${conn ? `Connected${conn.email ? ` as ${esc(conn.email)}` : ''}` : gcfg ? 'OAuth app configured — account not connected' : 'Not configured'}\n🔒 <b>Ownership:</b> DNS TXT verification required before monitoring`;
}

async function handleAdd(env, chatId, user, domain) {
  if (!(await requireTimezone(env, chatId, user))) return;
  const cfg = planConfig(user);
  const existing = await env.DB.prepare(`SELECT status FROM domain_verifications WHERE user_id=? AND domain=? AND status IN ('pending','verified') ORDER BY id DESC LIMIT 1`).bind(user.id, domain).first();
  if (!existing) {
    const slots = await env.DB.prepare(`SELECT COUNT(DISTINCT domain) c FROM domain_verifications WHERE user_id=? AND status IN ('pending','verified')`).bind(user.id).first();
    if (Number(slots?.c || 0) >= cfg.maxDomains) return send(env, chatId, `🚦 <b>Website limit reached</b>\n\nYour ${cfg.label} plan supports ${cfg.maxDomains} verified/verification-pending website(s).\n\nUse /plans to upgrade.`, { reply_markup: plansMarkup() });
  }
  const v = await requestVerification(env, user, domain);
  if (v.alreadyVerified) {
    await activateWatch(env, user, domain, v.verification);
    await send(env, chatId, `✅ <b>Ownership already verified</b>\n\n🌐 ${esc(domain)}\n⏱ Uptime monitoring: active\n📅 Domain expiry alerts: active\n🔐 Certificate expiry alerts: active\n\nA fresh full report will be prepared if today’s PDF limit allows it.`, { reply_markup: scheduleButtons(domain) });
    const usage = await consumeUsage(env, user, { report: true });
    if (!usage.ok) return send(env, chatId, `ℹ️ Monitoring is active, but ${esc(usage.reason.toLowerCase())}\nUse /plans for higher limits.`);
    const r = await runFullScan(env, chatId, usage.user || user, domain);
    await maybeServeAd(env, usage.user || user, chatId).catch(() => null);
    return r;
  }
  const x = v.verification;
  return send(env, chatId, `🛡 <b>Verify website ownership</b>\n\n🌐 <b>${esc(domain)}</b>\n\nAdd this DNS TXT record at your DNS provider:\n\n<b>Type</b>\n<code>TXT</code>\n\n<b>Name / Host</b>\n<code>${esc(x.record_name)}</code>\n\n<b>Value</b>\n<code>${esc(x.token)}</code>\n\n⏳ <b>Valid for:</b> 24 hours\n\nAfter saving the record, tap <b>Verify DNS Now</b>. Once verified, monitoring activates and WEB DOCTOR PRO prepares the first signed PDF report if your daily report allowance is available.`, { reply_markup: verifyButtons(domain) });
}
async function handleVerify(env, chatId, user, domain) {
  const msg = await startProgress(env, chatId, `Verifying ${domain}`, 'Looking for the unique DNS TXT record…');
  const x = await verifyOwnership(env, user, domain);
  if (!x.ok) return edit(env, chatId, msg.message_id, `⏳ <b>Verification not complete yet</b>\n\n🌐 ${esc(domain)}\n${esc(x.reason)}\n\nKeep the TXT record in DNS and try again.`, { reply_markup: verifyButtons(domain) });
  await activateWatch(env, user, domain, x.verification);
  await edit(env, chatId, msg.message_id, `✅ <b>Ownership verified</b>\n\n🌐 ${esc(domain)}\n🛡 DNS verification: complete\n⏱ Uptime monitoring: active\n📅 Domain expiry alerts: active\n🔐 Certificate expiry alerts: active\n\n🧪 Preparing your first full signed report if today’s limit allows it…`, { reply_markup: scheduleButtons(domain) });
  const usage = await consumeUsage(env, user, { report: true });
  if (!usage.ok) return send(env, chatId, `ℹ️ Monitoring is active, but ${esc(usage.reason.toLowerCase())}\nUse /plans for higher limits.`);
  const r = await runFullScan(env, chatId, usage.user || user, domain);
  await maybeServeAd(env, usage.user || user, chatId).catch(() => null);
  return r;
}
async function setSchedule(env, chatId, user, domain, frequency) {
  const interval = scheduleIntervalMs(frequency), cfg = planConfig(user);
  const watch = await env.DB.prepare(`SELECT w.id,w.verified_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=? AND w.active=1`).bind(user.id, domain).first();
  if (!watch?.verified_at) return send(env, chatId, `🛡 <b>Verification required</b>\n\nUse <code>/add ${esc(domain)}</code> first.`);
  if (frequency === 'off') {
    await env.DB.prepare(`UPDATE watches SET report_schedule='off',next_report_at=NULL,updated_at=? WHERE id=?`).bind(nowIso(), watch.id).run();
    return send(env, chatId, `⏹ <b>Scheduled reports disabled</b>\n🌐 ${esc(domain)}`);
  }
  if (!interval || !['daily','weekly','monthly'].includes(frequency)) return send(env, chatId, '❌ Choose daily, weekly, monthly or off.');
  if (!cfg.schedules.includes(frequency)) return send(env, chatId, `🔒 <b>${esc(frequency)} reports are not included in ${cfg.label}</b>\n\nAvailable: ${cfg.schedules.join(', ')}\nUse /plans to upgrade.`, { reply_markup: plansMarkup() });
  const next = new Date(Date.now() + interval).toISOString();
  await env.DB.prepare(`UPDATE watches SET report_schedule=?,next_report_at=?,updated_at=? WHERE id=?`).bind(frequency, next, nowIso(), watch.id).run();
  return send(env, chatId, `🗓 <b>Scheduled reports enabled</b>\n\n🌐 ${esc(domain)}\n📑 Frequency: <b>${esc(frequency)}</b>\n🕒 Next report: ${esc(formatInTimezone(next, user.timezone || 'UTC'))}\n\nEach scheduled report is delivered as a signed PDF.`);
}

async function adminByTelegramId(env, telegramId) {
  return env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(telegramId)).first();
}
async function handleAdminCommand(env, msg, user, cmd, args) {
  if (!(await isAdmin(env, user))) return false;
  const chatId = msg.chat.id;
  if (cmd === '/admin') return void await send(env, chatId, await adminStatsText(env), { reply_markup: adminMenuMarkup() });
  if (cmd === '/admin_cancel') { await clearAdminSession(env,user.id); return void await send(env,chatId,'✅ Admin draft mode cleared.'); }
  if (cmd === '/admin_users') { const v = await adminUsersView(env); return void await send(env, chatId, v.text, { reply_markup: v.markup }); }
  if (cmd === '/admin_user') {
    if (!args[0]) return void await send(env, chatId, 'Usage: <code>/admin_user TELEGRAM_ID</code>');
    const target = await adminByTelegramId(env, args[0]); if (!target) return void await send(env, chatId, '❌ User not found.');
    const v = await adminUserDetail(env, target.id); return void await send(env, chatId, v.text, { reply_markup: v.markup });
  }
  if (cmd === '/admin_block' || cmd === '/admin_unblock') {
    if (!args[0]) return void await send(env, chatId, `Usage: <code>${cmd} TELEGRAM_ID</code>`);
    const target = await adminByTelegramId(env, args[0]); if (!target) return void await send(env, chatId, '❌ User not found.');
    if (await isAdmin(env, target)) return void await send(env, chatId, '🛡 The platform admin cannot be blocked.');
    const blocked = cmd === '/admin_block' ? 1 : 0;
    await env.DB.prepare('UPDATE users SET blocked=?,updated_at=? WHERE id=?').bind(blocked, nowIso(), target.id).run();
    return void await send(env, chatId, `${blocked ? '🚫 User blocked.' : '✅ User unblocked.'}`);
  }
  if (cmd === '/admin_grant') {
    if (!args[0] || !['starter','pro'].includes(String(args[1] || '').toLowerCase()) || !/^\d+$/.test(String(args[2] || ''))) return void await send(env, chatId, 'Usage: <code>/admin_grant TELEGRAM_ID starter|pro DAYS</code>');
    const target = await adminByTelegramId(env, args[0]); if (!target) return void await send(env, chatId, '❌ User not found.');
    const plan = args[1].toLowerCase(), days = Math.max(1, Math.min(3650, Number(args[2]))), expiry = await extendPlan(env, target.id, plan, days);
    await send(env, target.chat_id, `🎁 <b>Plan access granted</b>\n\n💎 ${PLAN_CONFIG[plan].label}\n📅 +${days} day(s)\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}`).catch(() => {});
    return void await send(env, chatId, `✅ Granted ${PLAN_CONFIG[plan].label} for ${days} day(s).`);
  }
  if (cmd === '/admin_coins') {
    if (!args[0] || !/^-?\d+$/.test(String(args[1] || ''))) return void await send(env, chatId, 'Usage: <code>/admin_coins TELEGRAM_ID AMOUNT</code>');
    const target = await adminByTelegramId(env, args[0]); if (!target) return void await send(env, chatId, '❌ User not found.');
    const amount = Math.max(-100000, Math.min(100000, Number(args[1])));
    await env.DB.prepare('UPDATE users SET coins=MAX(0,coins+?),updated_at=? WHERE id=?').bind(amount, nowIso(), target.id).run();
    return void await send(env, chatId, `✅ Coins adjusted by ${amount}.`);
  }
  if (cmd === '/admin_coupons') return void await send(env, chatId, await adminCouponsText(env), { reply_markup: adminMenuMarkup() });
  if (cmd === '/admin_coupon_create') {
    const [codeRaw, planRaw, daysRaw, maxRaw, expiryRaw, coinsRaw = '0'] = args;
    const code = String(codeRaw || '').toUpperCase(), plan = String(planRaw || '').toLowerCase();
    if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !['starter','pro'].includes(plan) || !/^\d+$/.test(String(daysRaw || '')) || !/^\d+$/.test(String(maxRaw || '')) || !/^-?\d+$/.test(String(coinsRaw))) return void await send(env, chatId, 'Usage: <code>/admin_coupon_create CODE pro 7 100 2026-12-31 0</code>');
    const expiry = parseDateEnd(expiryRaw); if (expiryRaw && !['none','never','-'].includes(String(expiryRaw).toLowerCase()) && !expiry) return void await send(env, chatId, '❌ Invalid expiry date.');
    try {
      await env.DB.prepare(`INSERT INTO coupons(code,plan,bonus_days,bonus_coins,max_uses,uses_count,per_user_limit,expires_at,active,created_at,updated_at) VALUES(?,?,?,?,?,0,1,?,1,?,?)`)
        .bind(code, plan, Number(daysRaw), Math.max(0, Number(coinsRaw)), Number(maxRaw) === 0 ? null : Number(maxRaw), expiry, nowIso(), nowIso()).run();
      return void await send(env, chatId, `✅ Coupon <code>${esc(code)}</code> created.`);
    } catch { return void await send(env, chatId, '❌ Coupon code already exists or data is invalid.'); }
  }
  if (cmd === '/admin_coupon_edit') {
    const code = String(args.shift() || '').toUpperCase(); if (!code) return void await send(env, chatId, 'Usage: <code>/admin_coupon_edit CODE days=14 max=200 active=1</code>');
    const c = await env.DB.prepare('SELECT * FROM coupons WHERE code=?').bind(code).first(); if (!c) return void await send(env, chatId, '❌ Coupon not found.');
    const next = { ...c };
    for (const pair of args) {
      const i = pair.indexOf('='); if (i < 1) continue; const k = pair.slice(0, i).toLowerCase(), v = pair.slice(i + 1);
      if (k === 'days' && /^\d+$/.test(v)) next.bonus_days = Number(v);
      if (k === 'coins' && /^\d+$/.test(v)) next.bonus_coins = Number(v);
      if (k === 'max' && /^\d+$/.test(v)) next.max_uses = Number(v) === 0 ? null : Number(v);
      if (k === 'active' && /^[01]$/.test(v)) next.active = Number(v);
      if (k === 'plan' && ['starter','pro'].includes(v)) next.plan = v;
      if (k === 'expiry') next.expires_at = parseDateEnd(v);
    }
    await env.DB.prepare('UPDATE coupons SET plan=?,bonus_days=?,bonus_coins=?,max_uses=?,expires_at=?,active=?,updated_at=? WHERE id=?').bind(next.plan,next.bonus_days,next.bonus_coins,next.max_uses,next.expires_at,next.active,nowIso(),c.id).run();
    return void await send(env, chatId, `✅ Coupon <code>${esc(code)}</code> updated.`);
  }
  if (cmd === '/admin_coupon_delete') {
    const code = String(args[0] || '').toUpperCase(); if (!code) return void await send(env, chatId, 'Usage: <code>/admin_coupon_delete CODE</code>');
    const r = await env.DB.prepare('DELETE FROM coupons WHERE code=?').bind(code).run(); return void await send(env, chatId, r.meta.changes ? '✅ Coupon deleted.' : 'ℹ️ Coupon not found.');
  }
  if (cmd === '/admin_ads') return void await send(env, chatId, await adminAdsText(env), { reply_markup: adminMenuMarkup() });
  if (cmd === '/admin_ad_create') {
    await setAdminSession(env, user.id, 'ad_create'); return void await send(env, chatId, '➕ <b>Create Ad</b>\n\nSend the ad now as text, image, video, or voice.\nThe media bytes stay on Telegram; only Telegram file_id is saved.');
  }
  if (cmd === '/admin_ad_edit') {
    if (!/^\d+$/.test(String(args[0] || ''))) return void await send(env, chatId, 'Usage: <code>/admin_ad_edit ID</code>');
    const ad = await env.DB.prepare('SELECT id FROM ads WHERE id=?').bind(Number(args[0])).first(); if (!ad) return void await send(env, chatId, '❌ Ad not found.');
    await setAdminSession(env, user.id, 'ad_edit', { id: ad.id }); return void await send(env, chatId, `✏️ Send replacement content for ad #${ad.id} as text, image, video, or voice.`);
  }
  if (cmd === '/admin_ad_buttons') {
    const id = Number(args.shift()); if (!id) return void await send(env, chatId, 'Usage: <code>/admin_ad_buttons ID Label|https://url; More|https://url</code>');
    const buttons = parseButtonsSpec(args.join(' ')); await env.DB.prepare('UPDATE ads SET buttons_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(buttons),nowIso(),id).run(); return void await send(env, chatId, `✅ ${buttons.length} button(s) saved for ad #${id}.`);
  }
  if (['/admin_ad_on','/admin_ad_off','/admin_ad_delete'].includes(cmd)) {
    const id = Number(args[0]); if (!id) return void await send(env, chatId, `Usage: <code>${cmd} ID</code>`);
    if (cmd === '/admin_ad_delete') { await env.DB.prepare('DELETE FROM ads WHERE id=?').bind(id).run(); return void await send(env, chatId, `🗑 Ad #${id} deleted.`); }
    await env.DB.prepare('UPDATE ads SET active=?,updated_at=? WHERE id=?').bind(cmd === '/admin_ad_on' ? 1 : 0,nowIso(),id).run(); return void await send(env, chatId, `${cmd === '/admin_ad_on' ? '🟢 Enabled' : '⚪ Disabled'} ad #${id}.`);
  }
  if (cmd === '/admin_ads_on' || cmd === '/admin_ads_off') { await setAppMeta(env,'ads_enabled',cmd === '/admin_ads_on' ? '1' : '0'); return void await send(env,chatId,cmd === '/admin_ads_on' ? '🟢 Ads globally enabled.' : '⚪ Ads globally disabled.'); }
  if (cmd === '/admin_broadcasts') return void await send(env, chatId, await adminBroadcastsText(env), { reply_markup: adminMenuMarkup() });
  if (cmd === '/admin_broadcast') { await setAdminSession(env,user.id,'broadcast_create'); return void await send(env,chatId,'📢 <b>Create Broadcast</b>\n\nSend text, image, video, or voice. Media stays on Telegram; only file_id is stored.'); }
  if (cmd === '/admin_broadcast_buttons') {
    const id = Number(args.shift()); if (!id) return void await send(env,chatId,'Usage: <code>/admin_broadcast_buttons ID Label|https://url</code>');
    const buttons = parseButtonsSpec(args.join(' ')); await env.DB.prepare('UPDATE broadcasts SET buttons_json=?,updated_at=? WHERE id=?').bind(JSON.stringify(buttons),nowIso(),id).run(); return void await send(env,chatId,`✅ ${buttons.length} button(s) saved for broadcast #${id}.`);
  }
  if (cmd === '/admin_broadcast_send') { const id=Number(args[0]); if(!id)return void await send(env,chatId,'Usage: <code>/admin_broadcast_send ID</code>'); await env.DB.prepare("UPDATE broadcasts SET status='queued',cursor_user_id=0,updated_at=? WHERE id=? AND status='draft'").bind(nowIso(),id).run(); return void await send(env,chatId,`🚀 Broadcast #${id} queued. It will deliver in safe batches.`); }
  if (cmd === '/admin_broadcast_delete') { const id=Number(args[0]); if(!id)return void await send(env,chatId,'Usage: <code>/admin_broadcast_delete ID</code>'); await env.DB.prepare("DELETE FROM broadcasts WHERE id=? AND status='draft'").bind(id).run(); return void await send(env,chatId,`🗑 Draft broadcast #${id} deleted if it existed.`); }
  return false;
}


async function handleCommand(env, msg, user) {
  const chatId = msg.chat.id, text = String(msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/), cmd = rawCmd.toLowerCase().split('@')[0];

  if (cmd === '/claim_admin') {
    const existing = await getAdminTelegramId(env);
    if (existing) return void await send(env, chatId, '🛡 Admin is already configured.');
    if (!env.ADMIN_CLAIM_TOKEN || !args[0] || args[0] !== env.ADMIN_CLAIM_TOKEN) return void await send(env, chatId, '❌ Invalid admin claim token.');
    await setAppMeta(env, 'admin_user_id', String(user.telegram_user_id));
    await setAppMeta(env, 'telegram_profile_version', '');
    await deleteTelegramMessage(env, chatId, msg.message_id);
    await syncBotProfile(env);
    return void await send(env, chatId, `✅ <b>Admin access activated</b>\n\nAdmin commands are now scoped to this private chat only. Use /admin.`);
  }

  if (await handleAdminCommand(env, msg, user, cmd, [...args])) return;

  if (cmd === '/start') {
    let referred = false;
    if (args[0]?.toLowerCase().startsWith('ref_')) referred = await applyReferral(env, user, args[0].slice(4));
    await send(env, chatId, welcome(user.first_name));
    if (referred) await send(env, chatId, `🎁 <b>Referral reward added</b>\n\n🪙 You received ${REFERRAL_NEW_USER_COINS} coins.\nUse /coins to see rewards.`);
    if (!user.timezone_configured) await requireTimezone(env, chatId, user);
    return;
  }
  if (cmd === '/about') return void await send(env, chatId, `🩺 <b>WEB DOCTOR PRO</b>\n<b>Your Website Doctor.</b>\n\nMonitor uptime, domain and certificate expiry, audit SEO/GEO/AEO, verify website ownership, and receive signed PDF reports and automatic Telegram alerts.\n\n📦 v${VERSION}\n👨‍💻 Developer: ${DEVELOPER}\n🔗 ${GITHUB_URL}`);
  if (cmd === '/help') return void await send(env, chatId, `${welcome(user.first_name)}\n\n<b>Commands</b>\n/check example.com — quick check\n/scan example.com — full scan + signed PDF\n/seo example.com — SEO/GEO/AEO\n/performance example.com — PageSpeed\n/ssl example.com — certificate expiry\n/provider example.com — hosting/DNS/registrar\n/links example.com — broken links\n/robots example.com — robots/sitemap/llms.txt\n/keywords example.com — keyword opportunities\n/add example.com — verify + monitor\n/verify example.com — re-check DNS TXT\n/schedule example.com weekly — scheduled reports\n/google — connect your own Google account data\n/plans — plans & Stars\n/invite — referral link\n/coins — coin balance/rewards\n/coupon CODE — redeem coupon\n/list — monitored sites\n/remove example.com — stop monitoring\n/status — bot status\n/settings — settings & usage`);
  if (cmd === '/timezone') {
    const tz = args.join(' '); if (!tz) return void await requireTimezone(env, chatId, user);
    if (!(await setTimezone(env, user.id, tz))) return void await send(env, chatId, '❌ Invalid timezone. Example: <code>/timezone Asia/Kolkata</code>');
    return void await send(env, chatId, `✅ <b>Timezone set</b>\n\n🕒 ${esc(formatInTimezone(nowIso(), tz))}\n🌍 <code>${esc(tz)}</code>`);
  }
  if (cmd === '/time') { if (!(await requireTimezone(env, chatId, user))) return; return void await send(env, chatId, `🕒 <b>Your local time</b>\n\n${esc(formatInTimezone(nowIso(), user.timezone))}`); }
  if (cmd === '/status') return void await send(env, chatId, await statusText(env, user));
  if (cmd === '/settings') return void await send(env, chatId, await settingsText(env, user));
  if (cmd === '/plans' || cmd === '/plan') return void await send(env, chatId, plansText(user), { reply_markup: plansMarkup() });
  if (cmd === '/subscribe') {
    const plan = String(args[0] || '').toLowerCase(); if (!['starter','pro'].includes(plan)) return void await send(env, chatId, 'Usage: <code>/subscribe starter</code> or <code>/subscribe pro</code>', { reply_markup: plansMarkup() });
    return void await sendPlanInvoice(env, chatId, user, plan);
  }
  if (cmd === '/invite') return void await send(env, chatId, await referralText(env, user));
  if (cmd === '/coins') {
    const row = await env.DB.prepare('SELECT coins FROM users WHERE id=?').bind(user.id).first(), coins = Number(row?.coins || 0);
    return void await send(env, chatId, `🪙 <b>Your Coins</b>\n\nBalance: <b>${coins}</b>\n\nRewards\n• 100 coins → +7 Starter days\n• 250 coins → +7 Pro days\n• 600 coins → +30 Pro days\n\nEarn more with /invite.`, { reply_markup: coinsMarkup(coins) });
  }
  if (cmd === '/coupon') return void await redeemCoupon(env, chatId, user, args[0]);

  if (['/check','/scan','/seo','/performance','/ssl','/provider','/links','/robots','/keywords'].includes(cmd)) {
    if (!args[0]) return void await send(env, chatId, `💡 <b>Usage</b>\n<code>${cmd} example.com</code>`);
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    return runTool(env, chatId, user, cmd.slice(1), domain);
  }
  if (cmd === '/add') {
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/add example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    return handleAdd(env, chatId, user, domain);
  }
  if (cmd === '/verify') {
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/verify example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    return handleVerify(env, chatId, user, domain);
  }
  if (cmd === '/schedule') {
    if (!args[0] || !args[1]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/schedule example.com weekly</code>\n\nOptions: daily, weekly, monthly, off');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    return setSchedule(env, chatId, user, domain, args[1].toLowerCase());
  }

  if (cmd === '/google_setup') {
    if (!args[0] || !args[1]) return void await send(env, chatId, `🔗 <b>Connect your own Google project</b>\n\nGoogle requires an OAuth client before account consent can start. WEB DOCTOR PRO does not use the platform owner’s Google credentials.\n\n1. Create a Web OAuth client in your Google Cloud project.\n2. Add this redirect URI exactly:\n<code>${PUBLIC_BASE_URL}/google/callback</code>\n3. Enable Search Console API and Analytics Data API.\n4. Send:\n<code>/google_setup CLIENT_ID CLIENT_SECRET</code>\n\nFor privacy, the bot deletes that setup message after encrypting the credentials.`);
    const clientId = args[0], clientSecret = args[1];
    if (!/\.apps\.googleusercontent\.com$/.test(clientId) || clientSecret.length < 8) return void await send(env, chatId, '❌ The Google OAuth client credentials do not look valid.');
    await saveGoogleUserConfig(env, user.id, clientId, clientSecret);
    await deleteTelegramMessage(env, chatId, msg.message_id);
    return void await send(env, chatId, '✅ <b>Your Google OAuth app is configured</b>\n\nCredentials are encrypted in the bot database. Now use /google to authorize read-only account access.');
  }
  if (cmd === '/google') {
    const conn = await googleConnection(env, user.id).catch(() => null);
    if (conn) return void await send(env, chatId, `🔗 <b>Google account data is connected</b>${conn.email ? `\n👤 ${esc(conn.email)}` : ''}\n\nSearch Console can be matched automatically for verified domains. Analytics is optional and can be mapped with:\n<code>/analytics example.com PROPERTY_ID</code>\n\nDisconnect with /google_disconnect.`);
    const cfg = await googleUserConfig(env, user.id).catch(() => null);
    if (!cfg) return void await send(env, chatId, `🔗 <b>Google connection uses your own OAuth app</b>\n\nWEB DOCTOR PRO does not use the platform owner’s Google API credentials.\n\nFirst run:\n<code>/google_setup CLIENT_ID CLIENT_SECRET</code>\n\nRedirect URI:\n<code>${PUBLIC_BASE_URL}/google/callback</code>`);
    const url = await createGoogleConnectUrl(env, user);
    if (!url) return void await send(env, chatId, '⚠️ Could not create the Google authorization link. Re-run /google_setup.');
    return void await send(env, chatId, `🔗 <b>Connect your Google account</b>\n\nThis requests read-only Search Console and Analytics access for your own account.`, { reply_markup: { inline_keyboard: [[{ text: '🔗 Authorize Google Account', url }]] } });
  }
  if (cmd === '/google_disconnect') {
    await env.DB.batch([env.DB.prepare('DELETE FROM google_connections WHERE user_id=?').bind(user.id), env.DB.prepare('DELETE FROM google_user_configs WHERE user_id=?').bind(user.id)]);
    return void await send(env, chatId, '✅ Google account connection and your stored OAuth app credentials were removed.');
  }
  if (cmd === '/analytics') {
    if (!args[0] || !args[1]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/analytics example.com 123456789</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    if (!/^\d+$/.test(args[1])) return void await send(env, chatId, '❌ Analytics property ID should contain numbers only.');
    const watch = await env.DB.prepare(`SELECT w.id,w.verified_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=? AND w.active=1`).bind(user.id, domain).first();
    if (!watch?.verified_at) return void await send(env, chatId, `🛡 Verify and monitor the domain first with <code>/add ${esc(domain)}</code>.`);
    if (!(await googleConnection(env, user.id))) return void await send(env, chatId, '🔗 Connect your Google account first with /google.');
    await env.DB.prepare('UPDATE watches SET ga_property_id=?,updated_at=? WHERE id=?').bind(args[1], nowIso(), watch.id).run();
    return void await send(env, chatId, `✅ <b>Analytics property mapped</b>\n\n🌐 ${esc(domain)}\n📊 Property ID: <code>${esc(args[1])}</code>\n\nFuture full and scheduled reports will include available read-only Analytics metrics.`);
  }
  if (cmd === '/list') {
    const rows = await env.DB.prepare(`SELECT d.name,d.expires_at,d.ssl_expires_at,w.verified_at,w.uptime_state,w.report_schedule,w.next_report_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.name`).bind(user.id).all();
    if (!rows.results.length) return void await send(env, chatId, '📭 <b>No monitored websites yet</b>\n\nUse <code>/add example.com</code>.');
    const lines = rows.results.map((r,i) => `${i+1}. 🌐 <b>${esc(r.name)}</b>\n   🛡 ${r.verified_at ? 'Verified' : 'Pending'} • ⏱ ${esc(r.uptime_state || 'unknown')}\n   📅 Domain: ${r.expires_at ? esc(expiryLabel(r.expires_at)) : 'Unknown'}\n   🔐 Certificate: ${r.ssl_expires_at ? esc(expiryLabel(r.ssl_expires_at)) : 'Unknown'}\n   📑 Reports: ${esc(r.report_schedule || 'off')}`);
    return void await send(env, chatId, `📋 <b>Monitored Websites</b>\n\n${lines.join('\n\n')}`);
  }
  if (cmd === '/remove') {
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/remove example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    const r = await env.DB.prepare(`UPDATE watches SET active=0,updated_at=? WHERE user_id=? AND domain_id=(SELECT id FROM domains WHERE name=?)`).bind(nowIso(), user.id, domain).run();
    return void await send(env, chatId, r.meta.changes ? `✅ <b>Monitoring stopped</b>\n🌐 ${esc(domain)}` : `ℹ️ <b>${esc(domain)}</b> was not being monitored.`);
  }
  return void await send(env, chatId, '❓ <b>Unknown command</b>\n\nUse /help, or send a domain like <code>example.com</code>.');
}

async function handleCallback(env, q) {
  if (!q?.from || !q?.message) return;
  const user = await upsertUser(env, q.from, q.message.chat.id), data = String(q.data || '');
  if (user.blocked) { await answerCb(env, q.id, 'Account access unavailable.'); return; }
  if (data.startsWith('tz:')) {
    const tz = data.slice(3); if (await setTimezone(env, user.id, tz)) { await answerCb(env, q.id, `Timezone: ${tz}`); return send(env, q.message.chat.id, `✅ <b>Timezone set</b>\n\n🕒 ${esc(formatInTimezone(nowIso(), tz))}`); }
  }
  if (data.startsWith('buyplan:')) {
    const plan = data.slice('buyplan:'.length); await answerCb(env, q.id, 'Opening Telegram Stars payment…');
    if (['starter','pro'].includes(plan)) return sendPlanInvoice(env, q.message.chat.id, user, plan);
    return;
  }
  if (data.startsWith('redeem:')) { await answerCb(env, q.id, 'Redeeming coins…'); return redeemCoins(env, q.message.chat.id, user, data.slice(7)); }
  if (data === 'couponhelp:show') { await answerCb(env, q.id, 'Coupon'); return send(env, q.message.chat.id, '🎟 Redeem a coupon with:\n<code>/coupon YOURCODE</code>'); }

  if (data.startsWith('admin') && await isAdmin(env, user)) {
    await answerCb(env, q.id, 'Admin');
    if (data === 'admin:home' || data === 'admin:stats') return send(env, q.message.chat.id, await adminStatsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:users') { const v = await adminUsersView(env); return send(env, q.message.chat.id, v.text, { reply_markup: v.markup }); }
    if (data === 'admin:coupons') return send(env, q.message.chat.id, await adminCouponsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:ads') return send(env, q.message.chat.id, await adminAdsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:broadcasts') return send(env, q.message.chat.id, await adminBroadcastsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:plans') return send(env, q.message.chat.id, plansText(user), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:adcreate') { await setAdminSession(env,user.id,'ad_create'); return send(env,q.message.chat.id,'➕ <b>Create Ad</b>\n\nSend text, image, video, or voice now.'); }
    if (data === 'admin:broadcastcreate') { await setAdminSession(env,user.id,'broadcast_create'); return send(env,q.message.chat.id,'📢 <b>Create Broadcast</b>\n\nSend text, image, video, or voice now.'); }
    if (data.startsWith('adminuser:')) { const v=await adminUserDetail(env,Number(data.split(':')[1])); return send(env,q.message.chat.id,v.text,{reply_markup:v.markup}); }
    const id = Number(data.split(':')[1]);
    if (data.startsWith('adminblock:')) {
      const target=await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first(); if(target && !(await isAdmin(env,target))) await env.DB.prepare('UPDATE users SET blocked=1,updated_at=? WHERE id=?').bind(nowIso(),id).run();
      const v=await adminUserDetail(env,id); return send(env,q.message.chat.id,v.text,{reply_markup:v.markup});
    }
    if (data.startsWith('adminunblock:')) { await env.DB.prepare('UPDATE users SET blocked=0,updated_at=? WHERE id=?').bind(nowIso(),id).run(); const v=await adminUserDetail(env,id); return send(env,q.message.chat.id,v.text,{reply_markup:v.markup}); }
    if (data.startsWith('admingrantstarter:') || data.startsWith('admingrantpro:')) { const plan=data.startsWith('admingrantpro:')?'pro':'starter'; await extendPlan(env,id,plan,30); const v=await adminUserDetail(env,id); return send(env,q.message.chat.id,v.text,{reply_markup:v.markup}); }
    if (data.startsWith('admincoins100:')) { await env.DB.prepare('UPDATE users SET coins=coins+100,updated_at=? WHERE id=?').bind(nowIso(),id).run(); const v=await adminUserDetail(env,id); return send(env,q.message.chat.id,v.text,{reply_markup:v.markup}); }
    return;
  }

  const idx = data.indexOf(':'); if (idx <= 0) return;
  const action = data.slice(0, idx), domainRaw = data.slice(idx + 1);
  let domain; try { domain = normalizeDomain(domainRaw); } catch { return answerCb(env, q.id, 'Invalid domain'); }
  await answerCb(env, q.id, 'Working…');
  if (action === 'add') return handleAdd(env, q.message.chat.id, user, domain);
  if (action === 'verify') return handleVerify(env, q.message.chat.id, user, domain);
  if (action === 'cancelverify') {
    await env.DB.prepare(`UPDATE domain_verifications SET status='cancelled' WHERE user_id=? AND domain=? AND status='pending'`).bind(user.id, domain).run();
    return send(env, q.message.chat.id, `❌ <b>Verification cancelled</b>\n🌐 ${esc(domain)}`);
  }
  if (action.startsWith('schedule_')) return setSchedule(env, q.message.chat.id, user, domain, action.slice('schedule_'.length));
  if (action === 'statusdomain') return send(env, q.message.chat.id, `✅ <b>${esc(domain)}</b> is verified and monitored.`, { reply_markup: scheduleButtons(domain) });
  if (['check','scan','seo','performance','ssl','provider','links','robots','keywords'].includes(action)) return runTool(env, q.message.chat.id, user, action, domain);
}

async function handleTelegram(env, update) {
  await syncBotProfile(env);
  if (update.pre_checkout_query) return handlePreCheckout(env, update.pre_checkout_query);
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message; if (!msg?.from || !msg?.chat) return;
  let user = await upsertUser(env, msg.from, msg.chat.id);
  if (user.blocked) { await reactToMessage(env,msg,'🚫'); return send(env,msg.chat.id,'🚫 <b>Account access unavailable</b>\n\nPlease contact support if you believe this is a mistake.'); }
  await reactToMessage(env, msg, '👀');
  try {
    if (msg.successful_payment) { await handleSuccessfulPayment(env,msg,user); return; }
    const text = String(msg.text || '').trim();
    if (text.startsWith('/')) { await handleCommand(env, msg, user); await reactToMessage(env,msg,'👍'); return; }
    if (await isAdmin(env,user) && await handleAdminMediaSession(env,msg,user)) { await reactToMessage(env,msg,'👍'); return; }
    try { await runTool(env, msg.chat.id, user, 'check', normalizeDomain(text)); await reactToMessage(env,msg,'👍'); return; }
    catch { await send(env, msg.chat.id, '💡 <b>Send a domain</b>\n\nExample: <code>example.com</code>\n\nUse /help for all tools.'); await reactToMessage(env,msg,'👍'); return; }
  } catch (e) {
    await reactToMessage(env,msg,'⚠️');
    console.error(JSON.stringify({event:'message_failed',error:e.message}));
    try { await send(env,msg.chat.id,'⚠️ <b>Something went wrong</b>\n\nPlease try again.'); } catch { /* ignore */ }
  }
}

async function refreshDomains(env) {
  const now = nowIso();
  const due = await env.DB.prepare(`SELECT * FROM domains WHERE next_check_at IS NULL OR next_check_at<=? ORDER BY COALESCE(next_check_at,'') LIMIT 30`).bind(now).all();
  for (const row of due.results) {
    try { await saveDomain(env, await rdapLookup(row.name)); }
    catch (e) { await env.DB.prepare('UPDATE domains SET last_checked_at=?,next_check_at=?,last_error=? WHERE id=?').bind(now,new Date(Date.now()+3*3600000).toISOString(),short(e.message,500),row.id).run(); }
  }
  const sslDue = await env.DB.prepare(`SELECT * FROM domains WHERE ssl_next_check_at IS NULL OR ssl_next_check_at<=? ORDER BY COALESCE(ssl_next_check_at,'') LIMIT 20`).bind(now).all();
  for (const row of sslDue.results) {
    try {
      const ssl = await sslLookup(row.name);
      await env.DB.prepare('UPDATE domains SET ssl_expires_at=?,ssl_issuer=?,ssl_last_checked_at=?,ssl_next_check_at=? WHERE id=?').bind(ssl.expiresAt,ssl.issuer,now,new Date(Date.now()+24*3600000).toISOString(),row.id).run();
    } catch { await env.DB.prepare('UPDATE domains SET ssl_next_check_at=? WHERE id=?').bind(new Date(Date.now()+6*3600000).toISOString(),row.id).run(); }
  }
}
async function sendExpiryAlerts(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.notify_days,u.chat_id,u.timezone,d.name,d.expires_at,d.ssl_expires_at FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.timezone_configured=1 AND u.blocked=0`).all();
  for (const row of rows.results) {
    let thresholds; try { thresholds = JSON.parse(row.notify_days); } catch { thresholds = ALERT_DAYS; }
    for (const item of [{kind:'domain-expiry',iso:row.expires_at,emoji:'📅',label:'Domain'}, {kind:'ssl-expiry',iso:row.ssl_expires_at,emoji:'🔐',label:'Certificate'}]) {
      const d = daysUntil(item.iso); if (d === null || !thresholds.includes(d)) continue;
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO notifications(watch_id,kind,threshold,expiry_snapshot,sent_at) VALUES(?,?,?,?,?)`).bind(row.watch_id,item.kind,d,item.iso,nowIso()).run();
      if (!inserted.meta.changes) continue;
      try { await send(env,row.chat_id,`🚨 <b>${item.label} Expiry Alert</b>\n\n🌐 <b>${esc(row.name)}</b>\n${item.emoji} ${d===0 ? 'Expires today' : `Expires in ${d} day(s)`}\n🕒 ${esc(formatInTimezone(item.iso,row.timezone))}\n\n💡 Renew or verify it early to avoid interruption.`); }
      catch (e) { console.error(JSON.stringify({event:'expiry_alert_failed',domain:row.name,error:e.message})); }
    }
  }
}
async function checkUptime(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.uptime_state,w.uptime_last_status,w.uptime_fail_count,u.chat_id,u.timezone,d.name FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.blocked=0 ORDER BY COALESCE(w.uptime_last_checked_at,'') LIMIT 80`).all();
  for (const row of rows.results) {
    let status = 0, error = null, state = 'down';
    try {
      const r = await fetch(`https://${row.name}`, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` }, signal: AbortSignal.timeout(10000) });
      status = r.status; state = r.status < 500 ? 'up' : 'down';
    } catch (e) { error = short(e.message, 300); state = 'down'; }
    const previous = row.uptime_state || 'unknown', changed = previous !== 'unknown' && previous !== state;
    const failCount = state === 'down' ? Number(row.uptime_fail_count || 0) + 1 : 0;
    await env.DB.prepare(`UPDATE watches SET uptime_state=?,uptime_last_status=?,uptime_last_checked_at=?,uptime_changed_at=CASE WHEN uptime_state<>? THEN ? ELSE uptime_changed_at END,uptime_last_error=?,uptime_fail_count=?,updated_at=? WHERE id=?`)
      .bind(state,status || null,nowIso(),state,nowIso(),error,failCount,nowIso(),row.watch_id).run();
    if (changed) {
      try {
        if (state === 'down') await send(env,row.chat_id,`🚨 <b>Website Uptime Alert</b>\n\n🌐 <b>${esc(row.name)}</b>\n🔴 Website is currently unavailable or returning a server error.\n📡 Status: ${status || 'Connection failed'}\n🕒 ${esc(formatInTimezone(nowIso(),row.timezone || 'UTC'))}\n\nWEB DOCTOR PRO will keep checking and notify you when it recovers.`);
        else await send(env,row.chat_id,`✅ <b>Website Recovered</b>\n\n🌐 <b>${esc(row.name)}</b>\n🟢 Website is reachable again.\n📡 HTTP ${status}\n🕒 ${esc(formatInTimezone(nowIso(),row.timezone || 'UTC'))}`);
      } catch (e) { console.error(JSON.stringify({event:'uptime_alert_failed',domain:row.name,error:e.message})); }
    }
  }
}
async function sendScheduledReports(env) {
  const due = await env.DB.prepare(`SELECT w.id watch_id,w.report_schedule,w.next_report_at,u.*,d.name FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.blocked=0 AND w.report_schedule<>'off' AND w.next_report_at IS NOT NULL AND w.next_report_at<=? ORDER BY w.next_report_at LIMIT 4`).bind(nowIso()).all();
  for (let row of due.results) {
    try {
      row = await refreshExpiredPlan(env, row);
      const cfg = planConfig(row);
      if (!cfg.schedules.includes(row.report_schedule)) {
        await env.DB.prepare("UPDATE watches SET report_schedule='off',next_report_at=NULL,updated_at=? WHERE id=?").bind(nowIso(),row.watch_id).run();
        await send(env,row.chat_id,`ℹ️ Scheduled ${esc(row.report_schedule)} reports were disabled because they are not included in your current ${cfg.label} plan. Use /plans to compare options.`).catch(() => {});
        continue;
      }
      const usage = await consumeUsage(env, row, { report: true });
      if (!usage.ok) {
        const retry = new Date(Date.now()+6*3600000).toISOString();
        await env.DB.prepare('UPDATE watches SET next_report_at=? WHERE id=?').bind(retry,row.watch_id).run();
        continue;
      }
      await runFullScan(env, row.chat_id, usage.user || row, row.name, { silentProgress: true, scheduled: true });
      await maybeServeAd(env, usage.user || row, row.chat_id).catch(() => null);
      const interval = scheduleIntervalMs(row.report_schedule), next = interval ? new Date(Date.now() + interval).toISOString() : null;
      await env.DB.prepare('UPDATE watches SET last_report_at=?,next_report_at=?,updated_at=? WHERE id=?').bind(nowIso(),next,nowIso(),row.watch_id).run();
    } catch (e) { await env.DB.prepare('UPDATE watches SET next_report_at=? WHERE id=?').bind(new Date(Date.now()+3600000).toISOString(),row.watch_id).run(); }
  }
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error');
  if (error) return new Response(`<html><body><h2>WEB DOCTOR PRO</h2><p>Google connection was cancelled: ${esc(error)}</p><p>You can close this page and return to Telegram.</p></body></html>`, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (!state || !code || !env.GOOGLE_TOKEN_KEY) return new Response('Invalid connection request.', { status: 400 });
  const st = await env.DB.prepare('SELECT * FROM oauth_states WHERE state=? AND expires_at>?').bind(state, nowIso()).first();
  if (!st) return new Response('This connection link is invalid or expired.', { status: 400 });
  const cfg = await googleUserConfig(env, st.user_id);
  if (!cfg) return new Response('Your Google OAuth app configuration is missing. Return to Telegram and run /google_setup.', { status: 400 });
  await env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: `${PUBLIC_BASE_URL}/google/callback`, grant_type: 'authorization_code' })
  });
  if (!tokenRes.ok) return new Response('Google connection failed during token exchange. Check your OAuth client and redirect URI.', { status: 502 });
  const token = await tokenRes.json(); token.expires_at = Date.now() + (token.expires_in || 3600) * 1000;
  let email = null;
  try { const ur = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } }); if (ur.ok) email = (await ur.json()).email || null; } catch { /* ignore */ }
  await saveGoogleTokens(env, st.user_id, token, email);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(st.user_id).first();
  if (user?.chat_id) await send(env, user.chat_id, `✅ <b>Your Google account is connected</b>${email ? `\n👤 ${esc(email)}` : ''}\n\nSearch Console data can now be included automatically for matching verified domains.\n\nAnalytics is optional; map a property with:\n<code>/analytics example.com PROPERTY_ID</code>`).catch(() => {});
  return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WEB DOCTOR PRO</title></head><body style="font-family:system-ui;max-width:620px;margin:60px auto;padding:20px"><h1>WEB DOCTOR PRO</h1><h2>Connection successful</h2><p>Your Google read-only account connection is ready. You can close this page and return to Telegram.</p><p style="color:#666">WEB DOCTOR PRO ${VERSION} · Developer Nadeem</p></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-web-doctor-signature': signature() } });
}

export { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      ctx.waitUntil(syncBotProfile(env));
      const db = await env.DB.prepare('SELECT 1 ok').first();
      return json({ ok: true, service: 'WEB DOCTOR PRO', version: VERSION, database: db?.ok === 1, uptimeMonitor: 'active', reportEngine: 'active', now: nowIso() });
    }
    if (url.pathname === '/google/callback' && request.method === 'GET') return handleGoogleCallback(request, env);
    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      const update = await request.json();
      ctx.waitUntil(handleTelegram(env, update).catch((e) => console.error(JSON.stringify({ event: 'telegram_update_failed', error: e.message }))));
      return new Response('OK', { headers: { 'x-web-doctor-signature': signature() } });
    }
    return json({ service: 'WEB DOCTOR PRO', version: VERSION, status: 'online', developer: DEVELOPER, github: GITHUB_URL, health: '/health' });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await syncBotProfile(env);
      await cleanupTemporaryMessages(env);
      await cleanupCoupons(env);
      await processBroadcasts(env);
      await checkUptime(env);
      await refreshDomains(env);
      await sendExpiryAlerts(env);
      await sendScheduledReports(env);
    })().catch((e) => console.error(JSON.stringify({ event: 'scheduled_failed', error: e.message }))));
  }
};
