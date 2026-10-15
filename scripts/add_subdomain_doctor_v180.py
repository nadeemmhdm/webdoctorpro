from pathlib import Path

index = Path('src/index.js')
s = index.read_text()

if "const VERSION = '1.7.2';" not in s:
    raise SystemExit('expected v1.7.2 source')
s = s.replace("const VERSION = '1.7.2';", "const VERSION = '1.8.0';", 1)
s = s.replace("const MINI_APP_URL = `${PUBLIC_BASE_URL}/app?rev=20261013-2`;", "const MINI_APP_URL = `${PUBLIC_BASE_URL}/app?rev=20261015-1`;", 1)
s = s.replace("const LAST_UPDATED_AT = '2026-10-14T09:45:00+05:30';", "const LAST_UPDATED_AT = '2026-10-15T10:05:00+05:30';", 1)

const_anchor = "const MINI_APP_MAX_AGE_SECONDS = 86400;"
const_block = """const MINI_APP_MAX_AGE_SECONDS = 86400;
const SUBDOMAIN_PAGE_SIZE = 8;
const SUBDOMAIN_DISCOVERY_LIMIT = 80;
const SUBDOMAIN_COMMON_LABELS = Object.freeze(['www','mail','webmail','api','app','blog','shop','store','portal','docs','status','cdn']);"""
if const_anchor not in s:
    raise SystemExit('subdomain constants anchor missing')
s = s.replace(const_anchor, const_block, 1)

insert_anchor = "async function mailHealthReport(domain) {"
subdomain_code = r"""
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

"""
if insert_anchor not in s:
    raise SystemExit('mail health insertion anchor missing')
s = s.replace(insert_anchor, subdomain_code + insert_anchor, 1)

# Telegram command menu.
menu_old = "      { command: 'mail', description: '📧 Mail DNS & authentication health' },\n      { command: 'add', description: '🛡 Verify ownership & monitor' },"
menu_new = "      { command: 'mail', description: '📧 Mail DNS & authentication health' },\n      { command: 'subdomains', description: '🔎 Verified subdomain health & SEO' },\n      { command: 'add', description: '🛡 Verify ownership & monitor' },"
if menu_old not in s:
    raise SystemExit('Telegram command menu anchor missing')
s = s.replace(menu_old, menu_new, 1)

# Team help.
team_help_old = "/keywords domain\\\n/mail domain\\\n/add domain"
team_help_new = "/keywords domain\\\n/mail domain\\\n/subdomains domain [page]\\\n/add domain"
if team_help_old not in s:
    raise SystemExit('Team help anchor missing')
s = s.replace(team_help_old, team_help_new, 1)

# Team command routing before generic tool map.
team_route_anchor = "  const toolMap = { '/check':'check','/scan':'scan','/seo':'seo','/performance':'performance','/ssl':'ssl','/provider':'provider','/links':'links','/robots':'robots','/keywords':'keywords','/mail':'mail','/main':'mail' };"
team_route = """  if (cmd === '/subdomains') {
    if (!args[0]) return send(env, chatId, '💡 Usage: <code>/subdomains example.com [page]</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return send(env, chatId, '❌ Invalid domain.'); }
    const page = Math.max(1, Math.min(10, Number(args[1] || 1) || 1));
    return runSubdomainDoctor(env, chatId, access.owner, domain, page);
  }
""" + team_route_anchor
if team_route_anchor not in s:
    raise SystemExit('Team router anchor missing')
s = s.replace(team_route_anchor, team_route, 1)

# Mini App command allowlist.
allow_old = "'/robots','/keywords','/mail','/main','/add'"
allow_new = "'/robots','/keywords','/mail','/main','/subdomains','/add'"
if allow_old not in s:
    raise SystemExit('Mini App allowlist anchor missing')
s = s.replace(allow_old, allow_new, 1)

# Private help.
help_old = "/keywords example.com — keyword opportunities\\\n/add example.com — verify + monitor"
help_new = "/keywords example.com — keyword opportunities\\\n/mail example.com — mail DNS health\\\n/subdomains example.com — verified subdomain health + SEO\\\n/add example.com — verify + monitor"
if help_old not in s:
    raise SystemExit('Private help anchor missing')
s = s.replace(help_old, help_new, 1)

# Private command routing before existing website tool list.
private_anchor = "  if (['/check','/scan','/seo','/performance','/ssl','/provider','/links','/robots','/keywords','/mail','/main'].includes(cmd)) {"
private_route = """  if (cmd === '/subdomains') {
    if (!args[0]) return void await send(env, chatId, '💡 <b>Usage</b>\\n<code>/subdomains example.com [page]</code>');
    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }
    const page = Math.max(1, Math.min(10, Number(args[1] || 1) || 1));
    return runSubdomainDoctor(env, chatId, user, domain, page);
  }
""" + private_anchor
if private_anchor not in s:
    raise SystemExit('Private command router anchor missing')
s = s.replace(private_anchor, private_route, 1)

index.write_text(s)

# Mini App: tool tile + verified site action.
mini = Path('src/miniapp.js')
ms = mini.read_text()
tools_old = "['📧','Mail Health','MX, SPF & DMARC','/mail'],['❤️','Health Score','Latest score','/score']"
tools_new = "['📧','Mail Health','MX, SPF & DMARC','/mail'],['🔎','Subdomain Doctor','Verified DNS, SEO & health','/subdomains'],['❤️','Health Score','Latest score','/score']"
if tools_old not in ms:
    raise SystemExit('Mini App tool grid anchor missing')
ms = ms.replace(tools_old, tools_new, 1)
site_old = "<button class=\"action secondary\" data-sitecmd=\"/score\">Score</button><button class=\"action secondary\" data-sitecmd=\"/schedule\" data-extra=\"weekly\">Schedule</button>"
site_new = "<button class=\"action secondary\" data-sitecmd=\"/score\">Score</button><button class=\"action secondary\" data-sitecmd=\"/subdomains\">Subdomains</button><button class=\"action secondary\" data-sitecmd=\"/schedule\" data-extra=\"weekly\">Schedule</button>"
if site_old not in ms:
    raise SystemExit('Mini App verified site actions anchor missing')
ms = ms.replace(site_old, site_new, 1)
mini.write_text(ms)

# Package version.
pkg = Path('package.json')
ps = pkg.read_text()
if '"version": "1.7.2"' not in ps:
    raise SystemExit('package version anchor missing')
pkg.write_text(ps.replace('"version": "1.7.2"', '"version": "1.8.0"', 1))

# Regression tests.
test = Path('test/platform.test.js')
ts = test.read_text()
ts = ts.replace('1.7.2', '1.8.0').replace(r'1\.7\.2', r'1\.8\.0')
ts += r"""

test('v1.8.0 Subdomain Doctor is verified-only and available in bot + Mini App', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const mini = await readFile(new URL('../src/miniapp.js', import.meta.url), 'utf8');
  assert.match(source, /const VERSION = '1\.8\.0'/);
  assert.ok(source.includes('async function discoverCertificateSubdomains(rootDomain)'));
  assert.ok(source.includes('include_subdomains=true&expand=dns_names'));
  assert.ok(source.includes('async function subdomainHealthItem(host)'));
  assert.ok(source.includes('async function subdomainDoctorText(rootDomain, requestedPage = 1)'));
  assert.ok(source.includes('async function runSubdomainDoctor(env, chatId, user, rootDomain, page = 1)'));
  assert.ok(source.includes('const verified = await isVerified(env, user.id, rootDomain);'));
  assert.ok(source.includes("cmd === '/subdomains'"));
  assert.ok(source.includes("command: 'subdomains'"));
  assert.ok(source.includes("'/subdomains','/add'"));
  assert.ok(mini.includes("['🔎','Subdomain Doctor','Verified DNS, SEO & health','/subdomains']"));
  assert.ok(mini.includes('data-sitecmd=\\"/subdomains\\"'));
});
"""
test.write_text(ts)
