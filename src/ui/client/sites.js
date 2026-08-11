async function renderSites(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    const d=await api('/api/sites-list',{method:'GET'});
    const sites=d.sites||[];
    let h=sites.map((s)=>{
      const urls=[s.localUrl,s.baseUrl,s.domainUrl].filter(Boolean);
      return '<div class="card" style="padding:12px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        +'<strong>'+esc(s.name)+'</strong>'+(s.provider?'<span class="badge">'+esc(s.provider)+'</span>':'')
        +'<span class="dim">'+esc(s.domain||'-')+'</span>'
        +'<span class="'+(s.running?'ok':'dim')+'">'+(s.running?'● running':'○ stopped')+'</span>'
        +'<div class="spacer"></div>'
        +(urls.length?urls.map((u)=>'<span class="mono" style="font-size:10px">'+esc(u)+'</span>').join('<br>'):'')
        +'<button class="btn btn-sm" onclick="goSite(\''+esc(s.name)+'\',\'portal\')">users</button>'
        +(s.name!=='default'?'<button class="btn btn-sm btn-danger" onclick="removeSite(\''+esc(s.name)+'\')">del</button>':'')
        +'</div></div>';
    }).join('');
    h+='<div class="actions" style="margin-top:10px"><input id="ns-name" placeholder="new site" style="max-width:130px"><button class="btn btn-sm btn-primary" onclick="addSite()">add</button></div>';
    c.innerHTML=h;
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}
window.addSite=async()=>{const name=document.getElementById('ns-name').value;if(!name)return;try{await api('/api/site-add',{method:'POST',body:{name}});toast('added');renderSites();}catch(e){toast(String(e),true);}};
window.removeSite=async(name)=>{confirmDlg('remove site',esc(name),'remove',async()=>{try{await api('/api/site-remove',{method:'POST',body:{name}});toast('removed');renderSites();}catch(e){toast(String(e),true);}});};
