import {
  normalizeDomain, parseRdap, daysUntil, formatInTimezone, validTimezone,
  detectDnsProvider, detectHostingProvider, analyzeSeoHtml, analyzeGeoAeo, parseRobots, parseSitemap,
  parseCertSpotter, fallbackKeywords, normalizeTxtRecord, parsePageSpeed, scheduleIntervalMs, buildReportPdf, sitemapSemanticEntries
} from './lib.js';
import { MINI_APP_HTML } from './miniapp.js';

const VERSION = '1.8.1';
const DEVELOPER = 'Nadeem';
const GITHUB_URL = 'https://github.com/nadeemmhdm/webdoctorpro';
const PUBLIC_BASE_URL = 'https://webdoctorpro.nadeemmhdm-ai.workers.dev';
const MINI_APP_URL = `${PUBLIC_BASE_URL}/app?rev=20261015-1`;
const LAST_UPDATED_AT = '2026-10-15T10:05:00+05:30';
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
  pro: { label: 'Pro', stars: 129, dailyScans: 100, dailyReports: 20, maxDomains: 25, schedules: ['daily', 'weekly', 'monthly'], adEvery: 0 },
  team: { label: 'Team', stars: 299, dailyScans: 250, dailyReports: 50, maxDomains: 50, schedules: ['daily', 'weekly', 'monthly'], adEvery: 0 }
});
const SUBSCRIPTION_PERIOD = 2592000;
const TEAM_ACTIVATION_TTL_MS = 24 * 3600000;
const ADMIN_TELEGRAM_ID = '8984229401';
const REFERRAL_REFERRER_COINS = 25;
const REFERRAL_NEW_USER_COINS = 10;
const AD_VISIBLE_MS = 60000;
const BROADCAST_BATCH = 20;
const CHANGE_CHECK_INTERVAL_MS = 15 * 60000;
const UPTIME_CONFIRM_FAILURES = 2;
const MONITOR_RETENTION_DAYS = 90;
const MINI_APP_MAX_AGE_SECONDS = 86400;
const SUBDOMAIN_PAGE_SIZE = 8;
const SUBDOMAIN_DISCOVERY_LIMIT = 80;
const SUBDOMAIN_COMMON_LABELS = Object.freeze(['www','mail','webmail','api','app','blog','shop','store','portal','docs','status','cdn']);

function planRank(plan) { return plan === 'team' ? 3 : plan === 'pro' ? 2 : plan === 'starter' ? 1 : 0; }
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
async function filteredSitesView(env, userId, filter = 'all', team = false) {
  const where = filter === 'verified' ? ' AND w.verified_at IS NOT NULL' : filter === 'pending' ? ' AND w.verified_at IS NULL' : '';
  const rows = await env.DB.prepare(`SELECT d.name,d.expires_at,d.ssl_expires_at,w.verified_at,w.uptime_state,w.report_schedule,w.next_report_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1${where} ORDER BY d.name`).bind(userId).all();
  const title = filter === 'verified' ? '✅ Verified Websites' : filter === 'pending' ? '⏳ Pending Websites' : (team ? '📋 Team Monitored Websites' : '📋 Monitored Websites');
  if (!rows.results.length) return { text: `${title}\n\n${filter === 'verified' ? 'No verified websites yet.' : filter === 'pending' ? 'No pending websites.' : 'No monitored websites yet.'}`, markup: sitesFilterMarkup(filter) };
  const lines = rows.results.map((r,i) => `${i+1}. 🌐 <b>${esc(r.name)}</b>\n   ${r.verified_at ? '✅ Verified' : '⏳ Pending verification'} • ${esc(r.uptime_state || 'unknown')} • reports ${esc(r.report_schedule || 'off')}`);
  return { text: `<b>${title}</b>\n\n${lines.join('\n\n')}`, markup: sitesFilterMarkup(filter) };
}
function sitesFilterMarkup(active = 'all') {
  const mark = (key,label) => ({ text: `${active===key?'• ':''}${label}`, callback_data: `sites:${key}` });
  return { inline_keyboard: [
    [mark('all','🌐 All'), mark('verified','✅ Verified'), mark('pending','⏳ Pending')]
  ] };
}

async function appMeta(env, key) {
  const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key=?').bind(key).first();
  return row?.value ?? null;
}
async function setAppMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO app_meta(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key, String(value), nowIso()).run();
}
async function isAdmin(env, user) {
  return Boolean(user?.telegram_user_id && String(user.telegram_user_id) === ADMIN_TELEGRAM_ID);
}
async function getAdminTelegramId(env) { return ADMIN_TELEGRAM_ID; }

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

async function adminSetExactPlan(env, target, plan, days = 30) {
  if (!target || !PLAN_CONFIG[plan]) throw new Error('Invalid plan target.');
  if (target.subscription_auto_renew && target.subscription_charge_id) {
    try {
      await tg(env, 'editUserStarSubscription', {
        user_id: Number(target.telegram_user_id),
        telegram_payment_charge_id: target.subscription_charge_id,
        is_canceled: true
      });
    } catch { /* manual admin override must still succeed */ }
  }
  if (plan === 'free') {
    await env.DB.prepare(`UPDATE users SET plan='free',plan_expires_at=NULL,subscription_auto_renew=0,subscription_charge_id=NULL,updated_at=? WHERE id=?`)
      .bind(nowIso(), target.id).run();
    await env.DB.prepare('UPDATE team_chats SET active=0,updated_at=? WHERE owner_user_id=? AND active=1').bind(nowIso(), target.id).run();
    return null;
  }
  const expiry = addDays(null, Math.max(1, Math.min(3650, Number(days || 30))));
  await env.DB.prepare(`UPDATE users SET plan=?,plan_expires_at=?,subscription_auto_renew=0,subscription_charge_id=NULL,updated_at=? WHERE id=?`)
    .bind(plan, expiry, nowIso(), target.id).run();
  if (plan === 'team') await syncTeamWorkspaceExpiry(env, target.id, expiry);
  else await env.DB.prepare('UPDATE team_chats SET active=0,updated_at=? WHERE owner_user_id=? AND active=1').bind(nowIso(), target.id).run();
  return expiry;
}

async function createGift(env, targetUserId, coins) {
  const amount = Math.max(1, Math.min(100000, Number(coins || 0)));
  const r = await env.DB.prepare(`INSERT INTO user_gifts(user_id,coins,status,created_by_telegram_id,created_at) VALUES(?,?,'pending',?,?)`)
    .bind(targetUserId, amount, ADMIN_TELEGRAM_ID, nowIso()).run();
  return { id: Number(r.meta?.last_row_id || 0), coins: amount };
}

async function sendPendingGiftBox(env, user, chatId, { force = false } = {}) {
  const gift = await env.DB.prepare(`SELECT * FROM user_gifts WHERE user_id=? AND status='pending' ORDER BY id ASC LIMIT 1`).bind(user.id).first();
  if (!gift) {
    if (force) await send(env, chatId, '🎁 <b>No unopened gifts</b>\n\nYou have no pending gift right now.');
    return false;
  }
  if (!force && gift.notified_at) return false;
  await send(env, chatId, '🎁 <b>You received a gift!</b>\n\nTap the gift box to open it and reveal your coin reward.', {
    reply_markup: { inline_keyboard: [[{ text: '🎁 Open Gift', callback_data: `giftopen:${gift.id}` }]] }
  });
  if (!gift.notified_at) await env.DB.prepare('UPDATE user_gifts SET notified_at=? WHERE id=? AND notified_at IS NULL').bind(nowIso(), gift.id).run();
  return true;
}

async function claimGift(env, q, user, giftId) {
  const gift = await env.DB.prepare('SELECT * FROM user_gifts WHERE id=? AND user_id=?').bind(giftId, user.id).first();
  if (!gift) return answerCb(env, q.id, 'Gift not found.');
  if (gift.status !== 'pending') { await answerCb(env, q.id, 'This gift is already opened.'); return; }
  const claimedAt = nowIso();
  const r = await env.DB.prepare(`UPDATE user_gifts SET status='claimed',claimed_at=? WHERE id=? AND user_id=? AND status='pending'`)
    .bind(claimedAt, gift.id, user.id).run();
  if (!Number(r.meta?.changes || 0)) return answerCb(env, q.id, 'This gift is already opened.');
  await env.DB.prepare('UPDATE users SET coins=coins+?,updated_at=? WHERE id=?').bind(Number(gift.coins), claimedAt, user.id).run();
  const bal = await env.DB.prepare('SELECT coins FROM users WHERE id=?').bind(user.id).first();
  await answerCb(env, q.id, `🎉 +${gift.coins} coins`);
  return edit(env, q.message.chat.id, q.message.message_id, `🎁 <b>Gift opened!</b>\n\n🪙 You received <b>${gift.coins} coins</b>.\n💰 Balance: <b>${Number(bal?.coins || 0)} coins</b>`);
}


function teamCodeFromText(text) {
  const clean = String(text || '').trim().replace(/^\/team_activate(?:@\w+)?\s+/i, '').trim().toUpperCase();
  return /^WDP-TEAM-[A-F0-9]{10}$/.test(clean) ? clean : null;
}
function isTelegramAdminStatus(status) { return status === 'administrator' || status === 'creator'; }
async function isTelegramChatAdmin(env, chatId, userId) {
  try { const m = await tg(env, 'getChatMember', { chat_id: chatId, user_id: Number(userId) }); return isTelegramAdminStatus(m?.status); }
  catch { return false; }
}
async function teamAccessForChat(env, chatId) {
  const workspace = await env.DB.prepare('SELECT * FROM team_chats WHERE chat_id=? AND active=1 AND plan_expires_at>? ORDER BY id DESC LIMIT 1').bind(String(chatId), nowIso()).first();
  if (!workspace) return null;
  const owner = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(workspace.owner_user_id).first();
  if (!owner || owner.blocked || activePlan(owner) !== 'team') {
    await env.DB.prepare('UPDATE team_chats SET active=0,updated_at=? WHERE id=?').bind(nowIso(), workspace.id).run();
    return null;
  }
  return { workspace, owner };
}
async function syncTeamWorkspaceExpiry(env, ownerUserId, expiry) {
  await env.DB.prepare('UPDATE team_chats SET plan_expires_at=?,updated_at=? WHERE owner_user_id=? AND active=1').bind(expiry, nowIso(), ownerUserId).run();
}
async function issueTeamActivationCode(env, userId) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  if (!user || activePlan(user) !== 'team') throw new Error('An active Team plan is required.');
  await env.DB.prepare('DELETE FROM team_activation_codes WHERE user_id=? AND used_at IS NULL').bind(user.id).run();
  const code = `WDP-TEAM-${randomHex(5).toUpperCase()}`;
  const planEnd = user.plan_expires_at ? new Date(user.plan_expires_at).getTime() : Date.now() + TEAM_ACTIVATION_TTL_MS;
  const expiresAt = new Date(Math.min(Date.now() + TEAM_ACTIVATION_TTL_MS, planEnd)).toISOString();
  await env.DB.prepare('INSERT INTO team_activation_codes(user_id,code,expires_at,created_at) VALUES(?,?,?,?)').bind(user.id, code, expiresAt, nowIso()).run();
  return { code, expiresAt };
}
async function pendingTeamActivationCode(env, userId) {
  return env.DB.prepare('SELECT * FROM team_activation_codes WHERE user_id=? AND used_at IS NULL AND expires_at>? ORDER BY id DESC LIMIT 1').bind(userId, nowIso()).first();
}
async function activateTeamWorkspace(env, chat, purchaser, code) {
  if (!chat || !['group','supergroup','channel'].includes(chat.type)) return { ok: false, reason: 'Choose a Telegram group, supergroup or channel.' };
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(purchaser.id).first();
  if (!fresh || activePlan(fresh) !== 'team') return { ok: false, reason: 'Your Team plan is not active.' };
  const row = await env.DB.prepare('SELECT * FROM team_activation_codes WHERE code=?').bind(String(code).toUpperCase()).first();
  if (!row || Number(row.user_id) !== Number(fresh.id)) return { ok: false, reason: 'This activation code does not belong to this purchaser.' };
  if (row.used_at) return { ok: false, reason: 'This activation code has already been used.' };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: 'This activation code expired. Open the bot privately and use /team_code for a new 24-hour code.' };
  const me = await tg(env, 'getMe', {});
  const botIsAdmin = await isTelegramChatAdmin(env, chat.id, me.id);
  if (!botIsAdmin) return { ok: false, reason: 'Make WEB DOCTOR PRO an administrator in this chat first, then try again.' };
  const purchaserIsAdmin = await isTelegramChatAdmin(env, chat.id, fresh.telegram_user_id);
  if (!purchaserIsAdmin) return { ok: false, reason: 'The Team purchaser must also be an administrator of the target chat.' };
  const expiry = fresh.plan_expires_at || addDays(null, 30);
  await env.DB.prepare('UPDATE team_chats SET active=0,updated_at=? WHERE owner_user_id=? AND active=1').bind(nowIso(), fresh.id).run();
  await env.DB.prepare(`INSERT INTO team_chats(chat_id,owner_user_id,chat_type,title,plan_expires_at,active,activated_at,updated_at)
    VALUES(?,?,?,?,?,1,?,?)
    ON CONFLICT(chat_id) DO UPDATE SET owner_user_id=excluded.owner_user_id,chat_type=excluded.chat_type,title=excluded.title,plan_expires_at=excluded.plan_expires_at,active=1,activated_at=excluded.activated_at,updated_at=excluded.updated_at`)
    .bind(String(chat.id), fresh.id, chat.type, chat.title || chat.username || 'Team Workspace', expiry, nowIso(), nowIso()).run();
  await env.DB.prepare('UPDATE team_activation_codes SET used_at=?,used_chat_id=? WHERE id=? AND used_at IS NULL').bind(nowIso(), String(chat.id), row.id).run();
  return { ok: true, expiry, workspaceTitle: chat.title || chat.username || 'Team Workspace' };
}
async function teamAccountView(env, user) {
  const fresh = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const plan = activePlan(fresh);
  const workspace = await env.DB.prepare('SELECT * FROM team_chats WHERE owner_user_id=? AND active=1 ORDER BY id DESC LIMIT 1').bind(fresh.id).first();
  const pending = await pendingTeamActivationCode(env, fresh.id);
  let text = `🏢 <b>Team Workspace</b>\n\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>`;
  if (plan !== 'team') text += '\n\nTeam access is not active. Purchase Team from /plans.';
  else {
    text += `\n📅 Plan until: ${esc(formatInTimezone(fresh.plan_expires_at, fresh.timezone_configured ? fresh.timezone : 'UTC'))}`;
    if (workspace && new Date(workspace.plan_expires_at).getTime() > Date.now()) text += `\n\n✅ <b>Active workspace</b>\n${esc(workspace.title || workspace.chat_id)}\nType: ${esc(workspace.chat_type)}`;
    else text += '\n\n⚪ No active group/channel yet.';
    if (pending) text += `\n\n🔑 24-hour activation code\n<code>${esc(pending.code)}</code>\nExpires: ${esc(formatInTimezone(pending.expires_at, fresh.timezone_configured ? fresh.timezone : 'UTC'))}`;
    text += '\n\n<b>Group / Supergroup</b>\n1. Add this bot and make it admin.\n2. The Team purchaser sends the code in that group.\n3. Only that purchaser can activate it.\n\n<b>Channel</b>\nAdd the bot as admin, then activate privately with:\n<code>/team_activate CODE @channelusername</code>';
  }
  const rows = [];
  if (plan === 'team') rows.push([{ text: '🔑 New 24h Code', callback_data: 'teamcode:new' }]);
  rows.push([{ text: '💎 View Plans', callback_data: 'team:plans' }]);
  return { text, markup: { inline_keyboard: rows } };
}
async function teamWorkspaceStatusText(env, access) {
  const usage = await dailyUsage(env, access.owner), cfg = PLAN_CONFIG.team;
  return `🏢 <b>Team Workspace Active</b>\n\n✅ ${esc(access.workspace.title || access.workspace.chat_id)}\n💎 Team plan\n📅 Until: ${esc(formatInTimezone(access.workspace.plan_expires_at, access.owner.timezone_configured ? access.owner.timezone : 'UTC'))}\n📊 Shared usage today: ${usage.row.scan_count || 0}/${cfg.dailyScans} checks • ${usage.row.report_count || 0}/${cfg.dailyReports} PDFs\n🌐 Shared monitored sites: up to ${cfg.maxDomains}\n📣 Ads: Off`;
}
async function handleTeamChatUpdate(env, msg) {
  const chatId = msg.chat?.id; if (!chatId) return;
  const text = String(msg.text || msg.caption || '').trim();
  const code = teamCodeFromText(text);
  if (code) {
    if (!msg.from?.id) return send(env, chatId, '🔐 For channels, the purchaser must activate from the bot private chat with <code>/team_activate CODE @channelusername</code>.');
    const purchaser = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(msg.from.id)).first();
    if (!purchaser) return send(env, chatId, '❌ Only the Team plan purchaser can activate this code. Open the bot privately first.');
    const result = await activateTeamWorkspace(env, msg.chat, purchaser, code);
    if (!result.ok) return send(env, chatId, `❌ <b>Team activation failed</b>\n\n${esc(result.reason)}`);
    return send(env, chatId, `🎉 <b>Team plan activated for this chat</b>\n\n🏢 ${esc(result.workspaceTitle)}\n💎 Shared Team features are now available.\n📅 Access until: ${esc(formatInTimezone(result.expiry, purchaser.timezone_configured ? purchaser.timezone : 'UTC'))}\n\nUse /team_status or send a domain.`);
  }
  const access = await teamAccessForChat(env, chatId);
  if (!access) {
    if (/^\/(team|team_status|plans)(?:@\w+)?\b/i.test(text)) return send(env, chatId, '🏢 <b>Team plan is not active in this chat</b>\n\nThe Team purchaser should add the bot as admin and send their 24-hour activation code here.');
    return;
  }
  if (!text) return;
  const [rawCmd, ...args] = text.split(/\s+/), cmd = rawCmd.toLowerCase().split('@')[0];
  if (cmd === '/team' || cmd === '/team_status' || cmd === '/status') return send(env, chatId, await teamWorkspaceStatusText(env, access));
  if (cmd === '/help') return send(env, chatId, '🏢 <b>Team commands</b>\n\n/check domain\n/scan domain\n/seo domain\n/performance domain\n/ssl domain\n/provider domain\n/links domain\n/robots domain\n/keywords domain\n/mail domain\
/subdomains domain [page]\n/add domain\n/verify domain\n/schedule domain weekly\n/score domain\n/compare domain\n/fix domain\n/emergency domain\n/list\n/remove domain\n/team_status\n\nTeam usage, verified sites and limits are shared through the purchaser account.');
  if (cmd === '/plans') return send(env, chatId, plansText(access.owner));
  if (['/score','/compare','/fix','/emergency'].includes(cmd)) { if(!args[0]) return send(env,chatId,`💡 Usage: <code>${cmd} example.com</code>`); let domain; try{domain=normalizeDomain(args[0]);}catch{return send(env,chatId,'❌ Invalid domain.');} if(cmd==='/score') return send(env,chatId,await healthScoreText(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); if(cmd==='/compare') return send(env,chatId,await compareText(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); if(cmd==='/fix') return send(env,chatId,await fixesText(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); return send(env,chatId,await emergencyDoctor(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); }
  if (cmd === '/subdomains') {
    if (!args[0]) return send(env, chatId, '💡 Usage: <code>/subdomains example.com [page]</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    const page = Math.max(1, Math.min(10, Number(args[1] || 1) || 1));
    return runSubdomainDoctor(env, chatId, access.owner, domain, page);
  }
  const toolMap = { '/check':'check','/scan':'scan','/seo':'seo','/performance':'performance','/ssl':'ssl','/provider':'provider','/links':'links','/robots':'robots','/keywords':'keywords','/mail':'mail','/main':'mail' };
  if (toolMap[cmd]) {
    if (!args[0]) return send(env, chatId, '💡 Add a domain after the command. Example: <code>/check example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    return runTool(env, chatId, access.owner, toolMap[cmd], domain);
  }
  if (cmd === '/add' || cmd === '/verify') {
    if (!args[0]) return send(env, chatId, `💡 Usage: <code>${cmd} example.com</code>`);
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    return cmd === '/add' ? handleAdd(env, chatId, access.owner, domain) : handleVerify(env, chatId, access.owner, domain);
  }
  if (cmd === '/schedule') {
    if (!args[0] || !args[1]) return send(env, chatId, '💡 Usage: <code>/schedule example.com weekly</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    return setSchedule(env, chatId, access.owner, domain, args[1].toLowerCase());
  }
  if (['/verified','/pending','/pwnding'].includes(cmd)) {
    const filter = cmd === '/verified' ? 'verified' : 'pending';
    const v = await filteredSitesView(env, access.owner.id, filter, true);
    return send(env, chatId, v.text, { reply_markup: v.markup });
  }
  if (cmd === '/list') {
    const rows = await env.DB.prepare(`SELECT d.name,w.verified_at,w.uptime_state,w.report_schedule FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.name`).bind(access.owner.id).all();
    const lines = rows.results.map((r,i) => `${i+1}. 🌐 <b>${esc(r.name)}</b> • ${r.verified_at ? '✅ verified' : '⏳ pending'} • ${esc(r.uptime_state || 'unknown')} • reports ${esc(r.report_schedule || 'off')}`);
    return send(env, chatId, lines.length ? `📋 <b>Team Monitored Websites</b>\n\n${lines.join('\n')}` : '📭 No Team websites are monitored yet.');
  }
  if (cmd === '/remove') {
    if (!msg.from?.id || !(await isTelegramChatAdmin(env, chatId, msg.from.id))) return send(env, chatId, '🔒 Only a chat administrator can remove a Team-monitored site.');
    if (!args[0]) return send(env, chatId, '💡 Usage: <code>/remove example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    const r = await env.DB.prepare(`UPDATE watches SET active=0,updated_at=? WHERE user_id=? AND domain_id=(SELECT id FROM domains WHERE name=?)`).bind(nowIso(), access.owner.id, domain).run();
    return send(env, chatId, r.meta.changes ? `✅ Monitoring stopped for <b>${esc(domain)}</b>.` : `ℹ️ ${esc(domain)} was not being monitored.`);
  }
  if (!text.startsWith('/')) {
    let domain; try { domain = normalizeDomain(text); } catch { return; }
    return runTool(env, chatId, access.owner, 'check', domain);
  }
}


function clamp100(v) { return Math.max(0, Math.min(100, Math.round(Number(v) || 0))); }
function expiryScore(iso) {
  const d = daysUntil(iso);
  if (d === null) return 50;
  if (d <= 0) return 0;
  if (d <= 3) return 20;
  if (d <= 7) return 40;
  if (d <= 30) return 70;
  if (d <= 90) return 90;
  return 100;
}
function safeJson(value, fallback = null) { try { return JSON.parse(value); } catch { return fallback; } }
function stableValues(values = []) { return [...new Set((values || []).map((x) => String(x).trim()).filter(Boolean))].sort(); }
async function sha256Text(value) {
  const bytes = new TextEncoder().encode(String(value ?? ''));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function watchForDomain(env, userId, domain) {
  return env.DB.prepare(`SELECT w.*,d.expires_at,d.ssl_expires_at,d.registrar,d.hosting_provider,d.dns_provider FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=? AND w.active=1`).bind(userId, domain).first();
}
async function availabilityStats(env, watchId, days = 30) {
  if (!watchId) return { score: 100, uptime: 100, samples: 0, incidents: 0 };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const [samples, incidents] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) total,SUM(CASE WHEN state='up' THEN 1 ELSE 0 END) up_count FROM uptime_samples WHERE watch_id=? AND checked_at>=?`).bind(watchId, since).first(),
    env.DB.prepare(`SELECT COUNT(*) count FROM uptime_incidents WHERE watch_id=? AND started_at>=?`).bind(watchId, since).first()
  ]);
  const total = Number(samples?.total || 0), up = Number(samples?.up_count || 0);
  const uptime = total ? Math.max(0, Math.min(100, up * 100 / total)) : 100;
  return { score: clamp100(uptime), uptime, samples: total, incidents: Number(incidents?.count || 0) };
}
function securityHealthScore(report) {
  const h = Object.fromEntries(Object.entries(report?.snap?.page?.headers || {}).map(([k,v]) => [String(k).toLowerCase(), String(v)]));
  let score = 30;
  if (String(report?.snap?.page?.url || '').startsWith('https://')) score += 25;
  if (h['strict-transport-security']) score += 15;
  if (h['content-security-policy']) score += 10;
  if (h['x-content-type-options']) score += 8;
  if (h['referrer-policy']) score += 6;
  if (h['permissions-policy']) score += 6;
  return clamp100(score);
}
function dnsHealthScore(report) {
  const ns = report?.snap?.nsRecords || [];
  const a = report?.dnsHealth?.a || [];
  const aaaa = report?.dnsHealth?.aaaa || [];
  const mx = report?.dnsHealth?.mx || [];
  let score = 0;
  if (ns.length) score += 35;
  if (a.length || aaaa.length) score += 45;
  if (mx.length) score += 20;
  return clamp100(score);
}
function buildTopFixes(report, metrics) {
  const fixes = [];
  const add = (severity, text) => { if (text && !fixes.some((x) => x.text === text)) fixes.push({ severity, text }); };
  const sslDays = daysUntil(report?.ssl?.expiresAt), domainDays = daysUntil(report?.rdap?.expiresAt);
  if (sslDays !== null && sslDays <= 7) add('high', `Renew the TLS certificate — ${sslDays <= 0 ? 'expired' : `${sslDays} day(s) remaining`}.`);
  if (domainDays !== null && domainDays <= 30) add('high', `Renew the domain early — ${domainDays <= 0 ? 'expired' : `${domainDays} day(s) remaining`}.`);
  if ((report?.pageSpeed?.performance ?? 100) < 70) add('medium', `Improve mobile performance — current score ${report.pageSpeed.performance}/100.`);
  if ((report?.links?.broken?.length || 0) > 0) add('medium', `Fix ${report.links.broken.length} broken/problem internal link(s).`);
  if (!report?.robots?.exists) add('medium', 'Add a valid robots.txt file.');
  if (!report?.sitemap?.exists) add('medium', 'Publish and reference an XML sitemap.');
  const highSeo = (report?.seo?.issues || []).find((x) => x.severity === 'high');
  if (highSeo) add('high', highSeo.issue);
  if ((metrics?.securityScore || 100) < 70) add('medium', 'Strengthen HTTP security headers such as HSTS and Content-Security-Policy.');
  if ((metrics?.availabilityScore || 100) < 99) add('high', `Investigate recent availability; measured uptime is ${Number(report?.availability?.uptime || 0).toFixed(2)}%.`);
  if (!fixes.length) add('low', 'No critical issue detected. Keep monitoring and review performance/SEO trends regularly.');
  const rank = { high: 0, medium: 1, low: 2 };
  return fixes.sort((a,b) => rank[a.severity] - rank[b.severity]).slice(0, 3);
}
function comparisonArrow(oldValue, newValue, lowerIsBetter = false) {
  oldValue = Number(oldValue); newValue = Number(newValue);
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue) || oldValue === newValue) return '→';
  const better = lowerIsBetter ? newValue < oldValue : newValue > oldValue;
  return better ? '↑' : '↓';
}
async function enrichHealthReport(env, user, report) {
  const watch = await watchForDomain(env, user.id, report.domain);
  const [a, aaaa, mx, availability, previous] = await Promise.all([
    dnsLookup(report.domain, 'A'), dnsLookup(report.domain, 'AAAA'), dnsLookup(report.domain, 'MX'),
    availabilityStats(env, watch?.id, 30),
    env.DB.prepare(`SELECT * FROM scan_history WHERE user_id=? AND domain=? ORDER BY scanned_at DESC LIMIT 1`).bind(user.id, report.domain).first()
  ]);
  report.dnsHealth = { a: stableValues(a), aaaa: stableValues(aaaa), mx: stableValues(mx) };
  report.availability = availability;
  const metrics = {
    domainScore: expiryScore(report?.rdap?.expiresAt),
    sslScore: expiryScore(report?.ssl?.expiresAt),
    securityScore: securityHealthScore(report),
    seoScore: clamp100(report?.seo?.score ?? 50),
    performanceScore: clamp100(report?.pageSpeed?.performance ?? 50),
    dnsScore: 0,
    availabilityScore: availability.score
  };
  metrics.dnsScore = dnsHealthScore(report);
  metrics.healthScore = clamp100(metrics.domainScore * .10 + metrics.sslScore * .15 + metrics.securityScore * .15 + metrics.seoScore * .20 + metrics.performanceScore * .20 + metrics.dnsScore * .10 + metrics.availabilityScore * .10);
  const fixes = buildTopFixes(report, metrics);
  report.health = metrics;
  report.topFixes = fixes;
  report.previousScan = previous || null;
  report.comparison = previous ? {
    performance: [Number(previous.performance_score), metrics.performanceScore],
    seo: [Number(previous.seo_score), metrics.seoScore],
    brokenLinks: [Number(previous.broken_links), Number(report?.links?.broken?.length || 0)],
    health: [Number(previous.health_score), metrics.healthScore],
    availability: [Number(previous.availability_score), metrics.availabilityScore],
    loadMs: [previous.load_ms == null ? null : Number(previous.load_ms), report?.pageSpeed?.lcpMs == null ? null : Number(report.pageSpeed.lcpMs)]
  } : null;
  const metricsJson = JSON.stringify({ ...metrics, sslExpiry: report?.ssl?.expiresAt || null, domainExpiry: report?.rdap?.expiresAt || null });
  await env.DB.prepare(`INSERT INTO scan_history(watch_id,user_id,domain,scanned_at,health_score,domain_score,ssl_score,security_score,seo_score,performance_score,dns_score,availability_score,broken_links,load_ms,fixes_json,metrics_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(watch?.id || null,user.id,report.domain,nowIso(),metrics.healthScore,metrics.domainScore,metrics.sslScore,metrics.securityScore,metrics.seoScore,metrics.performanceScore,metrics.dnsScore,metrics.availabilityScore,Number(report?.links?.broken?.length || 0),report?.pageSpeed?.lcpMs ?? null,JSON.stringify(fixes),metricsJson).run();
  if (watch?.id) await env.DB.prepare('UPDATE watches SET last_health_score=?,last_health_at=?,updated_at=? WHERE id=?').bind(metrics.healthScore,nowIso(),nowIso(),watch.id).run();
  return report;
}
function healthActionButtons(domain) {
  return { inline_keyboard: [
    [{ text: '❤️ Health Score', callback_data: `score:${domain}` }, { text: '📈 Compare', callback_data: `compare:${domain}` }],
    [{ text: '🧠 What Should I Fix?', callback_data: `fix:${domain}` }, { text: '🆘 Emergency Doctor', callback_data: `emergency:${domain}` }],
    [{ text: '🔄 Recheck', callback_data: `scan:${domain}` }, { text: '🗓 Report Schedule', callback_data: `schedule_weekly:${domain}` }]
  ] };
}
async function latestScanHistory(env, userId, domain, limit = 2) {
  const r = await env.DB.prepare(`SELECT * FROM scan_history WHERE user_id=? AND domain=? ORDER BY scanned_at DESC LIMIT ?`).bind(userId,domain,limit).all();
  return r.results || [];
}
async function healthScoreText(env, user, domain) {
  const rows = await latestScanHistory(env,user.id,domain,1);
  if (!rows.length) return `❤️ <b>No health score yet</b>\n\n🌐 ${esc(domain)}\nRun <code>/scan ${esc(domain)}</code> first.`;
  const x=rows[0];
  return `❤️ <b>WEB DOCTOR SCORE: ${x.health_score}/100 ${x.health_score>=85?'🟢':x.health_score>=70?'🟡':x.health_score>=50?'🟠':'🔴'}</b>\n\n🌐 <b>${esc(domain)}</b>\n📅 Domain — ${x.domain_score}/100\n🔐 SSL — ${x.ssl_score}/100\n🛡 Security — ${x.security_score}/100\n📈 SEO — ${x.seo_score}/100\n⚡ Performance — ${x.performance_score}/100\n🧭 DNS — ${x.dns_score}/100\n⏱ Availability — ${x.availability_score}/100\n\n🕒 ${esc(formatInTimezone(x.scanned_at,user.timezone_configured?user.timezone:'UTC'))}`;
}
async function compareText(env, user, domain) {
  const rows = await latestScanHistory(env,user.id,domain,2);
  if (rows.length < 2) return `📈 <b>Not enough scan history</b>\n\nRun <code>/scan ${esc(domain)}</code> at least twice to compare changes.`;
  const [n,o]=rows;
  const line=(label,a,b,lower=false,suffix='')=>`${label}: <b>${a}${suffix} → ${b}${suffix}</b> ${comparisonArrow(a,b,lower)}`;
  const sslOld=safeJson(o.metrics_json,{})?.sslExpiry||null, sslNew=safeJson(n.metrics_json,{})?.sslExpiry||null;
  return `📈 <b>Since Last Scan — ${esc(domain)}</b>\n\n${line('❤️ Health',o.health_score,n.health_score)}\n${line('⚡ Performance',o.performance_score,n.performance_score)}\n${line('📈 SEO',o.seo_score,n.seo_score)}\n${line('🔗 Broken links',o.broken_links,n.broken_links,true)}\n${line('⏱ Availability',o.availability_score,n.availability_score)}\n⚡ LCP: <b>${o.load_ms ?? 'N/A'}ms → ${n.load_ms ?? 'N/A'}ms</b>\n🔐 SSL: <b>${sslOld===sslNew?'No change':'Changed'}</b>\n\n🕒 Latest: ${esc(formatInTimezone(n.scanned_at,user.timezone_configured?user.timezone:'UTC'))}`;
}
async function fixesText(env, user, domain) {
  const rows = await latestScanHistory(env,user.id,domain,1);
  if (!rows.length) return `🧠 <b>No scan findings yet</b>\n\nRun <code>/scan ${esc(domain)}</code> first.`;
  const fixes=safeJson(rows[0].fixes_json,[])||[];
  const icons={high:'🔴',medium:'🟡',low:'🟢'};
  return `🧠 <b>What Should I Fix? — ${esc(domain)}</b>\n\n${fixes.slice(0,3).map((x,i)=>`${i+1}. ${icons[x.severity]||'•'} ${esc(x.text)}`).join('\n')}\n\nStart with item 1, then tap <b>Recheck</b> after the change.`;
}
async function emergencyDoctor(env, user, domain) {
  if (!(await isVerified(env,user.id,domain))) return `🛡 <b>Ownership verification required</b>\n\nEmergency diagnostics are available for verified monitored websites. Use <code>/add ${esc(domain)}</code>.`;
  const [a,aaaa,ns,mx,ssl] = await Promise.all([
    dnsLookup(domain,'A'),dnsLookup(domain,'AAAA'),dnsLookup(domain,'NS'),dnsLookup(domain,'MX'),sslLookup(domain).catch(()=>({expiresAt:null,issuer:null}))
  ]);
  let httpStatus=0, finalUrl=`https://${domain}`, headers={}, latency=null, httpError=null;
  const started=Date.now();
  try { const p=await fetchText(`https://${domain}`,120000,{signal:AbortSignal.timeout(10000)}); httpStatus=p.status; finalUrl=p.url; headers=p.headers; latency=Date.now()-started; }
  catch(e){ httpError=short(e.message,160); latency=Date.now()-started; }
  const hosting=detectHostingProvider({headers,cnames:await dnsLookup(domain,'CNAME')});
  const dnsProvider=detectDnsProvider(ns);
  let cause='No active outage detected', confidence=95;
  if (!a.length && !aaaa.length) { cause='DNS address records are missing or not resolving'; confidence=97; }
  else if (httpStatus===530) { cause='DNS / origin configuration problem'; confidence=91; }
  else if (!httpStatus) { cause='Network/origin connection failure'; confidence=88; }
  else if (httpStatus>=500 && /cloudflare/i.test(hosting)) { cause='Origin server or CDN-to-origin failure'; confidence=86; }
  else if (httpStatus>=500) { cause='Origin/server application failure'; confidence=87; }
  else if (!ssl.expiresAt) { cause='Certificate/TLS publication issue'; confidence=78; }
  const originNote=/cloudflare|vercel|netlify|cloudfront/i.test(hosting)?'Origin is shielded by CDN/proxy; direct origin cannot be safely inferred.':'Origin appears directly exposed by the current response.';
  return `🆘 <b>Emergency Website Doctor — ${esc(domain)}</b>\n\n1. 🧭 DNS: ${a.length||aaaa.length?'✅ Resolving':'🔴 Failed'}\n2. 📡 HTTP: ${httpStatus?`HTTP ${httpStatus}`:'Connection failed'}\n3. 🔐 SSL: ${ssl.expiresAt?'✅ Certificate found':'⚠️ Certificate not confirmed'}\n4. ↪️ Redirect/final URL: ${esc(short(finalUrl,120))}\n5. ☁️ CDN/Hosting: ${esc(hosting)}\n6. 🌐 Nameservers: ${ns.length?'✅ '+esc(short(ns.join(', '),150)):'🔴 Missing'}\n7. 🏷 DNS provider: ${esc(dnsProvider)}\n8. 🖥 Server response: ${httpStatus&&httpStatus<500?'✅ Responding':'🔴 Problem detected'}${latency!=null?` • ${latency}ms`:''}\n\n<b>Likely cause:</b> ${esc(cause)}\n<b>Confidence:</b> ${confidence}%\n\n💡 ${esc(originNote)}${httpError?`\nTechnical signal: ${esc(httpError)}`:''}`;
}
async function captureChangeSnapshot(env, domain) {
  const [ns,a,aaaa,mx,cname,rdap,ssl,page,robots,sitemap] = await Promise.all([
    dnsLookup(domain,'NS'),dnsLookup(domain,'A'),dnsLookup(domain,'AAAA'),dnsLookup(domain,'MX'),dnsLookup(domain,'CNAME'),
    rdapLookup(domain).catch(()=>({})),sslLookup(domain).catch(()=>({expiresAt:null,issuer:null})),
    fetchText(`https://${domain}`,250000,{signal:AbortSignal.timeout(10000)}).catch(()=>null),
    fetchText(`https://${domain}/robots.txt`,120000,{signal:AbortSignal.timeout(8000)}).catch(()=>null),
    fetchText(`https://${domain}/sitemap.xml`,200000,{signal:AbortSignal.timeout(8000)}).catch(()=>null)
  ]);
  if (!page) return null;
  const seo=analyzeSeoHtml(page.text,page.url||`https://${domain}`);
  const sitemapState = sitemap && sitemap.status < 400
    ? sitemapSemanticEntries(sitemap.text, `https://${domain}/sitemap.xml`)
    : { valid:false, type:'missing', entries:[] };
  const sitemapSemanticHash = sitemapState.valid ? await sha256Text(JSON.stringify(sitemapState.entries)) : '';
  return {
    ns:stableValues(ns),a:stableValues(a),aaaa:stableValues(aaaa),mx:stableValues(mx),
    ssl:`${ssl.issuer||''}|${ssl.expiresAt||''}`,registrar:rdap.registrar||'',domainExpiry:rdap.expiresAt||'',
    robotsHash:robots?await sha256Text(robots.text):'',robotsExists:Boolean(robots&&robots.status<400),
    sitemapHash:sitemapSemanticHash,sitemapSemanticHash,sitemapSemanticVersion:1,sitemapEntryCount:sitemapState.entries.length,sitemapType:sitemapState.type,sitemapExists:Boolean(sitemapState.valid),
    title:seo.title||'',description:seo.description||'',hostingProvider:detectHostingProvider({headers:page.headers,cnames:cname}),dnsProvider:detectDnsProvider(ns)
  };
}
function stabilizeChangeSnapshot(oldSnap,newSnap){
  const stable={...newSnap};
  for(const key of ['registrar','domainExpiry']) if(!stable[key] && oldSnap?.[key]) stable[key]=oldSnap[key];
  return stable;
}
function snapshotChangeList(oldSnap,newSnap){
  const out=[]; const add=(kind,label,a,b)=>out.push({kind,label,oldValue:String(a??''),newValue:String(b??'')});
  const norm=(x)=>String(x||'').trim().replace(/\s+/g,' ').toLowerCase();
  const j=(x)=>JSON.stringify(x||[]);
  const dynamicEdgeProviders=new Set(['Vercel','Cloudflare','Netlify','GitHub Pages']);
  const sameEdgeProvider=Boolean(oldSnap.hostingProvider && oldSnap.hostingProvider===newSnap.hostingProvider && dynamicEdgeProviders.has(newSnap.hostingProvider));
  const sameDnsContext=j(oldSnap.ns)===j(newSnap.ns) && oldSnap.dnsProvider===newSnap.dnsProvider;
  const suppressEdgeIpRotation=sameEdgeProvider && sameDnsContext;
  if(j(oldSnap.ns)!==j(newSnap.ns)) add('nameserver','Nameserver changed',oldSnap.ns?.join(', '),newSnap.ns?.join(', '));
  if(j(oldSnap.a)!==j(newSnap.a) && !suppressEdgeIpRotation) add('a-record','A record changed',oldSnap.a?.join(', '),newSnap.a?.join(', '));
  if(j(oldSnap.aaaa)!==j(newSnap.aaaa) && !suppressEdgeIpRotation) add('aaaa-record','AAAA record changed',oldSnap.aaaa?.join(', '),newSnap.aaaa?.join(', '));
  if(j(oldSnap.mx)!==j(newSnap.mx)) add('mx-record','MX record changed',oldSnap.mx?.join(', '),newSnap.mx?.join(', '));
  if(oldSnap.ssl!==newSnap.ssl) add('ssl','SSL certificate changed',oldSnap.ssl,newSnap.ssl);
  if(oldSnap.registrar && newSnap.registrar && norm(oldSnap.registrar)!==norm(newSnap.registrar)) add('registrar','Registrar changed',oldSnap.registrar,newSnap.registrar);
  if(oldSnap.domainExpiry && newSnap.domainExpiry && oldSnap.domainExpiry!==newSnap.domainExpiry) add('domain-expiry','Domain expiry date changed',oldSnap.domainExpiry,newSnap.domainExpiry);
  if(oldSnap.robotsHash!==newSnap.robotsHash) add('robots','robots.txt changed',oldSnap.robotsHash?'Previous version':'Missing',newSnap.robotsHash?'New version':'Missing');
  const sitemapComparable=Number(oldSnap.sitemapSemanticVersion||0)>=1 && Number(newSnap.sitemapSemanticVersion||0)>=1;
  if(sitemapComparable){
    if(oldSnap.sitemapExists && !newSnap.sitemapExists) add('sitemap','Sitemap disappeared','Available','Missing');
    else if(!oldSnap.sitemapExists && newSnap.sitemapExists) add('sitemap','Sitemap appeared','Missing','Available');
    else if(oldSnap.sitemapExists && newSnap.sitemapExists && oldSnap.sitemapSemanticHash!==newSnap.sitemapSemanticHash){
      const oldCount=Number(oldSnap.sitemapEntryCount||0),newCount=Number(newSnap.sitemapEntryCount||0);
      add('sitemap','Sitemap URL entries changed',`${oldCount} entr${oldCount===1?'y':'ies'} — previous set`,`${newCount} entr${newCount===1?'y':'ies'} — new set`);
    }
  }
  if(oldSnap.title!==newSnap.title) add('title','Homepage title changed',oldSnap.title,newSnap.title);
  if(oldSnap.description!==newSnap.description) add('meta','Homepage meta description changed',oldSnap.description,newSnap.description);
  if(oldSnap.hostingProvider!==newSnap.hostingProvider) add('hosting','Hosting/CDN changed',oldSnap.hostingProvider,newSnap.hostingProvider);
  if(oldSnap.dnsProvider!==newSnap.dnsProvider) add('dns-provider','DNS provider changed',oldSnap.dnsProvider,newSnap.dnsProvider);
  return out;
}
function sitemapStateSignature(snap){
  return `${snap?.sitemapExists?'1':'0'}:${snap?.sitemapSemanticHash||''}:${snap?.sitemapType||''}`;
}
async function confirmSitemapChanges(env,watchId,oldSnap,newSnap,changes){
  const key=`sitemap_pending:${watchId}`;
  const sitemapChanges=changes.filter((c)=>c.kind==='sitemap');
  if(!sitemapChanges.length){
    await env.DB.prepare('DELETE FROM app_meta WHERE key=?').bind(key).run().catch(()=>{});
    return {changes,snapshot:newSnap,confirmed:false};
  }
  const baseline=sitemapStateSignature(oldSnap),candidate=sitemapStateSignature(newSnap);
  let pending=null;
  try { pending=JSON.parse((await appMeta(env,key))||'null'); } catch { pending=null; }
  if(pending?.baseline===baseline && pending?.candidate===candidate){
    await env.DB.prepare('DELETE FROM app_meta WHERE key=?').bind(key).run().catch(()=>{});
    return {changes,snapshot:newSnap,confirmed:true};
  }
  await setAppMeta(env,key,JSON.stringify({baseline,candidate,firstSeenAt:nowIso()}));
  const stable={...newSnap};
  for(const field of ['sitemapHash','sitemapSemanticHash','sitemapSemanticVersion','sitemapEntryCount','sitemapType','sitemapExists']){
    if(Object.prototype.hasOwnProperty.call(oldSnap,field)) stable[field]=oldSnap[field];
    else delete stable[field];
  }
  return {changes:changes.filter((c)=>c.kind!=='sitemap'),snapshot:stable,confirmed:false};
}
async function smtpConfig(env) {
  const row=await env.DB.prepare('SELECT * FROM smtp_config WHERE id=1 AND active=1').first();
  if(!row) return null;
  try { return {...row,appPassword:await decryptGoogle(env,row.app_password_cipher)}; } catch { return null; }
}
function utf8B64(value){ return b64FromBytes(new TextEncoder().encode(String(value))); }
function wrapB64(value){ return String(value).match(/.{1,76}/g)?.join('\r\n') || ''; }
async function smtpReadResponse(reader,state){
  while(true){
    const lines=state.buffer.split('\r\n');
    for(let i=0;i<lines.length-1;i++) if(/^\d{3} /.test(lines[i])) { const consumed=lines.slice(0,i+1).join('\r\n')+'\r\n'; const out=state.buffer.slice(0,consumed.length); state.buffer=state.buffer.slice(consumed.length); return out; }
    const {value,done}=await reader.read(); if(done) throw new Error('SMTP connection closed unexpectedly.'); state.buffer+=new TextDecoder().decode(value,{stream:true}); if(state.buffer.length>50000) throw new Error('SMTP response too large.');
  }
}
function smtpCode(text){ return Number(String(text).match(/^(\d{3})/m)?.[1]||0); }
async function smtpSendWithCreds(sender,appPassword,{to,subject,text,pdfBytes=null,pdfName=null}){
  const { connect } = await import('cloudflare:sockets'); const socket=connect({hostname:'smtp.gmail.com',port:465},{secureTransport:'on'}); await socket.opened;
  const reader=socket.readable.getReader(), writer=socket.writable.getWriter(), state={buffer:''};
  const write=async(line)=>writer.write(new TextEncoder().encode(line+'\r\n'));
  const expect=async(codes)=>{const r=await smtpReadResponse(reader,state),c=smtpCode(r); if(!codes.includes(c)) throw new Error(`SMTP ${c||'error'}: ${short(r.replace(/\s+/g,' '),180)}`); return r;};
  try {
    await expect([220]); await write('EHLO webdoctorpro'); await expect([250]); await write('AUTH LOGIN'); await expect([334]);
    await write(btoa(sender)); await expect([334]); await write(btoa(String(appPassword).replace(/\s+/g,''))); await expect([235]);
    await write(`MAIL FROM:<${sender}>`); await expect([250]); await write(`RCPT TO:<${to}>`); await expect([250,251]); await write('DATA'); await expect([354]);
    const boundary=`WDP-${randomHex(8)}`;
    const headers=[`From: WEB DOCTOR PRO <${sender}>`,`To: ${to}`,`Subject: =?UTF-8?B?${utf8B64(subject)}?=`,`MIME-Version: 1.0`];
    let body='';
    if(pdfBytes){
      headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
      body=`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapB64(utf8B64(text))}\r\n--${boundary}\r\nContent-Type: application/pdf; name="${pdfName||'WEB-DOCTOR-PRO-report.pdf'}"\r\nContent-Disposition: attachment; filename="${pdfName||'WEB-DOCTOR-PRO-report.pdf'}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrapB64(b64FromBytes(pdfBytes))}\r\n--${boundary}--`;
    } else { headers.push('Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64'); body=wrapB64(utf8B64(text)); }
    const data=(headers.join('\r\n')+'\r\n\r\n'+body).split('\r\n').map((l)=>l.startsWith('.')?'.'+l:l).join('\r\n');
    await writer.write(new TextEncoder().encode(data+'\r\n.\r\n')); await expect([250]); await write('QUIT'); await expect([221]);
    return true;
  } finally { try{writer.releaseLock();}catch{} try{reader.releaseLock();}catch{} try{await socket.close();}catch{} }
}
async function sendUserEmail(env,user,subject,text,opts={}){
  if(!user?.notification_email) return false; const cfg=await smtpConfig(env); if(!cfg) return false;
  try { await smtpSendWithCreds(cfg.sender_email,cfg.appPassword,{to:user.notification_email,subject,text,...opts}); return true; }
  catch(e){ console.error(JSON.stringify({event:'email_send_failed',to:user.notification_email,error:e.message})); return false; }
}
async function smtpStatusText(env){
  const row=await env.DB.prepare('SELECT sender_email,active,updated_at FROM smtp_config WHERE id=1').first();
  return `📧 <b>Global Email Notification Sender</b>\n\n${row?`${row.active?'🟢 Enabled':'⚪ Disabled'}\nSender: <code>${esc(row.sender_email)}</code>\nUpdated: ${esc(row.updated_at)}`:'⚪ Not configured'}\n\n<b>Recommended setup</b>\nThis single admin Gmail SMTP account sends automated alerts for all users. Users only save their recipient email with /email.

Use a separate Gmail account for WEB DOCTOR PRO. Enable 2-Step Verification, create a 16-character App Password, then send:\n<code>/admin_email_setup sender@gmail.com APP_PASSWORD</code>\n\nThe setup message is deleted after the password is encrypted. Never use your normal Google Account password.`;
}
async function registrationIsOpen(env){ return (await appMeta(env,'registrations_open'))!=='0'; }
async function waitlistRegistration(env,from,chatId){
  const now=nowIso();
  await env.DB.prepare(`INSERT INTO registration_waitlist(telegram_user_id,chat_id,username,first_name,first_seen_at,last_seen_at,notified_reopened_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id,username=excluded.username,first_name=excluded.first_name,last_seen_at=excluded.last_seen_at`).bind(String(from.id),String(chatId),from.username||null,from.first_name||null,now,now).run();
}
async function notifyRegistrationWaitlist(env,limit=40){
  if(!(await registrationIsOpen(env))) return 0;
  const rows=await env.DB.prepare(`SELECT * FROM registration_waitlist WHERE notified_reopened_at IS NULL ORDER BY first_seen_at LIMIT ?`).bind(limit).all();
  let sent=0;
  for(const row of rows.results){
    try { await send(env,row.chat_id,`🎉 <b>WEB DOCTOR PRO registrations are open again</b>\n\nYou can now create your account and start using Your Website Doctor. Send /start to continue.`); sent++; }
    catch{};
    await env.DB.prepare('UPDATE registration_waitlist SET notified_reopened_at=? WHERE telegram_user_id=?').bind(nowIso(),row.telegram_user_id).run();
  }
  return sent;
}
async function registrationAdminText(env){
  const open=await registrationIsOpen(env), row=await env.DB.prepare('SELECT COUNT(*) count FROM registration_waitlist WHERE notified_reopened_at IS NULL').first();
  return `🚪 <b>New User Registration</b>\n\nStatus: ${open?'🟢 OPEN':'🔴 CLOSED'}\nWaiting users: <b>${Number(row?.count||0)}</b>\n\nWhen closed, existing users continue working. New users receive a closed-registration message and are added to the waiting list. When reopened, waiting users are notified automatically.`;
}
async function monitorWebsiteChanges(env){
  const cutoff=new Date(Date.now()-CHANGE_CHECK_INTERVAL_MS).toISOString();
  const rows=await env.DB.prepare(`SELECT w.id watch_id,w.last_change_check_at,u.*,d.name FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.blocked=0 AND (w.last_change_check_at IS NULL OR w.last_change_check_at<=?) ORDER BY COALESCE(w.last_change_check_at,'') LIMIT 8`).bind(cutoff).all();
  for(const row of rows.results){
    try {
      const snap=await captureChangeSnapshot(env,row.name); if(!snap){ await env.DB.prepare('UPDATE watches SET last_change_check_at=?,updated_at=? WHERE id=?').bind(nowIso(),nowIso(),row.watch_id).run(); continue; }
      const prevRow=await env.DB.prepare('SELECT snapshot_json FROM website_snapshots WHERE watch_id=?').bind(row.watch_id).first();
      if(prevRow){
        const old=safeJson(prevRow.snapshot_json,{})||{};
        Object.assign(snap,stabilizeChangeSnapshot(old,snap));
        const rawChanges=snapshotChangeList(old,snap);
        const sitemapDecision=await confirmSitemapChanges(env,row.watch_id,old,snap,rawChanges);
        Object.assign(snap,sitemapDecision.snapshot);
        const changes=sitemapDecision.changes;
        if(changes.length){
          const detected=nowIso();
          for(const c of changes) await env.DB.prepare(`INSERT INTO website_change_events(watch_id,kind,label,old_value,new_value,detected_at) VALUES(?,?,?,?,?,?)`).bind(row.watch_id,c.kind,c.label,short(c.oldValue,600),short(c.newValue,600),detected).run();
          const detail=changes.slice(0,8).map((c)=>`• <b>${esc(c.label)}</b>\n  Old: ${esc(short(c.oldValue||'—',140))}\n  New: ${esc(short(c.newValue||'—',140))}`).join('\n');
          const sitemapOnly=changes.every((c)=>c.kind==='sitemap');
          const guidance=sitemapOnly
            ? '🗺 Sitemap changes are compared by normalized URL entries and confirmed across two checks. Timestamp, formatting and ordering-only changes are ignored.'
            : '🛡 Review unexpected DNS, certificate, registrar or hosting changes promptly.';
          const text=`⚠️ <b>Website Change Detected</b>\n\n🌐 <b>${esc(row.name)}</b>\n${detail}\n\n🕒 ${esc(formatInTimezone(detected,row.timezone||'UTC'))}\n\n${guidance}`;
          await send(env,row.chat_id,text).catch(()=>{});
          await sendUserEmail(env,row,`WEB DOCTOR PRO change alert — ${row.name}`,text.replace(/<[^>]+>/g,'')).catch(()=>false);
        }
      }
      await env.DB.prepare(`INSERT INTO website_snapshots(watch_id,snapshot_json,captured_at) VALUES(?,?,?) ON CONFLICT(watch_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,captured_at=excluded.captured_at`).bind(row.watch_id,JSON.stringify(snap),nowIso()).run();
      await env.DB.prepare('UPDATE watches SET last_change_check_at=?,updated_at=? WHERE id=?').bind(nowIso(),nowIso(),row.watch_id).run();
    } catch(e){ console.error(JSON.stringify({event:'change_monitor_failed',domain:row.name,error:e.message})); }
  }
}
async function cleanupMonitoringHistory(env){
  const old=new Date(Date.now()-MONITOR_RETENTION_DAYS*86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM uptime_samples WHERE checked_at<?').bind(old),
    env.DB.prepare('DELETE FROM website_change_events WHERE detected_at<?').bind(old)
  ]).catch(()=>{});
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
  return `💎 <b>WEB DOCTOR PRO Plans</b>\n\n🆓 <b>Free</b>\n• 5 checks/day • 1 PDF/day • 1 monitored site\n• Weekly reports • Ads after scans\n\n⭐ <b>Starter — 49 Stars / 30 days</b>\n• 25 checks/day • 5 PDFs/day • 5 monitored sites\n• Daily + weekly reports • Fewer ads\n\n👑 <b>Pro — 129 Stars / 30 days</b>\n• 100 checks/day • 20 PDFs/day • 25 monitored sites\n• Daily/weekly/monthly reports • No ads\n\n🏢 <b>Team — 299 Stars / 30 days</b>\n• 250 shared checks/day • 50 PDFs/day • 50 monitored sites\n• Group/channel workspace access • No ads\n• One active Team workspace per subscription\n\n📌 Current plan: <b>${PLAN_CONFIG[current].label}${esc(until)}</b>\n\nTelegram handles recurring Star subscription payments. Team activation codes are valid for 24 hours.`;
}
function plansMarkup() {
  return { inline_keyboard: [[{ text: '⭐ Starter — 49 Stars', callback_data: 'buyplan:starter' }], [{ text: '👑 Pro — 129 Stars', callback_data: 'buyplan:pro' }], [{ text: '🏢 Team — 299 Stars', callback_data: 'buyplan:team' }], [{ text: '🎟 Redeem Coupon', callback_data: 'couponhelp:show' }]] };
}
async function sendPlanInvoice(env, chatId, user, plan) {
  const cfg = PLAN_CONFIG[plan]; if (!cfg || !cfg.stars) throw new Error('Invalid paid plan.');
  const payload = `sub:${plan}:${user.id}:${randomHex(6)}`;
  const invoiceUrl = await tg(env, 'createInvoiceLink', {
    title: `WEB DOCTOR PRO ${cfg.label}`,
    description: `${cfg.label} access for 30 days. Recurring payment uses Telegram Stars.`,
    payload,
    currency: 'XTR',
    prices: [{ label: `${cfg.label} — 30 days`, amount: cfg.stars }],
    subscription_period: SUBSCRIPTION_PERIOD
  });
  return send(env, chatId, `⭐ <b>Telegram Stars checkout</b>\n\n💎 Plan: <b>${cfg.label}</b>\n⭐ Price: <b>${cfg.stars} Stars / 30 days</b>\n\nTap below to open Telegram's secure Stars payment screen.`, {
    reply_markup: { inline_keyboard: [[{ text: `⭐ Pay ${cfg.stars} Stars`, url: invoiceUrl }]] }
  });
}
async function handlePreCheckout(env, q) {
  const payload = String(q.invoice_payload || ''), m = /^sub:(starter|pro|team):(\d+):/.exec(payload);
  if (!m) return tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: false, error_message: 'Invalid subscription invoice.' });
  const user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(q.from?.id || '')).first();
  const ok = Boolean(user && !user.blocked && Number(user.id) === Number(m[2]) && Number(q.total_amount) === PLAN_CONFIG[m[1]].stars && q.currency === 'XTR');
  return tg(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok, ...(ok ? {} : { error_message: 'This subscription invoice is no longer valid.' }) });
}
async function handleSuccessfulPayment(env, msg, user) {
  const p = msg.successful_payment, m = /^sub:(starter|pro|team):(\d+):/.exec(String(p?.invoice_payload || ''));
  if (!m || Number(m[2]) !== Number(user.id) || p.currency !== 'XTR') return;
  const plan = m[1], cfg = PLAN_CONFIG[plan]; if (Number(p.total_amount) !== cfg.stars) return;
  const expiry = p.subscription_expiration_date ? new Date(Number(p.subscription_expiration_date) * 1000).toISOString() : addDays(user.plan_expires_at, 30);
  await env.DB.prepare(`INSERT OR IGNORE INTO star_payments(user_id,plan,amount,currency,invoice_payload,telegram_charge_id,provider_charge_id,subscription_expiration_date,is_recurring,is_first_recurring,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(user.id, plan, p.total_amount, p.currency, p.invoice_payload, p.telegram_payment_charge_id, p.provider_payment_charge_id || null, expiry, p.is_recurring ? 1 : 0, p.is_first_recurring ? 1 : 0, nowIso()).run();
  await extendPlan(env, user.id, plan, 30, { autoRenew: Boolean(p.is_recurring), chargeId: p.telegram_payment_charge_id, absoluteExpiry: expiry });
  let teamActivation = null;
  if (plan === 'team') {
    await syncTeamWorkspaceExpiry(env, user.id, expiry);
    const activeWorkspace = await env.DB.prepare('SELECT id FROM team_chats WHERE owner_user_id=? AND active=1 AND plan_expires_at>? LIMIT 1').bind(user.id, nowIso()).first();
    if (!activeWorkspace) teamActivation = await issueTeamActivationCode(env, user.id);
  }
  await reactToMessage(env, msg, '🎉');
  await send(env, msg.chat.id, `🎉 <b>${cfg.label} activated</b>\n\n⭐ Payment: ${cfg.stars} Stars\n📅 Access until: ${esc(formatInTimezone(expiry, user.timezone_configured ? user.timezone : 'UTC'))}\n${p.is_recurring ? '🔁 Recurring subscription is active.' : ''}${teamActivation ? `\n\n🔑 <b>Your 24-hour Team activation code</b>\n<code>${teamActivation.code}</code>\n\nAdd this bot as an admin in your group/supergroup, then send this code there yourself. For a channel, use <code>/team_activate ${teamActivation.code} @channelusername</code> here in private.` : plan === 'team' ? '\n\n🏢 Your existing Team workspace expiry was extended automatically.' : ''}\n\nUse /plans anytime to view your plan.`);
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
    [{ text: '🚪 Registrations', callback_data: 'admin:registrations' }, { text: '📧 Email', callback_data: 'admin:email' }],
    [{ text: '➕ Create Ad', callback_data: 'admin:adcreate' }, { text: '➕ Broadcast', callback_data: 'admin:broadcastcreate' }],
    [{ text: '🔄 Refresh', callback_data: 'admin:home' }]
  ] };
}
async function adminStatsText(env) {
  const [users, paid, blocked, verified, ads, broadcasts, revenue] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) c FROM users').first(),
    env.DB.prepare("SELECT COUNT(*) c FROM users WHERE plan IN ('starter','pro','team') AND (plan_expires_at IS NULL OR plan_expires_at>?)").bind(nowIso()).first(),
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
    [{ text: '🆓 Set Free', callback_data: `adminsetfree:${u.id}` }],
    [{ text: '⭐ Set Starter', callback_data: `adminsetstarter:${u.id}` }, { text: '👑 Set Pro', callback_data: `adminsetpro:${u.id}` }],
    [{ text: '🏢 Set Team', callback_data: `adminsetteam:${u.id}` }],
    [{ text: '🎁 Gift 50', callback_data: `admingift50:${u.id}` }, { text: '🎁 Gift 100', callback_data: `admingift100:${u.id}` }],
    [{ text: '🎁 Gift 250', callback_data: `admingift250:${u.id}` }, { text: '🪙 +100 Direct', callback_data: `admincoins100:${u.id}` }],
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

async function adminAdsView(env) {
  const rows = await env.DB.prepare('SELECT * FROM ads ORDER BY id DESC LIMIT 12').all();
  const globalOn = (await appMeta(env, 'ads_enabled')) !== '0';
  const lines = rows.results.length ? rows.results.map((a) => `• #${a.id} ${a.active ? '🟢 ON' : '⚪ OFF'} • ${esc(a.content_type)} • views ${a.impressions || 0} • ${esc(short(a.title || a.text_content || 'Ad', 34))}`).join('\n') : 'No ads yet.';
  const buttons = [
    [{ text: globalOn ? '🟢 Global Ads ON · Turn OFF' : '⚪ Global Ads OFF · Turn ON', callback_data: `adminads:${globalOn ? 'off' : 'on'}` }],
    [{ text: '➕ Create Ad', callback_data: 'admin:adcreate' }]
  ];
  for (const a of rows.results) buttons.push([
    { text: `#${a.id} ${a.active ? '🟢 ON' : '⚪ OFF'}`, callback_data: `adminad:${a.active ? 'off' : 'on'}:${a.id}` },
    { text: '✏️ Edit', callback_data: `adminad:edit:${a.id}` },
    { text: '🗑 Delete', callback_data: `adminad:ask:${a.id}` }
  ]);
  buttons.push([{ text: '⬅️ Admin Home', callback_data: 'admin:home' }]);
  return { text: `📣 <b>Ads Manager</b>\n\nGlobal: <b>${globalOn ? 'ON' : 'OFF'}</b>\n\n${lines}\n\nTap buttons below to control ads. Editing asks you to send replacement text/image/video/voice.`, markup: { inline_keyboard: buttons } };
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
      { command: 'mail', description: '📧 Mail DNS & authentication health' },
      { command: 'subdomains', description: '🔎 Verified subdomain health & SEO' },
      { command: 'add', description: '🛡 Verify ownership & monitor' },
      { command: 'verify', description: '🔄 Verify DNS ownership record' },
      { command: 'schedule', description: '🗓 Schedule signed PDF reports' },
      { command: 'score', description: '❤️ Website health score' },
      { command: 'compare', description: '📈 Compare latest scans' },
      { command: 'fix', description: '🧠 Top fixes first' },
      { command: 'emergency', description: '🆘 Emergency website diagnostics' },
      { command: 'email', description: '📧 Email alert destination' },
      { command: 'google', description: '🔗 Connect your Google account data' },
      { command: 'plans', description: '💎 Plans & Telegram Stars' },
      { command: 'team', description: '🏢 Team workspace & activation' },
      { command: 'team_code', description: '🔑 New Team activation code' },
      { command: 'invite', description: '🎁 Invite friends & earn coins' },
      { command: 'coins', description: '🪙 Coins & plan rewards' },
      { command: 'coupon', description: '🎟 Redeem a coupon' },
      { command: 'list', description: '📋 View monitored websites' },
      { command: 'verified', description: '✅ View verified websites' },
      { command: 'pending', description: '⏳ View pending websites' },
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
        { command: 'admin_plan', description: '💎 Set exact user plan' },
        { command: 'admin_gift', description: '🎁 Queue a coin gift' },
        { command: 'admin_registrations', description: '🚪 Open/close new users' },
        { command: 'admin_email', description: '📧 Email sender settings' },
        { command: 'admin_email_setup', description: '🔐 Configure Gmail App Password' },
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

function parseMxRecord(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d+)\s+(.+)$/);
  return { priority: m ? Number(m[1]) : 0, host: String(m ? m[2] : raw).replace(/\.$/, '').toLowerCase() };
}
function mailTag(record, key) {
  const m = String(record || '').match(new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*([^;]+)`, 'i'));
  return m ? m[1].trim() : null;
}
function mailScoreLabel(score) { return score >= 90 ? '🟢 Excellent' : score >= 75 ? '🟢 Good' : score >= 55 ? '🟡 Needs attention' : '🔴 Critical'; }
async function discoverDkim(domain) {
  const selectors = ['default','google','selector1','selector2','mail','dkim'];
  const found = [];
  await Promise.all(selectors.map(async (selector) => {
    const name = `${selector}._domainkey.${domain}`;
    const [txt, cname] = await Promise.all([dnsLookup(name, 'TXT'), dnsLookup(name, 'CNAME')]);
    if (txt.some((x) => /v=dkim1|\bp=/i.test(x)) || cname.length) found.push(selector);
  }));
  return [...new Set(found)].sort();
}

async function discoverCertificateSubdomains(rootDomain) {
  const url = `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(rootDomain)}&include_subdomains=true&expand=dns_names`;
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Certificate transparency service returned HTTP ${r.status}`);
  const rows = await r.json();
  const names = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const raw of Array.isArray(row?.dns_names) ? row.dns_names : []) {
      const name = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
      if (!name || name === rootDomain || !name.endsWith(`.${rootDomain}`)) continue;
      try { if (normalizeDomain(name) === name) names.add(name); } catch { /* ignore malformed CT names */ }
      if (names.size >= SUBDOMAIN_DISCOVERY_LIMIT) break;
    }
    if (names.size >= SUBDOMAIN_DISCOVERY_LIMIT) break;
  }
  return [...names].sort();
}

async function discoverSubdomainCandidates(rootDomain) {
  const ct = await discoverCertificateSubdomains(rootDomain).catch(() => []);
  const out = [...ct];
  const seen = new Set(out);
  for (const label of SUBDOMAIN_COMMON_LABELS) {
    const host = `${label}.${rootDomain}`;
    if (!seen.has(host)) { seen.add(host); out.push(host); }
  }
  return { candidates: out.slice(0, SUBDOMAIN_DISCOVERY_LIMIT), ctCount: ct.length };
}

async function subdomainHealthItem(host) {
  const [a, aaaa] = await Promise.all([dnsLookup(host, 'A'), dnsLookup(host, 'AAAA')]);
  const dnsAnswers = stableValues([...a, ...aaaa]);
  if (!dnsAnswers.length) return { host, dnsActive: false, dnsAnswers: [], status: null, protocol: null, seo: null, ssl: null, health: 0 };

  let page = null, protocol = 'https';
  try {
    page = await fetchText(`https://${host}`, 280000, { signal: AbortSignal.timeout(9000) });
  } catch {
    protocol = 'http';
    try { page = await fetchText(`http://${host}`, 280000, { signal: AbortSignal.timeout(9000) }); } catch { page = null; }
  }

  const httpsLive = Boolean(page && /^https:/i.test(page.url || '') && page.status < 600);
  const ssl = httpsLive ? await sslLookup(host).catch(() => ({ expiresAt: null, issuer: null })) : { expiresAt: null, issuer: null };
  const seo = page && page.status < 500 ? analyzeSeoHtml(page.text || '', page.url || `${protocol}://${host}`) : null;
  const seoScore = clamp100(seo?.score ?? 0);
  const sslDays = ssl?.expiresAt ? daysUntil(ssl.expiresAt) : null;
  const dnsScore = 15;
  const webScore = !page ? 0 : page.status < 400 ? 30 : page.status < 500 ? 18 : 5;
  const sslScore = httpsLive ? (sslDays !== null && sslDays >= 1 ? 20 : ssl?.expiresAt ? 5 : 10) : 0;
  const health = clamp100(Math.round(dnsScore + webScore + seoScore * 0.35 + sslScore));
  return {
    host, dnsActive: true, dnsAnswers, status: page?.status ?? null, protocol: page ? (/^https:/i.test(page.url || '') ? 'https' : protocol) : null,
    seo: seo ? { score: seoScore, title: seo.title || '', description: seo.description || '' } : null,
    ssl: { expiresAt: ssl?.expiresAt || null, issuer: ssl?.issuer || null, days: sslDays }, health
  };
}

async function subdomainDoctorReport(rootDomain, requestedPage = 1) {
  const found = await discoverSubdomainCandidates(rootDomain);
  const totalPages = Math.max(1, Math.ceil(found.candidates.length / SUBDOMAIN_PAGE_SIZE));
  const page = Math.max(1, Math.min(totalPages, Number(requestedPage || 1) || 1));
  const start = (page - 1) * SUBDOMAIN_PAGE_SIZE;
  const selected = found.candidates.slice(start, start + SUBDOMAIN_PAGE_SIZE);
  const items = await Promise.all(selected.map((host) => subdomainHealthItem(host)));
  return { rootDomain, page, totalPages, candidateCount: found.candidates.length, ctCount: found.ctCount, items };
}

async function subdomainDoctorText(rootDomain, requestedPage = 1) {
  const r = await subdomainDoctorReport(rootDomain, requestedPage);
  const active = r.items.filter((x) => x.dnsActive);
  const lines = active.map((x, i) => {
    const web = x.status == null ? '❌ unreachable' : `${x.protocol === 'https' ? '🔒' : '⚠️'} ${String(x.protocol || '').toUpperCase()} ${x.status}`;
    const seo = x.seo ? `${x.seo.score}/100 • title ${x.seo.title ? '✅' : '❌'} • meta ${x.seo.description ? '✅' : '❌'}` : 'not available';
    const ssl = x.ssl?.expiresAt ? `${x.ssl.days !== null && x.ssl.days >= 0 ? '✅' : '❌'} ${x.ssl.days === null ? 'date unavailable' : `${x.ssl.days}d`}` : (x.protocol === 'https' ? '⚪ certificate date unavailable' : '❌ no HTTPS');
    return `${i + 1}. <b>${esc(x.host)}</b>\n   🧭 DNS ✅ • ${x.dnsAnswers.length} answer(s)\n   🌐 Web ${web}\n   ❤️ Health <b>${x.health}/100</b> ${scoreLabel(x.health)}\n   📈 SEO ${seo}\n   🔐 SSL ${ssl}`;
  });
  const inactive = r.items.length - active.length;
  return `🔎 <b>Subdomain Doctor — ${esc(rootDomain)}</b>\n\n✅ Root-domain ownership verified\n🔐 Discovery: Certificate Transparency + DNS resolution\n📚 CT names found: <b>${r.ctCount}</b> • candidates: <b>${r.candidateCount}</b>\n📄 Page <b>${r.page}/${r.totalPages}</b> • checked ${r.items.length} candidate(s)\n\n${lines.length ? lines.join('\n\n') : '⚪ No active DNS-resolving subdomains on this page.'}\n\n${inactive ? `🕳 ${inactive} candidate(s) on this page did not resolve in DNS.\n` : ''}${r.totalPages > 1 ? `➡️ Next: <code>/subdomains ${esc(rootDomain)} ${Math.min(r.totalPages, r.page + 1)}</code>\n` : ''}\n💡 <i>CT logs can contain historical hostnames. Active status is confirmed separately with current DNS. SEO is an on-page check of the subdomain homepage.</i>`;
}

async function runSubdomainDoctor(env, chatId, user, rootDomain, page = 1) {
  if (!(await requireTimezone(env, chatId, user))) return null;
  const verified = await isVerified(env, user.id, rootDomain);
  if (!verified) return send(env, chatId, `🔒 <b>Verified domains only</b>\n\n🌐 ${esc(rootDomain)}\n\nSubdomain discovery and scanning can expose infrastructure details, so WEB DOCTOR PRO only runs it for domains you have verified.\n\nUse <code>/add ${esc(rootDomain)}</code> first.`);
  const usage = await consumeUsage(env, user, { report: false });
  if (!usage.ok) return send(env, chatId, `🚦 <b>Daily limit reached</b>\n\n${esc(usage.reason)}\nCurrent plan: <b>${esc(PLAN_CONFIG[usage.plan].label)}</b>`, { reply_markup: plansMarkup() });
  user = usage.user || user;
  const msg = await startProgress(env, chatId, `Subdomain Doctor — ${rootDomain}`, 'Discovering certificate and DNS signals…');
  try {
    await updateProgress(env, chatId, msg.message_id, `Subdomain Doctor — ${rootDomain}`, 1, 3, 'Discovering subdomain candidates…');
    await updateProgress(env, chatId, msg.message_id, `Subdomain Doctor — ${rootDomain}`, 2, 3, 'Checking DNS, web health, SSL and SEO…');
    const text = await subdomainDoctorText(rootDomain, page);
    await updateProgress(env, chatId, msg.message_id, `Subdomain Doctor — ${rootDomain}`, 3, 3, 'Finalizing subdomain health results…');
    await edit(env, chatId, msg.message_id, text);
    await maybeServeAd(env, user, chatId).catch(() => null);
    return text;
  } catch (e) {
    await edit(env, chatId, msg.message_id, `⚠️ <b>Subdomain scan could not finish</b>\n\n🌐 ${esc(rootDomain)}\n${esc(short(e?.message || 'Unknown error', 500))}`);
    return null;
  }
}

async function mailHealthReport(domain) {
  const [mxRaw, rootTxt, dmarcTxt, mtaStsTxt, tlsRptTxt, dkim] = await Promise.all([
    dnsLookup(domain, 'MX'),
    dnsLookup(domain, 'TXT'),
    dnsLookup(`_dmarc.${domain}`, 'TXT'),
    dnsLookup(`_mta-sts.${domain}`, 'TXT'),
    dnsLookup(`_smtp._tls.${domain}`, 'TXT'),
    discoverDkim(domain)
  ]);
  const mx = mxRaw.map(parseMxRecord).filter((x) => x.host).sort((a,b) => a.priority - b.priority || a.host.localeCompare(b.host));
  const spf = rootTxt.filter((x) => /^v=spf1\b/i.test(x));
  const dmarc = dmarcTxt.filter((x) => /^v=dmarc1\b/i.test(x));
  const mtaSts = mtaStsTxt.filter((x) => /^v=stsv1\b/i.test(x));
  const tlsRpt = tlsRptTxt.filter((x) => /^v=tlsrptv1\b/i.test(x));
  const mxHosts = await Promise.all(mx.slice(0, 8).map(async (record) => {
    const [a, aaaa] = await Promise.all([dnsLookup(record.host, 'A'), dnsLookup(record.host, 'AAAA')]);
    return { ...record, a: stableValues(a), aaaa: stableValues(aaaa), resolves: Boolean(a.length || aaaa.length) };
  }));
  const resolved = mxHosts.filter((x) => x.resolves).length;
  const issues = [], notes = [];
  let score = 0;
  if (mx.length) score += 35; else issues.push('🔴 No MX record found — incoming mail cannot be routed normally.');
  if (mx.length && resolved === mxHosts.length) score += 15;
  else if (resolved > 0) { score += 8; issues.push(`🟡 Only ${resolved}/${mxHosts.length} checked MX hosts resolve to an IP address.`); }
  else if (mx.length) issues.push('🔴 None of the checked MX hosts resolve to A/AAAA records.');
  if (spf.length === 1) score += 20;
  else if (!spf.length) issues.push('🟡 SPF record is missing.');
  else { score += 5; issues.push('🔴 Multiple SPF records detected; publish a single SPF policy.'); }
  let dmarcPolicy = null;
  if (dmarc.length) {
    dmarcPolicy = String(mailTag(dmarc[0], 'p') || 'none').toLowerCase();
    score += dmarcPolicy === 'reject' || dmarcPolicy === 'quarantine' ? 20 : 12;
    if (dmarcPolicy === 'none') issues.push('🟡 DMARC is monitoring-only (p=none); spoofing protection is limited.');
  } else issues.push('🟡 DMARC record is missing.');
  if (mtaSts.length) score += 5; else notes.push('MTA-STS is not configured.');
  if (tlsRpt.length) score += 5; else notes.push('TLS-RPT is not configured.');
  if (!dkim.length) notes.push('DKIM selector was not auto-discovered; this alone does not mean DKIM is missing.');
  score = clamp100(score);
  return { domain, score, mx, mxHosts, resolved, spf, dmarc, dmarcPolicy, dkim, mtaSts, tlsRpt, issues, notes };
}
async function mailHealthText(domain) {
  const r = await mailHealthReport(domain);
  const mxText = r.mx.length ? r.mx.slice(0, 6).map((x) => `${x.priority} ${x.host}`).join('\n') : '—';
  const status = (ok, yes='✅', no='❌') => ok ? yes : no;
  const spfState = r.spf.length === 1 ? '✅ Valid record found' : r.spf.length > 1 ? `❌ ${r.spf.length} SPF records` : '⚠️ Missing';
  const dmarcState = r.dmarc.length ? `✅ ${esc(r.dmarcPolicy || 'present')}` : '⚠️ Missing';
  const dkimState = r.dkim.length ? `✅ ${esc(r.dkim.join(', '))}` : 'ℹ️ Not auto-discovered';
  const findings = r.issues.length ? `\n\n<b>Findings</b>\n${r.issues.map(esc).join('\n')}` : '\n\n✅ <b>No major mail DNS issues detected.</b>';
  const notes = r.notes.length ? `\n\n<b>Hardening</b>\n${r.notes.map((x) => `• ${esc(x)}`).join('\n')}` : '';
  return `📧 <b>Mail Health — ${esc(domain)}</b>\n\n<b>MAIL HEALTH SCORE: ${r.score}/100</b> ${mailScoreLabel(r.score)}\n\n📬 <b>MX</b> ${status(r.mx.length)} ${r.mx.length ? `${r.mx.length} record(s)` : 'Missing'}\n🧭 <b>MX host resolution</b> ${status(r.mx.length && r.resolved === r.mxHosts.length)} ${r.resolved}/${r.mxHosts.length || 0}\n🛡 <b>SPF</b> ${spfState}\n🔐 <b>DMARC</b> ${dmarcState}\n✍️ <b>DKIM</b> ${dkimState}\n🔒 <b>MTA-STS</b> ${r.mtaSts.length ? '✅ Present' : '⚪ Not configured'}\n📨 <b>TLS-RPT</b> ${r.tlsRpt.length ? '✅ Present' : '⚪ Not configured'}\n\n<b>MX servers</b>\n${esc(mxText)}${findings}${notes}\n\n<i>This checks mail DNS/authentication health. It does not prove that a specific mailbox can send or receive messages.</i>`;
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
async function isHttp530Domain(domain) {
  try {
    const r = await fetch(`https://${domain}`, {
      method: 'GET', redirect: 'follow',
      headers: { Range: 'bytes=0-0', 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` },
      signal: AbortSignal.timeout(10000)
    });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return r.status === 530;
  } catch { return false; }
}
function invalidDomain530Text(domain) {
  return `❌ <b>Invalid domain</b>\n\n🌐 ${esc(domain)}`;
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
  await env.DB.prepare(`UPDATE domain_verifications SET status='verified',verified_at=?,expires_at='9999-12-31T23:59:59.999Z' WHERE id=?`).bind(verifiedAt, v.id).run();
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
  await enrichHealthReport(env, user, base);

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
  const h=report.health||{};
  const fixes=(report.topFixes||[]).slice(0,3).map((x,i)=>`${i+1}. ${x.severity==='high'?'🔴':x.severity==='medium'?'🟡':'🟢'} ${esc(x.text)}`).join('\n');
  return `🧪 <b>Full Scan Complete</b>\n\n🌐 <b>${esc(report.domain)}</b>\n❤️ <b>WEB DOCTOR SCORE: ${h.healthScore ?? 'N/A'}/100</b>\n\n📅 Domain: ${h.domainScore ?? 'N/A'}/100 • 🔐 SSL: ${h.sslScore ?? 'N/A'}/100\n🛡 Security: ${h.securityScore ?? 'N/A'}/100 • 🧭 DNS: ${h.dnsScore ?? 'N/A'}/100\n📈 SEO: <b>${report.seo.score}/100</b> • ⚡ Performance: <b>${speed}</b>\n⏱ Availability: <b>${h.availabilityScore ?? 'N/A'}/100</b>\n🌍 GEO: ${report.geoAeo.geoScore}/100 • 💬 AEO: ${report.geoAeo.aeoScore}/100\n🔗 Broken links: <b>${report.links.broken.length}</b> / ${report.links.checked} checked\n📄 robots.txt: ${report.robots.exists ? '✅' : '❌'} • Sitemap: ${report.sitemap.exists ? '✅' : '❌'}\n\n🧠 <b>Top fixes</b>\n${fixes||'✅ No urgent fix detected.'}\n\n📑 <b>Signed PDF report:</b> ${esc(report.reportId)}`;
}
async function runFullScan(env, chatId, user, domain, { silentProgress = false, scheduled = false, preflightDone = false } = {}) {
  if (!preflightDone && await isHttp530Domain(domain)) { await send(env, chatId, invalidDomain530Text(domain)); return null; }
  let msg = null;
  if (!silentProgress) msg = await startProgress(env, chatId, `Scanning ${domain}`, 'Starting full website audit…');
  const onProgress = silentProgress ? async () => {} : async (step, total, detail) => updateProgress(env, chatId, msg.message_id, `Scanning ${domain}`, step, total, detail);
  try {
    const report = await fullScanData(env, user, domain, onProgress);
    if (!silentProgress) await finishProgress(env, chatId, msg.message_id, `Scanning ${domain}`, 'Audit complete. Preparing your PDF…');
    const filename = `WEB-DOCTOR-PRO-${domain.replace(/[^a-z0-9.-]/gi, '-')}-${report.reportId}.pdf`;
    await sendDocument(env, chatId, report.pdfBytes, filename, `📑 <b>WEB DOCTOR PRO ${scheduled ? 'Scheduled ' : ''}Report</b>\n🌐 ${esc(domain)}\n🆔 ${esc(report.reportId)}\n🕒 ${esc(report.generatedLocal)}`, domainButtons(domain, Boolean(await isVerified(env, user.id, domain)), Boolean(await isVerified(env, user.id, domain))));
    await send(env, chatId, fullScanSummary(report), { reply_markup: healthActionButtons(domain) });
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
  if (action !== 'mail' && await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));
  const usage = await consumeUsage(env, user, { report: action === 'scan' });
  if (!usage.ok) return send(env, chatId, `🚦 <b>Daily limit reached</b>\n\n${esc(usage.reason)}\nCurrent plan: <b>${esc(PLAN_CONFIG[usage.plan].label)}</b>\n\nUse /plans to compare limits or upgrade.` , { reply_markup: plansMarkup() });
  user = usage.user || user;
  if (action === 'scan') {
    const result = await runFullScan(env, chatId, user, domain, { preflightDone: true });
    if (!result) return null;
    await maybeServeAd(env, user, chatId).catch(() => null);
    return result;
  }
  const titleMap = { check: 'Quick website check', seo: 'SEO / GEO / AEO audit', performance: 'Performance analysis', ssl: 'Certificate check', provider: 'Provider detection', links: 'Broken-link scan', robots: 'Robots and sitemap analysis', keywords: 'Keyword research', mail: 'Mail health monitor' };
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
    if (action === 'mail') text = await mailHealthText(domain);
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
    if (e?.status === 530 || /HTTP 530/i.test(String(e?.message || ''))) {
      await edit(env, chatId, msg.message_id, invalidDomain530Text(domain));
      return null;
    }
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
  return `🩺 <b>WEB DOCTOR PRO</b>\n<b>Your Website Doctor.</b>\n\n${hi}\n\n🌐 Check website health\n⏱ Monitor uptime\n📅 Track domain expiry\n🔐 Watch certificate expiry\n📈 Audit SEO / GEO / AEO\n📑 Get signed PDF reports\n\n<b>Fastest way</b>\nSend a domain directly:\n<code>example.com</code>\n\n<b>Monitor your website</b>\n<code>/add example.com</code>\nA one-time DNS TXT verification protects ownership-sensitive monitoring.\n\n💎 Use /plans for Free, Starter, Pro and Team.\n🏢 Team plan can activate one shared group/channel workspace.\n🎁 Use /invite to earn coins.\n\nUse /help for all commands.`;
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
  if (await isVerified(env, user.id, domain)) return send(env, chatId, `✅ <b>Ownership already verified</b>\n\n🌐 ${esc(domain)}\n🛡 No DNS verification is needed again. You can safely remove the old TXT record.`, { reply_markup: scheduleButtons(domain) });
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
  if (!(await isAdmin(env, user)) || String(msg.chat?.id) !== ADMIN_TELEGRAM_ID || msg.chat?.type !== 'private') return false;
  const chatId = msg.chat.id;
  if (cmd === '/admin') return void await send(env, chatId, await adminStatsText(env), { reply_markup: adminMenuMarkup() });
  if (cmd === '/admin_cancel') { await clearAdminSession(env,user.id); return void await send(env,chatId,'✅ Admin draft mode cleared.'); }

  if (cmd === '/admin_registrations') return void await send(env,chatId,await registrationAdminText(env),{reply_markup:{inline_keyboard:[[{text:'🟢 Open',callback_data:'adminreg:open'},{text:'🔴 Close',callback_data:'adminreg:close'}],[{text:'🔄 Refresh',callback_data:'admin:registrations'}],[{text:'↩️ Admin Home',callback_data:'admin:home'}]]}});
  if (cmd === '/admin_email') return void await send(env,chatId,await smtpStatusText(env),{reply_markup:{inline_keyboard:[[{text:'🧪 Send Test',callback_data:'adminemail:test'},{text:'⏯ Toggle',callback_data:'adminemail:toggle'}],[{text:'📖 App Password Guide',callback_data:'adminemail:guide'}],[{text:'↩️ Admin Home',callback_data:'admin:home'}]]}});
  if (cmd === '/admin_email_setup') {
    const sender=String(args[0]||'').trim().toLowerCase(), password=String(args.slice(1).join('')||'').replace(/\s+/g,'');
    if(!/^[^\s@]+@gmail\.com$/.test(sender)||password.length<12) return void await send(env,chatId,'Usage: <code>/admin_email_setup secondaccount@gmail.com 16_CHAR_APP_PASSWORD</code>');
    await deleteTelegramMessage(env,chatId,msg.message_id);
    try { await smtpSendWithCreds(sender,password,{to:sender,subject:'WEB DOCTOR PRO email sender test',text:'Your WEB DOCTOR PRO Gmail SMTP sender is working.'}); }
    catch(e){ return void await send(env,chatId,`❌ <b>Email sender test failed</b>\n\n${esc(short(e.message,300))}\n\nCheck the Gmail address, 2-Step Verification and App Password.`); }
    const cipher=await encryptGoogle(env,password);
    await env.DB.prepare(`INSERT INTO smtp_config(id,sender_email,app_password_cipher,active,created_at,updated_at) VALUES(1,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET sender_email=excluded.sender_email,app_password_cipher=excluded.app_password_cipher,active=1,updated_at=excluded.updated_at`).bind(sender,cipher,nowIso(),nowIso()).run();
    return void await send(env,chatId,'✅ <b>Email sender configured</b>\n\nThe App Password was encrypted and the setup message was deleted. A test email was sent successfully.');
  }

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
  if (cmd === '/admin_plan') {
    if (!args[0] || !['free','starter','pro','team'].includes(String(args[1] || '').toLowerCase())) return void await send(env, chatId, 'Usage: <code>/admin_plan TELEGRAM_ID free|starter|pro [DAYS]</code>');
    const target = await adminByTelegramId(env, args[0]); if (!target) return void await send(env, chatId, '❌ User not found.');
    const plan = String(args[1]).toLowerCase(), days = /^\d+$/.test(String(args[2] || '')) ? Number(args[2]) : 30;
    const expiry = await adminSetExactPlan(env, target, plan, days);
    const teamActivation = plan === 'team' ? await issueTeamActivationCode(env, target.id) : null;
    await send(env, target.chat_id, `🛠 <b>Your plan was updated by admin</b>\n\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>${expiry ? `\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}` : ''}${teamActivation ? `\n\n🔑 Team activation code (24h)\n<code>${teamActivation.code}</code>` : ''}`).catch(() => {});
    return void await send(env, chatId, `✅ User plan set to <b>${PLAN_CONFIG[plan].label}</b>.`);
  }
  if (cmd === '/admin_gift') {
    if (!args[0] || !/^\d+$/.test(String(args[1] || '')) || Number(args[1]) <= 0) return void await send(env, chatId, 'Usage: <code>/admin_gift TELEGRAM_ID COINS</code>');
    const target = await adminByTelegramId(env, args[0]); if (!target) return void await send(env, chatId, '❌ User not found.');
    const gift = await createGift(env, target.id, Number(args[1]));
    return void await send(env, chatId, `🎁 Gift #${gift.id} queued for ${esc(target.first_name || target.username || target.telegram_user_id)}: <b>${gift.coins} coins</b>. It will appear on their next interaction.`);
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
  if (cmd === '/admin_ads') { const v = await adminAdsView(env); return void await send(env, chatId, v.text, { reply_markup: v.markup }); }
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

  if ((await isAdmin(env, user)) && String(msg.chat?.id) === ADMIN_TELEGRAM_ID && msg.chat?.type === 'private' && cmd.startsWith('/admin')) {
    const handled = await handleAdminCommand(env, msg, user, cmd, [...args]);
    if (handled === false) await send(env, chatId, '❓ <b>Unknown admin command</b>\n\nUse /admin to open the admin dashboard.');
    return;
  }

  if (cmd === '/start') {
    let referred = false;
    if (args[0]?.toLowerCase().startsWith('ref_')) referred = await applyReferral(env, user, args[0].slice(4));
    await send(env, chatId, welcome(user.first_name));
    if (referred) await send(env, chatId, `🎁 <b>Referral reward added</b>\n\n🪙 You received ${REFERRAL_NEW_USER_COINS} coins.\nUse /coins to see rewards.`);
    if (!user.timezone_configured) await requireTimezone(env, chatId, user);
    return;
  }
  if (cmd === '/about') return void await send(env, chatId, `🩺 <b>WEB DOCTOR PRO</b>\n<b>Your Website Doctor.</b>\n\nMonitor uptime, domain and certificate expiry, audit SEO/GEO/AEO, verify website ownership, and receive signed PDF reports and automatic Telegram alerts.\n\n📦 v${VERSION}\n👨‍💻 Developer: ${DEVELOPER}\n🔗 ${GITHUB_URL}`);
  if (cmd === '/help') return void await send(env, chatId, `${welcome(user.first_name)}\n\n<b>Commands</b>\n/check example.com — quick check\n/scan example.com — full scan + signed PDF\n/seo example.com — SEO/GEO/AEO\n/performance example.com — PageSpeed\n/ssl example.com — certificate expiry\n/provider example.com — hosting/DNS/registrar\n/links example.com — broken links\n/robots example.com — robots/sitemap/llms.txt\n/keywords example.com — keyword opportunities\
/mail example.com — mail DNS health\
/subdomains example.com — verified subdomain health + SEO\n/add example.com — verify + monitor\n/verify example.com — re-check DNS TXT\n/schedule example.com weekly — scheduled reports\n/score example.com — website health score\n/compare example.com — compare latest scans\n/fix example.com — top 3 fixes\n/emergency example.com — outage diagnostics\n/email you@example.com — email alerts\n/google — connect your own Google account data\n/plans — plans & Stars\n/team — Team workspace status\n/team_code — new 24-hour Team activation code\n/team_activate CODE @channel — activate a channel\n/invite — referral link\n/coins — coin balance/rewards\n/coupon CODE — redeem coupon\n/list — monitored sites\n/remove example.com — stop monitoring\n/status — bot status\n/settings — settings & usage`);
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
    const plan = String(args[0] || '').toLowerCase(); if (!['starter','pro','team'].includes(plan)) return void await send(env, chatId, 'Usage: <code>/subscribe starter</code>, <code>/subscribe pro</code> or <code>/subscribe team</code>', { reply_markup: plansMarkup() });
    return void await sendPlanInvoice(env, chatId, user, plan);
  }
  if (cmd === '/team' || cmd === '/team_status') { const v = await teamAccountView(env, user); return void await send(env, chatId, v.text, { reply_markup: v.markup }); }
  if (cmd === '/team_code') {
    if (activePlan(user) !== 'team') return void await send(env, chatId, '🔒 Team plan required. Use /plans.', { reply_markup: plansMarkup() });
    const x = await issueTeamActivationCode(env, user.id);
    return void await send(env, chatId, `🔑 <b>New Team activation code</b>\n\n<code>${x.code}</code>\n\nValid for 24 hours (or until your Team plan expires). Add the bot as admin in the target group/supergroup and send this code there yourself.`);
  }
  if (cmd === '/team_activate') {
    const code = String(args[0] || '').toUpperCase(), target = args[1];
    if (!/^WDP-TEAM-[A-F0-9]{10}$/.test(code)) return void await send(env, chatId, 'Usage: <code>/team_activate WDP-TEAM-CODE @channelusername</code>\n\nFor groups, simply send the code inside the group after making this bot an admin.');
    if (!target) return void await send(env, chatId, '🏢 <b>Group activation</b>\nMake this bot an admin and send the code directly in that group.\n\n📣 <b>Channel activation</b>\nUse <code>/team_activate CODE @channelusername</code> after making this bot a channel admin.');
    let targetChat; try { targetChat = await tg(env, 'getChat', { chat_id: /^-?\d+$/.test(target) ? Number(target) : target }); } catch { return void await send(env, chatId, '❌ I cannot access that target chat. Add this bot there as an admin first and check the username/ID.'); }
    const result = await activateTeamWorkspace(env, targetChat, user, code);
    return void await send(env, chatId, result.ok ? `🎉 <b>Team workspace activated</b>\n\n🏢 ${esc(result.workspaceTitle)}\n📅 Until: ${esc(formatInTimezone(result.expiry, user.timezone_configured ? user.timezone : 'UTC'))}` : `❌ <b>Team activation failed</b>\n\n${esc(result.reason)}`);
  }

  if (cmd === '/email') {
    const value=String(args[0]||'').trim().toLowerCase();
    if(!value) return void await send(env,chatId,`📧 <b>Email notifications</b>\n\nCurrent: ${user.notification_email?`<code>${esc(user.notification_email)}</code>`:'Not configured'}\n\nSet: <code>/email you@example.com</code>\nDisable: <code>/email off</code>\n\nEmail alerts can include downtime/recovery, security-relevant website changes and Pro/Team scheduled PDF reports.

📤 Sender: WEB DOCTOR PRO admin Gmail SMTP
📥 You only provide the email address that should receive alerts. No Gmail password or App Password is requested from users.`);
    if(value==='off'){ await env.DB.prepare('UPDATE users SET notification_email=NULL,updated_at=? WHERE id=?').bind(nowIso(),user.id).run(); return void await send(env,chatId,'✅ Email notifications disabled.'); }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return void await send(env,chatId,'❌ Enter a valid email address.');
    await env.DB.prepare('UPDATE users SET notification_email=?,updated_at=? WHERE id=?').bind(value,nowIso(),user.id).run(); user.notification_email=value;
    await send(env,chatId,`✅ <b>Email notifications enabled</b>\n\n📧 <code>${esc(value)}</code>\n\nAlerts are sent from the single WEB DOCTOR PRO admin Gmail SMTP account to this address. You do not need to provide any Gmail password or App Password.`);
    await sendUserEmail(env,user,'WEB DOCTOR PRO email notifications enabled','Your WEB DOCTOR PRO email notifications are configured successfully.').catch(()=>false);
    return;
  }
  if (['/score','/compare','/fix','/emergency'].includes(cmd)) {
    if(!args[0]) return void await send(env,chatId,`💡 Usage: <code>${cmd} example.com</code>`);
    let domain; try{domain=normalizeDomain(args[0]);}catch{return void await send(env,chatId,'❌ <b>Invalid domain</b>');}
    if(cmd==='/score') return void await send(env,chatId,await healthScoreText(env,user,domain),{reply_markup:healthActionButtons(domain)});
    if(cmd==='/compare') return void await send(env,chatId,await compareText(env,user,domain),{reply_markup:healthActionButtons(domain)});
    if(cmd==='/fix') return void await send(env,chatId,await fixesText(env,user,domain),{reply_markup:healthActionButtons(domain)});
    if(cmd==='/emergency') return void await send(env,chatId,await emergencyDoctor(env,user,domain),{reply_markup:healthActionButtons(domain)});
  }

  if (cmd === '/gift') return void await sendPendingGiftBox(env, user, chatId, { force: true });
  if (cmd === '/invite') return void await send(env, chatId, await referralText(env, user));
  if (cmd === '/coins') {
    const row = await env.DB.prepare('SELECT coins FROM users WHERE id=?').bind(user.id).first(), coins = Number(row?.coins || 0);
    return void await send(env, chatId, `🪙 <b>Your Coins</b>\n\nBalance: <b>${coins}</b>\n\nRewards\n• 100 coins → +7 Starter days\n• 250 coins → +7 Pro days\n• 600 coins → +30 Pro days\n\nEarn more with /invite.`, { reply_markup: coinsMarkup(coins) });
  }
  if (cmd === '/coupon') return void await redeemCoupon(env, chatId, user, args[0]);

  if (cmd === '/subdomains') {
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/subdomains example.com [page]</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    const page = Math.max(1, Math.min(10, Number(args[1] || 1) || 1));
    return runSubdomainDoctor(env, chatId, user, domain, page);
  }
  if (['/check','/scan','/seo','/performance','/ssl','/provider','/links','/robots','/keywords','/mail','/main'].includes(cmd)) {
    if (!args[0]) return void await send(env, chatId, `💡 <b>Usage</b>\n<code>${cmd} example.com</code>`);
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    const action = cmd === '/main' ? 'mail' : cmd.slice(1);
    return runTool(env, chatId, user, action, domain);
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
  if (['/verified','/pending','/pwnding'].includes(cmd)) {
    const filter = cmd === '/verified' ? 'verified' : 'pending';
    const v = await filteredSitesView(env, user.id, filter, false);
    return void await send(env, chatId, v.text, { reply_markup: v.markup });
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
  const data = String(q.data || ''), sharedChat = q.message.chat.type !== 'private';
  let user, teamAccess = null;
  if (sharedChat) {
    teamAccess = await teamAccessForChat(env, q.message.chat.id);
    if (!teamAccess) { await answerCb(env, q.id, 'Team plan is not active in this chat.'); return; }
    user = teamAccess.owner;
  } else user = await upsertUser(env, q.from, q.message.chat.id);
  if (user.blocked) { await answerCb(env, q.id, 'Account access unavailable.'); return; }
  if (sharedChat && (data.startsWith('tz:') || data.startsWith('buyplan:') || data.startsWith('redeem:') || data === 'couponhelp:show' || data.startsWith('giftopen:') || data.startsWith('teamcode:') || data.startsWith('admin'))) { await answerCb(env, q.id, 'Open WEB DOCTOR PRO privately for this action.'); return; }
  if (data.startsWith('tz:')) {
    const tz = data.slice(3); if (await setTimezone(env, user.id, tz)) { await answerCb(env, q.id, `Timezone: ${tz}`); return send(env, q.message.chat.id, `✅ <b>Timezone set</b>\n\n🕒 ${esc(formatInTimezone(nowIso(), tz))}`); }
  }
  if (data.startsWith('sites:')) {
    const filter = data.slice('sites:'.length);
    if (!['all','verified','pending'].includes(filter)) return answerCb(env,q.id,'Invalid filter.');
    const v = await filteredSitesView(env, user.id, filter, false);
    await answerCb(env,q.id,'Updated');
    return edit(env,q.message.chat.id,q.message.message_id,v.text,{reply_markup:v.markup});
  }

  if (data.startsWith('buyplan:')) {
    const plan = data.slice('buyplan:'.length);
    if (!['starter','pro','team'].includes(plan)) return answerCb(env, q.id, 'Invalid plan.');
    await answerCb(env, q.id, 'Opening Telegram Stars checkout…');
    try { return await sendPlanInvoice(env, q.message.chat.id, user, plan); }
    catch { return send(env, q.message.chat.id, '⚠️ <b>Stars checkout could not open</b>\n\nPlease try again with <code>/subscribe ' + esc(plan) + '</code>.'); }
  }
  if (data === 'team:plans') { await answerCb(env, q.id, 'Plans'); return send(env, q.message.chat.id, plansText(user), { reply_markup: plansMarkup() }); }
  if (data === 'teamcode:new') {
    if (activePlan(user) !== 'team') return answerCb(env, q.id, 'Team plan required.');
    const x = await issueTeamActivationCode(env, user.id); await answerCb(env, q.id, 'New Team code created.');
    return send(env, q.message.chat.id, `🔑 <b>New 24-hour Team activation code</b>\n\n<code>${x.code}</code>\n\nOnly you can activate it. Make the bot admin in the target group and send this code there.`);
  }
  if (data.startsWith('redeem:')) { await answerCb(env, q.id, 'Redeeming coins…'); return redeemCoins(env, q.message.chat.id, user, data.slice(7)); }
  if (data === 'couponhelp:show') { await answerCb(env, q.id, 'Coupon'); return send(env, q.message.chat.id, '🎟 Redeem a coupon with:\n<code>/coupon YOURCODE</code>'); }

  if (data.startsWith('giftopen:')) {
    const giftId = Number(data.slice('giftopen:'.length));
    if (!Number.isInteger(giftId) || giftId <= 0) return answerCb(env, q.id, 'Invalid gift.');
    return claimGift(env, q, user, giftId);
  }

  if (data.startsWith('admin') && await isAdmin(env, user) && String(q.from?.id) === ADMIN_TELEGRAM_ID && String(q.message.chat?.id) === ADMIN_TELEGRAM_ID && q.message.chat?.type === 'private') {
    await answerCb(env, q.id, 'Admin');
    if (data === 'admin:home' || data === 'admin:stats') return send(env, q.message.chat.id, await adminStatsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:users') { const v = await adminUsersView(env); return send(env, q.message.chat.id, v.text, { reply_markup: v.markup }); }
    if (data === 'admin:registrations') return send(env,q.message.chat.id,await registrationAdminText(env),{reply_markup:{inline_keyboard:[[{text:'🟢 Open',callback_data:'adminreg:open'},{text:'🔴 Close',callback_data:'adminreg:close'}],[{text:'🔄 Refresh',callback_data:'admin:registrations'}],[{text:'↩️ Admin Home',callback_data:'admin:home'}]]}});
    if (data === 'admin:email') return send(env,q.message.chat.id,await smtpStatusText(env),{reply_markup:{inline_keyboard:[[{text:'🧪 Send Test',callback_data:'adminemail:test'},{text:'⏯ Toggle',callback_data:'adminemail:toggle'}],[{text:'📖 App Password Guide',callback_data:'adminemail:guide'}],[{text:'↩️ Admin Home',callback_data:'admin:home'}]]}});
    if (data.startsWith('adminreg:')) { const open=data.endsWith(':open'); await setAppMeta(env,'registrations_open',open?'1':'0'); if(open) await notifyRegistrationWaitlist(env,80); return send(env,q.message.chat.id,await registrationAdminText(env),{reply_markup:adminMenuMarkup()}); }
    if (data.startsWith('adminemail:')) { const action=data.split(':')[1]; const cfg=await env.DB.prepare('SELECT * FROM smtp_config WHERE id=1').first(); if(action==='guide') return send(env,q.message.chat.id,`📖 <b>Gmail App Password Setup</b>

1. Use a separate Gmail account for WEB DOCTOR PRO.
2. Turn on Google 2-Step Verification.
3. Open Google Account → Security → App passwords.
4. Create an App Password named WEB DOCTOR PRO.
5. Copy the 16-character password once.
6. Send privately here:
<code>/admin_email_setup secondaccount@gmail.com APP_PASSWORD</code>

⚠️ Do not use your normal Google Account password.`); if(!cfg) return send(env,q.message.chat.id,'⚪ Email sender is not configured. Use /admin_email for setup instructions.'); if(action==='toggle'){await env.DB.prepare('UPDATE smtp_config SET active=CASE WHEN active=1 THEN 0 ELSE 1 END,updated_at=? WHERE id=1').bind(nowIso()).run(); return send(env,q.message.chat.id,await smtpStatusText(env),{reply_markup:adminMenuMarkup()});} if(action==='test'){const x=await smtpConfig(env); if(!x)return send(env,q.message.chat.id,'⚪ Email sender is disabled or unavailable.'); try{await smtpSendWithCreds(x.sender_email,x.appPassword,{to:x.sender_email,subject:'WEB DOCTOR PRO email test',text:'Email notifications are working.'});return send(env,q.message.chat.id,'✅ Test email sent successfully.');}catch(e){return send(env,q.message.chat.id,`❌ Test failed: ${esc(short(e.message,300))}`);}} }
    if (data === 'admin:coupons') return send(env, q.message.chat.id, await adminCouponsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:ads') { const v = await adminAdsView(env); return edit(env, q.message.chat.id, q.message.message_id, v.text, { reply_markup: v.markup }); }
    if (data.startsWith('adminads:')) {
      const turnOn = data.endsWith(':on'); await setAppMeta(env, 'ads_enabled', turnOn ? '1' : '0');
      const v = await adminAdsView(env); return edit(env, q.message.chat.id, q.message.message_id, v.text, { reply_markup: v.markup });
    }
    if (data.startsWith('adminad:')) {
      const [, action, idRaw] = data.split(':'), adId = Number(idRaw);
      if (!adId) return answerCb(env, q.id, 'Invalid ad.');
      if (action === 'ask') return edit(env, q.message.chat.id, q.message.message_id, `🗑 <b>Delete ad #${adId}?</b>\n\nThis permanently removes the ad record.`, { reply_markup: { inline_keyboard: [[{ text: '🗑 Yes, Delete', callback_data: `adminad:delete:${adId}` }, { text: 'Cancel', callback_data: 'admin:ads' }]] } });
      if (action === 'delete') await env.DB.prepare('DELETE FROM ads WHERE id=?').bind(adId).run();
      if (action === 'on' || action === 'off') await env.DB.prepare('UPDATE ads SET active=?,updated_at=? WHERE id=?').bind(action === 'on' ? 1 : 0, nowIso(), adId).run();
      if (action === 'edit') { const ad = await env.DB.prepare('SELECT id FROM ads WHERE id=?').bind(adId).first(); if (!ad) return send(env,q.message.chat.id,'❌ Ad not found.'); await setAdminSession(env,user.id,'ad_edit',{id:adId}); return send(env,q.message.chat.id,`✏️ Send replacement content for ad #${adId} as text, image, video, or voice.`); }
      const v = await adminAdsView(env); return edit(env, q.message.chat.id, q.message.message_id, v.text, { reply_markup: v.markup });
    }
    if (data === 'admin:broadcasts') return send(env, q.message.chat.id, await adminBroadcastsText(env), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:plans') return send(env, q.message.chat.id, plansText(user), { reply_markup: adminMenuMarkup() });
    if (data === 'admin:adcreate') { await setAdminSession(env,user.id,'ad_create'); return send(env,q.message.chat.id,'➕ <b>Create Ad</b>\n\nSend text, image, video, or voice now.'); }
    if (data === 'admin:broadcastcreate') { await setAdminSession(env,user.id,'broadcast_create'); return send(env,q.message.chat.id,'📢 <b>Create Broadcast</b>\n\nSend text, image, video, or voice now.'); }
    if (data.startsWith('adminuser:')) { const v=await adminUserDetail(env,Number(data.split(':')[1])); return send(env,q.message.chat.id,v.text,{reply_markup:v.markup}); }
    const id = Number(data.split(':')[1]);
    if (data.startsWith('adminsetfree:') || data.startsWith('adminsetstarter:') || data.startsWith('adminsetpro:') || data.startsWith('adminsetteam:')) {
      const plan = data.startsWith('adminsetfree:') ? 'free' : data.startsWith('adminsetteam:') ? 'team' : data.startsWith('adminsetpro:') ? 'pro' : 'starter';
      const target = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
      if (!target) return send(env, q.message.chat.id, '❌ User not found.');
      const expiry = await adminSetExactPlan(env, target, plan, 30);
      const teamActivation = plan === 'team' ? await issueTeamActivationCode(env, target.id) : null;
      await send(env, target.chat_id, `🛠 <b>Your plan was updated by admin</b>\n\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>${expiry ? `\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}` : ''}${teamActivation ? `\n\n🔑 Team activation code (24h)\n<code>${teamActivation.code}</code>` : ''}`).catch(() => {});
      const v = await adminUserDetail(env, id); return send(env, q.message.chat.id, v.text, { reply_markup: v.markup });
    }
    if (/^admingift(50|100|250):/.test(data)) {
      const amount = Number(/^admingift(50|100|250):/.exec(data)[1]);
      const target = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(id).first();
      if (!target) return send(env, q.message.chat.id, '❌ User not found.');
      const gift = await createGift(env, id, amount);
      return send(env, q.message.chat.id, `🎁 Gift #${gift.id} queued: <b>${gift.coins} coins</b>. The user will see the gift box on their next interaction.`);
    }
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
  if (action === 'score') return send(env,q.message.chat.id,await healthScoreText(env,user,domain),{reply_markup:healthActionButtons(domain)});
  if (action === 'compare') return send(env,q.message.chat.id,await compareText(env,user,domain),{reply_markup:healthActionButtons(domain)});
  if (action === 'fix') return send(env,q.message.chat.id,await fixesText(env,user,domain),{reply_markup:healthActionButtons(domain)});
  if (action === 'emergency') return send(env,q.message.chat.id,await emergencyDoctor(env,user,domain),{reply_markup:healthActionButtons(domain)});
  if (['check','scan','seo','performance','ssl','provider','links','robots','keywords'].includes(action)) return runTool(env, q.message.chat.id, user, action, domain);
}

async function handleTelegram(env, update) {
  await syncBotProfile(env);
  await syncMiniAppMenu(env).catch(() => {});
  if (update.pre_checkout_query) return handlePreCheckout(env, update.pre_checkout_query);
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message || update.channel_post; if (!msg?.chat) return;
  if (msg.chat.type !== 'private') return handleTeamChatUpdate(env, msg);
  if (!msg.from) return;
  const existingUser = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(msg.from.id)).first();
  if (!existingUser && !(await registrationIsOpen(env))) { await waitlistRegistration(env,msg.from,msg.chat.id); await reactToMessage(env,msg,'🚫'); return send(env,msg.chat.id,'🚪 <b>New user registration is currently closed</b>\n\nWEB DOCTOR PRO is temporarily not accepting new accounts. You have been added to the waiting list automatically.\n\nWhen registrations reopen, I will message you here.'); }
  let user = await upsertUser(env, msg.from, msg.chat.id);
  if (user.blocked) { await reactToMessage(env,msg,'🚫'); return send(env,msg.chat.id,'🚫 <b>Account access unavailable</b>\n\nPlease contact support if you believe this is a mistake.'); }
  await sendPendingGiftBox(env, user, msg.chat.id).catch(() => false);
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
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.notify_days,u.*,d.name,d.expires_at,d.ssl_expires_at FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.timezone_configured=1 AND u.blocked=0`).all();
  for (const row of rows.results) {
    let thresholds; try { thresholds = JSON.parse(row.notify_days); } catch { thresholds = ALERT_DAYS; }
    for (const item of [{kind:'domain-expiry',iso:row.expires_at,emoji:'📅',label:'Domain'}, {kind:'ssl-expiry',iso:row.ssl_expires_at,emoji:'🔐',label:'Certificate'}]) {
      const d = daysUntil(item.iso); if (d === null || !thresholds.includes(d)) continue;
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO notifications(watch_id,kind,threshold,expiry_snapshot,sent_at) VALUES(?,?,?,?,?)`).bind(row.watch_id,item.kind,d,item.iso,nowIso()).run();
      if (!inserted.meta.changes) continue;
      try { const alert=`🚨 <b>${item.label} Expiry Alert</b>\n\n🌐 <b>${esc(row.name)}</b>\n${item.emoji} ${d===0 ? 'Expires today' : `Expires in ${d} day(s)`}\n🕒 ${esc(formatInTimezone(item.iso,row.timezone))}\n\n💡 Renew or verify it early to avoid interruption.`; await send(env,row.chat_id,alert); await sendUserEmail(env,row,`${item.label} expiry alert — ${row.name}`,alert.replace(/<[^>]+>/g,'')).catch(()=>false); }
      catch (e) { console.error(JSON.stringify({event:'expiry_alert_failed',domain:row.name,error:e.message})); }
    }
  }
}
async function checkUptime(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.uptime_state,w.uptime_last_status,w.uptime_fail_count,w.incident_started_at,u.*,d.name FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.blocked=0 ORDER BY COALESCE(w.uptime_last_checked_at,'') LIMIT 80`).all();
  for (const row of rows.results) {
    let status=0,error=null,rawState='down'; const started=Date.now();
    try { const r=await fetch(`https://${row.name}`,{method:'HEAD',redirect:'follow',headers:{'user-agent':`WEB-DOCTOR-PRO/${VERSION}`},signal:AbortSignal.timeout(10000)}); status=r.status; rawState=r.status<500?'up':'down'; }
    catch(e){ error=short(e.message,300); rawState='down'; }
    const latency=Date.now()-started, previous=row.uptime_state||'unknown';
    const failCount=rawState==='down'?Number(row.uptime_fail_count||0)+1:0;
    let state=rawState, incidentStarted=row.incident_started_at;
    if(rawState==='down' && failCount<UPTIME_CONFIRM_FAILURES){ state=previous==='down'?'down':previous; if(!incidentStarted) incidentStarted=nowIso(); }
    if(rawState==='down' && failCount>=UPTIME_CONFIRM_FAILURES && !incidentStarted) incidentStarted=nowIso();
    const downTransition=rawState==='down' && failCount>=UPTIME_CONFIRM_FAILURES && previous!=='down';
    const recovery=rawState==='up' && previous==='down';
    if(rawState==='up' && previous!=='down') incidentStarted=null;
    await env.DB.prepare(`INSERT INTO uptime_samples(watch_id,checked_at,state,http_status,latency_ms) VALUES(?,?,?,?,?)`).bind(row.watch_id,nowIso(),rawState,status||null,latency).run();
    await env.DB.prepare(`UPDATE watches SET uptime_state=?,uptime_last_status=?,uptime_last_checked_at=?,uptime_changed_at=CASE WHEN uptime_state<>? THEN ? ELSE uptime_changed_at END,uptime_last_error=?,uptime_fail_count=?,incident_started_at=?,updated_at=? WHERE id=?`).bind(state,status||null,nowIso(),state,nowIso(),error,failCount,incidentStarted,nowIso(),row.watch_id).run();
    if(downTransition){
      const startAt=incidentStarted||nowIso();
      await env.DB.prepare(`INSERT INTO uptime_incidents(watch_id,started_at,start_status,created_at) VALUES(?,?,?,?)`).bind(row.watch_id,startAt,status||null,nowIso()).run();
      const text=`🚨 <b>WEBSITE DOWN</b>\n\n🌐 <b>${esc(row.name)}</b>\n🔴 Confirmed unavailable after ${UPTIME_CONFIRM_FAILURES} consecutive checks\n📡 ${status?`HTTP ${status}`:'Connection failed'}\n🕒 Detected: ${esc(formatInTimezone(startAt,row.timezone||'UTC'))}\n\nWEB DOCTOR PRO will keep checking and send one recovery alert when the site returns.`;
      await send(env,row.chat_id,text).catch(()=>{}); await sendUserEmail(env,row,`WEBSITE DOWN — ${row.name}`,text.replace(/<[^>]+>/g,'')).catch(()=>false);
    }
    if(recovery){
      const open=await env.DB.prepare(`SELECT * FROM uptime_incidents WHERE watch_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1`).bind(row.watch_id).first();
      const startAt=open?.started_at||row.incident_started_at||nowIso(), duration=Math.max(0,Math.round((Date.now()-new Date(startAt).getTime())/1000));
      if(open) await env.DB.prepare(`UPDATE uptime_incidents SET ended_at=?,recovery_status=?,duration_seconds=? WHERE id=?`).bind(nowIso(),status||null,duration,open.id).run();
      await env.DB.prepare('UPDATE watches SET incident_started_at=NULL,updated_at=? WHERE id=?').bind(nowIso(),row.watch_id).run();
      const mins=duration<60?`${duration}s`:`${Math.floor(duration/60)}m ${duration%60}s`;
      const text=`🟢 <b>WEBSITE RECOVERED</b>\n\n🌐 <b>${esc(row.name)}</b>\n✅ Website is reachable again\n📡 HTTP ${status}\n⏱ Downtime: <b>${mins}</b>\n🕒 Recovered: ${esc(formatInTimezone(nowIso(),row.timezone||'UTC'))}`;
      await send(env,row.chat_id,text).catch(()=>{}); await sendUserEmail(env,row,`WEBSITE RECOVERED — ${row.name}`,text.replace(/<[^>]+>/g,'')).catch(()=>false);
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
      const scheduledReport = await runFullScan(env, row.chat_id, usage.user || row, row.name, { silentProgress: true, scheduled: true });
      if (scheduledReport && row.notification_email && ['pro','team'].includes(activePlan(usage.user || row))) { const filename=`WEB-DOCTOR-PRO-${row.name}-${scheduledReport.reportId}.pdf`; const plain=`${row.report_schedule.toUpperCase()} WEB DOCTOR PRO report for ${row.name}\nHealth score: ${scheduledReport.health?.healthScore ?? 'N/A'}/100\nUptime: ${Number(scheduledReport.availability?.uptime ?? 100).toFixed(2)}%\nIncidents (30d): ${scheduledReport.availability?.incidents ?? 0}\nSEO: ${scheduledReport.seo?.score ?? 'N/A'}/100\nPerformance: ${scheduledReport.pageSpeed?.performance ?? 'N/A'}/100`; await sendUserEmail(env,usage.user || row,`WEB DOCTOR PRO ${row.report_schedule} report — ${row.name}`,plain,{pdfBytes:scheduledReport.pdfBytes,pdfName:filename}).catch(()=>false); }
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


const MINI_USER_COMMANDS = new Set([
  '/start','/about','/help','/timezone','/time','/status','/settings','/plans','/plan','/subscribe',
  '/team','/team_status','/team_code','/team_activate','/email','/score','/compare','/fix','/emergency',
  '/gift','/invite','/coins','/coupon','/check','/scan','/seo','/performance','/ssl','/provider','/links',
  '/robots','/keywords','/mail','/main','/subdomains','/add','/verify','/schedule','/google_setup','/google','/google_disconnect','/analytics',
  '/list','/verified','/pending','/pwnding','/remove'
]);

function miniSafeEqualHex(a, b) {
  a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase();
  if (a.length !== b.length || !a.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function miniHex(bytes) { return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join(''); }
async function miniHmac(keyBytes, value) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(value))));
}
async function validateMiniAppInitData(env, raw) {
  if (!env.TELEGRAM_BOT_TOKEN || !raw || String(raw).length > 16384) return null;
  const params = new URLSearchParams(String(raw));
  const receivedHash = params.get('hash'); if (!receivedHash) return null;
  const pairs = [];
  for (const [k, v] of params.entries()) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = await miniHmac(new TextEncoder().encode('WebAppData'), env.TELEGRAM_BOT_TOKEN);
  const expected = miniHex(await miniHmac(secret, pairs.join('\n')));
  if (!miniSafeEqualHex(expected, receivedHash)) return null;
  const authDate = Number(params.get('auth_date') || 0), now = Math.floor(Date.now() / 1000);
  if (!authDate || authDate > now + 60 || now - authDate > MINI_APP_MAX_AGE_SECONDS) return null;
  let telegramUser = null;
  try { telegramUser = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!telegramUser?.id) return null;
  return { params, telegramUser, authDate };
}
function miniError(message, status = 400) { const e = new Error(message); e.status = status; return e; }
async function miniAuth(request, env) {
  const valid = await validateMiniAppInitData(env, request.headers.get('x-telegram-init-data'));
  if (!valid) throw miniError('Telegram Mini App authentication failed. Reopen the dashboard from the bot.', 401);
  let user = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(valid.telegramUser.id)).first();
  if (!user) {
    if (!(await registrationIsOpen(env))) throw miniError('New user registration is currently closed.', 403);
    user = await upsertUser(env, valid.telegramUser, valid.telegramUser.id);
  } else {
    user = await upsertUser(env, valid.telegramUser, user.chat_id || valid.telegramUser.id);
  }
  if (user.blocked) throw miniError('Account access is unavailable.', 403);
  return { user, telegramUser: valid.telegramUser };
}
async function miniFirst(env, sql, binds = []) { try { return await env.DB.prepare(sql).bind(...binds).first(); } catch { return null; } }
async function miniAll(env, sql, binds = []) { try { const r = await env.DB.prepare(sql).bind(...binds).all(); return r.results || []; } catch { return []; } }
async function miniBootstrap(env, user) {
  const fresh0 = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(user.id).first();
  const fresh = await refreshExpiredPlan(env, fresh0 || user), current = activePlan(fresh), cfg = PLAN_CONFIG[current];
  const usage = (await dailyUsage(env, fresh)).row;
  const sites = await miniAll(env, `SELECT d.name,d.expires_at,d.ssl_expires_at,d.registrar,d.hosting_provider,d.dns_provider,d.last_seo_score,d.last_geo_score,d.last_aeo_score,d.last_pagespeed_score,w.verified_at,w.uptime_state,w.uptime_last_status,w.uptime_last_checked_at,w.report_schedule,w.next_report_at,w.last_health_score,w.last_health_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.name`, [fresh.id]);
  const google = await miniFirst(env, 'SELECT email,updated_at FROM google_connections WHERE user_id=?', [fresh.id]);
  const workspace = await miniFirst(env, 'SELECT chat_id,chat_type,title,plan_expires_at,active FROM team_chats WHERE owner_user_id=? AND active=1 ORDER BY id DESC LIMIT 1', [fresh.id]);
  const pendingGift = await miniFirst(env, "SELECT id,coins,created_at FROM user_gifts WHERE user_id=? AND status='pending' ORDER BY id LIMIT 1", [fresh.id]);
  const incidents = await miniAll(env, `SELECT i.started_at,i.ended_at,i.duration_seconds,d.name FROM uptime_incidents i JOIN watches w ON w.id=i.watch_id JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? ORDER BY i.started_at DESC LIMIT 8`, [fresh.id]);
  const changes = await miniAll(env, `SELECT e.kind,e.label,e.old_value,e.new_value,e.detected_at,d.name FROM website_change_events e JOIN watches w ON w.id=e.watch_id JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? ORDER BY e.detected_at DESC LIMIT 8`, [fresh.id]);
  let admin = null;
  if (await isAdmin(env, fresh)) {
    const usersCount = await miniFirst(env, 'SELECT COUNT(*) c FROM users');
    const verified = await miniFirst(env, 'SELECT COUNT(*) c FROM watches WHERE active=1 AND verified_at IS NOT NULL');
    const pending = await miniFirst(env, 'SELECT COUNT(*) c FROM watches WHERE active=1 AND verified_at IS NULL');
    const down = await miniFirst(env, "SELECT COUNT(*) c FROM watches WHERE active=1 AND verified_at IS NOT NULL AND uptime_state='down'");
    const waitlist = await miniFirst(env, 'SELECT COUNT(*) c FROM registration_waitlist WHERE notified_reopened_at IS NULL');
    const broadcastsCount = await miniFirst(env, 'SELECT COUNT(*) c FROM broadcasts');
    const users = await miniAll(env, `SELECT id,telegram_user_id,username,first_name,plan,plan_expires_at,blocked,coins,notification_email,last_seen_at,created_at FROM users ORDER BY COALESCE(last_seen_at,created_at) DESC LIMIT 80`);
    const coupons = await miniAll(env, 'SELECT id,code,plan,bonus_days,bonus_coins,max_uses,uses_count,expires_at,active,created_at FROM coupons ORDER BY id DESC LIMIT 50');
    const broadcasts = await miniAll(env, 'SELECT id,content_type,text_content,status,sent_count,failed_count,created_at,updated_at FROM broadcasts ORDER BY id DESC LIMIT 30');
    const ads = await miniAll(env, 'SELECT id,title,content_type,text_content,active,impressions,created_at,updated_at FROM ads ORDER BY id DESC LIMIT 30');
    const smtp = await miniFirst(env, 'SELECT sender_email,active,updated_at FROM smtp_config WHERE id=1');
    admin = {
      stats: { users: Number(usersCount?.c || 0), verified: Number(verified?.c || 0), pending: Number(pending?.c || 0), down: Number(down?.c || 0), waitlist: Number(waitlist?.c || 0), broadcasts: Number(broadcastsCount?.c || 0) },
      registrationsOpen: await registrationIsOpen(env), users, coupons, broadcasts, ads, smtp
    };
  }
  return {
    ok: true, version: VERSION, user: { id:fresh.id, telegram_user_id:fresh.telegram_user_id, username:fresh.username, first_name:fresh.first_name, timezone:fresh.timezone, timezone_configured:fresh.timezone_configured, notification_email:fresh.notification_email, plan:current, plan_expires_at:fresh.plan_expires_at, coins:Number(fresh.coins||0), blocked:Number(fresh.blocked||0) },
    usage, currentPlanConfig: cfg, plans: PLAN_CONFIG, sites, google: { connected:Boolean(google), email:google?.email || null }, team: { workspace }, pendingGift, incidents, changes, admin
  };
}
async function miniRunCommand(env, user, command, adminRequested = false) {
  command = String(command || '').trim();
  if (!command || command.length > 4096 || !command.startsWith('/')) throw miniError('Invalid command.');
  const base = command.split(/\s+/)[0].toLowerCase().split('@')[0];
  const adminCommand = base.startsWith('/admin');
  if (adminCommand || adminRequested) {
    if (!(await isAdmin(env, user))) throw miniError('Admin access required.', 403);
    if (!adminCommand) throw miniError('Admin actions must use an /admin command.');
  } else if (!MINI_USER_COMMANDS.has(base)) throw miniError('This command is not available from the Mini App.', 400);
  const chatId = Number(user.chat_id || user.telegram_user_id);
  const msg = { message_id: 0, date: Math.floor(Date.now()/1000), chat: { id: chatId, type: 'private' }, from: { id: Number(user.telegram_user_id), username: user.username || undefined, first_name: user.first_name || 'User' }, text: command };
  await handleCommand(env, msg, user);
  return true;
}
async function miniAdminManage(env, user, body) {
  if (!(await isAdmin(env, user))) throw miniError('Admin access required.', 403);
  const action = String(body?.action || '');
  if (action === 'registration') { const open = Boolean(body.open); await setAppMeta(env, 'registrations_open', open ? '1' : '0'); if (open) await notifyRegistrationWaitlist(env).catch(()=>0); return { ok:true, registrationsOpen:open }; }
  if (action === 'broadcast_create') {
    const text = short(String(body.text || ''), 4096); if (!text) throw miniError('Broadcast text is required.');
    const buttons = parseButtonsSpec(String(body.buttons || ''));
    const r = await env.DB.prepare(`INSERT INTO broadcasts(content_type,text_content,telegram_file_id,buttons_json,status,cursor_user_id,sent_count,failed_count,created_at,updated_at) VALUES('text',?,NULL,?,'draft',0,0,0,?,?)`).bind(text,JSON.stringify(buttons),nowIso(),nowIso()).run();
    return { ok:true, id:Number(r.meta?.last_row_id || 0) };
  }
  if (action === 'broadcast_queue') { const id=Number(body.id); if(!id) throw miniError('Invalid broadcast.'); await env.DB.prepare("UPDATE broadcasts SET status='queued',cursor_user_id=0,updated_at=? WHERE id=? AND status='draft'").bind(nowIso(),id).run(); return {ok:true}; }
  if (action === 'broadcast_delete') { const id=Number(body.id); if(!id) throw miniError('Invalid broadcast.'); await env.DB.prepare("DELETE FROM broadcasts WHERE id=? AND status='draft'").bind(id).run(); return {ok:true}; }
  if (action === 'ad_create_text') {
    const title = short(String(body.title || 'Sponsored'), 120), text = short(String(body.text || ''), 4096);
    if (!text) throw miniError('Ad text is required.');
    const buttons = parseButtonsSpec(String(body.buttons || ''));
    const r = await env.DB.prepare(`INSERT INTO ads(title,content_type,text_content,telegram_file_id,buttons_json,active,impressions,created_at,updated_at) VALUES(?,'text',?,NULL,?,0,0,?,?)`).bind(title,text,JSON.stringify(buttons),nowIso(),nowIso()).run();
    return { ok:true, id:Number(r.meta?.last_row_id || 0) };
  }
  if (action === 'ad_toggle') { const id=Number(body.id); if(!id) throw miniError('Invalid ad.'); await env.DB.prepare('UPDATE ads SET active=CASE WHEN active=1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?').bind(nowIso(),id).run(); return {ok:true}; }
  if (action === 'ad_delete') { const id=Number(body.id); if(!id) throw miniError('Invalid ad.'); await env.DB.prepare('DELETE FROM ads WHERE id=?').bind(id).run(); return {ok:true}; }
  throw miniError('Unsupported admin dashboard action.');
}
async function miniUploadTelegramMedia(env, file, contentType) {
  if (!['photo','video','voice'].includes(contentType)) throw miniError('Unsupported media type.');
  if (!(file instanceof File) || !file.size) throw miniError('Choose a media file.');
  if (file.size > 20 * 1024 * 1024) throw miniError('Media file is too large for dashboard upload.');
  const method = contentType === 'photo' ? 'sendPhoto' : contentType === 'video' ? 'sendVideo' : 'sendVoice';
  const form = new FormData(); form.set('chat_id', ADMIN_TELEGRAM_ID); form.set(contentType, file, file.name || `${contentType}.bin`);
  const r = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method:'POST', body:form });
  const data = await r.json(); if (!data.ok) throw miniError(`Telegram media upload failed: ${data.description || r.status}`, 502);
  const message = data.result; let fileId = null;
  if (contentType === 'photo') fileId = message.photo?.[message.photo.length - 1]?.file_id || null;
  if (contentType === 'video') fileId = message.video?.file_id || null;
  if (contentType === 'voice') fileId = message.voice?.file_id || null;
  if (!fileId) throw miniError('Telegram did not return a reusable media file ID.', 502);
  await deleteTelegramMessage(env, ADMIN_TELEGRAM_ID, message.message_id).catch(()=>false);
  return fileId;
}
async function miniAdminMedia(request, env, user) {
  if (!(await isAdmin(env, user))) throw miniError('Admin access required.', 403);
  const form = await request.formData(), mode = String(form.get('mode') || ''), contentType = String(form.get('content_type') || ''), file = form.get('file'), text = short(String(form.get('text') || ''), 4096), buttons = parseButtonsSpec(String(form.get('buttons') || ''));
  const fileId = await miniUploadTelegramMedia(env, file, contentType);
  if (mode === 'broadcast') {
    const r = await env.DB.prepare(`INSERT INTO broadcasts(content_type,text_content,telegram_file_id,buttons_json,status,cursor_user_id,sent_count,failed_count,created_at,updated_at) VALUES(?,?,?,?, 'draft',0,0,0,?,?)`).bind(contentType,text||null,fileId,JSON.stringify(buttons),nowIso(),nowIso()).run();
    return { ok:true, id:Number(r.meta?.last_row_id || 0), mode };
  }
  if (mode === 'ad') {
    const title = short(String(form.get('title') || 'Sponsored'), 120);
    const r = await env.DB.prepare(`INSERT INTO ads(title,content_type,text_content,telegram_file_id,buttons_json,active,impressions,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?)`).bind(title,contentType,text||null,fileId,JSON.stringify(buttons),nowIso(),nowIso()).run();
    return { ok:true, id:Number(r.meta?.last_row_id || 0), mode };
  }
  throw miniError('Choose broadcast or ad upload mode.');
}
function miniHtmlResponse() {
  return new Response(MINI_APP_HTML, { headers: {
    'content-type':'text/html; charset=utf-8', 'cache-control':'no-store, max-age=0', 'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer', 'permissions-policy':'camera=(), microphone=(), geolocation=()',
    'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; font-src 'self' data:; base-uri 'none'; form-action 'none'",
    'x-web-doctor-signature':signature()
  } });
}
function miniJsonError(e) { return json({ ok:false, error:short(e?.message || 'Mini App request failed.', 500) }, Number(e?.status || 500)); }
async function syncMiniAppMenu(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const current = await appMeta(env, 'telegram_miniapp_version'); if (current === VERSION) return;
  await tg(env, 'setChatMenuButton', { menu_button: { type:'web_app', text:'Open', web_app:{ url:MINI_APP_URL } } });
  await setAppMeta(env, 'telegram_miniapp_version', VERSION);
}

export { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec, validateMiniAppInitData };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/app' && request.method === 'GET') return miniHtmlResponse();
    if (url.pathname === '/api/mini/bootstrap' && request.method === 'GET') { try { const {user}=await miniAuth(request,env); return json(await miniBootstrap(env,user)); } catch(e) { return miniJsonError(e); } }
    if (url.pathname === '/api/mini/action' && request.method === 'POST') { try { const {user}=await miniAuth(request,env); const body=await request.json(); const command=String(body?.command||''); const admin=Boolean(body?.admin); ctx.waitUntil(miniRunCommand(env,user,command,admin).catch((e)=>console.error(JSON.stringify({event:'mini_command_failed',error:e.message})))); return json({ok:true,queued:true}); } catch(e) { return miniJsonError(e); } }
    if (url.pathname === '/api/mini/admin/manage' && request.method === 'POST') { try { const {user}=await miniAuth(request,env); const body=await request.json(); return json(await miniAdminManage(env,user,body)); } catch(e) { return miniJsonError(e); } }
    if (url.pathname === '/api/mini/admin/media' && request.method === 'POST') { try { const {user}=await miniAuth(request,env); return json(await miniAdminMedia(request,env,user)); } catch(e) { return miniJsonError(e); } }
    if (url.pathname === '/health') {
      ctx.waitUntil(Promise.all([syncBotProfile(env),syncMiniAppMenu(env)]));
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
      await syncMiniAppMenu(env).catch(() => {});
      await cleanupTemporaryMessages(env);
      await cleanupCoupons(env);
      await processBroadcasts(env);
      await checkUptime(env);
      await monitorWebsiteChanges(env);
      await notifyRegistrationWaitlist(env);
      await cleanupMonitoringHistory(env);
      await refreshDomains(env);
      await sendExpiryAlerts(env);
      await sendScheduledReports(env);
    })().catch((e) => console.error(JSON.stringify({ event: 'scheduled_failed', error: e.message }))));
  }
};
