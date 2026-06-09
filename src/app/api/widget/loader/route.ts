// GET /api/widget/loader?key=<widget_key>
// Returns the embeddable widget JavaScript (with the key + API origin baked in).
// Embed on any site:  <script src="https://<app>/api/widget/loader?key=wk_..." async></script>
import { resolveWidget } from '@/lib/livechat'
import { createServiceRoleClient } from '@/lib/supabase-server'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const key = (url.searchParams.get('key') || '').trim()
  const origin = url.origin

  // Soft-validate: if the key is unknown/disabled, return an inert no-op script
  // (don't break the host page). The widget still re-checks via /config at runtime.
  let ok = false
  if (key) {
    try {
      const supabase = await createServiceRoleClient()
      ok = (await resolveWidget(supabase, key)) !== null
    } catch { ok = false }
  }

  const js = ok ? buildWidgetJs(key, origin) : '/* live-chat: unknown or disabled widget key */'
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

function buildWidgetJs(key: string, origin: string): string {
  // Vanilla, self-contained, no deps. Polls every 3s; de-dupes by message id.
  return `(function(){
  var KEY=${JSON.stringify(key)}, API=${JSON.stringify(origin + '/api/widget')};
  if (window.__lcwLoaded) return; window.__lcwLoaded = true;
  var SKEY='lcw_sid_'+KEY;
  var sid=localStorage.getItem(SKEY);
  if(!sid){sid='sess_'+((window.crypto&&crypto.randomUUID)?crypto.randomUUID():(Date.now()+'_'+Math.random().toString(36).slice(2)));localStorage.setItem(SKEY,sid);}
  var color='#16a34a', title='Chat with us', welcome='Hi! How can we help?', subtitle='', launcher='', position='right', fg='#fff', prechat=false, online=true, offlineMsg='', bhEnabled=false;
  var open=false, seen={}, lastAt=null, pollTimer=null, started=false, configured=false;
  var NKEY='lcw_nm_'+KEY, EKEY='lcw_em_'+KEY;
  var visitorName=localStorage.getItem(NKEY)||'', visitorEmail=localStorage.getItem(EKEY)||'';

  // Pick readable text (dark/light) for a given background — so ANY accent works.
  function contrast(hex){var h=(hex||'').replace('#','');if(h.length===3)h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];var r=parseInt(h.substr(0,2),16),g=parseInt(h.substr(2,2),16),b=parseInt(h.substr(4,2),16);if(isNaN(r))return '#fff';return (0.299*r+0.587*g+0.114*b)/255>0.62?'#111827':'#fff';}

  var css=document.createElement('style');
  css.textContent=''
    +'.lcw-fab{position:fixed;bottom:20px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;transition:transform .15s}'
    +'.lcw-fab:hover{transform:scale(1.06)}'
    +'.lcw-fab svg{width:26px;height:26px}'
    +'.lcw-launch{position:fixed;bottom:32px;z-index:2147482999;border:1px solid #e5e7eb;background:#fff;color:#1f2937;border-radius:18px;padding:7px 13px;font-size:13px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.16);cursor:pointer;white-space:nowrap;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif}'
    +'.lcw-panel{position:fixed;bottom:88px;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}'
    +'.lcw-panel.lcw-open{display:flex}'
    +'.lcw-head{padding:13px 16px;font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:space-between;gap:10px}'
    +'.lcw-htext{display:flex;flex-direction:column;gap:1px;min-width:0}'
    +'.lcw-title{line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    +'.lcw-sub{font-weight:400;font-size:12px;opacity:.85;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    +'.lcw-x{background:none;border:none;color:inherit;opacity:.85;cursor:pointer;font-size:20px;line-height:1}'
    +'.lcw-body{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px}'
    +'.lcw-msg{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}'
    +'.lcw-in{align-self:flex-start;background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-bottom-left-radius:4px}'
    +'.lcw-out{align-self:flex-end;border-bottom-right-radius:4px}'
    +'.lcw-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff}'
    +'.lcw-input{flex:1;border:1px solid #d1d5db;border-radius:20px;padding:9px 14px;font-size:14px;outline:none}'
    +'.lcw-send{border:none;border-radius:20px;padding:0 16px;cursor:pointer;font-size:14px;font-weight:600}'
    +'.lcw-pc{display:flex;flex-direction:column;gap:10px;padding:18px 16px}'
    +'.lcw-pc-t{font-size:15px;font-weight:600;color:#1f2937}'
    +'.lcw-pc-d{font-size:12.5px;color:#6b7280;margin-top:-4px;line-height:1.4}'
    +'.lcw-pc-f{border:1px solid #d1d5db;border-radius:10px;padding:10px 12px;font-size:14px;outline:none;width:100%;box-sizing:border-box}'
    +'.lcw-pc-f:focus{border-color:#9ca3af}'
    +'.lcw-pc-err{font-size:12px;color:#dc2626}'
    +'.lcw-pc-go{border:none;border-radius:10px;padding:10px;cursor:pointer;font-size:14px;font-weight:600}';
  document.head.appendChild(css);

  var fab=document.createElement('button');
  fab.className='lcw-fab'; fab.setAttribute('aria-label','Open chat');
  fab.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.1 1 4 2.7 5.4-.1 1.2-.6 2.4-1.5 3.3 1.6-.2 3.1-.8 4.3-1.7 1.4.5 2.9.8 4.5.8 5.5 0 10-3.6 10-8s-4.5-8-10-8z"/></svg>';
  var launchEl=document.createElement('button'); launchEl.className='lcw-launch'; launchEl.style.display='none';
  var panel=document.createElement('div'); panel.className='lcw-panel';
  panel.innerHTML='<div class="lcw-head"><div class="lcw-htext"><span class="lcw-title"></span><span class="lcw-sub"></span></div><button class="lcw-x" aria-label="Close">&times;</button></div>'
    +'<div class="lcw-body"></div>'
    +'<div class="lcw-foot"><input class="lcw-input" placeholder="Type a message..." /><button class="lcw-send">Send</button></div>';
  document.body.appendChild(fab); document.body.appendChild(launchEl); document.body.appendChild(panel);

  var head=panel.querySelector('.lcw-head'), body=panel.querySelector('.lcw-body'), input=panel.querySelector('.lcw-input'),
      sendBtn=panel.querySelector('.lcw-send'), titleEl=panel.querySelector('.lcw-title'), subEl=panel.querySelector('.lcw-sub'),
      foot=panel.querySelector('.lcw-foot');

  function applyLayout(){
    var side=position==='left'?'left':'right', off=position==='left'?'right':'left';
    fab.style[side]='20px'; fab.style[off]='auto';
    panel.style[side]='20px'; panel.style[off]='auto';
    launchEl.style[side]='86px'; launchEl.style[off]='auto';
  }
  function applyTheme(){
    fg=contrast(color);
    fab.style.background=color; fab.style.color=fg;
    head.style.background=color; head.style.color=fg;
    sendBtn.style.background=color; sendBtn.style.color=fg;
    var outs=body.querySelectorAll('.lcw-out');for(var i=0;i<outs.length;i++){outs[i].style.background=color;outs[i].style.color=fg;}
  }
  function addMsg(id,dir,text){if(id&&seen[id])return;if(id)seen[id]=1;
    var d=document.createElement('div');d.className='lcw-msg '+(dir==='inbound'?'lcw-out':'lcw-in');
    if(dir==='inbound'){d.style.background=color;d.style.color=fg;}d.textContent=text;body.appendChild(d);body.scrollTop=body.scrollHeight;}

  function loadConfig(){return fetch(API+'/config?key='+encodeURIComponent(KEY)).then(function(r){return r.ok?r.json():null;}).then(function(c){
    if(c){title=c.title||title;color=c.color||color;welcome=c.welcome_message||welcome;subtitle=c.subtitle||'';launcher=c.launcher_text||'';position=c.position==='left'?'left':'right';prechat=!!c.prechat_enabled;bhEnabled=!!c.business_hours_enabled;online=c.online!==false;offlineMsg=c.offline_message||'';}
    configured=true;
    titleEl.textContent=title;subEl.textContent=subtitle;subEl.style.display=subtitle?'block':'none';
    if(launcher)launchEl.textContent=launcher;
    applyLayout();applyTheme();
    if(launcher&&!open)launchEl.style.display='block';}).catch(function(){});}

  function poll(){var u=API+'/poll?key='+encodeURIComponent(KEY)+'&session_id='+encodeURIComponent(sid)+(lastAt?('&after='+encodeURIComponent(lastAt)):'');
    return fetch(u).then(function(r){return r.ok?r.json():{messages:[]};}).then(function(d){
      var ms=(d&&d.messages)||[];for(var i=0;i<ms.length;i++){addMsg(ms[i].id,ms[i].direction,ms[i].text);lastAt=ms[i].at||lastAt;}}).catch(function(){});}

  function startPolling(){if(pollTimer)return;poll();pollTimer=setInterval(poll,3000);}

  function send(){var t=(input.value||'').trim();if(!t)return;input.value='';
    fetch(API+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,session_id:sid,text:t,visitor_name:visitorName,visitor_email:visitorEmail})})
      .then(function(r){return r.ok?r.json():null;}).then(function(d){if(d&&d.message_id)addMsg(d.message_id,'inbound',t);else addMsg(null,'inbound',t);poll();})
      .catch(function(){addMsg(null,'inbound',t);});}

  function begin(){foot.style.display='flex';
    if(!body.children.length){var greet=(bhEnabled&&!online)?(offlineMsg||'Thanks for reaching out! We are away right now — leave your message and we will reply by email.'):welcome;if(greet)addMsg(null,'outbound',greet);}
    startPolling();input.focus();}
  function showPrechat(){
    foot.style.display='none'; body.innerHTML='';
    var f=document.createElement('div'); f.className='lcw-pc';
    f.innerHTML='<div class="lcw-pc-t">Before we start</div><div class="lcw-pc-d">Tell us who you are so we can help — and follow up if we get disconnected.</div>';
    var nm=document.createElement('input'); nm.className='lcw-pc-f'; nm.placeholder='Your name'; nm.value=visitorName||'';
    var em=document.createElement('input'); em.className='lcw-pc-f'; em.type='email'; em.placeholder='Email address';
    var er=document.createElement('div'); er.className='lcw-pc-err';
    var go=document.createElement('button'); go.className='lcw-pc-go'; go.textContent='Start chat'; go.style.background=color; go.style.color=fg;
    f.appendChild(nm); f.appendChild(em); f.appendChild(er); f.appendChild(go); body.appendChild(f);
    function submit(){var n=(nm.value||'').trim(), e=(em.value||'').trim();
      if(!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(e)){er.textContent='Please enter a valid email address.';em.focus();return;}
      visitorName=n||visitorName; visitorEmail=e;
      try{localStorage.setItem(NKEY,visitorName);localStorage.setItem(EKEY,visitorEmail);}catch(x){}
      body.innerHTML=''; begin();}
    go.addEventListener('click',submit);
    em.addEventListener('keydown',function(ev){if(ev.key==='Enter')submit();});
    nm.focus();
  }
  function startFlow(){if(prechat&&!visitorEmail)showPrechat();else begin();}
  function openPanel(){open=true;panel.classList.add('lcw-open');launchEl.style.display='none';
    if(!started){started=true;if(configured)startFlow();else loadConfig().then(startFlow);}
    else if(foot&&foot.style.display!=='none'){input.focus();}}
  function closePanel(){open=false;panel.classList.remove('lcw-open');if(launcher)launchEl.style.display='block';}

  fab.addEventListener('click',function(){open?closePanel():openPanel();});
  launchEl.addEventListener('click',openPanel);
  panel.querySelector('.lcw-x').addEventListener('click',closePanel);
  sendBtn.addEventListener('click',send);
  input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});

  // Load config on init so the bubble is themed, positioned + shows its launcher
  // label immediately (not only after the first open).
  applyLayout(); applyTheme(); loadConfig();
})();`
}
