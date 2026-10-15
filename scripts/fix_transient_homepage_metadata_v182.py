from pathlib import Path

p = Path('src/index.js')
s = p.read_text()

if "const VERSION = '1.8.1';" not in s:
    raise SystemExit('expected v1.8.1 source')
s = s.replace("const VERSION = '1.8.1';", "const VERSION = '1.8.2';", 1)

old_stabilizer = "for(const key of ['registrar','domainExpiry']) if(!stable[key] && oldSnap?.[key]) stable[key]=oldSnap[key];"
new_stabilizer = "for(const key of ['registrar','domainExpiry','title','description']) if(!stable[key] && oldSnap?.[key]) stable[key]=oldSnap[key];"
if old_stabilizer not in s:
    raise SystemExit('stabilizer anchor missing')
s = s.replace(old_stabilizer, new_stabilizer, 1)

old_title = "if(oldSnap.title!==newSnap.title) add('title','Homepage title changed',oldSnap.title,newSnap.title);"
new_title = "if(oldSnap.title && newSnap.title && oldSnap.title!==newSnap.title) add('title','Homepage title changed',oldSnap.title,newSnap.title);"
if old_title not in s:
    raise SystemExit('title comparison anchor missing')
s = s.replace(old_title, new_title, 1)

old_desc = "if(oldSnap.description!==newSnap.description) add('meta','Homepage meta description changed',oldSnap.description,newSnap.description);"
new_desc = "if(oldSnap.description && newSnap.description && oldSnap.description!==newSnap.description) add('meta','Homepage meta description changed',oldSnap.description,newSnap.description);"
if old_desc not in s:
    raise SystemExit('description comparison anchor missing')
s = s.replace(old_desc, new_desc, 1)

p.write_text(s)

pkg = Path('package.json')
ps = pkg.read_text()
if '"version": "1.8.1"' not in ps:
    raise SystemExit('package version anchor missing')
pkg.write_text(ps.replace('"version": "1.8.1"', '"version": "1.8.2"', 1))

t = Path('test/platform.test.js')
ts = t.read_text()
ts = ts.replace("const VERSION = '1.8.1'", "const VERSION = '1.8.2'")
ts = ts.replace("const VERSION = '1\\.8\\.1'", "const VERSION = '1\\.8\\.2'")
ts = ts.replace(
    'assert.ok(source.includes("for(const key of [\'registrar\',\'domainExpiry\'])"));',
    'assert.ok(source.includes("for(const key of [\'registrar\',\'domainExpiry\',\'title\',\'description\'])"));'
)
ts += """

test('v1.8.2 suppresses transient blank homepage title and meta alerts', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("for(const key of ['registrar','domainExpiry','title','description'])"));
  assert.ok(source.includes("oldSnap.title && newSnap.title && oldSnap.title!==newSnap.title"));
  assert.ok(source.includes("oldSnap.description && newSnap.description && oldSnap.description!==newSnap.description"));
});
"""
t.write_text(ts)
