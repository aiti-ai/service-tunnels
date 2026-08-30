function tr(k,p){let m=UI_MSG[k]||k;if(p){for(const kk of Object.keys(p))m=m.split('{'+kk+'}').join(p[kk]);}return m;}
function csrfToken(){return document.querySelector('meta[name="csrf-token"]')?.content||'';}
async function api(path,opts){
  const o=opts||{};
  const init={method:o.method||'GET'};
  if(o.body){init.headers={'Content-Type':'application/json','X-CSRF-Token':csrfToken()};init.body=JSON.stringify(o.body);}
  const res=await fetch(path,init);
  let d={};try{d=await res.json();}catch(e){}
  if(!res.ok){throw new Error(d.error||('HTTP '+res.status));}
  return d;
}
// ── state ────────────────────────────────────────────────────────────────
const state={status:null,live:null,lang:(document.documentElement.lang==='zh-CN'?'zh':'en'),expanded:new Set(),logsFor:null,logsData:null,tab:'ports',protoDetect:{},authDefault:'',presets:{tunnelPresets:{},authPresets:{}},_tunnelPresetName:null,_authPresetName:null};
const TABS=['ports','exposes','users','tokens','sites','tools','config','ddns'];
const TAB_LABELS={ports:tr('ui.nav.dashboard'),exposes:tr('ui.nav.expose'),users:tr('ui.nav.users'),tokens:tr('ui.nav.tokens'),sites:tr('ui.nav.sites'),tools:tr('ui.tools.tab'),config:tr('ui.nav.config'),ddns:tr('ui.nav.ddns')};
let pollTimer=null;
// ── helpers ──────────────────────────────────────────────────────────────
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtAddr(a){return a.includes(':')?'['+a+']':a;}
function toast(msg,err,duration){const r=document.getElementById('toastRoot');const d=document.createElement('div');d.className='toast'+(err?' err':'');d.textContent=msg;r.appendChild(d);setTimeout(()=>d.remove(),duration||(err?8000:4000));}
function confirmDlg(title,body,confirmLabel,onOk){
  const root=document.getElementById('modalRoot');
  root.innerHTML='<div class="modal-ov"><div class="modal"><h3>⚠ '+esc(title)+'</h3><div class="muted" style="line-height:1.7">'+body+'</div><div class="actions" style="margin-top:14px;justify-content:flex-end"><button class="btn" onclick="this.closest(\'.modal-ov\').remove()">'+esc(tr('ui.cancel'))+'</button><button class="btn btn-danger" id="confirmOk">'+esc(confirmLabel)+'</button></div></div></div>';
  document.getElementById('confirmOk').onclick=()=>{root.innerHTML='';onOk();};
}
function openModal(html){
  const root=document.getElementById('modalRoot');
  root.innerHTML='<div class="modal-ov"><div class="modal">'+html+'</div></div>';
  root.querySelector('.modal-ov').onclick=(e)=>{if(e.target===e.currentTarget)root.innerHTML='';};
}
function closeModal(){document.getElementById('modalRoot').innerHTML='';}
function copyText(t){if(navigator.clipboard&&navigator.clipboard.writeText){return navigator.clipboard.writeText(t);}return Promise.reject(new Error('no clipboard'));}
// ── data loading ─────────────────────────────────────────────────────────
async function loadStatus(){try{state.status=await api('/api/status');renderHeader();renderTabs();renderTab();}catch(e){toast(String(e),true);}}
async function loadLive(){try{state.live=await api('/api/live');renderHeader();if(state.tab==='ports'||state.tab==='exposes'){if(!userEditing())renderTab();}}catch(e){/* daemon may be down — keep last */}}
// Don't re-render while the user is typing in a form (10s poll would wipe
// in-progress expose-form input).
function userEditing(){const el=document.activeElement;return !!(el&&(el.tagName==='INPUT'||el.tagName==='SELECT'||el.tagName==='TEXTAREA'));}
function startPolling(){if(pollTimer)clearInterval(pollTimer);pollTimer=setInterval(loadLive,10000);}
function refreshAll(){loadStatus().then(loadLive);}
// ── header / tabs ────────────────────────────────────────────────────────
function renderHeader(){
  const d=state.live&&state.live.daemon?state.live.daemon:(state.status&&state.status.daemon?state.status.daemon:null);
  const dot=document.getElementById('daemonDot');const txt=document.getElementById('daemonTxt');
  const running=!!(d&&d.running);
  dot.className='dot '+(running?'on':'off');
  txt.textContent=running?('daemon '+(d.pid||'')):tr('ui.status.stopped');
  document.getElementById('modeTxt').textContent=state.status&&state.status.mode?('mode: '+state.status.mode):'';
}
function renderTabs(){
  const el=document.getElementById('tabs');
  el.innerHTML=TABS.map((t)=>'<button class="tab'+(state.tab===t?' active':'')+'" data-tab="'+t+'">'+esc(TAB_LABELS[t])+'</button>').join('');
  el.querySelectorAll('.tab').forEach((b)=>b.onclick=()=>{state.tab=b.dataset.tab;location.hash='#/'+state.tab;renderTabs();renderTab();});
}
function renderTab(){const f={ports:renderPorts,exposes:renderExposes,users:renderUsers,tokens:renderTokens,sites:renderSites,tools:renderTools,config:renderConfig,ddns:renderDdns}[state.tab];f();}
// ── ports tab ────────────────────────────────────────────────────────────
