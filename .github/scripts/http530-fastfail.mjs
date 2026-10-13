import fs from 'node:fs';

let s = fs.readFileSync('src/index.js', 'utf8');
const replace = (a,b,label) => { if (!s.includes(a)) throw new Error(`Missing anchor: ${label}`); s=s.replace(a,b); };
replace("const VERSION = '1.4.0';", "const VERSION = '1.4.1';", 'version');
replace("const LAST_UPDATED_AT = '2026-10-13T07:02:00+05:30';", "const LAST_UPDATED_AT = '2026-10-13T07:18:00+05:30';", 'updated');

const anchor = 'async function websiteSnapshot(domain) {';
const helper = `async function isHttp530Domain(domain) {
  try {
    const r = await fetch(\`https://\${domain}\`, {
      method: 'GET', redirect: 'follow',
      headers: { Range: 'bytes=0-0', 'user-agent': \`WEB-DOCTOR-PRO/\${VERSION}\` },
      signal: AbortSignal.timeout(10000)
    });
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return r.status === 530;
  } catch { return false; }
}
function invalidDomain530Text(domain) {
  return \`❌ <b>Invalid domain</b>\\n\\n🌐 \${esc(domain)}\`;
}

`;
replace(anchor, helper + anchor, 'website snapshot');
replace(
`async function runTool(env, chatId, user, action, domain) {
  if (!(await requireTimezone(env, chatId, user))) return;
  const usage = await consumeUsage(env, user, { report: action === 'scan' });`,
`async function runTool(env, chatId, user, action, domain) {
  if (!(await requireTimezone(env, chatId, user))) return;
  if (await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));
  const usage = await consumeUsage(env, user, { report: action === 'scan' });`, 'runTool');
replace(
`  if (action === 'scan') {
    const result = await runFullScan(env, chatId, user, domain);
    await maybeServeAd(env, user, chatId).catch(() => null);
    return result;
  }`,
`  if (action === 'scan') {
    const result = await runFullScan(env, chatId, user, domain, { preflightDone: true });
    if (!result) return null;
    await maybeServeAd(env, user, chatId).catch(() => null);
    return result;
  }`, 'scan branch');
replace(
"async function runFullScan(env, chatId, user, domain, { silentProgress = false, scheduled = false } = {}) {\n  let msg = null;",
"async function runFullScan(env, chatId, user, domain, { silentProgress = false, scheduled = false, preflightDone = false } = {}) {\n  if (!preflightDone && await isHttp530Domain(domain)) { await send(env, chatId, invalidDomain530Text(domain)); return null; }\n  let msg = null;", 'runFullScan');
replace(
`  } catch (e) {
    await edit(env, chatId, msg.message_id, \`⚠️ <b>Check could not finish</b>\\n\\n🌐 \${esc(domain)}\\n\${esc(short(e.message, 500))}\`);
    return null;
  }
}`,
`  } catch (e) {
    if (e?.status === 530 || /HTTP 530/i.test(String(e?.message || ''))) {
      await edit(env, chatId, msg.message_id, invalidDomain530Text(domain));
      return null;
    }
    await edit(env, chatId, msg.message_id, \`⚠️ <b>Check could not finish</b>\\n\\n🌐 \${esc(domain)}\\n\${esc(short(e.message, 500))}\`);
    return null;
  }
}`, 'runTool catch');

fs.writeFileSync('src/index.js', s);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8')); pkg.version='1.4.1'; fs.writeFileSync('package.json',JSON.stringify(pkg,null,2)+'\n');
let t=fs.readFileSync('test/platform.test.js','utf8');
t=t.replace("assert.ok(source.includes(\"const VERSION = '1.4.0'\"));", "assert.ok(source.includes(\"const VERSION = '1.4.1'\"));");
t += `\n\ntest('HTTP 530 fast-fails as invalid domain before checks', async () => {\n  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');\n  assert.ok(source.includes(\"const VERSION = '1.4.1'\"));\n  assert.ok(source.includes('async function isHttp530Domain(domain)'));\n  assert.ok(source.includes('return r.status === 530'));\n  assert.ok(source.includes('if (await isHttp530Domain(domain)) return send(env, chatId, invalidDomain530Text(domain));'));\n  assert.ok(source.includes('❌ <b>Invalid domain</b>'));\n});\n`;
fs.writeFileSync('test/platform.test.js', t);
