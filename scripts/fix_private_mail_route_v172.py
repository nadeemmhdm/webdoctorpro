from pathlib import Path

p = Path('src/index.js')
s = p.read_text()

if "const VERSION = '1.7.1';" not in s:
    raise SystemExit('expected v1.7.1 source')
s = s.replace("const VERSION = '1.7.1';", "const VERSION = '1.7.2';", 1)

old = "if (['/check','/scan','/seo','/performance','/ssl','/provider','/links','/robots','/keywords'].includes(cmd)) {\n    if (!args[0]) return void await send(env, chatId, `💡 <b>Usage</b>\\n<code>${cmd} example.com</code>`);\n    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }\n    return runTool(env, chatId, user, cmd.slice(1), domain);\n  }"
new = "if (['/check','/scan','/seo','/performance','/ssl','/provider','/links','/robots','/keywords','/mail','/main'].includes(cmd)) {\n    if (!args[0]) return void await send(env, chatId, `💡 <b>Usage</b>\\n<code>${cmd} example.com</code>`);\n    let domain; try { domain = normalizeDomain(args[0]); } catch { return void await send(env, chatId, '❌ <b>Invalid domain</b>'); }\n    const action = cmd === '/main' ? 'mail' : cmd.slice(1);\n    return runTool(env, chatId, user, action, domain);\n  }"
if old not in s:
    raise SystemExit('private tool router anchor missing')
s = s.replace(old, new, 1)

# Add Mail Health to private help when the known command sequence is present.
s = s.replace('/robots example.com\\n/keywords example.com', '/robots example.com\\n/keywords example.com\\n/mail example.com', 1)

p.write_text(s)

pkg = Path('package.json')
ps = pkg.read_text()
if '"version": "1.7.1"' not in ps:
    raise SystemExit('package version anchor missing')
pkg.write_text(ps.replace('"version": "1.7.1"', '"version": "1.7.2"', 1))

t = Path('test/platform.test.js')
ts = t.read_text()
ts = ts.replace("const VERSION = '1.7.1'", "const VERSION = '1.7.2'")
ts = ts.replace("const VERSION = '1\\.7\\.1'", "const VERSION = '1\\.7\\.2'")
ts += """

test('v1.7.2 routes private /mail and /main commands to Mail Health', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("['/check','/scan','/seo','/performance','/ssl','/provider','/links','/robots','/keywords','/mail','/main'].includes(cmd)"));
  assert.ok(source.includes("const action = cmd === '/main' ? 'mail' : cmd.slice(1);"));
  assert.ok(source.includes("return runTool(env, chatId, user, action, domain);"));
  assert.ok(source.includes("async function mailHealthText(domain)"));
});
"""
t.write_text(ts)
