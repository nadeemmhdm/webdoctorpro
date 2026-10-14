from pathlib import Path

p=Path('src/index.js')
s=p.read_text()

s=s.replace("const VERSION = '1.6.2';", "const VERSION = '1.6.3';", 1)
s=s.replace("text:'🩺 Dashboard'", "text:'Open'", 1)

needle="""function snapshotChangeList(oldSnap,newSnap){
  const out=[]; const add=(kind,label,a,b)=>out.push({kind,label,oldValue:String(a??''),newValue:String(b??'')});
"""
replacement="""function stabilizeChangeSnapshot(oldSnap,newSnap){
  const stable={...newSnap};
  for(const key of ['registrar','domainExpiry']) if(!stable[key] && oldSnap?.[key]) stable[key]=oldSnap[key];
  return stable;
}
function snapshotChangeList(oldSnap,newSnap){
  const out=[]; const add=(kind,label,a,b)=>out.push({kind,label,oldValue:String(a??''),newValue:String(b??'')});
  const norm=(x)=>String(x||'').trim().replace(/\\s+/g,' ').toLowerCase();
"""
if needle not in s: raise SystemExit('snapshot function marker missing')
s=s.replace(needle,replacement,1)

s=s.replace("if(oldSnap.registrar!==newSnap.registrar) add('registrar','Registrar changed',oldSnap.registrar,newSnap.registrar);", "if(oldSnap.registrar && newSnap.registrar && norm(oldSnap.registrar)!==norm(newSnap.registrar)) add('registrar','Registrar changed',oldSnap.registrar,newSnap.registrar);", 1)
s=s.replace("if(oldSnap.domainExpiry!==newSnap.domainExpiry) add('domain-expiry','Domain expiry date changed',oldSnap.domainExpiry,newSnap.domainExpiry);", "if(oldSnap.domainExpiry && newSnap.domainExpiry && oldSnap.domainExpiry!==newSnap.domainExpiry) add('domain-expiry','Domain expiry date changed',oldSnap.domainExpiry,newSnap.domainExpiry);", 1)

old="""      if(prevRow){
        const old=safeJson(prevRow.snapshot_json,{})||{}, changes=snapshotChangeList(old,snap);
        if(changes.length){
"""
new="""      if(prevRow){
        const old=safeJson(prevRow.snapshot_json,{})||{};
        Object.assign(snap,stabilizeChangeSnapshot(old,snap));
        const changes=snapshotChangeList(old,snap);
        if(changes.length){
"""
if old not in s: raise SystemExit('monitor comparison marker missing')
s=s.replace(old,new,1)

p.write_text(s)

pkg=Path('package.json')
ps=pkg.read_text().replace('"version": "1.6.2"','"version": "1.6.3"',1)
pkg.write_text(ps)

t=Path('test/platform.test.js')
ts=t.read_text().replace('1.6.2','1.6.3').replace(r'1\\.6\\.2',r'1\\.6\\.3')
ts += """

test('v1.6.3 suppresses transient RDAP blanks and uses Open Mini App label', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("text:'Open'"));
  assert.ok(source.includes("function stabilizeChangeSnapshot(oldSnap,newSnap)"));
  assert.ok(source.includes("for(const key of ['registrar','domainExpiry'])"));
  assert.ok(source.includes("oldSnap.registrar && newSnap.registrar"));
  assert.ok(source.includes("oldSnap.domainExpiry && newSnap.domainExpiry"));
  assert.ok(source.includes("Object.assign(snap,stabilizeChangeSnapshot(old,snap))"));
});
"""
t.write_text(ts)
