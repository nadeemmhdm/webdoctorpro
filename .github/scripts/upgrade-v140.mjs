import fs from 'node:fs';

let s = fs.readFileSync('src/index.js', 'utf8');
const must = (a,b,label) => { if (!s.includes(a)) throw new Error(`Missing anchor: ${label}`); s = s.replace(a,b); };
const mustRe = (re,b,label) => { if (!re.test(s)) throw new Error(`Missing regex anchor: ${label}`); s = s.replace(re,b); };

must("const VERSION = '1.3.1';", "const VERSION = '1.4.0';", 'version');
must("const LAST_UPDATED_AT = '2026-10-12T18:32:00+05:30';", "const LAST_UPDATED_AT = '2026-10-13T07:02:00+05:30';", 'updated time');
must("  pro: { label: 'Pro', stars: 129, dailyScans: 100, dailyReports: 20, maxDomains: 25, schedules: ['daily', 'weekly', 'monthly'], adEvery: 0 }\n});",
"  pro: { label: 'Pro', stars: 129, dailyScans: 100, dailyReports: 20, maxDomains: 25, schedules: ['daily', 'weekly', 'monthly'], adEvery: 0 },\n  team: { label: 'Team', stars: 299, dailyScans: 250, dailyReports: 50, maxDomains: 50, schedules: ['daily', 'weekly', 'monthly'], adEvery: 0 }\n});", 'team plan config');
must("const SUBSCRIPTION_PERIOD = 2592000;\nconst ADMIN_TELEGRAM_ID = '8984229401';", "const SUBSCRIPTION_PERIOD = 2592000;\nconst TEAM_ACTIVATION_TTL_MS = 24 * 3600000;\nconst ADMIN_TELEGRAM_ID = '8984229401';", 'team ttl');
must("function planRank(plan) { return plan === 'pro' ? 2 : plan === 'starter' ? 1 : 0; }", "function planRank(plan) { return plan === 'team' ? 3 : plan === 'pro' ? 2 : plan === 'starter' ? 1 : 0; }", 'plan rank');

must("    await env.DB.prepare(`UPDATE users SET plan='free',plan_expires_at=NULL,subscription_auto_renew=0,subscription_charge_id=NULL,updated_at=? WHERE id=?`)\n      .bind(nowIso(), target.id).run();\n    return null;",
"    await env.DB.prepare(`UPDATE users SET plan='free',plan_expires_at=NULL,subscription_auto_renew=0,subscription_charge_id=NULL,updated_at=? WHERE id=?`)\n      .bind(nowIso(), target.id).run();\n    await env.DB.prepare('UPDATE team_chats SET active=0,updated_at=? WHERE owner_user_id=? AND active=1').bind(nowIso(), target.id).run();\n    return null;", 'free disables team');
must("  await env.DB.prepare(`UPDATE users SET plan=?,plan_expires_at=?,subscription_auto_renew=0,subscription_charge_id=NULL,updated_at=? WHERE id=?`)\n    .bind(plan, expiry, nowIso(), target.id).run();\n  return expiry;",
"  await env.DB.prepare(`UPDATE users SET plan=?,plan_expires_at=?,subscription_auto_renew=0,subscription_charge_id=NULL,updated_at=? WHERE id=?`)\n    .bind(plan, expiry, nowIso(), target.id).run();\n  if (plan === 'team') await syncTeamWorkspaceExpiry(env, target.id, expiry);\n  else await env.DB.prepare('UPDATE team_chats SET active=0,updated_at=? WHERE owner_user_id=? AND active=1').bind(nowIso(), target.id).run();\n  return expiry;", 'exact plan team sync');

const teamHelpers = `
function teamCodeFromText(text) {
  const clean = String(text || '').trim().replace(/^\\/team_activate(?:@\\w+)?\\s+/i, '').trim().toUpperCase();
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
  const code = \`WDP-TEAM-\${randomHex(5).toUpperCase()}\`;
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
  let text = \`🏢 <b>Team Workspace</b>\\n\\n💎 Plan: <b>\${PLAN_CONFIG[plan].label}</b>\`;
  if (plan !== 'team') text += '\\n\\nTeam access is not active. Purchase Team from /plans.';
  else {
    text += \`\\n📅 Plan until: \${esc(formatInTimezone(fresh.plan_expires_at, fresh.timezone_configured ? fresh.timezone : 'UTC'))}\`;
    if (workspace && new Date(workspace.plan_expires_at).getTime() > Date.now()) text += \`\\n\\n✅ <b>Active workspace</b>\\n\${esc(workspace.title || workspace.chat_id)}\\nType: \${esc(workspace.chat_type)}\`;
    else text += '\\n\\n⚪ No active group/channel yet.';
    if (pending) text += \`\\n\\n🔑 24-hour activation code\\n<code>\${esc(pending.code)}</code>\\nExpires: \${esc(formatInTimezone(pending.expires_at, fresh.timezone_configured ? fresh.timezone : 'UTC'))}\`;
    text += '\\n\\n<b>Group / Supergroup</b>\\n1. Add this bot and make it admin.\\n2. The Team purchaser sends the code in that group.\\n3. Only that purchaser can activate it.\\n\\n<b>Channel</b>\\nAdd the bot as admin, then activate privately with:\\n<code>/team_activate CODE @channelusername</code>';
  }
  const rows = [];
  if (plan === 'team') rows.push([{ text: '🔑 New 24h Code', callback_data: 'teamcode:new' }]);
  rows.push([{ text: '💎 View Plans', callback_data: 'team:plans' }]);
  return { text, markup: { inline_keyboard: rows } };
}
async function teamWorkspaceStatusText(env, access) {
  const usage = await dailyUsage(env, access.owner), cfg = PLAN_CONFIG.team;
  return \`🏢 <b>Team Workspace Active</b>\\n\\n✅ \${esc(access.workspace.title || access.workspace.chat_id)}\\n💎 Team plan\\n📅 Until: \${esc(formatInTimezone(access.workspace.plan_expires_at, access.owner.timezone_configured ? access.owner.timezone : 'UTC'))}\\n📊 Shared usage today: \${usage.row.scan_count || 0}/\${cfg.dailyScans} checks • \${usage.row.report_count || 0}/\${cfg.dailyReports} PDFs\\n🌐 Shared monitored sites: up to \${cfg.maxDomains}\\n📣 Ads: Off\`;
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
    if (!result.ok) return send(env, chatId, \`❌ <b>Team activation failed</b>\\n\\n\${esc(result.reason)}\`);
    return send(env, chatId, \`🎉 <b>Team plan activated for this chat</b>\\n\\n🏢 \${esc(result.workspaceTitle)}\\n💎 Shared Team features are now available.\\n📅 Access until: \${esc(formatInTimezone(result.expiry, purchaser.timezone_configured ? purchaser.timezone : 'UTC'))}\\n\\nUse /team_status or send a domain.\`);
  }
  const access = await teamAccessForChat(env, chatId);
  if (!access) {
    if (/^\\/(team|team_status|plans)(?:@\\w+)?\\b/i.test(text)) return send(env, chatId, '🏢 <b>Team plan is not active in this chat</b>\\n\\nThe Team purchaser should add the bot as admin and send their 24-hour activation code here.');
    return;
  }
  if (!text) return;
  const [rawCmd, ...args] = text.split(/\\s+/), cmd = rawCmd.toLowerCase().split('@')[0];
  if (cmd === '/team' || cmd === '/team_status' || cmd === '/status') return send(env, chatId, await teamWorkspaceStatusText(env, access));
  if (cmd === '/help') return send(env, chatId, '🏢 <b>Team commands</b>\\n\\n/check domain\\n/scan domain\\n/seo domain\\n/performance domain\\n/ssl domain\\n/provider domain\\n/links domain\\n/robots domain\\n/keywords domain\\n/add domain\\n/verify domain\\n/schedule domain weekly\\n/list\\n/remove domain\\n/team_status\\n\\nTeam usage, verified sites and limits are shared through the purchaser account.');
  if (cmd === '/plans') return send(env, chatId, plansText(access.owner));
  const toolMap = { '/check':'check','/scan':'scan','/seo':'seo','/performance':'performance','/ssl':'ssl','/provider':'provider','/links':'links','/robots':'robots','/keywords':'keywords' };
  if (toolMap[cmd]) {
    if (!args[0]) return send(env, chatId, '💡 Add a domain after the command. Example: <code>/check example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    return runTool(env, chatId, access.owner, toolMap[cmd], domain);
  }
  if (cmd === '/add' || cmd === '/verify') {
    if (!args[0]) return send(env, chatId, \`💡 Usage: <code>\${cmd} example.com</code>\`);
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    return cmd === '/add' ? handleAdd(env, chatId, access.owner, domain) : handleVerify(env, chatId, access.owner, domain);
  }
  if (cmd === '/schedule') {
    if (!args[0] || !args[1]) return send(env, chatId, '💡 Usage: <code>/schedule example.com weekly</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    return setSchedule(env, chatId, access.owner, domain, args[1].toLowerCase());
  }
  if (cmd === '/list') {
    const rows = await env.DB.prepare(`SELECT d.name,w.verified_at,w.uptime_state,w.report_schedule FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.name`).bind(access.owner.id).all();
    const lines = rows.results.map((r,i) => \`\${i+1}. 🌐 <b>\${esc(r.name)}</b> • \${r.verified_at ? '✅ verified' : '⏳ pending'} • \${esc(r.uptime_state || 'unknown')} • reports \${esc(r.report_schedule || 'off')}\`);
    return send(env, chatId, lines.length ? \`📋 <b>Team Monitored Websites</b>\\n\\n\${lines.join('\\n')}\` : '📭 No Team websites are monitored yet.');
  }
  if (cmd === '/remove') {
    if (!msg.from?.id || !(await isTelegramChatAdmin(env, chatId, msg.from.id))) return send(env, chatId, '🔒 Only a chat administrator can remove a Team-monitored site.');
    if (!args[0]) return send(env, chatId, '💡 Usage: <code>/remove example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    const r = await env.DB.prepare(`UPDATE watches SET active=0,updated_at=? WHERE user_id=? AND domain_id=(SELECT id FROM domains WHERE name=?)`).bind(nowIso(), access.owner.id, domain).run();
    return send(env, chatId, r.meta.changes ? \`✅ Monitoring stopped for <b>\${esc(domain)}</b>.\` : \`ℹ️ \${esc(domain)} was not being monitored.\`);
  }
  if (!text.startsWith('/')) {
    let domain; try { domain = normalizeDomain(text); } catch { return; }
    return runTool(env, chatId, access.owner, 'check', domain);
  }
}
`;
must("async function dailyUsage(env, user) {", teamHelpers + "\nasync function dailyUsage(env, user) {", 'team helpers');

mustRe(/function plansText\(user\) \{[\s\S]*?\n\}\nfunction plansMarkup\(\) \{[\s\S]*?\n\}/,
`function plansText(user) {
  const current = activePlan(user), until = user?.plan_expires_at && current !== 'free' ? \` until \${user.plan_expires_at.slice(0, 10)}\` : '';
  return \`💎 <b>WEB DOCTOR PRO Plans</b>\\n\\n🆓 <b>Free</b>\\n• 5 checks/day • 1 PDF/day • 1 monitored site\\n• Weekly reports • Ads after scans\\n\\n⭐ <b>Starter — 49 Stars / 30 days</b>\\n• 25 checks/day • 5 PDFs/day • 5 monitored sites\\n• Daily + weekly reports • Fewer ads\\n\\n👑 <b>Pro — 129 Stars / 30 days</b>\\n• 100 checks/day • 20 PDFs/day • 25 monitored sites\\n• Daily/weekly/monthly reports • No ads\\n\\n🏢 <b>Team — 299 Stars / 30 days</b>\\n• 250 shared checks/day • 50 PDFs/day • 50 monitored sites\\n• Group/channel workspace access • No ads\\n• One active Team workspace per subscription\\n\\n📌 Current plan: <b>\${PLAN_CONFIG[current].label}\${esc(until)}</b>\\n\\nTelegram handles recurring Star subscription payments. Team activation codes are valid for 24 hours.\`;
}
function plansMarkup() {
  return { inline_keyboard: [[{ text: '⭐ Starter — 49 Stars', callback_data: 'buyplan:starter' }], [{ text: '👑 Pro — 129 Stars', callback_data: 'buyplan:pro' }], [{ text: '🏢 Team — 299 Stars', callback_data: 'buyplan:team' }], [{ text: '🎟 Redeem Coupon', callback_data: 'couponhelp:show' }]] };
}`, 'plans UI');

must("const payload = String(q.invoice_payload || ''), m = /^sub:(starter|pro):(\\d+):/.exec(payload);", "const payload = String(q.invoice_payload || ''), m = /^sub:(starter|pro|team):(\\d+):/.exec(payload);", 'precheckout team');
must("const p = msg.successful_payment, m = /^sub:(starter|pro):(\\d+):/.exec(String(p?.invoice_payload || ''));", "const p = msg.successful_payment, m = /^sub:(starter|pro|team):(\\d+):/.exec(String(p?.invoice_payload || ''));", 'payment team');
must("  await extendPlan(env, user.id, plan, 30, { autoRenew: Boolean(p.is_recurring), chargeId: p.telegram_payment_charge_id, absoluteExpiry: expiry });\n  await reactToMessage(env, msg, '🎉');\n  await send(env, msg.chat.id, `🎉 <b>${cfg.label} activated</b>\\n\\n⭐ Payment: ${cfg.stars} Stars\\n📅 Access until: ${esc(formatInTimezone(expiry, user.timezone_configured ? user.timezone : 'UTC'))}\\n${p.is_recurring ? '🔁 Recurring subscription is active.' : ''}\\n\\nUse /plans anytime to view your plan.`);",
"  await extendPlan(env, user.id, plan, 30, { autoRenew: Boolean(p.is_recurring), chargeId: p.telegram_payment_charge_id, absoluteExpiry: expiry });\n  let teamActivation = null;\n  if (plan === 'team') {\n    await syncTeamWorkspaceExpiry(env, user.id, expiry);\n    const activeWorkspace = await env.DB.prepare('SELECT id FROM team_chats WHERE owner_user_id=? AND active=1 AND plan_expires_at>? LIMIT 1').bind(user.id, nowIso()).first();\n    if (!activeWorkspace) teamActivation = await issueTeamActivationCode(env, user.id);\n  }\n  await reactToMessage(env, msg, '🎉');\n  await send(env, msg.chat.id, `🎉 <b>${cfg.label} activated</b>\\n\\n⭐ Payment: ${cfg.stars} Stars\\n📅 Access until: ${esc(formatInTimezone(expiry, user.timezone_configured ? user.timezone : 'UTC'))}\\n${p.is_recurring ? '🔁 Recurring subscription is active.' : ''}${teamActivation ? `\\n\\n🔑 <b>Your 24-hour Team activation code</b>\\n<code>${teamActivation.code}</code>\\n\\nAdd this bot as an admin in your group/supergroup, then send this code there yourself. For a channel, use <code>/team_activate ${teamActivation.code} @channelusername</code> here in private.` : plan === 'team' ? '\\n\\n🏢 Your existing Team workspace expiry was extended automatically.' : ''}\\n\\nUse /plans anytime to view your plan.`);", 'team payment activation');

must("    [{ text: '⭐ Set Starter', callback_data: `adminsetstarter:${u.id}` }, { text: '👑 Set Pro', callback_data: `adminsetpro:${u.id}` }],", "    [{ text: '⭐ Set Starter', callback_data: `adminsetstarter:${u.id}` }, { text: '👑 Set Pro', callback_data: `adminsetpro:${u.id}` }],\n    [{ text: '🏢 Set Team', callback_data: `adminsetteam:${u.id}` }],", 'admin team button');
must("env.DB.prepare(\"SELECT COUNT(*) c FROM users WHERE plan IN ('starter','pro') AND (plan_expires_at IS NULL OR plan_expires_at>?)\").bind(nowIso()).first(),", "env.DB.prepare(\"SELECT COUNT(*) c FROM users WHERE plan IN ('starter','pro','team') AND (plan_expires_at IS NULL OR plan_expires_at>?)\").bind(nowIso()).first(),", 'stats team paid');

const adminAdsView = `
async function adminAdsView(env) {
  const rows = await env.DB.prepare('SELECT * FROM ads ORDER BY id DESC LIMIT 12').all();
  const globalOn = (await appMeta(env, 'ads_enabled')) !== '0';
  const lines = rows.results.length ? rows.results.map((a) => \`• #\${a.id} \${a.active ? '🟢 ON' : '⚪ OFF'} • \${esc(a.content_type)} • views \${a.impressions || 0} • \${esc(short(a.title || a.text_content || 'Ad', 34))}\`).join('\\n') : 'No ads yet.';
  const buttons = [
    [{ text: globalOn ? '🟢 Global Ads ON · Turn OFF' : '⚪ Global Ads OFF · Turn ON', callback_data: \`adminads:\${globalOn ? 'off' : 'on'}\` }],
    [{ text: '➕ Create Ad', callback_data: 'admin:adcreate' }]
  ];
  for (const a of rows.results) buttons.push([
    { text: \`#\${a.id} \${a.active ? '🟢 ON' : '⚪ OFF'}\`, callback_data: \`adminad:\${a.active ? 'off' : 'on'}:\${a.id}\` },
    { text: '✏️ Edit', callback_data: \`adminad:edit:\${a.id}\` },
    { text: '🗑 Delete', callback_data: \`adminad:ask:\${a.id}\` }
  ]);
  buttons.push([{ text: '⬅️ Admin Home', callback_data: 'admin:home' }]);
  return { text: \`📣 <b>Ads Manager</b>\\n\\nGlobal: <b>\${globalOn ? 'ON' : 'OFF'}</b>\\n\\n\${lines}\\n\\nTap buttons below to control ads. Editing asks you to send replacement text/image/video/voice.\`, markup: { inline_keyboard: buttons } };
}
`;
must("async function adminBroadcastsText(env) {", adminAdsView + "\nasync function adminBroadcastsText(env) {", 'ads button view');

must("  if (cmd === '/admin_ads') return void await send(env, chatId, await adminAdsText(env), { reply_markup: adminMenuMarkup() });", "  if (cmd === '/admin_ads') { const v = await adminAdsView(env); return void await send(env, chatId, v.text, { reply_markup: v.markup }); }", 'admin ads command buttons');
must("if (!args[0] || !['free','starter','pro'].includes(String(args[1] || '').toLowerCase()))", "if (!args[0] || !['free','starter','pro','team'].includes(String(args[1] || '').toLowerCase()))", 'admin plan accepts team');
must("    const expiry = await adminSetExactPlan(env, target, plan, days);\n    await send(env, target.chat_id, `🛠 <b>Your plan was updated by admin</b>\\n\\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>${expiry ? `\\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}` : ''}`).catch(() => {});",
"    const expiry = await adminSetExactPlan(env, target, plan, days);\n    const teamActivation = plan === 'team' ? await issueTeamActivationCode(env, target.id) : null;\n    await send(env, target.chat_id, `🛠 <b>Your plan was updated by admin</b>\\n\\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>${expiry ? `\\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}` : ''}${teamActivation ? `\\n\\n🔑 Team activation code (24h)\\n<code>${teamActivation.code}</code>` : ''}`).catch(() => {});", 'admin command team code');

must("  if (cmd === '/plans' || cmd === '/plan') return void await send(env, chatId, plansText(user), { reply_markup: plansMarkup() });\n  if (cmd === '/subscribe') {\n    const plan = String(args[0] || '').toLowerCase(); if (!['starter','pro'].includes(plan)) return void await send(env, chatId, 'Usage: <code>/subscribe starter</code> or <code>/subscribe pro</code>', { reply_markup: plansMarkup() });\n    return void await sendPlanInvoice(env, chatId, user, plan);\n  }",
"  if (cmd === '/plans' || cmd === '/plan') return void await send(env, chatId, plansText(user), { reply_markup: plansMarkup() });\n  if (cmd === '/subscribe') {\n    const plan = String(args[0] || '').toLowerCase(); if (!['starter','pro','team'].includes(plan)) return void await send(env, chatId, 'Usage: <code>/subscribe starter</code>, <code>/subscribe pro</code> or <code>/subscribe team</code>', { reply_markup: plansMarkup() });\n    return void await sendPlanInvoice(env, chatId, user, plan);\n  }\n  if (cmd === '/team' || cmd === '/team_status') { const v = await teamAccountView(env, user); return void await send(env, chatId, v.text, { reply_markup: v.markup }); }\n  if (cmd === '/team_code') {\n    if (activePlan(user) !== 'team') return void await send(env, chatId, '🔒 Team plan required. Use /plans.', { reply_markup: plansMarkup() });\n    const x = await issueTeamActivationCode(env, user.id);\n    return void await send(env, chatId, `🔑 <b>New Team activation code</b>\\n\\n<code>${x.code}</code>\\n\\nValid for 24 hours (or until your Team plan expires). Add the bot as admin in the target group/supergroup and send this code there yourself.`);\n  }\n  if (cmd === '/team_activate') {\n    const code = String(args[0] || '').toUpperCase(), target = args[1];\n    if (!/^WDP-TEAM-[A-F0-9]{10}$/.test(code)) return void await send(env, chatId, 'Usage: <code>/team_activate WDP-TEAM-CODE @channelusername</code>\\n\\nFor groups, simply send the code inside the group after making this bot an admin.');\n    if (!target) return void await send(env, chatId, '🏢 <b>Group activation</b>\\nMake this bot an admin and send the code directly in that group.\\n\\n📣 <b>Channel activation</b>\\nUse <code>/team_activate CODE @channelusername</code> after making this bot a channel admin.');\n    let targetChat; try { targetChat = await tg(env, 'getChat', { chat_id: /^-?\\d+$/.test(target) ? Number(target) : target }); } catch { return void await send(env, chatId, '❌ I cannot access that target chat. Add this bot there as an admin first and check the username/ID.'); }\n    const result = await activateTeamWorkspace(env, targetChat, user, code);\n    return void await send(env, chatId, result.ok ? `🎉 <b>Team workspace activated</b>\\n\\n🏢 ${esc(result.workspaceTitle)}\\n📅 Until: ${esc(formatInTimezone(result.expiry, user.timezone_configured ? user.timezone : 'UTC'))}` : `❌ <b>Team activation failed</b>\\n\\n${esc(result.reason)}`);\n  }", 'team commands');

must("💎 Use /plans for Free, Starter and Pro.\\n🎁 Use /invite to earn coins.", "💎 Use /plans for Free, Starter, Pro and Team.\\n🏢 Team plan can activate one shared group/channel workspace.\\n🎁 Use /invite to earn coins.", 'welcome team');
must("/plans — plans & Stars\\n/invite", "/plans — plans & Stars\\n/team — Team workspace status\\n/team_code — new 24-hour Team activation code\\n/team_activate CODE @channel — activate a channel\\n/invite", 'help team');
must("      { command: 'plans', description: '💎 Plans & Telegram Stars' },", "      { command: 'plans', description: '💎 Plans & Telegram Stars' },\n      { command: 'team', description: '🏢 Team workspace & activation' },\n      { command: 'team_code', description: '🔑 New Team activation code' },", 'bot command team');

must("async function handleVerify(env, chatId, user, domain) {\n  const msg = await startProgress(env, chatId, `Verifying ${domain}`, 'Looking for the unique DNS TXT record…');",
"async function handleVerify(env, chatId, user, domain) {\n  if (await isVerified(env, user.id, domain)) return send(env, chatId, `✅ <b>Ownership already verified</b>\\n\\n🌐 ${esc(domain)}\\n🛡 No DNS verification is needed again. You can safely remove the old TXT record.`, { reply_markup: scheduleButtons(domain) });\n  const msg = await startProgress(env, chatId, `Verifying ${domain}`, 'Looking for the unique DNS TXT record…');", 'verified short circuit');

must("async function handleCallback(env, q) {\n  if (!q?.from || !q?.message) return;\n  const user = await upsertUser(env, q.from, q.message.chat.id), data = String(q.data || '');\n  if (user.blocked) { await answerCb(env, q.id, 'Account access unavailable.'); return; }",
"async function handleCallback(env, q) {\n  if (!q?.from || !q?.message) return;\n  const data = String(q.data || ''), sharedChat = q.message.chat.type !== 'private';\n  let user, teamAccess = null;\n  if (sharedChat) {\n    teamAccess = await teamAccessForChat(env, q.message.chat.id);\n    if (!teamAccess) { await answerCb(env, q.id, 'Team plan is not active in this chat.'); return; }\n    user = teamAccess.owner;\n  } else user = await upsertUser(env, q.from, q.message.chat.id);\n  if (user.blocked) { await answerCb(env, q.id, 'Account access unavailable.'); return; }\n  if (sharedChat && (data.startsWith('tz:') || data.startsWith('buyplan:') || data.startsWith('redeem:') || data === 'couponhelp:show' || data.startsWith('giftopen:') || data.startsWith('teamcode:') || data.startsWith('admin'))) { await answerCb(env, q.id, 'Open WEB DOCTOR PRO privately for this action.'); return; }", 'shared callback owner');
must("    if (!['starter','pro'].includes(plan)) return answerCb(env, q.id, 'Invalid plan.');", "    if (!['starter','pro','team'].includes(plan)) return answerCb(env, q.id, 'Invalid plan.');", 'team buy callback');
must("  if (data.startsWith('redeem:')) { await answerCb(env, q.id, 'Redeeming coins…'); return redeemCoins(env, q.message.chat.id, user, data.slice(7)); }",
"  if (data === 'team:plans') { await answerCb(env, q.id, 'Plans'); return send(env, q.message.chat.id, plansText(user), { reply_markup: plansMarkup() }); }\n  if (data === 'teamcode:new') {\n    if (activePlan(user) !== 'team') return answerCb(env, q.id, 'Team plan required.');\n    const x = await issueTeamActivationCode(env, user.id); await answerCb(env, q.id, 'New Team code created.');\n    return send(env, q.message.chat.id, `🔑 <b>New 24-hour Team activation code</b>\\n\\n<code>${x.code}</code>\\n\\nOnly you can activate it. Make the bot admin in the target group and send this code there.`);\n  }\n  if (data.startsWith('redeem:')) { await answerCb(env, q.id, 'Redeeming coins…'); return redeemCoins(env, q.message.chat.id, user, data.slice(7)); }", 'team callback');

must("    if (data === 'admin:ads') return send(env, q.message.chat.id, await adminAdsText(env), { reply_markup: adminMenuMarkup() });",
"    if (data === 'admin:ads') { const v = await adminAdsView(env); return edit(env, q.message.chat.id, q.message.message_id, v.text, { reply_markup: v.markup }); }\n    if (data.startsWith('adminads:')) {\n      const turnOn = data.endsWith(':on'); await setAppMeta(env, 'ads_enabled', turnOn ? '1' : '0');\n      const v = await adminAdsView(env); return edit(env, q.message.chat.id, q.message.message_id, v.text, { reply_markup: v.markup });\n    }\n    if (data.startsWith('adminad:')) {\n      const [, action, idRaw] = data.split(':'), adId = Number(idRaw);\n      if (!adId) return answerCb(env, q.id, 'Invalid ad.');\n      if (action === 'ask') return edit(env, q.message.chat.id, q.message.message_id, `🗑 <b>Delete ad #${adId}?</b>\\n\\nThis permanently removes the ad record.`, { reply_markup: { inline_keyboard: [[{ text: '🗑 Yes, Delete', callback_data: `adminad:delete:${adId}` }, { text: 'Cancel', callback_data: 'admin:ads' }]] } });\n      if (action === 'delete') await env.DB.prepare('DELETE FROM ads WHERE id=?').bind(adId).run();\n      if (action === 'on' || action === 'off') await env.DB.prepare('UPDATE ads SET active=?,updated_at=? WHERE id=?').bind(action === 'on' ? 1 : 0, nowIso(), adId).run();\n      if (action === 'edit') { const ad = await env.DB.prepare('SELECT id FROM ads WHERE id=?').bind(adId).first(); if (!ad) return send(env,q.message.chat.id,'❌ Ad not found.'); await setAdminSession(env,user.id,'ad_edit',{id:adId}); return send(env,q.message.chat.id,`✏️ Send replacement content for ad #${adId} as text, image, video, or voice.`); }\n      const v = await adminAdsView(env); return edit(env, q.message.chat.id, q.message.message_id, v.text, { reply_markup: v.markup });\n    }", 'admin ad callbacks');
must("    if (data.startsWith('adminsetfree:') || data.startsWith('adminsetstarter:') || data.startsWith('adminsetpro:')) {\n      const plan = data.startsWith('adminsetfree:') ? 'free' : data.startsWith('adminsetpro:') ? 'pro' : 'starter';",
"    if (data.startsWith('adminsetfree:') || data.startsWith('adminsetstarter:') || data.startsWith('adminsetpro:') || data.startsWith('adminsetteam:')) {\n      const plan = data.startsWith('adminsetfree:') ? 'free' : data.startsWith('adminsetteam:') ? 'team' : data.startsWith('adminsetpro:') ? 'pro' : 'starter';", 'admin team callback');
must("      const expiry = await adminSetExactPlan(env, target, plan, 30);\n      await send(env, target.chat_id, `🛠 <b>Your plan was updated by admin</b>\\n\\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>${expiry ? `\\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}` : ''}`).catch(() => {});",
"      const expiry = await adminSetExactPlan(env, target, plan, 30);\n      const teamActivation = plan === 'team' ? await issueTeamActivationCode(env, target.id) : null;\n      await send(env, target.chat_id, `🛠 <b>Your plan was updated by admin</b>\\n\\n💎 Plan: <b>${PLAN_CONFIG[plan].label}</b>${expiry ? `\\n⏳ Until: ${esc(formatInTimezone(expiry, target.timezone_configured ? target.timezone : 'UTC'))}` : ''}${teamActivation ? `\\n\\n🔑 Team activation code (24h)\\n<code>${teamActivation.code}</code>` : ''}`).catch(() => {});", 'admin callback team code');

must("  const msg = update.message; if (!msg?.from || !msg?.chat) return;\n  let user = await upsertUser(env, msg.from, msg.chat.id);",
"  const msg = update.message || update.channel_post; if (!msg?.chat) return;\n  if (msg.chat.type !== 'private') return handleTeamChatUpdate(env, msg);\n  if (!msg.from) return;\n  let user = await upsertUser(env, msg.from, msg.chat.id);", 'route group channel team');

const migration = `PRAGMA foreign_keys = ON;\n\nCREATE TABLE IF NOT EXISTS team_activation_codes (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  user_id INTEGER NOT NULL,\n  code TEXT NOT NULL UNIQUE,\n  expires_at TEXT NOT NULL,\n  used_at TEXT,\n  used_chat_id TEXT,\n  created_at TEXT NOT NULL,\n  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_team_activation_codes_user ON team_activation_codes(user_id,expires_at);\n\nCREATE TABLE IF NOT EXISTS team_chats (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  chat_id TEXT NOT NULL UNIQUE,\n  owner_user_id INTEGER NOT NULL,\n  chat_type TEXT NOT NULL,\n  title TEXT,\n  plan_expires_at TEXT NOT NULL,\n  active INTEGER NOT NULL DEFAULT 1,\n  activated_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  FOREIGN KEY(owner_user_id) REFERENCES users(id) ON DELETE CASCADE\n);\nCREATE INDEX IF NOT EXISTS idx_team_chats_chat_active ON team_chats(chat_id,active,plan_expires_at);\nCREATE UNIQUE INDEX IF NOT EXISTS idx_team_chats_one_active_owner ON team_chats(owner_user_id) WHERE active=1;\n`;
fs.writeFileSync('migrations/0006_team_plan_and_button_ux.sql', migration);

fs.writeFileSync('src/index.js', s);
const pkg = JSON.parse(fs.readFileSync('package.json','utf8')); pkg.version='1.4.0'; fs.writeFileSync('package.json', JSON.stringify(pkg,null,2)+'\n');

let t = fs.readFileSync('test/platform.test.js','utf8');
t += `\n\ntest('v1.4.0 team workspace and button UX markers', async () => {\n  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');\n  const migration = await readFile(new URL('../migrations/0006_team_plan_and_button_ux.sql', import.meta.url), 'utf8');\n  assert.ok(source.includes(\"const VERSION = '1.4.0'\"));\n  assert.ok(source.includes(\"team: { label: 'Team', stars: 299\"));\n  assert.ok(source.includes('TEAM_ACTIVATION_TTL_MS = 24 * 3600000'));\n  assert.ok(source.includes('activateTeamWorkspace'));\n  assert.ok(source.includes('handleTeamChatUpdate'));\n  assert.ok(source.includes('adminAdsView'));\n  assert.ok(source.includes('adminad:delete:'));\n  assert.ok(source.includes('Ownership already verified'));\n  assert.match(migration, /CREATE TABLE IF NOT EXISTS team_activation_codes/);\n  assert.match(migration, /CREATE TABLE IF NOT EXISTS team_chats/);\n});\n`;
fs.writeFileSync('test/platform.test.js', t);
