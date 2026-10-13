from pathlib import Path
import json,re
p=Path('src/index.js')
s=p.read_text()

def rep(a,b,label):
    global s
    if a not in s: raise SystemExit(f'missing anchor: {label}')
    s=s.replace(a,b,1)

rep("const VERSION = '1.5.0';","const VERSION = '1.5.1';",'version')

helper=r'''async function filteredSitesView(env, userId, filter = 'all', team = false) {
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

'''
rep('async function appMeta(env, key) {',helper+'async function appMeta(env, key) {','site helper')

# Team/group command path: insert before existing /list block
anchor="  if (cmd === '/list') {\n    const rows = await env.DB.prepare(`SELECT d.name,w.verified_at,w.uptime_state,w.report_schedule FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.name`).bind(access.owner.id).all();"
insert="  if (['/verified','/pending','/pwnding'].includes(cmd)) {\n    const filter = cmd === '/verified' ? 'verified' : 'pending';\n    const v = await filteredSitesView(env, access.owner.id, filter, true);\n    return send(env, chatId, v.text, { reply_markup: v.markup });\n  }\n"+anchor
rep(anchor,insert,'team verified/pending commands')

# Private command path before private /list
anchor2="  if (cmd === '/list') {\n    const rows = await env.DB.prepare(`SELECT d.name,d.expires_at,d.ssl_expires_at,w.verified_at,w.uptime_state,w.report_schedule,w.next_report_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.name`).bind(user.id).all();"
insert2="  if (['/verified','/pending','/pwnding'].includes(cmd)) {\n    const filter = cmd === '/verified' ? 'verified' : 'pending';\n    const v = await filteredSitesView(env, user.id, filter, false);\n    return void await send(env, chatId, v.text, { reply_markup: v.markup });\n  }\n"+anchor2
rep(anchor2,insert2,'private verified/pending commands')

# callback navigation, insert before buyplan
anchor3="  if (data.startsWith('buyplan:')) {"
cb="  if (data.startsWith('sites:')) {\n    const filter = data.slice('sites:'.length);\n    if (!['all','verified','pending'].includes(filter)) return answerCb(env,q.id,'Invalid filter.');\n    const v = await filteredSitesView(env, user.id, filter, false);\n    await answerCb(env,q.id,'Updated');\n    return edit(env,q.message.chat.id,q.message.message_id,v.text,{reply_markup:v.markup});\n  }\n\n"+anchor3
rep(anchor3,cb,'site filter callback')

# command menu
rep("      { command: 'list', description: '📋 View monitored websites' },","      { command: 'list', description: '📋 View monitored websites' },\n      { command: 'verified', description: '✅ View verified websites' },\n      { command: 'pending', description: '⏳ View pending websites' },",'command menu')

# Clarify /email text and success message
rep("Email alerts can include downtime/recovery, security-relevant website changes and Pro/Team scheduled PDF reports.`);","Email alerts can include downtime/recovery, security-relevant website changes and Pro/Team scheduled PDF reports.\n\n📤 Sender: WEB DOCTOR PRO admin Gmail SMTP\n📥 You only provide the email address that should receive alerts. No Gmail password or App Password is requested from users.`);",'email help clarification')
rep("If the platform sender is configured, alerts will be delivered here.`);","Alerts are sent from the single WEB DOCTOR PRO admin Gmail SMTP account to this address. You do not need to provide any Gmail password or App Password.`);",'email success clarification')

# Clarify admin status text
rep("📧 <b>Email Notification Sender</b>","📧 <b>Global Email Notification Sender</b>", 'smtp title')
rep("Use a separate Gmail account for WEB DOCTOR PRO. Enable 2-Step Verification, create a 16-character App Password, then send:","This single admin Gmail SMTP account sends automated alerts for all users. Users only save their recipient email with /email.\n\nUse a separate Gmail account for WEB DOCTOR PRO. Enable 2-Step Verification, create a 16-character App Password, then send:", 'smtp global model')

p.write_text(s)

pkg=Path('package.json')
j=json.loads(pkg.read_text());j['version']='1.5.1';pkg.write_text(json.dumps(j,indent=2)+'\n')

t=Path('test/platform.test.js')
ts=t.read_text()
ts=ts.replace("const VERSION = '1.5.0'","const VERSION = '1.5.1'")
ts += """\n\ntest('v1.5.1 verified pending commands and global SMTP sender UX are wired', async () => {\n  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');\n  assert.ok(source.includes(\"const VERSION = '1.5.1'\"));\n  assert.ok(source.includes(\"['/verified','/pending','/pwnding'].includes(cmd)\"));\n  assert.ok(source.includes(\"command: 'verified'\"));\n  assert.ok(source.includes(\"command: 'pending'\"));\n  assert.ok(source.includes('filteredSitesView'));\n  assert.ok(source.includes('Global Email Notification Sender'));\n  assert.ok(source.includes('single WEB DOCTOR PRO admin Gmail SMTP account'));\n});\n"""
t.write_text(ts)
