from pathlib import Path
import re

idx=Path('src/index.js')
s=idx.read_text()
anchor="  if (action === 'ad_toggle') { const id=Number(body.id); if(!id) throw miniError('Invalid ad.'); await env.DB.prepare('UPDATE ads SET active=CASE WHEN active=1 THEN 0 ELSE 1 END,updated_at=? WHERE id=?').bind(nowIso(),id).run(); return {ok:true}; }"
insert="""  if (action === 'ad_create_text') {
    const title = short(String(body.title || 'Sponsored'), 120), text = short(String(body.text || ''), 4096);
    if (!text) throw miniError('Ad text is required.');
    const buttons = parseButtonsSpec(String(body.buttons || ''));
    const r = await env.DB.prepare(`INSERT INTO ads(title,content_type,text_content,telegram_file_id,buttons_json,active,impressions,created_at,updated_at) VALUES(?,'text',?,NULL,?,0,0,?,?)`).bind(title,text,JSON.stringify(buttons),nowIso(),nowIso()).run();
    return { ok:true, id:Number(r.meta?.last_row_id || 0) };
  }
"""+anchor
if anchor not in s: raise SystemExit('missing backend ad anchor')
s=s.replace(anchor,insert,1)
idx.write_text(s)

p=Path('src/miniapp.js')
m=p.read_text()
# FormData-safe API wrapper
old="if(opts.body&&!headers['content-type'])headers['content-type']='application/json';"
new="if(opts.body&&!headers['content-type']&&!(opts.body instanceof FormData))headers['content-type']='application/json';"
if old not in m: raise SystemExit('missing api content-type anchor')
m=m.replace(old,new,1)

old='''        <div class="card"><h4>🚪 Registrations</h4><p id="regState">Loading…</p><div class="row" style="margin-top:10px"><button class="action good" data-admin-command="/admin_registrations_open">Open</button><button class="action danger" data-admin-command="/admin_registrations_close">Close</button></div></div>
        <div class="card"><h4>📧 Global email sender</h4><p id="smtpState">Not configured</p><button class="action secondary" style="margin-top:10px" data-admin-command="/admin_email">Status / Test</button></div>
        <div class="card"><h4>📣 Ads</h4><p>Manage sponsored message inventory without changing user features.</p><button class="action secondary" style="margin-top:10px" data-admin-command="/admin_ads">Manage in bot</button></div>'''
new='''        <div class="card"><h4>🚪 Registrations</h4><p id="regState">Loading…</p><div class="row" style="margin-top:10px"><button class="action good" id="regOpenBtn">Open</button><button class="action danger" id="regCloseBtn">Close</button></div></div>
        <div class="card"><h4>📧 Global email sender</h4><p id="smtpState">Not configured</p><button class="action secondary" style="margin-top:10px" data-admin-command="/admin_email">Status / Test</button></div>
        <div class="card"><h4>📣 Campaign center</h4><p>Create and manage broadcasts + sponsored ads directly in the dashboard.</p><button class="action secondary" style="margin-top:10px" data-jump="campaigns">Open campaigns</button></div>'''
if old not in m: raise SystemExit('missing platform cards anchor')
m=m.replace(old,new,1)

old='''      <div class="sectionTitle"><h3>Broadcast</h3><small>Text + buttons</small></div>
      <div class="card form"><textarea id="broadcastText" class="input" placeholder="Announcement text"></textarea><input id="broadcastButtons" class="input" placeholder="Website|https://example.com; Support|https://t.me/..."><div class="row"><button class="action" id="broadcastCreate">Create draft in bot</button><button class="action secondary" data-admin-command="/admin_broadcasts">View broadcasts</button></div><p>Media broadcasts still use Telegram media file IDs; use the admin bot chat for photo/video/voice drafts. All queued delivery remains handled by the same bot scheduler.</p></div>'''
new='''      <div id="campaigns" class="sectionTitle"><h3>Broadcasts</h3><small>Text • photo • video • voice</small></div>
      <div class="card form">
        <textarea id="broadcastText" class="input" placeholder="Announcement text / media caption"></textarea>
        <input id="broadcastButtons" class="input" placeholder="Website|https://example.com; Support|https://t.me/...">
        <div class="row"><select id="broadcastType" class="input"><option value="text">Text only</option><option value="photo">Photo</option><option value="video">Video</option><option value="voice">Voice</option></select><input id="broadcastFile" class="input" type="file" accept="image/*,video/*,audio/*"></div>
        <button class="action" id="broadcastCreate">Create broadcast draft</button>
        <p>Drafts use the same safe batch-delivery engine as the Telegram bot. Review the draft below, then queue it.</p>
        <div id="broadcastList" class="list"></div>
      </div>
      <div class="sectionTitle"><h3>Sponsored ads</h3><small>Text • photo • video • voice</small></div>
      <div class="card form">
        <input id="adTitle" class="input" placeholder="Campaign title">
        <textarea id="adText" class="input" placeholder="Sponsored message / media caption"></textarea>
        <input id="adButtons" class="input" placeholder="Learn more|https://example.com">
        <div class="row"><select id="adType" class="input"><option value="text">Text only</option><option value="photo">Photo</option><option value="video">Video</option><option value="voice">Voice</option></select><input id="adFile" class="input" type="file" accept="image/*,video/*,audio/*"></div>
        <button class="action" id="adCreate">Create sponsored ad</button>
        <p>New ads start disabled. Enable a campaign below when it is ready.</p>
        <div id="adsList" class="list"></div>
      </div>'''
if old not in m: raise SystemExit('missing broadcast html anchor')
m=m.replace(old,new,1)

# Insert admin API helpers after run()
anchor="  function domainValue(){var v=$('toolDomain').value.trim();if(!v)throw new Error('Enter a domain first.');return v.replace(/^https?:\\/\\//i,'').split('/')[0].toLowerCase()}"
helpers=r'''  async function adminManage(body){var j=await api('/api/mini/admin/manage',{method:'POST',body:JSON.stringify(body)});toast('Admin change saved.');return j}
  async function adminMedia(mode,type,file,text,buttons,title){if(!file)throw new Error('Choose a media file.');var f=new FormData();f.set('mode',mode);f.set('content_type',type);f.set('file',file);f.set('text',text||'');f.set('buttons',buttons||'');if(title)f.set('title',title);var j=await api('/api/mini/admin/media',{method:'POST',body:f});toast(mode==='ad'?'Sponsored ad created.':'Broadcast draft created.');return j}
'''+anchor
if anchor not in m: raise SystemExit('missing helper anchor')
m=m.replace(anchor,helpers,1)

# Replace renderAdmin one-line function with richer version, preserving next function.
pat=re.compile(r"  function renderAdmin\(a\)\{[^\n]*\}\n  function renderAdminUsers")
replacement=r'''  function renderAdmin(a){
    if(!a)return;
    document.querySelectorAll('.adminOnly').forEach(function(x){x.style.display='block'});
    $('adminStats').innerHTML=[['Users',a.stats.users],['Verified',a.stats.verified],['Pending',a.stats.pending],['Down',a.stats.down],['Waitlist',a.stats.waitlist],['Broadcasts',a.stats.broadcasts]].map(function(x){return '<div class="stat"><b>'+esc(x[1])+'</b><span>'+esc(x[0])+'</span></div>'}).join('');
    $('regState').textContent=a.registrationsOpen?'🟢 Open':'🔴 Closed';
    $('smtpState').textContent=a.smtp&&a.smtp.sender_email?(a.smtp.active?'🟢 ':'⚪ ')+a.smtp.sender_email:'⚪ Not configured';
    $('adminUserCount').textContent=(a.users||[]).length+' recent users';
    renderAdminUsers();
    $('couponList').innerHTML=(a.coupons||[]).length?(a.coupons||[]).map(function(c){return '<div class="adminRow"><div class="userMain"><b>'+esc(c.code)+' • '+esc(c.plan)+'</b><span>'+esc(c.bonus_days)+' days • '+esc(c.uses_count)+'/'+esc(c.max_uses==null?'∞':c.max_uses)+' uses • '+(c.active?'active':'inactive')+'</span></div><button class="action danger" data-delcoupon="'+esc(c.code)+'">Delete</button></div>'}).join(''):'<div class="empty">No coupons.</div>';
    $('couponList').querySelectorAll('[data-delcoupon]').forEach(function(b){b.addEventListener('click',function(){run('/admin_coupon_delete '+b.getAttribute('data-delcoupon'),true).then(function(){setTimeout(load,800)})})});
    renderCampaigns(a);
  }
  function renderCampaigns(a){
    $('broadcastList').innerHTML=(a.broadcasts||[]).length?(a.broadcasts||[]).map(function(x){var draft=x.status==='draft';return '<div class="adminRow"><div class="userMain"><b>#'+esc(x.id)+' • '+esc(x.content_type)+' • '+esc(x.status)+'</b><span>'+esc((x.text_content||'No caption').slice(0,80))+' • sent '+esc(x.sent_count||0)+' • failed '+esc(x.failed_count||0)+'</span></div><div class="row" style="flex:0 0 auto">'+(draft?'<button class="action good" data-queuebroadcast="'+esc(x.id)+'">Queue</button><button class="action danger" data-delbroadcast="'+esc(x.id)+'">Delete</button>':'')+'</div></div>'}).join(''):'<div class="empty">No broadcasts yet.</div>';
    $('broadcastList').querySelectorAll('[data-queuebroadcast]').forEach(function(b){b.addEventListener('click',function(){adminManage({action:'broadcast_queue',id:Number(b.getAttribute('data-queuebroadcast'))}).then(function(){setTimeout(load,600)})})});
    $('broadcastList').querySelectorAll('[data-delbroadcast]').forEach(function(b){b.addEventListener('click',function(){adminManage({action:'broadcast_delete',id:Number(b.getAttribute('data-delbroadcast'))}).then(function(){setTimeout(load,600)})})});
    $('adsList').innerHTML=(a.ads||[]).length?(a.ads||[]).map(function(x){return '<div class="adminRow"><div class="userMain"><b>'+esc(x.title||('Ad #'+x.id))+' • '+esc(x.content_type)+'</b><span>'+(x.active?'🟢 Active':'⚪ Disabled')+' • '+esc(x.impressions||0)+' impressions</span></div><div class="row" style="flex:0 0 auto"><button class="action secondary" data-togglead="'+esc(x.id)+'">'+(x.active?'Disable':'Enable')+'</button><button class="action danger" data-delad="'+esc(x.id)+'">Delete</button></div></div>'}).join(''):'<div class="empty">No sponsored ads yet.</div>';
    $('adsList').querySelectorAll('[data-togglead]').forEach(function(b){b.addEventListener('click',function(){adminManage({action:'ad_toggle',id:Number(b.getAttribute('data-togglead'))}).then(function(){setTimeout(load,600)})})});
    $('adsList').querySelectorAll('[data-delad]').forEach(function(b){b.addEventListener('click',function(){adminManage({action:'ad_delete',id:Number(b.getAttribute('data-delad'))}).then(function(){setTimeout(load,600)})})});
  }
  function renderAdminUsers'''
m,n=pat.subn(replacement,m,count=1)
if n!=1: raise SystemExit('renderAdmin pattern failed')

# Add campaign jump handling to existing navigation listener line
old="document.querySelectorAll('[data-tab],[data-nav]').forEach(function(b){b.addEventListener('click',function(){page(b.getAttribute('data-tab')||b.getAttribute('data-nav'))})});"
new=old+"document.querySelectorAll('[data-jump]').forEach(function(b){b.addEventListener('click',function(){var el=$(b.getAttribute('data-jump'));if(el)el.scrollIntoView({behavior:'smooth',block:'start'})})});"
if old not in m: raise SystemExit('navigation anchor missing')
m=m.replace(old,new,1)

# Replace final admin listener line with complete direct campaign controls.
lines=m.splitlines()
out=[]
replaced=False
for line in lines:
    if line.startswith("  $('smtpSave').addEventListener"):
        replaced=True
        out.extend(r'''  $('smtpSave').addEventListener('click',function(){var e=$('smtpEmail').value.trim(),p=$('smtpPassword').value.replace(/\s+/g,'');if(!e||!p)return toast('Enter Gmail and App Password',true);run('/admin_email_setup '+e+' '+p,true).then(function(){$('smtpPassword').value='';setTimeout(load,900)})});
  $('createCouponBtn').addEventListener('click',function(){var c=$('couponCodeAdmin').value.trim().toUpperCase(),p=$('couponPlanAdmin').value,d=$('couponDaysAdmin').value.trim(),m=$('couponMaxAdmin').value.trim(),x=$('couponExpiryAdmin').value.trim()||'none',coins=$('couponCoinsAdmin').value.trim()||'0';if(!c)return toast('Enter coupon code',true);run('/admin_coupon_create '+c+' '+p+' '+d+' '+m+' '+x+' '+coins,true).then(function(){setTimeout(load,800)})});
  $('regOpenBtn').addEventListener('click',function(){adminManage({action:'registration',open:true}).then(function(){setTimeout(load,600)})});
  $('regCloseBtn').addEventListener('click',function(){adminManage({action:'registration',open:false}).then(function(){setTimeout(load,600)})});
  $('broadcastType').addEventListener('change',function(){$('broadcastFile').classList.toggle('hidden',this.value==='text')});$('broadcastFile').classList.add('hidden');
  $('adType').addEventListener('change',function(){$('adFile').classList.toggle('hidden',this.value==='text')});$('adFile').classList.add('hidden');
  $('broadcastCreate').addEventListener('click',async function(){try{var type=$('broadcastType').value,text=$('broadcastText').value.trim(),buttons=$('broadcastButtons').value.trim();if(type==='text'){if(!text)return toast('Enter broadcast text',true);await adminManage({action:'broadcast_create',text:text,buttons:buttons})}else{await adminMedia('broadcast',type,$('broadcastFile').files[0],text,buttons,'')}toast('Broadcast draft ready. Review and queue it below.');$('broadcastFile').value='';setTimeout(load,600)}catch(e){toast(e.message,true)}});
  $('adCreate').addEventListener('click',async function(){try{var type=$('adType').value,title=$('adTitle').value.trim()||'Sponsored',text=$('adText').value.trim(),buttons=$('adButtons').value.trim();if(type==='text'){if(!text)return toast('Enter sponsored message text',true);await adminManage({action:'ad_create_text',title:title,text:text,buttons:buttons})}else{await adminMedia('ad',type,$('adFile').files[0],text,buttons,title)}toast('Sponsored ad created disabled. Enable it below when ready.');$('adFile').value='';setTimeout(load,600)}catch(e){toast(e.message,true)}});'''.splitlines())
    else:
        out.append(line)
if not replaced: raise SystemExit('final listener line not found')
p.write_text('\n'.join(out)+'\n')

# Strengthen tests without changing version.
t=Path('test/platform.test.js')
ts=t.read_text()
marker="assert.match(mini, /Command console/);\n});"
newmarker="""assert.match(mini, /Command console/);
  assert.match(source, /ad_create_text/);
  assert.match(mini, /Create broadcast draft/);
  assert.match(mini, /Create sponsored ad/);
  assert.match(mini, /broadcast_queue/);
  assert.match(mini, /ad_toggle/);
  assert.match(mini, /adminMedia/);
});"""
if marker not in ts: raise SystemExit('test marker missing')
ts=ts.replace(marker,newmarker,1)
t.write_text(ts)
