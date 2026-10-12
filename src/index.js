import { normalizeDomain, parseRdap, daysUntil, formatInTimezone, validTimezone } from './lib.js';

const ALERT_DAYS = [30, 14, 7, 3, 1, 0];
const TELEGRAM_API = 'https://api.telegram.org';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

async function tg(env, method, body) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not configured');
  const r = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || r.status}`);
  return data.result;
}

async function send(env, chatId, text, extra = {}) {
  return tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

async function upsertUser(env, from, chatId) {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO users (telegram_user_id, chat_id, username, first_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id, username=excluded.username, first_name=excluded.first_name, updated_at=excluded.updated_at`)
    .bind(String(from.id), String(chatId), from.username || null, from.first_name || null, now, now).run();
  return env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(from.id)).first();
}

async function rdapLookup(domain) {
  const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
  const r = await fetch(url, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': 'WEB-DOCTOR-PRO/1.0' }, redirect: 'follow' });
  if (r.status === 404) return { domain, found: false, rdapUrl: r.url || url };
  if (!r.ok) throw new Error(`RDAP returned HTTP ${r.status}`);
  const data = await r.json();
  return { domain, found: true, rdapUrl: r.url || url, ...parseRdap(data) };
}

async function saveDomain(env, info) {
  const now = new Date().toISOString();
  const next = new Date(Date.now() + 12 * 3600000).toISOString();
  await env.DB.prepare(`INSERT INTO domains (name, expires_at, registered_at, registrar, rdap_url, status, last_checked_at, next_check_at, last_error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at, registered_at=excluded.registered_at, registrar=excluded.registrar,
      rdap_url=excluded.rdap_url, status=excluded.status, last_checked_at=excluded.last_checked_at, next_check_at=excluded.next_check_at, last_error=NULL`)
    .bind(info.domain, info.expiresAt || null, info.registeredAt || null, info.registrar || null, info.rdapUrl || null, info.found ? (info.status || 'active') : 'not-found', now, next, now).run();
  return env.DB.prepare('SELECT * FROM domains WHERE name=?').bind(info.domain).first();
}

function resultText(info, tz) {
  if (!info.found) return `🔎 <b>${esc(info.domain)}</b>\n\nNo RDAP registration record was found. The domain may be unregistered or the registry may not expose RDAP data.`;
  const d = daysUntil(info.expiresAt);
  const remaining = d === null ? 'Unknown' : d < 0 ? `Expired ${Math.abs(d)} day(s) ago` : `${d} day(s)`;
  return `🩺 <b>WEB DOCTOR PRO</b>\n\n🌐 <b>${esc(info.domain)}</b>\n📅 Expiry: <b>${esc(formatInTimezone(info.expiresAt, tz))}</b>\n⏳ Remaining: <b>${esc(remaining)}</b>\n🏢 Registrar: ${esc(info.registrar || 'Not published')}\n🧾 Status: ${esc(info.status || 'unknown')}\n\n<i>Source: registry RDAP. Some registries do not publish an expiry timestamp.</i>`;
}

async function requireTimezone(env, chatId, user) {
  if (user.timezone_configured) return true;
  await send(env, chatId, '🕒 <b>Set your timezone first</b>\n\nWEB DOCTOR PRO needs your timezone to show the correct local expiry time and reminders.\n\nChoose one below or use <code>/timezone Area/City</code>.', {
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
  await env.DB.prepare('UPDATE users SET timezone=?, timezone_configured=1, updated_at=? WHERE id=?').bind(tz, new Date().toISOString(), userId).run();
  return true;
}

async function handleCommand(env, msg, user) {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().split('@')[0];

  if (cmd === '/start' || cmd === '/help') {
    await send(env, chatId, `🩺 <b>WEB DOCTOR PRO</b>\nDomain expiry monitor for Telegram.\n\n<b>Commands</b>\n/check example.com — check expiry now\n/add example.com — monitor a domain\n/list — monitored domains\n/remove example.com — stop monitoring\n/timezone Asia/Kolkata — set local timezone\n/time — show local time\n/settings — current settings\n/help — help\n\nAutomatic alerts: ${ALERT_DAYS.join(', ')} days before expiry.`);
    if (!user.timezone_configured) await requireTimezone(env, chatId, user);
    return;
  }

  if (cmd === '/timezone') {
    const tz = args.join(' ');
    if (!tz) return void await requireTimezone(env, chatId, user);
    if (!(await setTimezone(env, user.id, tz))) return void await send(env, chatId, '❌ Invalid timezone. Example: <code>/timezone Asia/Kolkata</code>');
    await send(env, chatId, `✅ Timezone set to <b>${esc(tz)}</b>.\nCurrent local time: <b>${esc(formatInTimezone(new Date().toISOString(), tz))}</b>`);
    return;
  }

  if (cmd === '/time') {
    if (!(await requireTimezone(env, chatId, user))) return;
    await send(env, chatId, `🕒 Your local time: <b>${esc(formatInTimezone(new Date().toISOString(), user.timezone))}</b>\nTimezone: <code>${esc(user.timezone)}</code>`);
    return;
  }

  if (cmd === '/settings') {
    await send(env, chatId, `⚙️ <b>Settings</b>\nTimezone: <code>${esc(user.timezone_configured ? user.timezone : 'Not configured')}</code>\nAlerts: ${ALERT_DAYS.join(', ')} days before expiry\nExpiry source: Registry RDAP`);
    return;
  }

  if (cmd === '/check' || cmd === '/add') {
    if (!(await requireTimezone(env, chatId, user))) return;
    if (!args[0]) return void await send(env, chatId, `Usage: <code>${cmd} example.com</code>`);
    let domain;
    try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ Please enter a valid domain, e.g. <code>example.com</code>.'); }
    await send(env, chatId, `🔍 Checking <b>${esc(domain)}</b>…`);
    try {
      const info = await rdapLookup(domain);
      const row = await saveDomain(env, info);
      await send(env, chatId, resultText(info, user.timezone));
      if (cmd === '/add') {
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO watches (user_id, domain_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
          ON CONFLICT(user_id, domain_id) DO UPDATE SET active=1, updated_at=excluded.updated_at`).bind(user.id, row.id, now, now).run();
        await send(env, chatId, `✅ <b>${esc(domain)}</b> is now monitored. I’ll alert you before expiry.`);
      }
    } catch (e) {
      await send(env, chatId, `⚠️ Could not check this domain right now.\n<code>${esc(e.message)}</code>`);
    }
    return;
  }

  if (cmd === '/list') {
    const rows = await env.DB.prepare(`SELECT d.name, d.expires_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.expires_at IS NULL, d.expires_at`).bind(user.id).all();
    if (!rows.results.length) return void await send(env, chatId, '📭 You are not monitoring any domains. Use <code>/add example.com</code>.');
    const lines = rows.results.map((r, i) => `${i + 1}. <b>${esc(r.name)}</b> — ${r.expires_at ? esc(formatInTimezone(r.expires_at, user.timezone)) : 'expiry unknown'}`);
    await send(env, chatId, `📋 <b>Monitored domains</b>\n\n${lines.join('\n')}`);
    return;
  }

  if (cmd === '/remove') {
    if (!args[0]) return void await send(env, chatId, 'Usage: <code>/remove example.com</code>');
    let domain;
    try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ Invalid domain.'); }
    const r = await env.DB.prepare(`UPDATE watches SET active=0, updated_at=? WHERE user_id=? AND domain_id=(SELECT id FROM domains WHERE name=?)`).bind(new Date().toISOString(), user.id, domain).run();
    await send(env, chatId, r.meta.changes ? `✅ Stopped monitoring <b>${esc(domain)}</b>.` : `ℹ️ <b>${esc(domain)}</b> was not in your active watch list.`);
    return;
  }

  await send(env, chatId, 'Unknown command. Use /help.');
}

async function handleCallback(env, q) {
  if (!q?.from || !q?.message) return;
  const user = await upsertUser(env, q.from, q.message.chat.id);
  if (String(q.data || '').startsWith('tz:')) {
    const tz = q.data.slice(3);
    if (await setTimezone(env, user.id, tz)) {
      await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: `Timezone set: ${tz}` });
      await send(env, q.message.chat.id, `✅ Timezone set to <b>${esc(tz)}</b>.\nLocal time: <b>${esc(formatInTimezone(new Date().toISOString(), tz))}</b>`);
    }
  }
}

async function handleTelegram(env, update) {
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg?.from || !msg?.chat) return;
  const user = await upsertUser(env, msg.from, msg.chat.id);
  if (String(msg.text || '').startsWith('/')) return handleCommand(env, msg, user);
  await send(env, msg.chat.id, 'Use /check example.com to check a domain or /help for commands.');
}

async function refreshDomains(env) {
  const nowIso = new Date().toISOString();
  const due = await env.DB.prepare(`SELECT * FROM domains WHERE next_check_at IS NULL OR next_check_at <= ? ORDER BY COALESCE(next_check_at,'') LIMIT 40`).bind(nowIso).all();
  for (const row of due.results) {
    try {
      const info = await rdapLookup(row.name);
      await saveDomain(env, info);
    } catch (e) {
      const retry = new Date(Date.now() + 3 * 3600000).toISOString();
      await env.DB.prepare('UPDATE domains SET last_checked_at=?, next_check_at=?, last_error=? WHERE id=?').bind(nowIso, retry, String(e.message).slice(0, 500), row.id).run();
    }
  }
}

async function sendAlerts(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(`SELECT w.id watch_id, w.notify_days, u.chat_id, u.timezone, d.name, d.expires_at
    FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id
    WHERE w.active=1 AND u.timezone_configured=1 AND d.expires_at IS NOT NULL`).all();
  for (const row of rows.results) {
    const d = daysUntil(row.expires_at);
    if (d === null) continue;
    let thresholds;
    try { thresholds = JSON.parse(row.notify_days); } catch { thresholds = ALERT_DAYS; }
    if (!thresholds.includes(d)) continue;
    const expirySnapshot = row.expires_at;
    const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO notifications (watch_id, kind, threshold, expiry_snapshot, sent_at) VALUES (?, 'expiry', ?, ?, ?)`)
      .bind(row.watch_id, d, expirySnapshot, new Date().toISOString()).run();
    if (!inserted.meta.changes) continue;
    const label = d === 0 ? 'expires today' : `expires in ${d} day(s)`;
    try {
      await send(env, row.chat_id, `🚨 <b>Domain expiry alert</b>\n\n🌐 <b>${esc(row.name)}</b> ${label}.\n📅 Expiry: <b>${esc(formatInTimezone(row.expires_at, row.timezone))}</b>\n\nRenew it with your registrar if you want to keep the domain.`);
    } catch (e) {
      console.error(JSON.stringify({ event: 'alert_send_failed', domain: row.name, error: e.message }));
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const db = await env.DB.prepare('SELECT 1 AS ok').first();
      return json({ ok: true, service: 'WEB DOCTOR PRO', database: db?.ok === 1, telegramConfigured: Boolean(env.TELEGRAM_BOT_TOKEN), now: new Date().toISOString() });
    }
    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('Unauthorized', { status: 401 });
      const update = await request.json();
      ctx.waitUntil(handleTelegram(env, update).catch((e) => console.error(JSON.stringify({ event: 'telegram_update_failed', error: e.message }))));
      return new Response('OK');
    }
    return json({ service: 'WEB DOCTOR PRO', status: 'online', health: '/health' });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      await refreshDomains(env);
      await sendAlerts(env);
    })().catch((e) => console.error(JSON.stringify({ event: 'scheduled_failed', error: e.message }))));
  }
};
