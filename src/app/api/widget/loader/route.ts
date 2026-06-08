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
  var color='#16a34a', title='Chat with us', welcome='Hi! How can we help?';
  var open=false, seen={}, lastAt=null, pollTimer=null, started=false;

  var css=document.createElement('style');
  css.textContent=''
    +'.lcw-fab{position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;color:#fff;transition:transform .15s}'
    +'.lcw-fab:hover{transform:scale(1.06)}'
    +'.lcw-fab svg{width:26px;height:26px}'
    +'.lcw-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:calc(100vw - 32px);height:460px;max-height:calc(100vh - 120px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.22);z-index:2147483000;display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}'
    +'.lcw-panel.lcw-open{display:flex}'
    +'.lcw-head{padding:14px 16px;color:#fff;font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:space-between}'
    +'.lcw-x{background:none;border:none;color:#fff;opacity:.85;cursor:pointer;font-size:20px;line-height:1}'
    +'.lcw-body{flex:1;overflow-y:auto;padding:14px;background:#f7f8fa;display:flex;flex-direction:column;gap:8px}'
    +'.lcw-msg{max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;line-height:1.35;white-space:pre-wrap;word-wrap:break-word}'
    +'.lcw-in{align-self:flex-start;background:#fff;color:#1f2937;border:1px solid #e5e7eb;border-bottom-left-radius:4px}'
    +'.lcw-out{align-self:flex-end;color:#fff;border-bottom-right-radius:4px}'
    +'.lcw-foot{display:flex;gap:8px;padding:10px;border-top:1px solid #eee;background:#fff}'
    +'.lcw-input{flex:1;border:1px solid #d1d5db;border-radius:20px;padding:9px 14px;font-size:14px;outline:none}'
    +'.lcw-send{border:none;color:#fff;border-radius:20px;padding:0 16px;cursor:pointer;font-size:14px;font-weight:600}';
  document.head.appendChild(css);

  var fab=document.createElement('button');
  fab.className='lcw-fab'; fab.setAttribute('aria-label','Open chat');
  fab.innerHTML='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.6 2 11c0 2.1 1 4 2.7 5.4-.1 1.2-.6 2.4-1.5 3.3 1.6-.2 3.1-.8 4.3-1.7 1.4.5 2.9.8 4.5.8 5.5 0 10-3.6 10-8s-4.5-8-10-8z"/></svg>';
  var panel=document.createElement('div'); panel.className='lcw-panel';
  panel.innerHTML='<div class="lcw-head"><span class="lcw-title"></span><button class="lcw-x" aria-label="Close">&times;</button></div>'
    +'<div class="lcw-body"></div>'
    +'<div class="lcw-foot"><input class="lcw-input" placeholder="Type a message..." /><button class="lcw-send">Send</button></div>';
  document.body.appendChild(fab); document.body.appendChild(panel);

  var body=panel.querySelector('.lcw-body'), input=panel.querySelector('.lcw-input'),
      sendBtn=panel.querySelector('.lcw-send'), titleEl=panel.querySelector('.lcw-title');

  function applyColor(){fab.style.background=color;panel.querySelector('.lcw-head').style.background=color;sendBtn.style.background=color;
    var outs=body.querySelectorAll('.lcw-out');for(var i=0;i<outs.length;i++)outs[i].style.background=color;}
  function addMsg(id,dir,text){if(id&&seen[id])return;if(id)seen[id]=1;
    var d=document.createElement('div');d.className='lcw-msg '+(dir==='inbound'?'lcw-out':'lcw-in');
    if(dir==='inbound')d.style.background=color;d.textContent=text;body.appendChild(d);body.scrollTop=body.scrollHeight;}

  function loadConfig(){return fetch(API+'/config?key='+encodeURIComponent(KEY)).then(function(r){return r.ok?r.json():null;}).then(function(c){
    if(c){title=c.title||title;color=c.color||color;welcome=c.welcome_message||welcome;}
    titleEl.textContent=title;applyColor();}).catch(function(){});}

  function poll(){var u=API+'/poll?key='+encodeURIComponent(KEY)+'&session_id='+encodeURIComponent(sid)+(lastAt?('&after='+encodeURIComponent(lastAt)):'');
    return fetch(u).then(function(r){return r.ok?r.json():{messages:[]};}).then(function(d){
      var ms=(d&&d.messages)||[];for(var i=0;i<ms.length;i++){addMsg(ms[i].id,ms[i].direction,ms[i].text);lastAt=ms[i].at||lastAt;}}).catch(function(){});}

  function startPolling(){if(pollTimer)return;poll();pollTimer=setInterval(poll,3000);}

  function send(){var t=(input.value||'').trim();if(!t)return;input.value='';
    fetch(API+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:KEY,session_id:sid,text:t})})
      .then(function(r){return r.ok?r.json():null;}).then(function(d){if(d&&d.message_id)addMsg(d.message_id,'inbound',t);else addMsg(null,'inbound',t);poll();})
      .catch(function(){addMsg(null,'inbound',t);});}

  function openPanel(){open=true;panel.classList.add('lcw-open');
    if(!started){started=true;loadConfig().then(function(){if(welcome&&!body.children.length)addMsg(null,'outbound',welcome);startPolling();});}
    input.focus();}
  function closePanel(){open=false;panel.classList.remove('lcw-open');}

  fab.addEventListener('click',function(){open?closePanel():openPanel();});
  panel.querySelector('.lcw-x').addEventListener('click',closePanel);
  sendBtn.addEventListener('click',send);
  input.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}});
})();`
}
