import {
  normalizeDomain, parseRdap, daysUntil, formatInTimezone, validTimezone,
  detectDnsProvider, detectHostingProvider, analyzeSeoHtml, parseRobots, parseSitemap,
  parseCertSpotter, fallbackKeywords
} from './lib.js';

const VERSION = '1.1.0';
const DEVELOPER = 'Nadeem';
const GITHUB_URL = 'https://github.com/nadeemmhdm/webdoctorpro';
const LAST_UPDATED_AT = '2026-10-12T18:06:35+05:30';
const ALERT_DAYS = [30, 14, 7, 3, 1, 0];
const TELEGRAM_API = 'https://api.telegram.org';
const DEFAULT_OLLAMA_MODEL = 'gpt-oss:20b-cloud';
const MAX_HTML_BYTES = 600_000;
const MAX_LINK_CHECKS = 15;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function short(s, max = 500) { const x = String(s ?? '').trim(); return x.length > max ? `${x.slice(0, max - 1)}…` : x; }
function progress(score) { return score >= 85 ? '🟢 Excellent' : score >= 70 ? '🟡 Good' : score >= 50 ? '🟠 Needs work' : '🔴 Critical'; }

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
async function answerCb(env, id, text) {
  try { await tg(env, 'answerCallbackQuery', { callback_query_id: id, text: short(text, 180) }); } catch { /* ignore */ }
}

function domainButtons(domain, monitoring = false) {
  return { inline_keyboard: [
    [{ text: '🧪 Full Scan', callback_data: `scan:${domain}` }, { text: '📈 SEO', callback_data: `seo:${domain}` }],
    [{ text: '🔐 SSL', callback_data: `ssl:${domain}` }, { text: '🏢 Provider', callback_data: `provider:${domain}` }],
    [{ text: '🔗 Broken Links', callback_data: `links:${domain}` }, { text: '🤖 Keywords', callback_data: `keywords:${domain}` }],
    [{ text: monitoring ? '✅ Monitoring' : '➕ Monitor Domain', callback_data: `add:${domain}` }]
  ] };
}

async function syncBotProfile(env) {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_meta WHERE key='telegram_profile_version'").first();
    if (row?.value === VERSION) return;
    const commands = [
      { command: 'check', description: '🌐 Quick domain & website check' },
      { command: 'scan', description: '🧪 Full website health scan' },
      { command: 'seo', description: '📈 SEO score, issues & suggestions' },
      { command: 'ssl', description: '🔐 Check SSL certificate expiry' },
      { command: 'provider', description: '🏢 Hosting, DNS & registrar info' },
      { command: 'links', description: '🔗 Find broken internal links' },
      { command: 'robots', description: '🤖 Check robots.txt & sitemap' },
      { command: 'keywords', description: '✨ AI SEO keyword suggestions' },
      { command: 'add', description: '➕ Monitor domain & SSL expiry' },
      { command: 'list', description: '📋 View monitored domains' },
      { command: 'remove', description: '➖ Stop monitoring a domain' },
      { command: 'status', description: '🩺 Bot status & version' },
      { command: 'settings', description: '⚙️ Your bot settings' },
      { command: 'timezone', description: '🕒 Set your timezone' },
      { command: 'help', description: '❓ Help & examples' }
    ];
    await tg(env, 'setMyCommands', { commands });
    await tg(env, 'setMyDescription', { description: '🩺 WEB DOCTOR PRO monitors domain & SSL expiry and audits website SEO, hosting, robots, sitemaps and broken links.' });
    await tg(env, 'setMyShortDescription', { short_description: '🩺 Domain, SSL & SEO health monitor' });
    await env.DB.prepare("INSERT INTO app_meta(key,value,updated_at) VALUES('telegram_profile_version',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .bind(VERSION, new Date().toISOString()).run();
  } catch (e) { console.error(JSON.stringify({ event: 'profile_sync_failed', error: e.message })); }
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
  const data = await r.json();
  return { domain, ...parseCertSpotter(data, domain) };
}

async function dnsLookup(domain, type) {
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`, { headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.Answer || []).filter((x) => x?.data).map((x) => String(x.data).replace(/\.$/, '').replace(/^"|"$/g, ''));
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

async function fetchText(url, maxBytes = MAX_HTML_BYTES) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` } });
  const text = await readTextLimited(r, maxBytes);
  return { status: r.status, url: r.url, text, headers: Object.fromEntries(r.headers.entries()) };
}

async function websiteSnapshot(domain) {
  const [page, ns, cname] = await Promise.all([
    fetchText(`https://${domain}`), dnsLookup(domain, 'NS'), dnsLookup(domain, 'CNAME')
  ]);
  return {
    domain, page,
    dnsProvider: detectDnsProvider(ns),
    hostingProvider: detectHostingProvider({ headers: page.headers, cnames: cname }),
    nsRecords: ns, cnameRecords: cname
  };
}

async function robotsAndSitemap(domain) {
  const robotsRes = await fetchText(`https://${domain}/robots.txt`, 200_000).catch(() => ({ status: 0, text: '', url: '' }));
  const robots = parseRobots(robotsRes.text, robotsRes.status || 599);
  const sitemapUrl = robots.sitemapUrls[0] || `https://${domain}/sitemap.xml`;
  const sitemapRes = await fetchText(sitemapUrl, 500_000).catch(() => ({ status: 0, text: '', url: sitemapUrl }));
  const sitemap = parseSitemap(sitemapRes.text, sitemapRes.status || 599);
  return { robots, sitemap, sitemapUrl };
}

async function brokenLinks(snapshot) {
  const audit = analyzeSeoHtml(snapshot.page.text, snapshot.page.url || `https://${snapshot.domain}`);
  const originHost = new URL(snapshot.page.url || `https://${snapshot.domain}`).hostname;
  const links = audit.links.filter((x) => new URL(x).hostname === originHost).slice(0, MAX_LINK_CHECKS);
  const results = await Promise.all(links.map(async (url) => {
    try {
      let r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` } });
      if ([405, 501].includes(r.status)) r = await fetch(url, { method: 'GET', redirect: 'follow', headers: { Range: 'bytes=0-0', 'user-agent': `WEB-DOCTOR-PRO/${VERSION}` } });
      return { url, status: r.status, broken: r.status >= 400 };
    } catch { return { url, status: 0, broken: true }; }
  }));
  return { checked: results.length, broken: results.filter((x) => x.broken), results };
}

async function saveDomain(env, info, extra = {}) {
  const now = new Date().toISOString();
  const next = new Date(Date.now() + 12 * 3600000).toISOString();
  await env.DB.prepare(`INSERT INTO domains (name, expires_at, registered_at, registrar, rdap_url, status, last_checked_at, next_check_at, last_error, created_at,
      ssl_expires_at, ssl_issuer, ssl_last_checked_at, ssl_next_check_at, hosting_provider, dns_provider, last_http_status, last_audit_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET expires_at=excluded.expires_at, registered_at=excluded.registered_at, registrar=excluded.registrar,
      rdap_url=excluded.rdap_url, status=excluded.status, last_checked_at=excluded.last_checked_at, next_check_at=excluded.next_check_at, last_error=NULL,
      ssl_expires_at=COALESCE(excluded.ssl_expires_at,domains.ssl_expires_at), ssl_issuer=COALESCE(excluded.ssl_issuer,domains.ssl_issuer),
      ssl_last_checked_at=COALESCE(excluded.ssl_last_checked_at,domains.ssl_last_checked_at), ssl_next_check_at=COALESCE(excluded.ssl_next_check_at,domains.ssl_next_check_at),
      hosting_provider=COALESCE(excluded.hosting_provider,domains.hosting_provider), dns_provider=COALESCE(excluded.dns_provider,domains.dns_provider),
      last_http_status=COALESCE(excluded.last_http_status,domains.last_http_status), last_audit_at=COALESCE(excluded.last_audit_at,domains.last_audit_at)`)
    .bind(info.domain, info.expiresAt || null, info.registeredAt || null, info.registrar || null, info.rdapUrl || null,
      info.found ? (info.status || 'active') : 'not-found', now, next, now,
      extra.sslExpiresAt || null, extra.sslIssuer || null, extra.sslCheckedAt || null, extra.sslNextCheckAt || null,
      extra.hostingProvider || null, extra.dnsProvider || null, extra.httpStatus ?? null, extra.auditAt || null).run();
  return env.DB.prepare('SELECT * FROM domains WHERE name=?').bind(info.domain).first();
}

function expiryLabel(iso) {
  const d = daysUntil(iso);
  if (d === null) return 'Unknown';
  if (d < 0) return `Expired ${Math.abs(d)} day(s) ago`;
  if (d === 0) return 'Expires today';
  return `${d} day(s) remaining`;
}

async function quickCheck(env, domain, tz) {
  const [rdap, ssl, site] = await Promise.allSettled([rdapLookup(domain), sslLookup(domain), websiteSnapshot(domain)]);
  const info = rdap.status === 'fulfilled' ? rdap.value : { domain, found: false, status: 'lookup-error' };
  const sslInfo = ssl.status === 'fulfilled' ? ssl.value : { expiresAt: null, issuer: null };
  const snap = site.status === 'fulfilled' ? site.value : null;
  await saveDomain(env, info, {
    sslExpiresAt: sslInfo.expiresAt, sslIssuer: sslInfo.issuer, sslCheckedAt: sslInfo.expiresAt ? new Date().toISOString() : null,
    sslNextCheckAt: sslInfo.expiresAt ? new Date(Date.now() + 24 * 3600000).toISOString() : null,
    hostingProvider: snap?.hostingProvider, dnsProvider: snap?.dnsProvider, httpStatus: snap?.page?.status, auditAt: snap ? new Date().toISOString() : null
  }).catch(() => {});
  const siteState = snap ? (snap.page.status < 400 ? `🟢 Online (HTTP ${snap.page.status})` : `🔴 HTTP ${snap.page.status}`) : '⚪ Not checked';
  return `🩺 <b>WEB DOCTOR PRO — Quick Check</b>\n\n🌐 <b>${esc(domain)}</b>\n${siteState}\n\n📅 <b>Domain expiry</b>\n${info.expiresAt ? `${esc(formatInTimezone(info.expiresAt, tz))}\n⏳ ${esc(expiryLabel(info.expiresAt))}` : '⚪ Expiry date not published'}\n\n🔐 <b>SSL certificate</b>\n${sslInfo.expiresAt ? `${esc(formatInTimezone(sslInfo.expiresAt, tz))}\n⏳ ${esc(expiryLabel(sslInfo.expiresAt))}` : '⚪ Expiry date unavailable'}\n\n🏢 <b>Hosting:</b> ${esc(snap?.hostingProvider || 'Unknown')}\n🧭 <b>DNS:</b> ${esc(snap?.dnsProvider || 'Unknown')}\n🏷 <b>Registrar:</b> ${esc(info.registrar || 'Not published')}\n\n💡 <i>Tap a tool below for a deeper report.</i>`;
}

async function seoReport(domain) {
  const snap = await websiteSnapshot(domain);
  const audit = analyzeSeoHtml(snap.page.text, snap.page.url || `https://${domain}`);
  const top = audit.issues.slice(0, 6).map((x) => `${x.severity === 'high' ? '🔴' : x.severity === 'medium' ? '🟠' : '🟡'} ${esc(x.issue)}`).join('\n') || '✅ No major on-page issues detected.';
  const suggestions = audit.suggestions.slice(0, 5).map((x) => `• ${esc(x)}`).join('\n') || '• Keep content fresh and useful.';
  return { snap, audit, text: `📈 <b>SEO Audit — ${esc(domain)}</b>\n\n🎯 <b>Score:</b> ${audit.score}/100 — ${progress(audit.score)}\n🏷 <b>Title:</b> ${esc(short(audit.title || 'Missing', 90))}\n📝 <b>Description:</b> ${esc(short(audit.description || 'Missing', 120))}\n🔠 <b>H1:</b> ${audit.h1Count}  •  H2: ${audit.h2Count}\n🖼 <b>Images with alt:</b> ${audit.imageAltCount}/${audit.imageCount}\n🔗 <b>Links:</b> ${audit.internalLinkCount} internal • ${audit.externalLinkCount} external\n🧩 <b>Structured data:</b> ${audit.jsonLd ? '✅ Found' : '⚠️ Not found'}\n\n<b>Issues</b>\n${top}\n\n<b>Recommended fixes</b>\n${suggestions}` };
}

async function providerReport(domain) {
  const [rdap, snap] = await Promise.all([rdapLookup(domain).catch(() => ({ domain })), websiteSnapshot(domain)]);
  return `🏢 <b>Provider Report — ${esc(domain)}</b>\n\n☁️ <b>Hosting/CDN:</b> ${esc(snap.hostingProvider)}\n🧭 <b>DNS provider:</b> ${esc(snap.dnsProvider)}\n🏷 <b>Domain registrar:</b> ${esc(rdap.registrar || 'Not published')}\n🌐 <b>Final URL:</b> ${esc(snap.page.url || `https://${domain}`)}\n📡 <b>HTTP status:</b> ${snap.page.status}\n🖥 <b>Server header:</b> ${esc(snap.page.headers.server || 'Hidden / not sent')}\n\n<i>Hosting detection is based on DNS/CNAME and HTTP response fingerprints; some providers intentionally hide this information.</i>`;
}

async function sslReport(domain, tz) {
  const ssl = await sslLookup(domain);
  if (!ssl.expiresAt) return `🔐 <b>SSL Report — ${esc(domain)}</b>\n\n⚪ No unexpired public certificate record was found.\n\n<i>Source: Certificate Transparency data.</i>`;
  return `🔐 <b>SSL Report — ${esc(domain)}</b>\n\n📅 <b>Certificate expiry:</b>\n${esc(formatInTimezone(ssl.expiresAt, tz))}\n⏳ <b>${esc(expiryLabel(ssl.expiresAt))}</b>\n🏛 <b>Issuer:</b> ${esc(ssl.issuer || 'Not available')}\n\n<i>Source: Certificate Transparency (Cert Spotter). This is an expiry estimate from public certificate issuance records.</i>`;
}

async function robotsReport(domain) {
  const x = await robotsAndSitemap(domain);
  return `🤖 <b>Robots & Sitemap — ${esc(domain)}</b>\n\n📄 <b>robots.txt:</b> ${x.robots.exists ? `✅ Found (HTTP ${x.robots.status})` : '❌ Missing'}\n🚫 <b>Blocks all crawling:</b> ${x.robots.blocksAll ? '🔴 Yes' : '🟢 No'}\n📌 <b>Disallow rules:</b> ${x.robots.disallowCount}\n🗺 <b>Sitemap declared:</b> ${x.robots.sitemapUrls.length ? '✅ Yes' : '⚠️ No'}\n\n🗺 <b>XML sitemap:</b> ${x.sitemap.exists ? `✅ Found (${x.sitemap.type})` : '❌ Missing'}\n🔢 <b>URLs detected:</b> ${x.sitemap.urlCount}\n📚 <b>Child sitemaps:</b> ${x.sitemap.sitemapCount}\n🔗 <b>Checked:</b> ${esc(x.sitemapUrl)}`;
}

async function linksReport(domain) {
  const snap = await websiteSnapshot(domain);
  const x = await brokenLinks(snap);
  const detail = x.broken.slice(0, 8).map((r) => `❌ ${r.status || 'ERR'} — ${esc(short(r.url, 120))}`).join('\n');
  return `🔗 <b>Broken Link Check — ${esc(domain)}</b>\n\n🔍 <b>Internal links checked:</b> ${x.checked}/${MAX_LINK_CHECKS}\n${x.broken.length ? `🚨 <b>Broken/problem links:</b> ${x.broken.length}\n\n${detail}` : '✅ <b>No broken links found in the checked sample.</b>'}\n\n<i>To keep scans fast and safe, WEB DOCTOR PRO checks up to ${MAX_LINK_CHECKS} internal links per run.</i>`;
}

async function ollamaKeywords(env, domain, audit) {
  const fallback = fallbackKeywords(audit, domain);
  if (!env.OLLAMA_API_KEY) return { ai: false, text: fallback.join(', ') };
  const prompt = `You are an SEO keyword assistant. Based ONLY on the website data below, suggest 12 concise, relevant search keywords/phrases. Avoid invented locations, claims, or services. Return only a numbered list.\nDomain: ${domain}\nTitle: ${short(audit.title, 180)}\nDescription: ${short(audit.description, 320)}\nH1 count: ${audit.h1Count}`;
  const r = await fetch('https://ollama.com/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OLLAMA_API_KEY}` },
    body: JSON.stringify({ model: env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL, stream: false, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) return { ai: false, text: fallback.join(', '), error: `Ollama HTTP ${r.status}` };
  const data = await r.json();
  return { ai: true, text: short(data?.message?.content || fallback.join(', '), 1800) };
}

async function keywordsReport(env, domain) {
  const { audit } = await seoReport(domain);
  const x = await ollamaKeywords(env, domain, audit);
  return `✨ <b>SEO Keyword Suggestions — ${esc(domain)}</b>\n\n${esc(x.text)}\n\n${x.ai ? `🤖 <i>AI-assisted with Ollama Cloud (${esc(env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL)}).</i>` : '🧠 <i>Local deterministic suggestions used. Add OLLAMA_API_KEY to enable AI-assisted keywords.</i>'}`;
}

async function fullScan(env, domain, tz) {
  const [quick, seo, robot, links] = await Promise.all([
    quickCheck(env, domain, tz), seoReport(domain), robotsReport(domain), linksReport(domain)
  ]);
  return [quick, seo.text, robot, links];
}

async function requireTimezone(env, chatId, user) {
  if (user.timezone_configured) return true;
  await send(env, chatId, '🕒 <b>Choose your timezone</b>\n\nWEB DOCTOR PRO uses this to show accurate domain and SSL expiry times.\n\n👇 Select a common timezone or use <code>/timezone Area/City</code>.', {
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

function welcome(firstName = '') {
  const hi = firstName ? `Hi ${esc(firstName)}! 👋` : 'Welcome! 👋';
  return `🩺 <b>WEB DOCTOR PRO</b>\n${hi}\n\n🌐 Monitor domains. 🔐 Track SSL expiry. 📈 Improve SEO. 🔗 Find broken links.\n\n<b>Fastest way to use me</b>\nJust send a domain like:\n<code>example.com</code>\n\n<b>Popular tools</b>\n🌐 <code>/check example.com</code> — quick health check\n🧪 <code>/scan example.com</code> — full website scan\n📈 <code>/seo example.com</code> — SEO report\n🔐 <code>/ssl example.com</code> — SSL expiry\n🏢 <code>/provider example.com</code> — hosting/DNS/registrar\n🔗 <code>/links example.com</code> — broken links\n🤖 <code>/robots example.com</code> — robots + sitemap\n✨ <code>/keywords example.com</code> — SEO keywords\n➕ <code>/add example.com</code> — expiry monitoring\n\n💡 <i>You do not need to remember commands—send a domain and use the buttons.</i>`;
}

async function addWatch(env, user, domain) {
  const [info, ssl] = await Promise.all([rdapLookup(domain), sslLookup(domain).catch(() => ({ expiresAt: null, issuer: null }))]);
  const row = await saveDomain(env, info, {
    sslExpiresAt: ssl.expiresAt, sslIssuer: ssl.issuer, sslCheckedAt: new Date().toISOString(), sslNextCheckAt: new Date(Date.now()+24*3600000).toISOString()
  });
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO watches (user_id, domain_id, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(user_id, domain_id) DO UPDATE SET active=1, updated_at=excluded.updated_at`).bind(user.id, row.id, now, now).run();
  return row;
}

async function statusText(env, user) {
  const db = await env.DB.prepare('SELECT 1 AS ok').first().catch(() => null);
  const counts = await env.DB.prepare('SELECT COUNT(*) AS domains FROM domains').first().catch(() => ({ domains: 0 }));
  const tz = user?.timezone_configured ? user.timezone : 'UTC';
  return `🩺 <b>WEB DOCTOR PRO — Status</b>\n\n🟢 <b>Bot:</b> Online\n🗄 <b>Database:</b> ${db?.ok === 1 ? '🟢 Connected' : '🔴 Error'}\n🤖 <b>Ollama AI:</b> ${env.OLLAMA_API_KEY ? '🟢 Configured' : '⚪ Optional key not configured'}\n📦 <b>Version:</b> v${VERSION}\n👨‍💻 <b>Developer:</b> ${DEVELOPER}\n🔗 <b>GitHub:</b> ${GITHUB_URL}\n🌐 <b>Domains indexed:</b> ${counts?.domains || 0}\n🕒 <b>Last update:</b> ${esc(formatInTimezone(LAST_UPDATED_AT, tz))}\n⚡ <b>Runtime:</b> Cloudflare Workers + D1\n\n✅ <i>Domain monitoring, SSL monitoring and website diagnostics are active.</i>`;
}

async function runTool(env, chatId, user, action, domain) {
  if (!(await requireTimezone(env, chatId, user))) return;
  const tz = user.timezone || 'UTC';
  const labels = { check:'🌐 Checking domain & website…', scan:'🧪 Running full website scan…', seo:'📈 Auditing SEO…', ssl:'🔐 Checking SSL certificate…', provider:'🏢 Detecting providers…', links:'🔗 Checking internal links…', robots:'🤖 Inspecting robots.txt & sitemap…', keywords:'✨ Preparing keyword suggestions…' };
  await send(env, chatId, `${labels[action] || '🔎 Checking…'}\n<b>${esc(domain)}</b>`);
  try {
    let text;
    if (action === 'check') text = await quickCheck(env, domain, tz);
    else if (action === 'scan') {
      const sections = await fullScan(env, domain, tz);
      for (let i = 0; i < sections.length; i++) {
        await send(env, chatId, sections[i], i === sections.length - 1 ? { reply_markup: domainButtons(domain) } : {});
      }
      return;
    }
    else if (action === 'seo') text = (await seoReport(domain)).text;
    else if (action === 'ssl') text = await sslReport(domain, tz);
    else if (action === 'provider') text = await providerReport(domain);
    else if (action === 'links') text = await linksReport(domain);
    else if (action === 'robots') text = await robotsReport(domain);
    else if (action === 'keywords') text = await keywordsReport(env, domain);
    else throw new Error('Unknown tool');
    if (text.length <= 3900) {
      await send(env, chatId, text, { reply_markup: domainButtons(domain) });
    } else {
      const plain = text.replace(/<[^>]+>/g, '');
      for (let i = 0; i < plain.length; i += 3800) {
        await send(env, chatId, esc(plain.slice(i, i + 3800)), i + 3800 >= plain.length ? { reply_markup: domainButtons(domain) } : {});
      }
    }
  } catch (e) {
    await send(env, chatId, `⚠️ <b>Check could not be completed</b>\n\n🌐 ${esc(domain)}\n🧾 ${esc(short(e.message, 300))}\n\n💡 Please try again in a moment. Some registries or websites may temporarily block automated checks.`);
  }
}

async function handleCommand(env, msg, user) {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const [rawCmd, ...args] = text.split(/\s+/);
  const cmd = rawCmd.toLowerCase().split('@')[0];

  if (cmd === '/start' || cmd === '/help') {
    await send(env, chatId, welcome(user.first_name));
    if (!user.timezone_configured) await requireTimezone(env, chatId, user);
    return;
  }
  if (cmd === '/timezone') {
    const tz = args.join(' ');
    if (!tz) return void await requireTimezone(env, chatId, user);
    if (!(await setTimezone(env, user.id, tz))) return void await send(env, chatId, '❌ <b>Invalid timezone</b>\n\nExample: <code>/timezone Asia/Kolkata</code>');
    return void await send(env, chatId, `✅ <b>Timezone updated</b>\n\n🕒 ${esc(formatInTimezone(new Date().toISOString(), tz))}\n🌍 <code>${esc(tz)}</code>`);
  }
  if (cmd === '/time') {
    if (!(await requireTimezone(env, chatId, user))) return;
    return void await send(env, chatId, `🕒 <b>Your local time</b>\n\n${esc(formatInTimezone(new Date().toISOString(), user.timezone))}\n🌍 <code>${esc(user.timezone)}</code>`);
  }
  if (cmd === '/status') return void await send(env, chatId, await statusText(env, user));
  if (cmd === '/settings') return void await send(env, chatId, `⚙️ <b>Your Settings</b>\n\n🕒 <b>Timezone:</b> <code>${esc(user.timezone_configured ? user.timezone : 'Not configured')}</code>\n📅 <b>Domain alerts:</b> ${ALERT_DAYS.join(', ')} days before expiry\n🔐 <b>SSL alerts:</b> ${ALERT_DAYS.join(', ')} days before expiry\n🤖 <b>AI:</b> Used only for manual keyword suggestions\n🔒 <b>Storage:</b> Cloudflare D1; no R2 media storage`);

  if (['/check','/scan','/seo','/ssl','/provider','/links','/robots','/keywords'].includes(cmd)) {
    if (!args[0]) return void await send(env, chatId, `💡 <b>Usage</b>\n<code>${cmd} example.com</code>`);
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>\n\nTry: <code>example.com</code>'); }
    return runTool(env, chatId, user, cmd.slice(1), domain);
  }
  if (cmd === '/add') {
    if (!(await requireTimezone(env, chatId, user))) return;
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/add example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    await send(env, chatId, `➕ Adding <b>${esc(domain)}</b> to monitoring…`);
    try {
      await addWatch(env, user, domain);
      return void await send(env, chatId, `✅ <b>Monitoring enabled</b>\n\n🌐 ${esc(domain)}\n📅 Domain expiry alerts: ${ALERT_DAYS.join(', ')} days\n🔐 SSL expiry alerts: ${ALERT_DAYS.join(', ')} days\n\n🩺 WEB DOCTOR PRO will continue checking it automatically.`, { reply_markup: domainButtons(domain, true) });
    } catch (e) { return void await send(env, chatId, `⚠️ Could not add this domain.\n${esc(short(e.message, 250))}`); }
  }
  if (cmd === '/list') {
    const rows = await env.DB.prepare(`SELECT d.name,d.expires_at,d.ssl_expires_at FROM watches w JOIN domains d ON d.id=w.domain_id WHERE w.user_id=? AND w.active=1 ORDER BY d.expires_at IS NULL,d.expires_at`).bind(user.id).all();
    if (!rows.results.length) return void await send(env, chatId, '📭 <b>No monitored domains yet</b>\n\nAdd one with <code>/add example.com</code>.');
    const lines = rows.results.map((r,i) => `${i+1}. 🌐 <b>${esc(r.name)}</b>\n   📅 Domain: ${r.expires_at ? esc(expiryLabel(r.expires_at)) : 'Unknown'}\n   🔐 SSL: ${r.ssl_expires_at ? esc(expiryLabel(r.ssl_expires_at)) : 'Unknown'}`);
    return void await send(env, chatId, `📋 <b>Monitored Domains</b>\n\n${lines.join('\n\n')}`);
  }
  if (cmd === '/remove') {
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\n<code>/remove example.com</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    const r = await env.DB.prepare(`UPDATE watches SET active=0,updated_at=? WHERE user_id=? AND domain_id=(SELECT id FROM domains WHERE name=?)`).bind(new Date().toISOString(),user.id,domain).run();
    return void await send(env, chatId, r.meta.changes ? `✅ <b>Monitoring stopped</b>\n🌐 ${esc(domain)}` : `ℹ️ <b>${esc(domain)}</b> was not being monitored.`);
  }
  await send(env, chatId, '❓ <b>Unknown command</b>\n\nUse /help, or simply send a domain like <code>example.com</code>.');
}

async function handleCallback(env, q) {
  if (!q?.from || !q?.message) return;
  const user = await upsertUser(env, q.from, q.message.chat.id);
  const data = String(q.data || '');
  if (data.startsWith('tz:')) {
    const tz = data.slice(3);
    if (await setTimezone(env, user.id, tz)) {
      await answerCb(env, q.id, `Timezone: ${tz}`);
      return send(env, q.message.chat.id, `✅ <b>Timezone set</b>\n\n🕒 ${esc(formatInTimezone(new Date().toISOString(), tz))}\n🌍 <code>${esc(tz)}</code>`);
    }
  }
  const idx = data.indexOf(':');
  if (idx > 0) {
    const action = data.slice(0, idx), domainRaw = data.slice(idx + 1);
    let domain; try { domain = normalizeDomain(domainRaw); } catch { return answerCb(env, q.id, 'Invalid domain'); }
    await answerCb(env, q.id, action === 'add' ? 'Adding to monitoring…' : 'Running check…');
    if (action === 'add') {
      try { await addWatch(env, user, domain); return send(env, q.message.chat.id, `✅ <b>Monitoring enabled</b>\n🌐 ${esc(domain)}\n📅 Domain + SSL expiry alerts are active.`, { reply_markup: domainButtons(domain, true) }); }
      catch (e) { return send(env, q.message.chat.id, `⚠️ Could not enable monitoring.\n${esc(short(e.message, 250))}`); }
    }
    if (['check','scan','seo','ssl','provider','links','robots','keywords'].includes(action)) return runTool(env, q.message.chat.id, user, action, domain);
  }
}

async function handleTelegram(env, update) {
  await syncBotProfile(env);
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const msg = update.message;
  if (!msg?.from || !msg?.chat) return;
  const user = await upsertUser(env, msg.from, msg.chat.id);
  const text = String(msg.text || '').trim();
  if (text.startsWith('/')) return handleCommand(env, msg, user);
  // Easy UX: a plain domain/URL is automatically treated as a quick check.
  try {
    const domain = normalizeDomain(text);
    return runTool(env, msg.chat.id, user, 'check', domain);
  } catch {
    return send(env, msg.chat.id, '💡 <b>Send me a domain</b>\n\nExample: <code>example.com</code>\n\nOr use /help to see all website tools.');
  }
}

async function refreshDomains(env) {
  const nowIso = new Date().toISOString();
  const due = await env.DB.prepare(`SELECT * FROM domains WHERE next_check_at IS NULL OR next_check_at<=? ORDER BY COALESCE(next_check_at,'') LIMIT 30`).bind(nowIso).all();
  for (const row of due.results) {
    try { const info = await rdapLookup(row.name); await saveDomain(env, info); }
    catch (e) { await env.DB.prepare('UPDATE domains SET last_checked_at=?,next_check_at=?,last_error=? WHERE id=?').bind(nowIso,new Date(Date.now()+3*3600000).toISOString(),short(e.message,500),row.id).run(); }
  }
  const sslDue = await env.DB.prepare(`SELECT * FROM domains WHERE ssl_next_check_at IS NULL OR ssl_next_check_at<=? ORDER BY COALESCE(ssl_next_check_at,'') LIMIT 20`).bind(nowIso).all();
  for (const row of sslDue.results) {
    try {
      const ssl = await sslLookup(row.name);
      await env.DB.prepare('UPDATE domains SET ssl_expires_at=?,ssl_issuer=?,ssl_last_checked_at=?,ssl_next_check_at=? WHERE id=?')
        .bind(ssl.expiresAt,ssl.issuer,nowIso,new Date(Date.now()+24*3600000).toISOString(),row.id).run();
    } catch { await env.DB.prepare('UPDATE domains SET ssl_next_check_at=? WHERE id=?').bind(new Date(Date.now()+6*3600000).toISOString(),row.id).run(); }
  }
}

async function sendAlerts(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const rows = await env.DB.prepare(`SELECT w.id watch_id,w.notify_days,u.chat_id,u.timezone,d.name,d.expires_at,d.ssl_expires_at
    FROM watches w JOIN users u ON u.id=w.user_id JOIN domains d ON d.id=w.domain_id
    WHERE w.active=1 AND u.timezone_configured=1`).all();
  for (const row of rows.results) {
    let thresholds; try { thresholds = JSON.parse(row.notify_days); } catch { thresholds = ALERT_DAYS; }
    for (const item of [{kind:'domain-expiry',iso:row.expires_at,emoji:'📅',label:'Domain'}, {kind:'ssl-expiry',iso:row.ssl_expires_at,emoji:'🔐',label:'SSL certificate'}]) {
      const d = daysUntil(item.iso); if (d === null || !thresholds.includes(d)) continue;
      const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO notifications(watch_id,kind,threshold,expiry_snapshot,sent_at) VALUES(?,?,?,?,?)`)
        .bind(row.watch_id,item.kind,d,item.iso,new Date().toISOString()).run();
      if (!inserted.meta.changes) continue;
      try {
        await send(env,row.chat_id,`🚨 <b>${item.label} Expiry Alert</b>\n\n🌐 <b>${esc(row.name)}</b>\n${item.emoji} ${d===0 ? 'Expires today' : `Expires in ${d} day(s)`}\n🕒 ${esc(formatInTimezone(item.iso,row.timezone))}\n\n💡 <i>Renew or verify it early to avoid downtime.</i>`, { reply_markup: domainButtons(row.name,true) });
      } catch (e) { console.error(JSON.stringify({event:'alert_send_failed',domain:row.name,kind:item.kind,error:e.message})); }
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      ctx.waitUntil(syncBotProfile(env).catch((e) => console.error(JSON.stringify({ event: 'profile_sync_failed', error: e.message }))));
      const db = await env.DB.prepare('SELECT 1 AS ok').first();
      return json({ ok:true, service:'WEB DOCTOR PRO', version:VERSION, database:db?.ok===1, telegramConfigured:Boolean(env.TELEGRAM_BOT_TOKEN), ollamaConfigured:Boolean(env.OLLAMA_API_KEY), now:new Date().toISOString() });
    }
    if (url.pathname === '/telegram' && request.method === 'POST') {
      if (!env.WEBHOOK_SECRET || request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) return new Response('Unauthorized',{status:401});
      const update = await request.json();
      ctx.waitUntil(handleTelegram(env,update).catch((e)=>console.error(JSON.stringify({event:'telegram_update_failed',error:e.message}))));
      return new Response('OK');
    }
    return json({ service:'WEB DOCTOR PRO', version:VERSION, status:'online', developer:DEVELOPER, github:GITHUB_URL, health:'/health' });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async()=>{ await syncBotProfile(env); await refreshDomains(env); await sendAlerts(env); })().catch((e)=>console.error(JSON.stringify({event:'scheduled_failed',error:e.message}))));
  }
};
