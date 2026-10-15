from pathlib import Path

idx = Path('src/index.js')
s = idx.read_text()

# Version and import.
if "const VERSION = '1.8.0';" not in s:
    raise SystemExit('expected v1.8.0 source')
s = s.replace("const VERSION = '1.8.0';", "const VERSION = '1.8.1';", 1)
old_import = "  parseCertSpotter, fallbackKeywords, normalizeTxtRecord, parsePageSpeed, scheduleIntervalMs, buildReportPdf\n} from './lib.js';"
new_import = "  parseCertSpotter, fallbackKeywords, normalizeTxtRecord, parsePageSpeed, scheduleIntervalMs, buildReportPdf, sitemapSemanticEntries\n} from './lib.js';"
if old_import not in s:
    raise SystemExit('index import anchor missing')
s = s.replace(old_import, new_import, 1)

old_capture = """  if (!page) return null;\n  const seo=analyzeSeoHtml(page.text,page.url||`https://${domain}`);\n  return {\n    ns:stableValues(ns),a:stableValues(a),aaaa:stableValues(aaaa),mx:stableValues(mx),\n    ssl:`${ssl.issuer||''}|${ssl.expiresAt||''}`,registrar:rdap.registrar||'',domainExpiry:rdap.expiresAt||'',\n    robotsHash:robots?await sha256Text(robots.text):'',robotsExists:Boolean(robots&&robots.status<400),\n    sitemapHash:sitemap?await sha256Text(sitemap.text):'',sitemapExists:Boolean(sitemap&&sitemap.status<400),\n    title:seo.title||'',description:seo.description||'',hostingProvider:detectHostingProvider({headers:page.headers,cnames:cname}),dnsProvider:detectDnsProvider(ns)\n  };\n}"""
new_capture = """  if (!page) return null;\n  const seo=analyzeSeoHtml(page.text,page.url||`https://${domain}`);\n  const sitemapState = sitemap && sitemap.status < 400\n    ? sitemapSemanticEntries(sitemap.text, `https://${domain}/sitemap.xml`)\n    : { valid:false, type:'missing', entries:[] };\n  const sitemapSemanticHash = sitemapState.valid ? await sha256Text(JSON.stringify(sitemapState.entries)) : '';\n  return {\n    ns:stableValues(ns),a:stableValues(a),aaaa:stableValues(aaaa),mx:stableValues(mx),\n    ssl:`${ssl.issuer||''}|${ssl.expiresAt||''}`,registrar:rdap.registrar||'',domainExpiry:rdap.expiresAt||'',\n    robotsHash:robots?await sha256Text(robots.text):'',robotsExists:Boolean(robots&&robots.status<400),\n    sitemapHash:sitemapSemanticHash,sitemapSemanticHash,sitemapSemanticVersion:1,sitemapEntryCount:sitemapState.entries.length,sitemapType:sitemapState.type,sitemapExists:Boolean(sitemapState.valid),\n    title:seo.title||'',description:seo.description||'',hostingProvider:detectHostingProvider({headers:page.headers,cnames:cname}),dnsProvider:detectDnsProvider(ns)\n  };\n}"""
if old_capture not in s:
    raise SystemExit('capture snapshot anchor missing')
s = s.replace(old_capture, new_capture, 1)

old_sitemap_compare = """  if(oldSnap.sitemapExists && !newSnap.sitemapExists) add('sitemap','Sitemap disappeared','Available','Missing');\n  else if(oldSnap.sitemapHash!==newSnap.sitemapHash) add('sitemap','Sitemap changed',oldSnap.sitemapHash?'Previous version':'Missing',newSnap.sitemapHash?'New version':'Missing');"""
new_sitemap_compare = """  const sitemapComparable=Number(oldSnap.sitemapSemanticVersion||0)>=1 && Number(newSnap.sitemapSemanticVersion||0)>=1;\n  if(sitemapComparable){\n    if(oldSnap.sitemapExists && !newSnap.sitemapExists) add('sitemap','Sitemap disappeared','Available','Missing');\n    else if(!oldSnap.sitemapExists && newSnap.sitemapExists) add('sitemap','Sitemap appeared','Missing','Available');\n    else if(oldSnap.sitemapExists && newSnap.sitemapExists && oldSnap.sitemapSemanticHash!==newSnap.sitemapSemanticHash){\n      const oldCount=Number(oldSnap.sitemapEntryCount||0),newCount=Number(newSnap.sitemapEntryCount||0);\n      add('sitemap','Sitemap URL entries changed',`${oldCount} entr${oldCount===1?'y':'ies'} — previous set`,`${newCount} entr${newCount===1?'y':'ies'} — new set`);\n    }\n  }"""
if old_sitemap_compare not in s:
    raise SystemExit('sitemap comparison anchor missing')
s = s.replace(old_sitemap_compare, new_sitemap_compare, 1)

smtp_anchor = """  return out;\n}\nasync function smtpConfig(env) {"""
confirm_code = """  return out;\n}\nfunction sitemapStateSignature(snap){\n  return `${snap?.sitemapExists?'1':'0'}:${snap?.sitemapSemanticHash||''}:${snap?.sitemapType||''}`;\n}\nasync function confirmSitemapChanges(env,watchId,oldSnap,newSnap,changes){\n  const key=`sitemap_pending:${watchId}`;\n  const sitemapChanges=changes.filter((c)=>c.kind==='sitemap');\n  if(!sitemapChanges.length){\n    await env.DB.prepare('DELETE FROM app_meta WHERE key=?').bind(key).run().catch(()=>{});\n    return {changes,snapshot:newSnap,confirmed:false};\n  }\n  const baseline=sitemapStateSignature(oldSnap),candidate=sitemapStateSignature(newSnap);\n  let pending=null;\n  try { pending=JSON.parse((await appMeta(env,key))||'null'); } catch { pending=null; }\n  if(pending?.baseline===baseline && pending?.candidate===candidate){\n    await env.DB.prepare('DELETE FROM app_meta WHERE key=?').bind(key).run().catch(()=>{});\n    return {changes,snapshot:newSnap,confirmed:true};\n  }\n  await setAppMeta(env,key,JSON.stringify({baseline,candidate,firstSeenAt:nowIso()}));\n  const stable={...newSnap};\n  for(const field of ['sitemapHash','sitemapSemanticHash','sitemapSemanticVersion','sitemapEntryCount','sitemapType','sitemapExists']){\n    if(Object.prototype.hasOwnProperty.call(oldSnap,field)) stable[field]=oldSnap[field];\n    else delete stable[field];\n  }\n  return {changes:changes.filter((c)=>c.kind!=='sitemap'),snapshot:stable,confirmed:false};\n}\nasync function smtpConfig(env) {"""
if smtp_anchor not in s:
    raise SystemExit('smtp anchor missing')
s = s.replace(smtp_anchor, confirm_code, 1)

old_monitor = """        const changes=snapshotChangeList(old,snap);\n        if(changes.length){\n          const detected=nowIso();"""
new_monitor = """        const rawChanges=snapshotChangeList(old,snap);\n        const sitemapDecision=await confirmSitemapChanges(env,row.watch_id,old,snap,rawChanges);\n        Object.assign(snap,sitemapDecision.snapshot);\n        const changes=sitemapDecision.changes;\n        if(changes.length){\n          const detected=nowIso();"""
if old_monitor not in s:
    raise SystemExit('monitor changes anchor missing')
s = s.replace(old_monitor, new_monitor, 1)

old_alert = """          const text=`⚠️ <b>Website Change Detected</b>\\n\\n🌐 <b>${esc(row.name)}</b>\\n${detail}\\n\\n🕒 ${esc(formatInTimezone(detected,row.timezone||'UTC'))}\\n\\n🛡 Review unexpected DNS, certificate, registrar or hosting changes promptly.`;"""
new_alert = """          const sitemapOnly=changes.every((c)=>c.kind==='sitemap');\n          const guidance=sitemapOnly\n            ? '🗺 Sitemap changes are compared by normalized URL entries and confirmed across two checks. Timestamp, formatting and ordering-only changes are ignored.'\n            : '🛡 Review unexpected DNS, certificate, registrar or hosting changes promptly.';\n          const text=`⚠️ <b>Website Change Detected</b>\\n\\n🌐 <b>${esc(row.name)}</b>\\n${detail}\\n\\n🕒 ${esc(formatInTimezone(detected,row.timezone||'UTC'))}\\n\\n${guidance}`;"""
if old_alert not in s:
    raise SystemExit('alert text anchor missing')
s = s.replace(old_alert, new_alert, 1)
idx.write_text(s)

# Add semantic sitemap parser to lib.
lib = Path('src/lib.js')
ls = lib.read_text()
anchor = """export function parseSitemap(text, status = 200) {\n  if (status >= 400) return { exists: false, status, urlCount: 0, sitemapCount: 0, type: 'missing' };\n  const body = String(text || '');\n  const urlCount = count(body, /<url\\b/gi);\n  const sitemapCount = count(body, /<sitemap\\b/gi);\n  return { exists: true, status, urlCount, sitemapCount, type: sitemapCount ? 'index' : 'urlset' };\n}\n"""
addition = anchor + """\nfunction decodeSitemapXmlText(value) {\n  return String(value || '')\n    .replace(/^<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>$/i, '$1')\n    .replace(/&#x([0-9a-f]+);/gi, (_, x) => { try { return String.fromCodePoint(parseInt(x, 16)); } catch { return ''; } })\n    .replace(/&#(\\d+);/g, (_, x) => { try { return String.fromCodePoint(parseInt(x, 10)); } catch { return ''; } })\n    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '\"').replace(/&apos;/gi, \"'\")\n    .trim();\n}\n\nexport function sitemapSemanticEntries(text, baseUrl = 'https://example.invalid/sitemap.xml') {\n  const body = String(text || '');\n  const type = /<sitemapindex\\b/i.test(body) ? 'index' : /<urlset\\b/i.test(body) ? 'urlset' : 'unknown';\n  if (type === 'unknown') return { valid: false, type, entries: [] };\n  const seen = new Set();\n  const re = /<loc\\b[^>]*>([\\s\\S]*?)<\\/loc>/gi;\n  let m;\n  while ((m = re.exec(body))) {\n    const raw = decodeSitemapXmlText(m[1]);\n    if (!raw) continue;\n    try {\n      const u = new URL(raw, baseUrl);\n      if (!['http:', 'https:'].includes(u.protocol)) continue;\n      u.hash = '';\n      seen.add(u.toString());\n    } catch { /* malformed sitemap location */ }\n  }\n  return { valid: true, type, entries: [...seen].sort() };\n}\n"""
if anchor not in ls:
    raise SystemExit('parseSitemap anchor missing')
ls = ls.replace(anchor, addition, 1)
lib.write_text(ls)

# Package version.
pkg = Path('package.json')
ps = pkg.read_text()
if '"version": "1.8.0"' not in ps:
    raise SystemExit('package version anchor missing')
pkg.write_text(ps.replace('"version": "1.8.0"', '"version": "1.8.1"', 1))

# Tests.
t = Path('test/platform.test.js')
ts = t.read_text()
ts = ts.replace("import { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec } from '../src/index.js';", "import { activePlan, planConfig, localDayKey, parseDateEnd, parseButtonsSpec } from '../src/index.js';\nimport { sitemapSemanticEntries } from '../src/lib.js';", 1)
ts = ts.replace("1.8.0", "1.8.1")
ts += r"""

test('v1.8.1 sitemap semantic comparison ignores lastmod, formatting and URL order', () => {
  const a = sitemapSemanticEntries(`<?xml version="1.0"?><urlset><url><loc>https://example.com/a</loc><lastmod>2026-10-15</lastmod></url><url><loc>https://example.com/b?x=1&amp;y=2</loc></url></urlset>`, 'https://example.com/sitemap.xml');
  const b = sitemapSemanticEntries(`<urlset>\n <url><loc><![CDATA[https://example.com/b?x=1&y=2]]></loc><lastmod>2099-01-01</lastmod></url>\n <url><loc>https://example.com/a</loc></url>\n</urlset>`, 'https://example.com/sitemap.xml');
  assert.equal(a.valid, true);
  assert.equal(b.valid, true);
  assert.deepEqual(a.entries, b.entries);
  const c = sitemapSemanticEntries(`<urlset><url><loc>https://example.com/c</loc></url></urlset>`, 'https://example.com/sitemap.xml');
  assert.notDeepEqual(a.entries, c.entries);
});

test('v1.8.1 sitemap monitor confirms semantic changes across two checks', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /const VERSION = '1\\.8\\.1'/);
  assert.ok(source.includes('sitemapSemanticEntries(sitemap.text'));
  assert.ok(source.includes('sitemapSemanticVersion:1'));
  assert.ok(source.includes('Sitemap URL entries changed'));
  assert.ok(source.includes('async function confirmSitemapChanges'));
  assert.ok(source.includes('sitemap_pending:'));
  assert.ok(source.includes("changes:changes.filter((c)=>c.kind!=='sitemap')"));
  assert.doesNotMatch(source, /oldSnap\\.sitemapHash!==newSnap\\.sitemapHash/);
});
"""
t.write_text(ts)
