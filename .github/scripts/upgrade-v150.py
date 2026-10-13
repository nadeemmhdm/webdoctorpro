from pathlib import Path
import json, re

index_path = Path('src/index.js')
lib_path = Path('src/lib.js')
pkg_path = Path('package.json')
test_path = Path('test/platform.test.js')

s = index_path.read_text()
lib = lib_path.read_text()

def once(old, new, label):
    global s
    if old not in s:
        raise SystemExit(f'missing anchor: {label}')
    s = s.replace(old, new, 1)

def once_lib(old, new, label):
    global lib
    if old not in lib:
        raise SystemExit(f'missing lib anchor: {label}')
    lib = lib.replace(old, new, 1)

once("} from './lib.js';\n", "} from './lib.js';\nimport { connect } from 'cloudflare:sockets';\n", 'cloudflare sockets import')
once("const VERSION = '1.4.1';", "const VERSION = '1.5.0';", 'version')
once("const LAST_UPDATED_AT = '2026-10-13T07:18:00+05:30';", "const LAST_UPDATED_AT = '2026-10-13T08:20:00+05:30';", 'last updated')
once("const BROADCAST_BATCH = 20;", "const BROADCAST_BATCH = 20;\nconst CHANGE_CHECK_INTERVAL_MS = 15 * 60000;\nconst UPTIME_CONFIRM_FAILURES = 2;\nconst MONITOR_RETENTION_DAYS = 90;", 'monitor constants')

helpers = r'''
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
function comparisonArrow(oldValue, newValue, lowerIsBetter = False) {
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
  const line=(label,a,b,lower=False,suffix='')=>`${label}: <b>${a}${suffix} → ${b}${suffix}</b> ${comparisonArrow(a,b,lower)}`;
  const sslOld=safeJson(o.metrics_json,{})?.sslExpiry||null, sslNew=safeJson(n.metrics_json,{})?.sslExpiry||null;
  return `📈 <b>Since Last Scan — ${esc(domain)}</b>\n\n${line('❤️ Health',o.health_score,n.health_score)}\n${line('⚡ Performance',o.performance_score,n.performance_score)}\n${line('📈 SEO',o.seo_score,n.seo_score)}\n${line('🔗 Broken links',o.broken_links,n.broken_links,True)}\n${line('⏱ Availability',o.availability_score,n.availability_score)}\n⚡ LCP: <b>${o.load_ms ?? 'N/A'}ms → ${n.load_ms ?? 'N/A'}ms</b>\n🔐 SSL: <b>${sslOld===sslNew?'No change':'Changed'}</b>\n\n🕒 Latest: ${esc(formatInTimezone(n.scanned_at,user.timezone_configured?user.timezone:'UTC'))}`;
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
  return {
    ns:stableValues(ns),a:stableValues(a),aaaa:stableValues(aaaa),mx:stableValues(mx),
    ssl:`${ssl.issuer||''}|${ssl.expiresAt||''}`,registrar:rdap.registrar||'',domainExpiry:rdap.expiresAt||'',
    robotsHash:robots?await sha256Text(robots.text):'',robotsExists:Boolean(robots&&robots.status<400),
    sitemapHash:sitemap?await sha256Text(sitemap.text):'',sitemapExists:Boolean(sitemap&&sitemap.status<400),
    title:seo.title||'',description:seo.description||'',hostingProvider:detectHostingProvider({headers:page.headers,cnames:cname}),dnsProvider:detectDnsProvider(ns)
  };
}
function snapshotChangeList(oldSnap,newSnap){
  const out=[]; const add=(kind,label,a,b)=>out.push({kind,label,oldValue:String(a??''),newValue:String(b??'')});
  const j=(x)=>JSON.stringify(x||[]);
  if(j(oldSnap.ns)!==j(newSnap.ns)) add('nameserver','Nameserver changed',oldSnap.ns?.join(', '),newSnap.ns?.join(', '));
  if(j(oldSnap.a)!==j(newSnap.a)) add('a-record','A record changed',oldSnap.a?.join(', '),newSnap.a?.join(', '));
  if(j(oldSnap.aaaa)!==j(newSnap.aaaa)) add('aaaa-record','AAAA record changed',oldSnap.aaaa?.join(', '),newSnap.aaaa?.join(', '));
  if(j(oldSnap.mx)!==j(newSnap.mx)) add('mx-record','MX record changed',oldSnap.mx?.join(', '),newSnap.mx?.join(', '));
  if(oldSnap.ssl!==newSnap.ssl) add('ssl','SSL certificate changed',oldSnap.ssl,newSnap.ssl);
  if(oldSnap.registrar!==newSnap.registrar) add('registrar','Registrar changed',oldSnap.registrar,newSnap.registrar);
  if(oldSnap.domainExpiry!==newSnap.domainExpiry) add('domain-expiry','Domain expiry date changed',oldSnap.domainExpiry,newSnap.domainExpiry);
  if(oldSnap.robotsHash!==newSnap.robotsHash) add('robots','robots.txt changed',oldSnap.robotsHash?'Previous version':'Missing',newSnap.robotsHash?'New version':'Missing');
  if(oldSnap.sitemapExists && !newSnap.sitemapExists) add('sitemap','Sitemap disappeared','Available','Missing');
  else if(oldSnap.sitemapHash!==newSnap.sitemapHash) add('sitemap','Sitemap changed',oldSnap.sitemapHash?'Previous version':'Missing',newSnap.sitemapHash?'New version':'Missing');
  if(oldSnap.title!==newSnap.title) add('title','Homepage title changed',oldSnap.title,newSnap.title);
  if(oldSnap.description!==newSnap.description) add('meta','Homepage meta description changed',oldSnap.description,newSnap.description);
  if(oldSnap.hostingProvider!==newSnap.hostingProvider) add('hosting','Hosting/CDN changed',oldSnap.hostingProvider,newSnap.hostingProvider);
  if(oldSnap.dnsProvider!==newSnap.dnsProvider) add('dns-provider','DNS provider changed',oldSnap.dnsProvider,newSnap.dnsProvider);
  return out;
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
  const socket=connect({hostname:'smtp.gmail.com',port:465},{secureTransport:'on'}); await socket.opened;
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
  return `📧 <b>Email Notification Sender</b>\n\n${row?`${row.active?'🟢 Enabled':'⚪ Disabled'}\nSender: <code>${esc(row.sender_email)}</code>\nUpdated: ${esc(row.updated_at)}`:'⚪ Not configured'}\n\n<b>Recommended setup</b>\nUse a separate Gmail account for WEB DOCTOR PRO. Enable 2-Step Verification, create a 16-character App Password, then send:\n<code>/admin_email_setup sender@gmail.com APP_PASSWORD</code>\n\nThe setup message is deleted after the password is encrypted. Never use your normal Google Account password.`;
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
        const old=safeJson(prevRow.snapshot_json,{})||{}, changes=snapshotChangeList(old,snap);
        if(changes.length){
          const detected=nowIso();
          for(const c of changes) await env.DB.prepare(`INSERT INTO website_change_events(watch_id,kind,label,old_value,new_value,detected_at) VALUES(?,?,?,?,?,?)`).bind(row.watch_id,c.kind,c.label,short(c.oldValue,600),short(c.newValue,600),detected).run();
          const detail=changes.slice(0,8).map((c)=>`• <b>${esc(c.label)}</b>\n  Old: ${esc(short(c.oldValue||'—',140))}\n  New: ${esc(short(c.newValue||'—',140))}`).join('\n');
          const text=`⚠️ <b>Website Change Detected</b>\n\n🌐 <b>${esc(row.name)}</b>\n${detail}\n\n🕒 ${esc(formatInTimezone(detected,row.timezone||'UTC'))}\n\n🛡 Review unexpected DNS, certificate, registrar or hosting changes promptly.`;
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
'''
# Python literals accidentally cannot use JS True/False identifiers in generated code.
helpers = helpers.replace('lowerIsBetter = False', 'lowerIsBetter = false').replace('lower=False', 'lower=false').replace(',True)', ',true)')
once("async function dailyUsage(env, user) {", helpers + "\nasync function dailyUsage(env, user) {", 'insert health email monitoring helpers')

# Enrich full scans before PDF generation.
once("  base.keywords = await keywordSuggestions(env, domain, seo, searchConsole);\n  base.recommendations = await smartRecommendations(env, base);",
     "  base.keywords = await keywordSuggestions(env, domain, seo, searchConsole);\n  base.recommendations = await smartRecommendations(env, base);\n  await enrichHealthReport(env, user, base);", 'enrich health report')

old_summary = """function fullScanSummary(report) {\n  const speed = report.pageSpeed?.performance == null ? 'N/A' : `${report.pageSpeed.performance}/100`;\n  return `🧪 <b>Full Scan Complete</b>\\n\\n🌐 <b>${esc(report.domain)}</b>\\n📈 SEO: <b>${report.seo.score}/100</b> — ${scoreLabel(report.seo.score)}\\n🌍 GEO: <b>${report.geoAeo.geoScore}/100</b>\\n💬 AEO: <b>${report.geoAeo.aeoScore}/100</b>\\n⚡ Mobile performance: <b>${speed}</b>\\n🔗 Broken links: <b>${report.links.broken.length}</b> / ${report.links.checked} checked\\n📄 robots.txt: ${report.robots.exists ? '✅' : '❌'}  •  Sitemap: ${report.sitemap.exists ? '✅' : '❌'}\\n\\n📑 <b>Signed PDF report:</b> ${esc(report.reportId)}\\n💡 The PDF includes prioritized improvements, keyword opportunities, provider details, expiry data and connected Google metrics when available.`;\n}"""
new_summary = """function fullScanSummary(report) {\n  const speed = report.pageSpeed?.performance == null ? 'N/A' : `${report.pageSpeed.performance}/100`;\n  const h=report.health||{};\n  const fixes=(report.topFixes||[]).slice(0,3).map((x,i)=>`${i+1}. ${x.severity==='high'?'🔴':x.severity==='medium'?'🟡':'🟢'} ${esc(x.text)}`).join('\\n');\n  return `🧪 <b>Full Scan Complete</b>\\n\\n🌐 <b>${esc(report.domain)}</b>\\n❤️ <b>WEB DOCTOR SCORE: ${h.healthScore ?? 'N/A'}/100</b>\\n\\n📅 Domain: ${h.domainScore ?? 'N/A'}/100 • 🔐 SSL: ${h.sslScore ?? 'N/A'}/100\\n🛡 Security: ${h.securityScore ?? 'N/A'}/100 • 🧭 DNS: ${h.dnsScore ?? 'N/A'}/100\\n📈 SEO: <b>${report.seo.score}/100</b> • ⚡ Performance: <b>${speed}</b>\\n⏱ Availability: <b>${h.availabilityScore ?? 'N/A'}/100</b>\\n🌍 GEO: ${report.geoAeo.geoScore}/100 • 💬 AEO: ${report.geoAeo.aeoScore}/100\\n🔗 Broken links: <b>${report.links.broken.length}</b> / ${report.links.checked} checked\\n📄 robots.txt: ${report.robots.exists ? '✅' : '❌'} • Sitemap: ${report.sitemap.exists ? '✅' : '❌'}\\n\\n🧠 <b>Top fixes</b>\\n${fixes||'✅ No urgent fix detected.'}\\n\\n📑 <b>Signed PDF report:</b> ${esc(report.reportId)}`;\n}"""
once(old_summary,new_summary,'full scan summary')
once("    await send(env, chatId, fullScanSummary(report), { reply_markup: scheduleButtons(domain) });",
     "    await send(env, chatId, fullScanSummary(report), { reply_markup: healthActionButtons(domain) });", 'health buttons after scan')

# Commands and help.
once("/schedule example.com weekly — scheduled reports\\n/google — connect your own Google account data",
     "/schedule example.com weekly — scheduled reports\\n/score example.com — website health score\\n/compare example.com — compare latest scans\\n/fix example.com — top 3 fixes\\n/emergency example.com — outage diagnostics\\n/email you@example.com — email alerts\\n/google — connect your own Google account data", 'help commands')

command_block = r'''
  if (cmd === '/email') {
    const value=String(args[0]||'').trim().toLowerCase();
    if(!value) return void await send(env,chatId,`📧 <b>Email notifications</b>\n\nCurrent: ${user.notification_email?`<code>${esc(user.notification_email)}</code>`:'Not configured'}\n\nSet: <code>/email you@example.com</code>\nDisable: <code>/email off</code>\n\nEmail alerts can include downtime/recovery, security-relevant website changes and Pro/Team scheduled PDF reports.`);
    if(value==='off'){ await env.DB.prepare('UPDATE users SET notification_email=NULL,updated_at=? WHERE id=?').bind(nowIso(),user.id).run(); return void await send(env,chatId,'✅ Email notifications disabled.'); }
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return void await send(env,chatId,'❌ Enter a valid email address.');
    await env.DB.prepare('UPDATE users SET notification_email=?,updated_at=? WHERE id=?').bind(value,nowIso(),user.id).run(); user.notification_email=value;
    await send(env,chatId,`✅ <b>Email notifications enabled</b>\n\n📧 <code>${esc(value)}</code>\n\nIf the platform sender is configured, alerts will be delivered here.`);
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
'''
once("  if (cmd === '/gift') return void await sendPendingGiftBox(env, user, chatId, { force: true });", command_block + "\n  if (cmd === '/gift') return void await sendPendingGiftBox(env, user, chatId, { force: true });", 'new user commands')

# Team help and commands.
once("/schedule domain weekly\\n/list",
     "/schedule domain weekly\\n/score domain\\n/compare domain\\n/fix domain\\n/emergency domain\\n/list", 'team help health commands')
once("  if (cmd === '/plans') return send(env, chatId, plansText(access.owner));",
     "  if (cmd === '/plans') return send(env, chatId, plansText(access.owner));\n  if (['/score','/compare','/fix','/emergency'].includes(cmd)) { if(!args[0]) return send(env,chatId,`💡 Usage: <code>${cmd} example.com</code>`); let domain; try{domain=normalizeDomain(args[0]);}catch{return send(env,chatId,'❌ Invalid domain.');} if(cmd==='/score') return send(env,chatId,await healthScoreText(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); if(cmd==='/compare') return send(env,chatId,await compareText(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); if(cmd==='/fix') return send(env,chatId,await fixesText(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); return send(env,chatId,await emergencyDoctor(env,access.owner,domain),{reply_markup:healthActionButtons(domain)}); }", 'team health handlers')

# Callback health actions.
once("  if (action === 'statusdomain') return send(env, q.message.chat.id, `✅ <b>${esc(domain)}</b> is verified and monitored.`, { reply_markup: scheduleButtons(domain) });\n  if (['check','scan','seo','performance','ssl','provider','links','robots','keywords'].includes(action)) return runTool(env, q.message.chat.id, user, action, domain);",
     "  if (action === 'statusdomain') return send(env, q.message.chat.id, `✅ <b>${esc(domain)}</b> is verified and monitored.`, { reply_markup: scheduleButtons(domain) });\n  if (action === 'score') return send(env,q.message.chat.id,await healthScoreText(env,user,domain),{reply_markup:healthActionButtons(domain)});\n  if (action === 'compare') return send(env,q.message.chat.id,await compareText(env,user,domain),{reply_markup:healthActionButtons(domain)});\n  if (action === 'fix') return send(env,q.message.chat.id,await fixesText(env,user,domain),{reply_markup:healthActionButtons(domain)});\n  if (action === 'emergency') return send(env,q.message.chat.id,await emergencyDoctor(env,user,domain),{reply_markup:healthActionButtons(domain)});\n  if (['check','scan','seo','performance','ssl','provider','links','robots','keywords'].includes(action)) return runTool(env, q.message.chat.id, user, action, domain);", 'health callbacks')

# Registration gate before creating a user.
once("  if (!msg.from) return;\n  let user = await upsertUser(env, msg.from, msg.chat.id);",
     "  if (!msg.from) return;\n  const existingUser = await env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(msg.from.id)).first();\n  if (!existingUser && !(await registrationIsOpen(env))) { await waitlistRegistration(env,msg.from,msg.chat.id); await reactToMessage(env,msg,'🚫'); return send(env,msg.chat.id,'🚪 <b>New user registration is currently closed</b>\\n\\nWEB DOCTOR PRO is temporarily not accepting new accounts. You have been added to the waiting list automatically.\\n\\nWhen registrations reopen, I will message you here.'); }\n  let user = await upsertUser(env, msg.from, msg.chat.id);", 'registration gate')

# Admin menu and commands.
once("    [{ text: '📢 Broadcasts', callback_data: 'admin:broadcasts' }, { text: '💎 Plans', callback_data: 'admin:plans' }],\n    [{ text: '➕ Create Ad', callback_data: 'admin:adcreate' }, { text: '➕ Broadcast', callback_data: 'admin:broadcastcreate' }],",
     "    [{ text: '📢 Broadcasts', callback_data: 'admin:broadcasts' }, { text: '💎 Plans', callback_data: 'admin:plans' }],\n    [{ text: '🚪 Registrations', callback_data: 'admin:registrations' }, { text: '📧 Email', callback_data: 'admin:email' }],\n    [{ text: '➕ Create Ad', callback_data: 'admin:adcreate' }, { text: '➕ Broadcast', callback_data: 'admin:broadcastcreate' }],", 'admin menu buttons')

admin_cmds = r'''
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
'''
once("  if (cmd === '/admin_cancel') { await clearAdminSession(env,user.id); return void await send(env,chatId,'✅ Admin draft mode cleared.'); }",
     "  if (cmd === '/admin_cancel') { await clearAdminSession(env,user.id); return void await send(env,chatId,'✅ Admin draft mode cleared.'); }\n" + admin_cmds, 'admin registration/email commands')

# Admin callbacks.
once("    if (data === 'admin:users') { const v = await adminUsersView(env); return send(env, q.message.chat.id, v.text, { reply_markup: v.markup }); }",
     "    if (data === 'admin:users') { const v = await adminUsersView(env); return send(env, q.message.chat.id, v.text, { reply_markup: v.markup }); }\n    if (data === 'admin:registrations') return send(env,q.message.chat.id,await registrationAdminText(env),{reply_markup:{inline_keyboard:[[{text:'🟢 Open',callback_data:'adminreg:open'},{text:'🔴 Close',callback_data:'adminreg:close'}],[{text:'🔄 Refresh',callback_data:'admin:registrations'}],[{text:'↩️ Admin Home',callback_data:'admin:home'}]]}});\n    if (data === 'admin:email') return send(env,q.message.chat.id,await smtpStatusText(env),{reply_markup:{inline_keyboard:[[{text:'🧪 Send Test',callback_data:'adminemail:test'},{text:'⏯ Toggle',callback_data:'adminemail:toggle'}],[{text:'📖 App Password Guide',callback_data:'adminemail:guide'}],[{text:'↩️ Admin Home',callback_data:'admin:home'}]]}});\n    if (data.startsWith('adminreg:')) { const open=data.endsWith(':open'); await setAppMeta(env,'registrations_open',open?'1':'0'); if(open) await notifyRegistrationWaitlist(env,80); return send(env,q.message.chat.id,await registrationAdminText(env),{reply_markup:adminMenuMarkup()}); }\n    if (data.startsWith('adminemail:')) { const action=data.split(':')[1]; const cfg=await env.DB.prepare('SELECT * FROM smtp_config WHERE id=1').first(); if(action==='guide') return send(env,q.message.chat.id,`📖 <b>Gmail App Password Setup</b>\n\n1. Use a separate Gmail account for WEB DOCTOR PRO.\n2. Turn on Google 2-Step Verification.\n3. Open Google Account → Security → App passwords.\n4. Create an App Password named WEB DOCTOR PRO.\n5. Copy the 16-character password once.\n6. Send privately here:\n<code>/admin_email_setup secondaccount@gmail.com APP_PASSWORD</code>\n\n⚠️ Do not use your normal Google Account password.`); if(!cfg) return send(env,q.message.chat.id,'⚪ Email sender is not configured. Use /admin_email for setup instructions.'); if(action==='toggle'){await env.DB.prepare('UPDATE smtp_config SET active=CASE WHEN active=1 THEN 0 ELSE 1 END,updated_at=? WHERE id=1').bind(nowIso()).run(); return send(env,q.message.chat.id,await smtpStatusText(env),{reply_markup:adminMenuMarkup()});} if(action==='test'){const x=await smtpConfig(env); if(!x)return send(env,q.message.chat.id,'⚪ Email sender is disabled or unavailable.'); try{await smtpSendWithCreds(x.sender_email,x.appPassword,{to:x.sender_email,subject:'WEB DOCTOR PRO email test',text:'Email notifications are working.'});return send(env,q.message.chat.id,'✅ Test email sent successfully.');}catch(e){return send(env,q.message.chat.id,`❌ Test failed: ${esc(short(e.message,300))}`);}} }", 'admin callbacks registration email')

# Smart downtime replacement.
pattern = re.compile(r"async function checkUptime\(env\) \{[\s\S]*?\n\}\nasync function sendScheduledReports", re.M)
match = pattern.search(s)
if not match:
    raise SystemExit('missing checkUptime block')
new_uptime = r'''async function checkUptime(env) {
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
async function sendScheduledReports'''
s = s[:match.start()] + new_uptime + s[match.end():]

# Scheduled report emails.
once("      await runFullScan(env, row.chat_id, usage.user || row, row.name, { silentProgress: true, scheduled: true });\n      await maybeServeAd(env, usage.user || row, row.chat_id).catch(() => null);",
     "      const scheduledReport = await runFullScan(env, row.chat_id, usage.user || row, row.name, { silentProgress: true, scheduled: true });\n      if (scheduledReport && row.notification_email && ['pro','team'].includes(activePlan(usage.user || row))) { const filename=`WEB-DOCTOR-PRO-${row.name}-${scheduledReport.reportId}.pdf`; const plain=`${row.report_schedule.toUpperCase()} WEB DOCTOR PRO report for ${row.name}\\nHealth score: ${scheduledReport.health?.healthScore ?? 'N/A'}/100\\nUptime: ${Number(scheduledReport.availability?.uptime ?? 100).toFixed(2)}%\\nIncidents (30d): ${scheduledReport.availability?.incidents ?? 0}\\nSEO: ${scheduledReport.seo?.score ?? 'N/A'}/100\\nPerformance: ${scheduledReport.pageSpeed?.performance ?? 'N/A'}/100`; await sendUserEmail(env,usage.user || row,`WEB DOCTOR PRO ${row.report_schedule} report — ${row.name}`,plain,{pdfBytes:scheduledReport.pdfBytes,pdfName:filename}).catch(()=>false); }\n      await maybeServeAd(env, usage.user || row, row.chat_id).catch(() => null);", 'scheduled email report')

# Add email to expiry alerts.
once("      try { await send(env,row.chat_id,`🚨 <b>${item.label} Expiry Alert</b>\\n\\n🌐 <b>${esc(row.name)}</b>\\n${item.emoji} ${d===0 ? 'Expires today' : `Expires in ${d} day(s)`}\\n🕒 ${esc(formatInTimezone(item.iso,row.timezone))}\\n\\n💡 Renew or verify it early to avoid interruption.`); }",
     "      try { const alert=`🚨 <b>${item.label} Expiry Alert</b>\\n\\n🌐 <b>${esc(row.name)}</b>\\n${item.emoji} ${d===0 ? 'Expires today' : `Expires in ${d} day(s)`}\\n🕒 ${esc(formatInTimezone(item.iso,row.timezone))}\\n\\n💡 Renew or verify it early to avoid interruption.`; await send(env,row.chat_id,alert); await sendUserEmail(env,row,`${item.label} expiry alert — ${row.name}`,alert.replace(/<[^>]+>/g,'')).catch(()=>false); }", 'email expiry alerts')
# Ensure expiry query selects notification_email via u.* style.
once("SELECT w.id watch_id,w.notify_days,u.chat_id,u.timezone,d.name,d.expires_at,d.ssl_expires_at", "SELECT w.id watch_id,w.notify_days,u.*,d.name,d.expires_at,d.ssl_expires_at", 'expiry query user fields')

# Scheduled cron additions.
once("      await checkUptime(env);\n      await refreshDomains(env);",
     "      await checkUptime(env);\n      await monitorWebsiteChanges(env);\n      await notifyRegistrationWaitlist(env);\n      await cleanupMonitoringHistory(env);\n      await refreshDomains(env);", 'scheduled monitoring additions')

# Bot commands.
once("      { command: 'schedule', description: '🗓 Schedule signed PDF reports' },\n      { command: 'google', description: '🔗 Connect your Google account data' },",
     "      { command: 'schedule', description: '🗓 Schedule signed PDF reports' },\n      { command: 'score', description: '❤️ Website health score' },\n      { command: 'compare', description: '📈 Compare latest scans' },\n      { command: 'fix', description: '🧠 Top fixes first' },\n      { command: 'emergency', description: '🆘 Emergency website diagnostics' },\n      { command: 'email', description: '📧 Email alert destination' },\n      { command: 'google', description: '🔗 Connect your Google account data' },", 'user bot commands')
once("        { command: 'admin_gift', description: '🎁 Queue a coin gift' },\n        { command: 'admin_cancel', description: '✖️ Cancel admin draft mode' }",
     "        { command: 'admin_gift', description: '🎁 Queue a coin gift' },\n        { command: 'admin_registrations', description: '🚪 Open/close new users' },\n        { command: 'admin_email', description: '📧 Email sender settings' },\n        { command: 'admin_email_setup', description: '🔐 Configure Gmail App Password' },\n        { command: 'admin_cancel', description: '✖️ Cancel admin draft mode' }", 'admin bot commands')

# PDF report health block.
once_lib("  kv('Certificate issuer', report.sslIssuer || 'Not available');\n\n  h2('SEO Findings');",
         "  kv('Certificate issuer', report.sslIssuer || 'Not available');\n\n  if (report.health) {\n    h2('WEB DOCTOR Health Score');\n    kv('Overall score', `${report.health.healthScore}/100`);\n    kv('Domain', `${report.health.domainScore}/100`);\n    kv('SSL', `${report.health.sslScore}/100`);\n    kv('Security', `${report.health.securityScore}/100`);\n    kv('SEO', `${report.health.seoScore}/100`);\n    kv('Performance', `${report.health.performanceScore}/100`);\n    kv('DNS', `${report.health.dnsScore}/100`);\n    kv('Availability', `${report.health.availabilityScore}/100`);\n    if (report.availability) kv('Measured uptime', `${Number(report.availability.uptime || 0).toFixed(2)}%`);\n    (report.topFixes || []).slice(0,3).forEach((x,i) => p(`${i+1}. [${String(x.severity||'info').toUpperCase()}] ${x.text}`));\n  }\n\n  h2('SEO Findings');", 'pdf health score block')

# Version package and tests.
index_path.write_text(s)
lib_path.write_text(lib)
pkg = json.loads(pkg_path.read_text())
pkg['version'] = '1.5.0'
pkg['description'] = 'Telegram website doctor with smart uptime/recovery alerts, change monitoring, health scoring, scan comparison, emergency diagnostics, email notifications, admin controls, plans, Team workspaces and signed PDF reports on Cloudflare Workers + D1'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n')

t = test_path.read_text()
t += r'''

test('v1.5 monitoring health email and registration controls are wired', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const lib = await readFile(new URL('../src/lib.js', import.meta.url), 'utf8');
  assert.match(source, /const VERSION = '1\.5\.0'/);
  assert.match(source, /UPTIME_CONFIRM_FAILURES = 2/);
  assert.match(source, /monitorWebsiteChanges/);
  assert.match(source, /website_change_events/);
  assert.match(source, /WEB DOCTOR SCORE/);
  assert.match(source, /compareText/);
  assert.match(source, /emergencyDoctor/);
  assert.match(source, /smtp\.gmail\.com/);
  assert.match(source, /registration_waitlist/);
  assert.match(source, /registrations_open/);
  assert.match(source, /adminemail:/);
  assert.match(source, /adminreg:/);
  assert.match(lib, /WEB DOCTOR Health Score/);
});
'''
test_path.write_text(t)
