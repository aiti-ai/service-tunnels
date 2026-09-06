function renderExposes(){
  const c=document.getElementById('content');
  const exs=(state.live&&state.live.exposes)||[];
  let h='<div class="actions" style="margin-bottom:10px"><div class="spacer"></div>'
    +'<button class="btn btn-sm btn-danger" onclick="stopAllExposes()">'+esc(tr('ui.ports.stopAll'))+'</button></div>';
  if(!exs.length){h+='<div class="empty">'+esc(tr('ui.ports.none'))+'</div>';}
  else{
    h+='<table><thead><tr><th>port</th><th>name</th><th>mode</th><th>provider</th><th>protocol</th><th>site</th><th>ddns</th><th>status</th><th></th></tr></thead><tbody>';
    h+=exs.map((e)=>'<tr><td class="mono">'+e.port+'</td><td class="mono">'+esc(e.name)+'</td><td>'+esc(modeOf(e)||'')+'</td>'
      +'<td>'+(e.provider?esc(e.provider):'<span class="badge authnone">⚠ none</span>')+'</td><td>'+esc(e.protocol||'http')+'</td><td>'+esc(e.site||'default')+'</td>'
      // DDNS 注册状态列：profile + 每条记录（ok/失败）
      +'<td>'+(e.ddns&&e.ddns.actions&&e.ddns.actions.length
        ?'<span class="mono" style="font-size:11px">'+(e.ddns.profile?esc(e.ddns.profile)+': ':'')+e.ddns.actions.map((a)=>'<span class="'+(a.ok?'ok':'bad')+'">'+esc(a.type)+'</span>').join(' ')+'</span>'
        :'<span class="dim">-</span>')+'</td>'
      +'<td><span class="'+(e.running?'ok':'dim')+'">'+(e.running?'● '+esc(tr('ui.tunnelRunning')):esc(tr('ui.tunnelStopped')))+'</span></td>'
      +'<td><div class="actions"><button class="btn btn-sm" onclick="showExposeDetail(\''+e.name+'\')">'+esc(tr('ui.ports.detail'))+'</button>'
      +'<button class="btn btn-sm btn-danger" onclick="stopExpose(\''+e.name+'\')">'+esc(tr('ui.ports.stop'))+'</button></div></td></tr>').join('');
    h+='</tbody></table>';
  }
  c.innerHTML=h;
}
window.stopAllExposes=()=>{confirmDlg(tr('ui.ports.stopAll'),tr('ui.ports.stopAllHint'),tr('ui.ports.stopAll'),async()=>{try{await api('/api/expose-stop-all',{method:'POST',body:{}});toast(tr('ui.ports.stopped'));await loadLive();}catch(e){toast(String(e),true);}});};
