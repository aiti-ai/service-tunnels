function renderExposes(){
  const c=document.getElementById('content');
  const exs=(state.live&&state.live.exposes)||[];
  let h='<div class="actions" style="margin-bottom:10px"><div class="spacer"></div>'
    +'<button class="btn btn-sm btn-danger" onclick="stopAllExposes()">'+esc(tr('ui.ports.stopAll'))+'</button></div>';
  if(!exs.length){h+='<div class="empty"><div style="font-size:24px;margin-bottom:6px">🌐</div>'+esc(tr('ui.exposes.none'))+'<p class="hint" style="margin-top:6px">'+esc(tr('ui.exposes.noneGuide'))+'</p></div>';}
  else if(window.matchMedia&&window.matchMedia('(max-width:640px)').matches){
    // L-g: 窄屏（≤640px）9 列表折叠为卡片列表（零依赖：matchMedia + 渲染分支）
    h+=exs.map((e)=>{
      const b=ddnsBadge(e.ddns);
      return '<div class="card" style="padding:8px 10px;margin-bottom:6px">'
        +'<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        +'<span class="port">'+e.port+'</span>'
        +'<span class="mono" style="font-size:11px">'+esc(e.name)+'</span>'
        +'<span class="badge">'+esc(modeOf(e)||'?')+'</span>'
        +(e.provider?'<span class="badge">'+esc(e.provider)+'</span>':'<span class="badge authnone">'+esc(tr('ui.ports.authNoneBadge'))+'</span>')
        +'<span class="'+(e.running?'ok':'dim')+'" style="font-size:10px">'+(e.running?'● '+esc(tr('ui.tunnelRunning')):esc(tr('ui.tunnelStopped')))+'</span></div>'
        +'<div class="dim" style="font-size:10px;margin-top:3px">'+esc(tr('ui.exposes.col.site'))+': '+esc(e.site||'default')+' · '+esc(e.protocol||'http')
        +(b?' · DDNS: '+esc(b.items.map((a)=>a.type).join(' ')):'')+'</div>'
        +'<div class="actions" style="margin-top:6px">'
        +'<button class="btn btn-sm" data-st-detail="'+esc(e.name)+'">'+esc(tr('ui.ports.detail'))+'</button>'
        +'<button class="btn btn-sm btn-danger" data-st-stop="'+esc(e.name)+'">'+esc(tr('ui.ports.stop'))+'</button></div></div>';
    }).join('');
  }
  else{
    h+='<div class="tbl-wrap"><table><thead><tr><th>'+esc(tr('ui.exposes.col.port'))+'</th><th>'+esc(tr('ui.exposes.col.name'))+'</th><th>'+esc(tr('ui.exposes.col.mode'))+'</th><th>'+esc(tr('ui.exposes.col.provider'))+'</th><th>'+esc(tr('ui.exposes.col.protocol'))+'</th><th>'+esc(tr('ui.exposes.col.site'))+'</th><th>DDNS</th><th>'+esc(tr('ui.exposes.col.status'))+'</th><th></th></tr></thead><tbody>';
    h+=exs.map((e)=>'<tr><td class="mono">'+e.port+'</td><td class="mono">'+esc(e.name)+'</td><td>'+esc(modeOf(e)||'')+'</td>'
      +'<td>'+(e.provider?esc(e.provider):'<span class="badge authnone">'+esc(tr('ui.ports.authNoneBadge'))+'</span>')+'</td><td>'+esc(e.protocol||'http')+'</td><td>'+esc(e.site||'default')+'</td>'
      // DDNS 注册状态列（共享层 ddnsBadge 单源）
      +'<td>'+((()=>{const b=ddnsBadge(e.ddns);return b?'<span class="mono" style="font-size:11px">'+(b.profile?esc(b.profile)+': ':'')+b.items.map((a)=>'<span class="'+(a.ok?'ok':'bad')+'">'+esc(a.type)+'</span>').join(' ')+'</span>':'<span class="dim">-</span>';})())+'</td>'
      +'<td><span class="'+(e.running?'ok':'dim')+'">'+(e.running?'● '+esc(tr('ui.tunnelRunning')):esc(tr('ui.tunnelStopped')))+'</span></td>'
      +'<td><div class="actions"><button class="btn btn-sm" data-st-detail="'+esc(e.name)+'">'+esc(tr('ui.ports.detail'))+'</button>'
      +'<button class="btn btn-sm btn-danger" data-st-stop="'+esc(e.name)+'">'+esc(tr('ui.ports.stop'))+'</button></div></td></tr>').join('');
    h+='</tbody></table></div>';
  }
  c.innerHTML=h;
}
window.stopAllExposes=()=>{confirmDlg(tr('ui.ports.stopAll'),tr('ui.ports.stopAllHint'),tr('ui.ports.stopAll'),async()=>{try{await api('/api/expose-stop-all',{method:'POST',body:{}});toast(tr('ui.ports.stopped'));await loadLive();}catch(e){toast(String(e),true);}});};

// 同 ports.js：data 属性 + 事件委托（name 含引号不进 onclick JS 上下文）
document.addEventListener('click',(ev)=>{
  const el=ev.target instanceof Element?ev.target.closest('[data-st-detail],[data-st-stop]'):null;
  if(!el)return;
  if(el.dataset.stDetail!==undefined)showExposeDetail(el.dataset.stDetail);
  else if(el.dataset.stStop!==undefined)stopExpose(el.dataset.stStop);
});
