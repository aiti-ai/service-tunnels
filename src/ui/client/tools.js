function renderTools(){
  const c=document.getElementById('content');
  const tools=(state.status&&state.status.tools&&state.status.tools.list)||[];
  const allow=state.status&&state.status.tools?state.status.tools.allowDownload:null;
  let h='';
  if(allow!==null)h+='<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="toolDl" '+(allow?'checked':'')+'> '+esc(tr('ui.ports.allowDownload'))+'</label>';
  h+='<table><thead><tr><th>tool</th><th>path</th><th>source</th><th></th></tr></thead><tbody>'
    +tools.map((t)=>{
      const missing=!t.path;
      const dlBtn=missing
        ?'<button class="btn btn-sm" id="dl-'+esc(t.name)+'" onclick="downloadTool(\''+esc(t.name)+'\')"'+(allow===false?' disabled title="downloads disabled"':'')+'>'+esc(tr('ui.tools.download'))+'</button>'
        :'';
      return '<tr><td class="mono">'+esc(t.name)+'</td><td class="mono">'+esc(t.path||'-')+'</td><td><span class="badge'+(missing?' bad':'')+'">'+esc(t.source||'missing')+'</span></td><td>'+dlBtn+'</td></tr>';
    }).join('')
    +'</tbody></table>';
  c.innerHTML=h;
  const dl=document.getElementById('toolDl');
  if(dl)dl.onchange=()=>{api('/api/settings',{method:'POST',body:{allowToolDownload:dl.checked}}).catch((e)=>toast(String(e),true));};
}
window.downloadTool=async(name)=>{
  const btn=document.getElementById('dl-'+name);
  if(btn){btn.disabled=true;btn.textContent='…';}
  try{
    const r=await api('/api/tools-ensure',{method:'POST',body:{name}});
    toast(name+' → '+(r.path||'ok'));
    refreshAll();
  }catch(err){
    toast(name+': '+(err.message||'download failed'),true);
    if(btn){btn.disabled=false;btn.textContent='↻';}
  }
};
