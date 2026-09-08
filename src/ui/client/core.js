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
const TABS=['ports','exposes','users','tokens','sites','tools','config','ddns','doctor'];
const TAB_LABELS={ports:tr('ui.nav.dashboard'),exposes:tr('ui.nav.expose'),users:tr('ui.nav.users'),tokens:tr('ui.nav.tokens'),sites:tr('ui.nav.sites'),tools:tr('ui.tools.tab'),config:tr('ui.nav.config'),ddns:tr('ui.nav.ddns'),doctor:tr('ui.nav.doctor')};
/** doctor tab 能力门控：/api/status netcheck=false（未实现且未开 mock）→ 隐藏。 */
function visibleTabs(){return TABS.filter((t)=>t!=='doctor'||canDoctor());}
let pollTimer=null;
// ── helpers ──────────────────────────────────────────────────────────────
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// ── 共享展示语义（双端单源：src/ui-shared.ts → dist/ui-shared.js → /ui/shared.js）──
// /ui/shared.js（module 脚本）加载后把全部导出挂到 window.__stShared；此处运行时
// 优先取共享层，缺失（404/老缓存）回落 __stLocal 本地实现——等价性由
// test/ui-shared.test.mjs 钉死（构建期同源，漂移即测试红）。
const __stLocal={
  modeOf:function(e){if(e&&e.mode)return e.mode;if(!e||!e.name)return '';if(e.name.indexOf('ipv6:')===0)return 'ipv6';if(e.name.indexOf('proxy:')===0)return 'proxy';return e.tunnelType||'';},
  fmtAddr:function(a){return a.includes(':')?'['+a+']':a;},
  fmtBytes:function(n){if(!Number.isFinite(n)||n<0)return '—';if(n>=1073741824)return (n/1073741824).toFixed(1)+' GB';if(n>=1048576)return (n/1048576).toFixed(1)+' MB';if(n>=1024)return (n/1024).toFixed(1)+' KB';return String(n)+' B';},
  identityView:function(id){if(!id)return {};var isHttp=!!id.protocol&&id.protocol!=='tcp';var meta=isHttp?[id.protocol+(id.status?' '+id.status:''),id.server].filter(Boolean).join(' · '):'';var hasLabel=!!id.label;var title=id.label||id.title;var detected=id.label&&id.title&&id.label!==id.title?id.title:undefined;var tooltip=[detected,meta].filter(Boolean).join(' · ');var out={};if(id.favicon)out.icon=id.favicon;if(title)out.title=title;if(tooltip)out.tooltip=tooltip;if(hasLabel)out.hasLabel=true;if(detected)out.detected=detected;return out;},
  ddnsBadge:function(ddns){if(!ddns||!Array.isArray(ddns.actions)||!ddns.actions.length)return null;var out={items:ddns.actions.map(function(a){return {type:String(a.type),ok:!!a.ok};})};if(ddns.profile)out.profile=ddns.profile;return out;},
  netcheckEventView:function(ev){switch(ev.type){case 'phase-start':return {icon:'▶',textKey:'ui.doctor.ev.phase-start',params:{label:String(ev.label??''),total:ev.total!=null?String(ev.total):''},tone:'dim'};case 'probe-done':return {icon:ev.ok?'✓':'✗',textKey:'ui.doctor.ev.probe-done',params:{item:String(ev.item??''),verdict:String(ev.verdict??''),ms:String(ev.ms??'')},tone:ev.ok?'ok':'bad'};case 'tunnel-est':return {icon:'✓',textKey:'ui.doctor.ev.tunnel-est',params:{provider:String(ev.provider??''),url:String(ev.url??''),ms:String(ev.ms??'')},tone:'ok'};case 'tunnel-fail':return {icon:'✗',textKey:'ui.doctor.ev.tunnel-fail',params:{provider:String(ev.provider??''),error:String(ev.error??''),ms:String(ev.ms??'')},tone:'bad'};case 'channel-result':return {icon:ev.ok?'✓':'✗',textKey:'ui.doctor.ev.channel-result',params:{provider:String(ev.provider??''),channel:String(ev.channel??''),level:String(ev.level??''),ms:String(ev.ms??'')},tone:ev.ok?'ok':'bad'};case 'verdict-confirmed':return {icon:ev.confirmed?'★':'○',textKey:'ui.doctor.ev.verdict-confirmed',params:{provider:String(ev.provider??''),verdict:String(ev.verdict??''),sourcesOk:String(ev.sourcesOk??'')},tone:ev.confirmed?'ok':'warn'};case 'advice-update':return {icon:'💡',textKey:'ui.doctor.ev.advice-update',params:{note:String(ev.note??'')},tone:'warn'};case 'phase-end':return {icon:'■',textKey:'ui.doctor.ev.phase-end',params:{phase:String(ev.phase??''),summary:String(ev.summary??'')},tone:'dim'};case 'summary':return {icon:'📋',textKey:'ui.doctor.ev.summary',tone:'ok'};case 'done':return {icon:'✔',textKey:'ui.doctor.ev.done',tone:'ok'};case 'error':return {icon:'⚠',textKey:'ui.doctor.ev.error',params:{message:String(ev.message??'')},tone:'bad'};case 'cancelled':return {icon:'⏹',textKey:'ui.doctor.ev.cancelled',tone:'warn'};default:return {icon:'·',textKey:'ui.doctor.ev.unknown',params:{type:String(ev.type??'')},tone:'dim'};}},
  adviceView:function(a){var score=typeof a.score==='number'&&Number.isFinite(a.score)?a.score:0;var confirmed=!!a.confirmed;var untested=!a.confidence||a.confidence==='none';var badgeKey=untested?'ui.doctor.advice.untested':confirmed?'ui.doctor.advice.confirmed':'ui.doctor.advice.unconfirmed';var tone=confirmed?'ok':untested?'dim':'warn';return {rank:score,badgeKey:badgeKey,tone:tone,key:String(a.id??'')};},
  portmapProbeView:function(report){var cls=report&&report.ipClass;if(cls==='cgnat')return {key:'ui.portmap.probeCgnat',bad:true};if(cls==='public')return {key:'ui.portmap.probePublic',bad:false};if(report&&report.upnp&&report.upnp.ok)return {key:'ui.portmap.probeOkUpnp',bad:false};if(report&&report.pcp&&report.pcp.ok)return {key:'ui.portmap.probeOkPcp',bad:false};return {key:'ui.portmap.probeNone',bad:true};},
};
function SH(){return (typeof window!=='undefined'&&window.__stShared)||__stLocal;}
function fmtAddr(a){return SH().fmtAddr(a);}
/** Expose 条目的显示模式：优先记录自带 mode；老记录按 name 前缀推断。 */
function modeOf(e){return SH().modeOf(e);}
function fmtBytes(n){return SH().fmtBytes(n);}
function identityView(id){return SH().identityView(id);}
function ddnsBadge(ddns){return SH().ddnsBadge(ddns);}
function netcheckEventView(ev){return SH().netcheckEventView(ev);}
function adviceView(a){return SH().adviceView(a);}
function portmapProbeView(r){return SH().portmapProbeView(r);}
function toast(msg,err,duration){const r=document.getElementById('toastRoot');const d=document.createElement('div');d.className='toast'+(err?' err':'');d.setAttribute('role','status');d.setAttribute('aria-live','polite');d.textContent=msg;r.appendChild(d);setTimeout(()=>d.remove(),duration||(err?8000:4000));}
function confirmDlg(title,body,confirmLabel,onOk){
  const root=document.getElementById('modalRoot');
  root.innerHTML='<div class="modal-ov"><div class="modal" role="dialog" aria-modal="true"><h3>⚠ '+esc(title)+'</h3><div class="muted" style="line-height:1.7">'+body+'</div><div class="actions" style="margin-top:14px;justify-content:flex-end"><button class="btn" onclick="this.closest(\'.modal-ov\').remove()">'+esc(tr('ui.cancel'))+'</button><button class="btn btn-danger" id="confirmOk">'+esc(confirmLabel)+'</button></div></div></div>';
  document.getElementById('confirmOk').onclick=()=>{root.innerHTML='';onOk();};
  document.addEventListener('keydown',modalEsc);
  const ok=document.getElementById('confirmOk');if(ok)ok.focus();
}
function openModal(html){
  const root=document.getElementById('modalRoot');
  root.innerHTML='<div class="modal-ov"><div class="modal" role="dialog" aria-modal="true">'+html+'</div></div>';
  root.querySelector('.modal-ov').onclick=(e)=>{if(e.target===e.currentTarget)root.innerHTML='';};
  // a11y：打开即聚焦首输入控件；Esc 关闭
  const first=root.querySelector('.modal input,.modal select,.modal textarea');
  if(first)setTimeout(()=>{try{first.focus();}catch(e){}},0);
  document.addEventListener('keydown',modalEsc);
}
function modalEsc(e){if(e.key==='Escape')closeModal();}
function closeModal(){document.getElementById('modalRoot').innerHTML='';document.removeEventListener('keydown',modalEsc);}
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
  // L-j header 增强：库版本 + daemon 停止提示（pollTxt 位原为死节点，复用）
  const poll=document.getElementById('pollTxt');
  if(poll){
    const ver=state.status&&state.status.version;
    poll.textContent=(ver?('v'+ver):'')+((!running&&state.status)?((ver?' · ':'')+tr('ui.status.startHint')):'');
  }
}
function renderTabs(){
  const el=document.getElementById('tabs');
  const tabs=visibleTabs();
  if(!tabs.includes(state.tab))state.tab=tabs[0];
  el.innerHTML=tabs.map((t)=>'<button class="tab'+(state.tab===t?' active':'')+'" data-tab="'+t+'" role="tab" aria-selected="'+(state.tab===t)+'">'+esc(TAB_LABELS[t])+'</button>').join('');
  el.querySelectorAll('.tab').forEach((b)=>b.onclick=()=>{state.tab=b.dataset.tab;location.hash='#/'+state.tab;renderTabs();renderTab();});
}
function renderTab(){const f={ports:renderPorts,exposes:renderExposes,users:renderUsers,tokens:renderTokens,sites:renderSites,tools:renderTools,config:renderConfig,ddns:renderDdns,doctor:renderDoctor}[state.tab];if(f)f();}
// ── ports tab ────────────────────────────────────────────────────────────
