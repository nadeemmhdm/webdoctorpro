import {
  normalizeDomain, parseRdap, daysUntil, formatInTimezone, validTimezone,
  detectDnsProvider, detectHostingProvider, analyzeSeoHtml, analyzeGeoAeo, parseRobots, parseSitemap,
  parseCertSpotter, fallbackKeywords, normalizeTxtRecord, parsePageSpeed, scheduleIntervalMs, buildReportPdf
} from './lib.js';

const VERSION = '1.2.0';
const DEVELOPER = 'Nadeem';
const GITHUB_URL = 'https://github.com/nadeemmhdm/webdoctorpro';
const PUBLIC_BASE_URL = 'https://webdoctorpro.nadeemmhdm-ai.workers.dev';
const LAST_UPDATED_AT = '2026-10-12T18:32:00+05:30';
const ALERT_DAYS = [30, 14, 7, 3, 1, 0];
const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b-cloud';
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
      { command: 'performance', description: '⚡ Google PageSpeed report' },
      { command: 'ssl', description: '🔐 Check certificate expiry' },
      { command: 'provider', description: '🏢 Hosting, DNS & registrar info' },
      { command: 'links', description: '🔗 Detect broken internal links' },
      { command: 'robots', description: '📄 Robots.txt & sitemap analysis' },
      { command: 'keywords', description: '✨ SEO keyword suggestions' },
      { command: 'add', description: '🛡 Verify ownership & monitor' },
      { command: 'verify', description: '🔄 Verify DNS ownership record' },
      { command: 'schedule', description: '🗓 Schedule PDF reports' },
      { command: 'google', description: '🔗 Connect Google read-only data' },
      { command: 'analytics', description: '📊 Map an Analytics property' },
      { command: 'list', description: '📋 View monitored websites' },
      { command: 'remove', description: '➖ Stop monitoring a website' },
      { command: 'status', description: '🩺 Bot status & version' },
      { command: 'settings', description: '⚙️ Your settings & connections' },
      { command: 'timezone', description: '🕒 Set your timezone' },
      { command: 'help', description: '❓ Help & examples' }
    ];
    await tg(env, 'setMyCommands', { commands });
    await tg(env, 'setMyDescription', { description: '🩺 WEB DOCTOR PRO verifies website ownership, monitors uptime/domain/certificate health, and delivers signed SEO/GEO/AEO PDF reports.' });
    await tg(env, 'setMyShortDescription', { short_description: '🩺 Website health, uptime & SEO report bot' });
    await env.DB.prepare("INSERT INTO app_meta(key,value,updated_at) VALUES('telegram_profile_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(VERSION, nowIso()).run();
  } catch (e) { console.error(JSON.stringify({ event: 'profile_sync_failed', error: e.message })); }
}

async function upsertUser(env, from, chatId) {
  const now = nowIso();
  await env.DB.prepare(`INSERT INTO users (telegram_user_id, chat_id, username, first_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET chat_id=excluded.chat_id, username=excluded.username, first_name=excluded.first_name, updated_at=excluded.updated_at`)
    .bind(String(from.id), String(chatId), from.username || null, from.first_name || null, now, now).run();
  return env.DB.prepare('SELECT * FROM users WHERE telegram_user_id=?').bind(String(from.id)).first();
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
  if (!env.PAGESPEED_API_KEY) return null;
  const q = new URLSearchParams({ url: `https://${domain}`, strategy, key: env.PAGESPEED_API_KEY });
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
  if (!env.OLLAMA_API_KEY) return null;
  try {
    const r = await fetch('https://ollama.com/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OLLAMA_API_KEY}` },
      body: JSON.stringify({ model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, stream: false, messages: [{ role: 'user', content: prompt }] }),
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
function googleConfigured(env) { return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_TOKEN_KEY); }
async function googleConnection(env, userId) { return env.DB.prepare('SELECT * FROM google_connections WHERE user_id=?').bind(userId).first(); }
async function saveGoogleTokens(env, userId, tokenData, email = null) {
  const encrypted = await encryptGoogle(env, tokenData);
  await env.DB.prepare(`INSERT INTO google_connections(user_id,token_cipher,scopes,email,created_at,updated_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET token_cipher=excluded.token_cipher,scopes=excluded.scopes,email=COALESCE(excluded.email,google_connections.email),updated_at=excluded.updated_at`)
    .bind(userId, encrypted, tokenData.scope || '', email, nowIso(), nowIso()).run();
}
async function getGoogleAccessToken(env, userId) {
  const row = await googleConnection(env, userId); if (!row) return null;
  let t = await decryptGoogle(env, row.token_cipher);
  if (t.access_token && Number(t.expires_at || 0) > Date.now() + 60000) return t.access_token;
  if (!t.refresh_token) return null;
  const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: t.refresh_token, grant_type: 'refresh_token' });
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error(`Google token refresh failed (${r.status})`);
  const fresh = await r.json();
  t = { ...t, ...fresh, refresh_token: fresh.refresh_token || t.refresh_token, expires_at: Date.now() + (fresh.expires_in || 3600) * 1000 };
  await saveGoogleTokens(env, userId, t, row.email);
  return t.access_token;
}
async function createGoogleConnectUrl(env, user) {
  if (!googleConfigured(env)) return null;
  const state = randomHex(24), expires = new Date(Date.now() + OAUTH_TTL_MS).toISOString();
  await env.DB.prepare('INSERT INTO oauth_states(state,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(state, user.id, nowIso(), expires).run();
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: `${PUBLIC_BASE_URL}/google/callback`, response_type: 'code', access_type: 'offline',
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
  if (!env.PAGESPEED_API_KEY) return `⚡ <b>Performance — ${esc(domain)}</b>\n\nℹ️ Google PageSpeed integration is not configured on the bot yet. Core website scanning remains available.`;
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
  if (action === 'scan') return runFullScan(env, chatId, user, domain);
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
  } catch (e) {
    await edit(env, chatId, msg.message_id, `⚠️ <b>Check could not finish</b>\n\n🌐 ${esc(domain)}\n${esc(short(e.message, 500))}`);
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
  return `🩺 <b>WEB DOCTOR PRO</b>\n${hi}\n\n🌐 Website health • ⏱ Uptime • 📅 Domain expiry • 🔐 Certificate expiry • 📈 SEO/GEO/AEO • 📑 Signed PDF reports\n\n<b>Fastest way</b>\nSend a domain directly:\n<code>example.com</code>\n\n<b>Full report</b>\n<code>/scan example.com</code>\nThe Full Scan uses the WEB DOCTOR PRO branded PDF template with report metadata and signature.\n\n<b>Monitoring</b>\n<code>/add example.com</code>\nMonitoring requires a one-time DNS TXT ownership verification.\n\nUse /help for all commands.`;
}
async function statusText(env, user) {
  const [count, conn] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) c FROM watches WHERE user_id=? AND active=1`).bind(user.id).first(),
    googleConnection(env, user.id).catch(() => null)
  ]);
  return `🩺 <b>WEB DOCTOR PRO Status</b>\n\n🟢 <b>Bot status:</b> Online\n📦 <b>Version:</b> v${VERSION}\n👨‍💻 <b>Developer:</b> ${DEVELOPER}\n🔗 <b>GitHub:</b> ${GITHUB_URL}\n🗄 <b>Database:</b> Connected\n⏱ <b>Uptime checks:</b> Every minute\n🌐 <b>Your monitored sites:</b> ${count?.c || 0}\n🔗 <b>Google connection:</b> ${conn ? '✅ Connected' : '⚪ Optional / not connected'}\n🕒 <b>Last update:</b> ${esc(formatInTimezone(LAST_UPDATED_AT, user.timezone_configured ? user.timezone : 'Asia/Kolkata'))}`;
}
async function settingsText(env, user) {
  const conn = await googleConnection(env, user.id).catch(() => null);
  return `⚙️ <b>Your Settings</b>\n\n🕒 <b>Timezone:</b> <code>${esc(user.timezone_configured ? user.timezone : 'Not configured')}</code>\n📅 <b>Domain alerts:</b> ${ALERT_DAYS.join(', ')} days\n🔐 <b>Certificate alerts:</b> ${ALERT_DAYS.join(', ')} days\n⏱ <b>Uptime alerts:</b> Enabled for verified monitored sites\n📑 <b>Scheduled PDF reports:</b> Configure per domain with /schedule\n🔗 <b>Google Search / Analytics:</b> ${conn ? `Connected${conn.email ? ` as ${esc(conn.email)}` : ''}` : 'Not connected'}\n🔒 <b>Ownership:</b> DNS TXT verification required before monitoring`;
}

async function handleAdd(env, chatId, user, domain) {
  if (!(await requireTimezone(env, chatId, user))) return;
  const v = await requestVerification(env, user, domain);
  if (v.alreadyVerified) {
    const watch = await activateWatch(env, user, domain, v.verification);
    await send(env, chatId, `✅ <b>Ownership already verified</b>\n\n🌐 ${esc(domain)}\n⏱ Uptime monitoring: active\n📅 Domain expiry alerts: active\n🔐 Certificate expiry alerts: active\n\nA fresh full report will be prepared now.`, { reply_markup: scheduleButtons(domain) });
    return runFullScan(env, chatId, user, domain);
  }
  const x = v.verification;
  await send(env, chatId, `🛡 <b>Verify website ownership</b>\n\n🌐 <b>${esc(domain)}</b>\n\nAdd this DNS TXT record at your DNS provider:\n\n<b>Type</b>\n<code>TXT</code>\n\n<b>Name / Host</b>\n<code>${esc(x.record_name)}</code>\n\n<b>Value</b>\n<code>${esc(x.token)}</code>\n\n⏳ <b>Valid for:</b> 24 hours\n\nAfter saving the record, tap <b>Verify DNS Now</b>. Once verified, monitoring activates and WEB DOCTOR PRO automatically sends the first signed PDF report.`, { reply_markup: verifyButtons(domain) });
}
async function handleVerify(env, chatId, user, domain) {
  const msg = await startProgress(env, chatId, `Verifying ${domain}`, 'Looking for the unique DNS TXT record…');
  const x = await verifyOwnership(env, user, domain);
  if (!x.ok) return edit(env, chatId, msg.message_id, `⏳ <b>Verification not complete yet</b>\n\n🌐 ${esc(domain)}\n${esc(x.reason)}\n\nKeep the TXT record in DNS and try again.`, { reply_markup: verifyButtons(domain) });
  const watch = await activateWatch(env, user, domain, x.verification);
  await edit(env, chatId, msg.message_id, `✅ <b>Ownership verified</b>\n\n🌐 ${esc(domain)}\n🛡 DNS verification: complete\n⏱ Uptime monitoring: active\n📅 Domain expiry alerts: active\n🔐 Certificate expiry alerts: active\n\n🧪 Preparing your first full signed report now…`, { reply_markup: scheduleButtons(domain) });
  return runFullScan(env, chatId, user, domain);
}
async function setSchedule(env, chatId, user, domain, frequency) {
  const interval = scheduleIntervalMs(frequency);
  const watch = await env.DB.prepare(`SELECT w.id,w.verified_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=? AND w.active=1`).bind(user.id, domain).first();
  if (!watch?.verified_at) return send(env, chatId, `🛡 <b>Verification required</b>\n\nUse <code>/add ${esc(domain)}</code> first.`);
  if (frequency === 'off') {
    await env.DB.prepare(`UPDATE watches SET report_schedule='off',next_report_at=NULL,updated_at=? WHERE id=?`).bind(nowIso(), watch.id).run();
    return send(env, chatId, `⏹ <b>Scheduled reports disabled</b>\n🌐 ${esc(domain)}`);
  }
  if (!interval) return send(env, chatId, '❌ Choose daily, weekly, monthly or off.');
  const next = new Date(Date.now() + interval).toISOString();
  await env.DB.prepare(`UPDATE watches SET report_schedule=?,next_report_at=?,updated_at=? WHERE id=?`).bind(frequency, next, nowIso(), watch.id).run();
  return send(env, chatId, `🗓 <b>Scheduled reports enabled</b>\n\n🌐 ${esc(domain)}\n📑 Frequency: <b>${esc(frequency)}</b>\n🕒 Next report: ${esc(formatInTimezone(next, user.timezone || 'UTC'))}\n\nEach scheduled report is delivered as a signed PDF.`);
}

async function handleCommand(env, msg, user) {
  const chatId = msg.chat.id, text = String(msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/), cmd = rawCmd.toLowerCase().split('@')[0];
  if (cmd === '/start') { await send(env, chatId, welcome(user.first_name)); if (!user.timezone_configured) await requireTimezone(env, chatId, user); return; }
  if (cmd === '/help') return void await send(env, chatId, `${welcome(user.first_name)}\n\n<b>Commands</b>\n/check example.com — quick check\n/scan example.com — full scan + signed PDF\n/seo example.com — SEO/GEO/AEO\n/performance example.com — PageSpeed\n/ssl example.com — certificate expiry\n/provider example.com — hosting/DNS/registrar\n/links example.com — broken links\n/robots example.com — robots/sitemap/llms.txt\n/keywords example.com — keyword opportunities\n/add example.com — verify + monitor\n/verify example.com — re-check DNS TXT\n/schedule example.com weekly — scheduled reports\n/google — connect Search Console/Analytics read-only\n/analytics example.com 123456789 — map optional Analytics property\n/list — monitored sites\n/remove example.com — stop monitoring\n/status — bot status\n/settings — your settings`);
  if (cmd === '/timezone') {
    const tz = args.join(' '); if (!tz) return void await requireTimezone(env, chatId, user);
    if (!(await setTimezone(env, user.id, tz))) return void await send(env, chatId, '❌ Invalid timezone. Example: <code>/timezone Asia/Kolkata</code>');
    return void await send(env, chatId, `✅ <b>Timezone set</b>\n\n🕒 ${esc(formatInTimezone(nowIso(), tz))}\n🌍 <code>${esc(tz)}</code>`);
  }
  if (cmd === '/time') { if (!(await requireTimezone(env, chatId, user))) return; return void await send(env, chatId, `🕒 <b>Your local time</b>\n\n${esc(formatInTimezone(nowIso(), user.timezone))}`); }
  if (cmd === '/status') return void await send(env, chatId, await statusText(env, user));
  if (cmd === '/settings') return void await send(env, chatId, await settingsText(env, user));
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
  if (cmd === '/google') {
    const conn = await googleConnection(env, user.id).catch(() => null);
    if (conn) return void await send(env, chatId, `🔗 <b>Google data is connected</b>${conn.email ? `\n👤 ${esc(conn.email)}` : ''}\n\nSearch Console can be matched automatically for verified domains. Analytics is optional and can be mapped with:\n<code>/analytics example.com PROPERTY_ID</code>`);
    const url = await createGoogleConnectUrl(env, user);
    if (!url) return void await send(env, chatId, 'ℹ️ <b>Google integration is not configured on the bot yet.</b>\n\nCore monitoring and reports continue to work normally.');
    return void await send(env, chatId, `🔗 <b>Connect Google read-only data</b>\n\nThis enables Search Console metrics and optional Analytics data inside verified-domain reports.\n\nThe bot requests read-only scopes only.`, { reply_markup: { inline_keyboard: [[{ text: '🔗 Connect Google', url }]] } });
  }
  if (cmd === '/analytics') {
    if (!args[0] || !args[1]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/analytics example.com 123456789</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    if (!/^\d+$/.test(args[1])) return void await send(env, chatId, '❌ Analytics property ID should contain numbers only.');
    const watch = await env.DB.prepare(`SELECT w.id,w.verified_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND d.name=? AND w.active=1`).bind(user.id, domain).first();
    if (!watch?.verified_at) return void await send(env, chatId, `🛡 Verify and monitor the domain first with <code>/add ${esc(domain)}</code>.`);
    if (!(await googleConnection(env, user.id))) return void await send(env, chatId, '🔗 Connect Google first with /google.');
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
  if (data.startsWith('tz:')) {
    const tz = data.slice(3); if (await setTimezone(env, user.id, tz)) { await answerCb(env, q.id, `Timezone: ${tz}`); return send(env, q.message.chat.id, `✅ <b>Timezone set</b>\n\n🕒 ${esc(formatInTimezone(nowIso(), tz))}`); }
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
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message; if (!msg?.from || !msg?.chat) return;
  const user = await upsertUser(env, msg.from, msg.chat.id), text = String(msg.text || '').trim();
  if (text.startsWith('/')) return handleCommand(env, msg, user);
  try { return runTool(env, msg.chat.id, user, 'check', normalizeDomain(text)); }
  catch { return send(env, msg.chat.id, '💡 <b>Send a domain</b>\n\nExample: <code>example.com</code>\n\nUse /help for all tools.'); }
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
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.notify_days,u.chat_id,u.timezone,d.name,d.expires_at,d.ssl_expires_at FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND u.timezone_configured=1`).all();
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
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.uptime_state,w.uptime_last_status,w.uptime_fail_count,u.chat_id,u.timezone,d.name FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL ORDER BY COALESCE(w.uptime_last_checked_at,'') LIMIT 80`).all();
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
  const due = await env.DB.prepare(`SELECT w.id watch_id,w.report_schedule,w.next_report_at,u.*,d.name FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id WHERE w.active=1 AND w.verified_at IS NOT NULL AND w.report_schedule<>'off' AND w.next_report_at IS NOT NULL AND w.next_report_at<=? ORDER BY w.next_report_at LIMIT 4`).bind(nowIso()).all();
  for (const row of due.results) {
    try {
      await runFullScan(env, row.chat_id, row, row.name, { silentProgress: true, scheduled: true });
      const interval = scheduleIntervalMs(row.report_schedule), next = interval ? new Date(Date.now() + interval).toISOString() : null;
      await env.DB.prepare('UPDATE watches SET last_report_at=?,next_report_at=?,updated_at=? WHERE id=?').bind(nowIso(),next,nowIso(),row.watch_id).run();
    } catch (e) { await env.DB.prepare('UPDATE watches SET next_report_at=? WHERE id=?').bind(new Date(Date.now()+3600000).toISOString(),row.watch_id).run(); }
  }
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url), state = url.searchParams.get('state'), code = url.searchParams.get('code'), error = url.searchParams.get('error');
  if (error) return new Response(`<html><body><h2>WEB DOCTOR PRO</h2><p>Google connection was cancelled: ${esc(error)}</p><p>You can close this page and return to Telegram.</p></body></html>`, { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } });
  if (!state || !code || !googleConfigured(env)) return new Response('Invalid connection request.', { status: 400 });
  const st = await env.DB.prepare('SELECT * FROM oauth_states WHERE state=? AND expires_at>?').bind(state, nowIso()).first();
  if (!st) return new Response('This connection link is invalid or expired.', { status: 400 });
  await env.DB.prepare('DELETE FROM oauth_states WHERE state=?').bind(state).run();
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: `${PUBLIC_BASE_URL}/google/callback`, grant_type: 'authorization_code' })
  });
  if (!tokenRes.ok) return new Response('Google connection failed during token exchange.', { status: 502 });
  const token = await tokenRes.json(); token.expires_at = Date.now() + (token.expires_in || 3600) * 1000;
  let email = null;
  try { const ur = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${token.access_token}` } }); if (ur.ok) email = (await ur.json()).email || null; } catch { /* ignore */ }
  await saveGoogleTokens(env, st.user_id, token, email);
  const user = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(st.user_id).first();
  if (user?.chat_id) await send(env, user.chat_id, `✅ <b>Google read-only data connected</b>${email ? `\n👤 ${esc(email)}` : ''}\n\nSearch Console data can now be included automatically for matching verified domains.\n\nAnalytics is optional; map a property with:\n<code>/analytics example.com PROPERTY_ID</code>`).catch(() => {});
  return new Response(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>WEB DOCTOR PRO</title></head><body style="font-family:system-ui;max-width:620px;margin:60px auto;padding:20px"><h1>WEB DOCTOR PRO</h1><h2>Connection successful</h2><p>Your Google read-only connection is ready. You can close this page and return to Telegram.</p><p style="color:#666">WEB DOCTOR PRO ${VERSION} · Developer Nadeem</p></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-web-doctor-signature': signature() } });
}

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
      await checkUptime(env);
      await refreshDomains(env);
      await sendExpiryAlerts(env);
      await sendScheduledReports(env);
    })().catch((e) => console.error(JSON.stringify({ event: 'scheduled_failed', error: e.message }))));
  }
};
