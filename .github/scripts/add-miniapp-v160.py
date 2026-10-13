from pathlib import Path
import json

p=Path('src/index.js')
s=p.read_text()

def rep(a,b,label):
    global s
    if a not in s:
        raise SystemExit(f'missing anchor: {label}')
    s=s.replace(a,b,1)

rep("} from './lib.js';\n", "} from './lib.js';\nimport { MINI_APP_HTML } from './miniapp.js';\n", 'miniapp import')
rep("const VERSION = '1.5.1';", "const VERSION = '1.6.0';", 'version')
rep("const PUBLIC_BASE_URL = 'https://webdoctorpro.nadeemmhdm-ai.workers.dev';", "const PUBLIC_BASE_URL = 'https://webdoctorpro.nadeemmhdm-ai.workers.dev';\nconst MINI_APP_URL = `${PUBLIC_BASE_URL}/app`;", 'mini url')
rep("const LAST_UPDATED_AT = '2026-10-13T08:20:00+05:30';", "const LAST_UPDATED_AT = '2026-10-13T09:40:00+05:30';", 'last update')
rep("const MONITOR_RETENTION_DAYS = 90;", "const MONITOR_RETENTION_DAYS = 90;\nconst MINI_APP_MAX_AGE_SECONDS = 86400;", 'mini auth age')

block = r'''

const MINI_USER_COMMANDS = new Set([
  '/start','/about','/help','/timezone','/time','/status','/settings','/plans','/plan','/subscribe',
  '/team','/team_status','/team_code','/team_activate','/email','/score','/compare','/fix','/emergency',
  '/gift','/invite','/coins','/coupon','/check','/scan','/seo','/performance','/ssl','/provider','/links',
  '/robots','/keywords','/add','/verify','/schedule','/google_setup','/google','/google_disconnect','/analytics',
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
    'content-type':'text/html; charset=utf-8', 'cache-control':'public, max-age=300', 'x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer', 'permissions-policy':'camera=(), microphone=(), geolocation=()',
    'content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:; font-src 'self' data:; base-uri 'none'; form-action 'none'",
    'x-web-doctor-signature':signature()
  } });
}
function miniJsonError(e) { return json({ ok:false, error:short(e?.message || 'Mini App request failed.', 500) }, Number(e?.status || 500)); }
async function syncMiniAppMenu(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const current = await appMeta(env, 'telegram_miniapp_version'); if (current === VERSION) return;
  await tg(env, 'setChatMenuButton', { menu_button: { type:'web_app', text:'🩺 Dashboard', web_app:{ url:MINI_APP_URL } } });
  await setAppMeta(env, 'telegram_miniapp_version', VERSION);
}
'''
rep("\nexport { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec };", block + "\nexport { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec, validateMiniAppInitData };", 'mini backend insertion')

# route additions
anchor = "    if (url.pathname === '/health') {\n      ctx.waitUntil(syncBotProfile(env));"
replacement = "    if (url.pathname === '/app' && request.method === 'GET') return miniHtmlResponse();\n    if (url.pathname === '/api/mini/bootstrap' && request.method === 'GET') { try { const {user}=await miniAuth(request,env); return json(await miniBootstrap(env,user)); } catch(e) { return miniJsonError(e); } }\n    if (url.pathname === '/api/mini/action' && request.method === 'POST') { try { const {user}=await miniAuth(request,env); const body=await request.json(); const command=String(body?.command||''); const admin=Boolean(body?.admin); ctx.waitUntil(miniRunCommand(env,user,command,admin).catch((e)=>console.error(JSON.stringify({event:'mini_command_failed',error:e.message})))); return json({ok:true,queued:true}); } catch(e) { return miniJsonError(e); } }\n    if (url.pathname === '/api/mini/admin/manage' && request.method === 'POST') { try { const {user}=await miniAuth(request,env); const body=await request.json(); return json(await miniAdminManage(env,user,body)); } catch(e) { return miniJsonError(e); } }\n    if (url.pathname === '/api/mini/admin/media' && request.method === 'POST') { try { const {user}=await miniAuth(request,env); return json(await miniAdminMedia(request,env,user)); } catch(e) { return miniJsonError(e); } }\n    if (url.pathname === '/health') {\n      ctx.waitUntil(Promise.all([syncBotProfile(env),syncMiniAppMenu(env)]));"
rep(anchor, replacement, 'fetch mini routes')

# handleTelegram sync without changing command behavior
rep("  await syncBotProfile(env);\n  if (update.pre_checkout_query)", "  await syncBotProfile(env);\n  await syncMiniAppMenu(env).catch(() => {});\n  if (update.pre_checkout_query)", 'telegram mini menu sync')

# cron sync menu
rep("      await syncBotProfile(env);\n      await cleanupTemporaryMessages(env);", "      await syncBotProfile(env);\n      await syncMiniAppMenu(env).catch(() => {});\n      await cleanupTemporaryMessages(env);", 'cron mini menu sync')

p.write_text(s)

pkg=Path('package.json')
j=json.loads(pkg.read_text());j['version']='1.6.0';pkg.write_text(json.dumps(j,indent=2)+'\n')

t=Path('test/platform.test.js')
ts=t.read_text().replace("const VERSION = '1.5.1'", "const VERSION = '1.6.0'").replace("const VERSION = '1\\.5\\.1'", "const VERSION = '1\\.6\\.0'")
ts=ts.replace("source.includes(\"const VERSION = '1.5.1'\")", "source.includes(\"const VERSION = '1.6.0'\")")
ts=ts.replace("/const VERSION = '1\\.5\\.1'/", "/const VERSION = '1\\.6\\.0'/")
ts += r'''

test('v1.6 Telegram Mini App keeps bot engine parity and authenticated admin dashboard', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const mini = await readFile(new URL('../src/miniapp.js', import.meta.url), 'utf8');
  assert.ok(source.includes("const VERSION = '1.6.0'"));
  assert.ok(source.includes("import { MINI_APP_HTML } from './miniapp.js'"));
  assert.ok(source.includes('validateMiniAppInitData'));
  assert.ok(source.includes("request.headers.get('x-telegram-init-data')"));
  assert.ok(source.includes("url.pathname === '/app'"));
  assert.ok(source.includes("url.pathname === '/api/mini/bootstrap'"));
  assert.ok(source.includes("url.pathname === '/api/mini/action'"));
  assert.ok(source.includes("url.pathname === '/api/mini/admin/media'"));
  assert.ok(source.includes("setChatMenuButton"));
  assert.ok(source.includes("await handleCommand(env, msg, user)"));
  assert.match(mini, /telegram-web-app\.js/);
  assert.match(mini, /Admin dashboard/);
  assert.match(mini, /Website manager/);
  assert.match(mini, /Command console/);
});
'''
t.write_text(ts)
