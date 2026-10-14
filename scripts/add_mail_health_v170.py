from pathlib import Path

p = Path('src/index.js')
s = p.read_text()

s = s.replace("const VERSION = '1.6.3';", "const VERSION = '1.7.0';", 1)
s = s.replace("const LAST_UPDATED_AT = '2026-10-13T09:40:00+05:30';", "const LAST_UPDATED_AT = '2026-10-14T09:45:00+05:30';", 1)

anchor = """async function readTextLimited(response, maxBytes = MAX_HTML_BYTES) {
"""
mail_code = r"""function parseMxRecord(value) {
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

"""
if anchor not in s:
    raise SystemExit('readTextLimited anchor missing')
s = s.replace(anchor, mail_code + anchor, 1)

# Mini App command allowlist.
s = s.replace("'/robots','/keywords','/add'", "'/robots','/keywords','/mail','/add'", 1)

# Telegram command menu.
menu_old = "      { command: 'keywords', description: '✨ Keyword opportunities' },\n      { command: 'add', description: '🛡 Verify ownership & monitor' },"
menu_new = "      { command: 'keywords', description: '✨ Keyword opportunities' },\n      { command: 'mail', description: '📧 Mail DNS & authentication health' },\n      { command: 'add', description: '🛡 Verify ownership & monitor' },"
if menu_old not in s:
    raise SystemExit('bot command menu anchor missing')
s = s.replace(menu_old, menu_new, 1)

# Team help.
s = s.replace('/robots domain\\n/keywords domain\\n/add domain', '/robots domain\\n/keywords domain\\n/mail domain\\n/add domain', 1)

# Both private and Team tool maps.
old_map = "const toolMap = { '/check':'check','/scan':'scan','/seo':'seo','/performance':'performance','/ssl':'ssl','/provider':'provider','/links':'links','/robots':'robots','/keywords':'keywords' };"
new_map = "const toolMap = { '/check':'check','/scan':'scan','/seo':'seo','/performance':'performance','/ssl':'ssl','/provider':'provider','/links':'links','/robots':'robots','/keywords':'keywords','/mail':'mail' };"
count = s.count(old_map)
if count < 2:
    raise SystemExit(f'expected at least 2 tool maps, found {count}')
s = s.replace(old_map, new_map)

# Mail checks are DNS-only and must not be rejected by an unrelated website HTTP 530.
s = s.replace("  if (await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));", "  if (action !== 'mail' && await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));", 1)

# Tool title and dispatch.
s = s.replace("keywords: 'Keyword research' };", "keywords: 'Keyword research', mail: 'Mail health monitor' };", 1)
s = s.replace("    if (action === 'robots') text = await robotsText(domain);\n    if (action === 'keywords') {", "    if (action === 'robots') text = await robotsText(domain);\n    if (action === 'mail') text = await mailHealthText(domain);\n    if (action === 'keywords') {", 1)

p.write_text(s)

# Mini App Tools grid.
m = Path('src/miniapp.js')
ms = m.read_text()
old_tools = "['✨','Keywords','Opportunities','/keywords'],['❤️','Health Score','Latest score','/score']"
new_tools = "['✨','Keywords','Opportunities','/keywords'],['📧','Mail Health','MX, SPF & DMARC','/mail'],['❤️','Health Score','Latest score','/score']"
if old_tools not in ms:
    raise SystemExit('Mini App tools anchor missing')
ms = ms.replace(old_tools, new_tools, 1)
m.write_text(ms)

pkg = Path('package.json')
ps = pkg.read_text().replace('"version": "1.6.3"', '"version": "1.7.0"', 1)
pkg.write_text(ps)

t = Path('test/platform.test.js')
ts = t.read_text().replace('1.6.3', '1.7.0').replace(r'1\.6\.3', r'1\.7\.0')
ts += r"""

test('v1.7.0 Mail Health Monitor is wired to bot and Mini App', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const mini = await readFile(new URL('../src/miniapp.js', import.meta.url), 'utf8');
  assert.match(source, /const VERSION = '1\.7\.0'/);
  assert.ok(source.includes("async function mailHealthReport(domain)"));
  assert.ok(source.includes("async function mailHealthText(domain)"));
  assert.ok(source.includes("'/mail':'mail'"));
  assert.ok(source.includes("action !== 'mail' && await isHttp530Domain(domain)"));
  assert.ok(source.includes("command: 'mail'"));
  assert.ok(source.includes("'/robots','/keywords','/mail','/add'"));
  assert.ok(mini.includes("['📧','Mail Health','MX, SPF & DMARC','/mail']"));
});
"""
t.write_text(ts)
