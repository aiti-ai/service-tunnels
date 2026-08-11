function renderTools(){
  const c=document.getElementById('content');
  const tools=(state.status&&state.status.tools&&state.status.tools.list)||[];
  const allow=state.status&&state.status.tools?state.status.tools.allowDownload:null;
  let h='';
  if(allow!==null)h+='<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="toolDl" '+(allow?'checked':'')+'> '+esc(tr('ui.ports.allowDownload'))+'</label>';
  h+='<table><thead><tr><th>tool</th><th>path</th><th>source</th></tr></thead><tbody>'
    +tools.map((t)=>'<tr><td class="mono">'+esc(t.name)+'</td><td class="mono">'+esc(t.path||'-')+'</td><td><span class="badge">'+esc(t.source||'missing')+'</span></td></tr>').join('')
    +'</tbody></table>';
  c.innerHTML=h;
  const dl=document.getElementById('toolDl');
  if(dl)dl.onchange=()=>{api('/api/settings',{method:'POST',body:{allowToolDownload:dl.checked}}).catch((e)=>toast(String(e),true));};
}
