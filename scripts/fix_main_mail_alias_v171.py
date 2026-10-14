from pathlib import Path

p = Path('src/index.js')
s = p.read_text()

if "const VERSION = '1.7.0';" not in s:
    raise SystemExit('expected v1.7.0 source')
s = s.replace("const VERSION = '1.7.0';", "const VERSION = '1.7.1';", 1)

allow_old = "'/robots','/keywords','/mail','/add'"
allow_new = "'/robots','/keywords','/mail','/main','/add'"
if allow_old not in s:
    raise SystemExit('Mini App command allowlist anchor missing')
s = s.replace(allow_old, allow_new, 1)

map_old = "'/robots':'robots','/keywords':'keywords','/mail':'mail' };"
map_new = "'/robots':'robots','/keywords':'keywords','/mail':'mail','/main':'mail' };"
if map_old not in s:
    raise SystemExit('tool map anchor missing')
s = s.replace(map_old, map_new, 1)

p.write_text(s)

pkg = Path('package.json')
ps = pkg.read_text()
if '"version": "1.7.0"' not in ps:
    raise SystemExit('package version anchor missing')
pkg.write_text(ps.replace('"version": "1.7.0"', '"version": "1.7.1"', 1))

t = Path('test/platform.test.js')
ts = t.read_text()
ts = ts.replace("const VERSION = '1.7.0'", "const VERSION = '1.7.1'")
ts = ts.replace("const VERSION = '1\\.7\\.0'", "const VERSION = '1\\.7\\.1'")
ts += """

test('v1.7.1 accepts /main as a safe alias for /mail', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("'/mail':'mail','/main':'mail'"));
  assert.ok(source.includes("'/robots','/keywords','/mail','/main','/add'"));
  assert.ok(source.includes("command: 'mail'"));
});
"""
t.write_text(ts)
