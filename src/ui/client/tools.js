function renderTools(){
  const c=document.getElementById('content');
  const tools=(state.status&&state.status.tools&&state.status.tools.list)||[];
  const allow=state.status&&state.status.tools?state.status.tools.allowDownload:null;
  let h='';
  if(allow!==null)h+='<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="toolDl" '+(allow?'checked':'')+'> '+esc(tr('ui.ports.allowDownload'))+'</label>';
  h+='<div class="tbl-wrap"><table><thead><tr><th>'+esc(tr('ui.tools.col.tool'))+'</th><th>'+esc(tr('ui.tools.col.path'))+'</th><th>'+esc(tr('ui.tools.col.source'))+'</th><th></th></tr></thead><tbody>'
    +tools.map((t)=>{
      const missing=!t.path;
      const dlBtn=missing
        ?'<button class="btn btn-sm" id="dl-'+esc(t.name)+'" onclick="downloadTool(\''+esc(t.name)+'\')"'+(allow===false?' disabled title="'+esc(tr('ui.tools.disabledTitle'))+'"':'')+'>'+esc(tr('ui.tools.download'))+'</button>'
        :'';
      return '<tr><td class="mono">'+esc(t.name)+'</td><td class="mono">'+esc(t.path||'-')+'</td><td><span class="badge'+(missing?' bad':'')+'">'+esc(t.source||tr('ui.tools.missing'))+'</span></td><td>'+dlBtn+'</td></tr>';
    }).join('')
    +'</tbody></table></div>';
  c.innerHTML=h;
  const dl=document.getElementById('toolDl');
  if(dl)dl.onchange=()=>{api('/api/settings',{method:'POST',body:{allowToolDownload:dl.checked}}).catch((e)=>toast(String(e),true));};
}
window.downloadTool=async(name)=>{
  const btn=document.getElementById('dl-'+name);
  if(btn){btn.disabled=true;btn.textContent='…';}
  // npm install / 工具下载耗时较长（5min 上限），失败信息持久显示（不随轮询消失）
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),5*60*1000);
  try{
    const res=await fetch('/api/tools-ensure',{method:'POST',signal:ctrl.signal,
      headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken()},
      body:JSON.stringify({name})});
    const d=await res.json().catch(()=>({}));
    if(!res.ok)throw new Error(d.error||('HTTP '+res.status));
    toast(name+' ✓ '+(d.path||''),false,10000);
    refreshAll();
  }catch(err){
    // 失败信息持久（12000ms）——轮询不会清 modalRoot，但 toast 会自动消失，
    // 长下载失败后用户必须能看到原因
    const msg=name+': '+(err.message||'download failed');
    toast(msg,true,12000);
    if(btn){btn.disabled=false;btn.textContent=tr('ui.tools.download');}
  }finally{clearTimeout(timer);}
};
