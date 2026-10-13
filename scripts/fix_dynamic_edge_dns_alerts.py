from pathlib import Path

p = Path('src/index.js')
s = p.read_text()

s = s.replace("const VERSION = '1.6.1';", "const VERSION = '1.6.2';", 1)

old = """function snapshotChangeList(oldSnap,newSnap){
  const out=[]; const add=(kind,label,a,b)=>out.push({kind,label,oldValue:String(a??''),newValue:String(b??'')});
  const j=(x)=>JSON.stringify(x||[]);
  if(j(oldSnap.ns)!==j(newSnap.ns)) add('nameserver','Nameserver changed',oldSnap.ns?.join(', '),newSnap.ns?.join(', '));
  if(j(oldSnap.a)!==j(newSnap.a)) add('a-record','A record changed',oldSnap.a?.join(', '),newSnap.a?.join(', '));
  if(j(oldSnap.aaaa)!==j(newSnap.aaaa)) add('aaaa-record','AAAA record changed',oldSnap.aaaa?.join(', '),newSnap.aaaa?.join(', '));
"""
new = """function snapshotChangeList(oldSnap,newSnap){
  const out=[]; const add=(kind,label,a,b)=>out.push({kind,label,oldValue:String(a??''),newValue:String(b??'')});
  const j=(x)=>JSON.stringify(x||[]);
  const dynamicEdgeProviders=new Set(['Vercel','Cloudflare','Netlify','GitHub Pages']);
  const sameEdgeProvider=Boolean(oldSnap.hostingProvider && oldSnap.hostingProvider===newSnap.hostingProvider && dynamicEdgeProviders.has(newSnap.hostingProvider));
  const sameDnsContext=j(oldSnap.ns)===j(newSnap.ns) && oldSnap.dnsProvider===newSnap.dnsProvider;
  const suppressEdgeIpRotation=sameEdgeProvider && sameDnsContext;
  if(j(oldSnap.ns)!==j(newSnap.ns)) add('nameserver','Nameserver changed',oldSnap.ns?.join(', '),newSnap.ns?.join(', '));
  if(j(oldSnap.a)!==j(newSnap.a) && !suppressEdgeIpRotation) add('a-record','A record changed',oldSnap.a?.join(', '),newSnap.a?.join(', '));
  if(j(oldSnap.aaaa)!==j(newSnap.aaaa) && !suppressEdgeIpRotation) add('aaaa-record','AAAA record changed',oldSnap.aaaa?.join(', '),newSnap.aaaa?.join(', '));
"""
if old not in s:
    raise SystemExit('snapshotChangeList target not found')
s = s.replace(old, new, 1)
p.write_text(s)

pkg = Path('package.json')
ps = pkg.read_text().replace('"version": "1.6.1"', '"version": "1.6.2"', 1)
pkg.write_text(ps)

t = Path('test/platform.test.js')
ts = t.read_text().replace('1.6.1', '1.6.2')
ts += """

test('v1.6.2 suppresses benign dynamic edge IP rotation alerts', async () => {
  const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(source, /dynamicEdgeProviders=new Set\(\['Vercel','Cloudflare','Netlify','GitHub Pages'\]\)/);
  assert.match(source, /suppressEdgeIpRotation=sameEdgeProvider && sameDnsContext/);
  assert.match(source, /A record changed/);
  assert.match(source, /AAAA record changed/);
});
"""
t.write_text(ts)
