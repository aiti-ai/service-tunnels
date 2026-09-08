/** Doctor（netcheck）tab — 事件流渲染走共享层 netcheckEventView/adviceView。
 *  能力门控：/api/status 的 netcheck=false 时 tab 不出现（core.js renderTabs 过滤）。
 *  SSE：EventSource（GET 免 CSRF）；断线浏览器自动重连并带 Last-Event-ID，
 *  服务端环形缓冲续传。 */

let es = null;
let doctorLog = [];
let doctorAdvice = [];
let doctorReport = null;
let doctorMock = false;

function canDoctor(){return !!(state.status&&state.status.netcheck);}
function setDoctorButtons(running){
  const s=document.getElementById('doctorStart'),t=document.getElementById('doctorStop'),x=document.getElementById('doctorState');
  if(s)s.disabled=running;if(t)t.disabled=!running;
  if(x)x.textContent=running?tr('ui.doctor.running')+(doctorMock?' (mock)':''):'';
}
async function renderDoctor(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="card" style="padding:12px">'
    +'<div class="actions" style="margin-bottom:8px">'
    +'<button class="btn btn-primary btn-sm" id="doctorStart" onclick="doctorStart()">'+esc(tr('ui.doctor.start'))+'</button>'
    +'<button class="btn btn-sm btn-danger" id="doctorStop" onclick="doctorStop()" disabled>'+esc(tr('ui.doctor.stop'))+'</button>'
    +'<span class="dim" id="doctorState"></span></div>'
    +'<div id="doctorEvents" class="mono" style="max-height:50vh;overflow:auto;font-size:11px;line-height:1.7"></div>'
    +'<div id="doctorAdvice"></div>'
    +'<div id="doctorReport"></div></div>';
  setDoctorButtons(es&&es.readyState===1&&!doctorIdle());
  if(!es||es.readyState===2)connectDoctorEvents();
  paintDoctor();
}
function doctorIdle(){return !doctorLog.length||doctorDone();}
function doctorDone(){const last=doctorLog[doctorLog.length-1];return !!last&&(last.type==='done'||last.type==='cancelled'||last.type==='error');}
function connectDoctorEvents(){
  if(es)es.close();
  es=new EventSource('/api/doctor-events');
  es.onmessage=(m)=>{try{onDoctorEvent(JSON.parse(m.data));}catch(e){/* skip bad frame */}};
  es.onerror=()=>{/* 断线由浏览器自动重连（Last-Event-ID 续传）*/};
}
function onDoctorEvent(ev){
  doctorLog.push(ev);
  if(ev.type==='advice-update'&&Array.isArray(ev.advice))doctorAdvice=ev.advice;
  if(ev.type==='summary'&&ev.report)doctorReport=ev;
  if(ev.type==='done'&&ev.report)doctorReport=doctorReport||ev;
  paintDoctor();
}
function paintDoctor(){
  const box=document.getElementById('doctorEvents');
  if(box){
    box.innerHTML=doctorLog.map((ev)=>{
      const v=netcheckEventView(ev);
      return '<div class="'+v.tone+'">'+esc(v.icon+' '+tr(v.textKey,v.params||{}))+'</div>';
    }).join('');
    box.scrollTop=box.scrollHeight;
  }
  const adv=document.getElementById('doctorAdvice');
  if(adv){
    adv.innerHTML=doctorAdvice.length
      ?'<div class="section-label">'+esc(tr('ui.doctor.advice'))+'</div>'+doctorAdvice.slice().sort((a,b)=>(b.score||0)-(a.score||0)).map((a)=>{
        const v=adviceView(a);
        return '<div class="card" style="padding:8px 10px;margin-bottom:6px">'
          +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>'+esc(a.title||a.id)+'</strong>'
          +'<span class="badge '+v.tone+'">'+esc(tr(v.badgeKey))+'</span><span class="dim mono">'+esc(String(a.score??''))+'</span></div>'
          +(a.why&&a.why.length?'<div class="hint">'+esc(a.why.join(' · '))+'</div>':'')
          +(a.cmd?'<pre class="log" style="margin-top:4px">'+esc(a.cmd)+'</pre>':'')+'</div>';
      }).join('')
      :'';
  }
  const rep=document.getElementById('doctorReport');
  if(rep){
    rep.innerHTML=doctorReport
      ?'<div class="section-label">'+esc(tr('ui.doctor.report'))+'</div><pre class="log" style="max-height:30vh">'+esc(doctorReport.markdown||doctorReport.text||'')+'</pre>'
        +'<div class="actions" style="margin-top:6px"><button class="btn btn-sm" onclick="copyDoctorReport()">'+esc(tr('ui.doctor.copyMd'))+'</button></div>'
      :'';
  }
}
window.copyDoctorReport=()=>{if(doctorReport)copyText(doctorReport.markdown||doctorReport.text||'').then(()=>toast(tr('ui.doctor.copied')));};
window.doctorStart=async()=>{
  try{
    doctorLog=[];doctorAdvice=[];doctorReport=null;doctorMock=false;
    const r=await api('/api/doctor-start',{method:'POST',body:{}});
    doctorMock=!!r.mock;
    setDoctorButtons(true);
    if(!es||es.readyState!==1)connectDoctorEvents();
    paintDoctor();
  }catch(e){toast(String(e),true);}
};
window.doctorStop=async()=>{try{await api('/api/doctor-stop',{method:'POST',body:{}});setDoctorButtons(false);}catch(e){toast(String(e),true);}};
