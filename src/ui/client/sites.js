async function renderSites(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    const d=await api('/api/sites-list',{method:'GET'});
    const sites=d.sites||[];
    if(!sites.length){
      c.innerHTML='<div class="empty"><div style="font-size:24px;margin-bottom:6px">🏠</div>'+esc(tr('ui.sites.none'))+'<p class="hint" style="margin-top:6px">'+esc(tr('ui.sites.noneGuide'))+'</p></div>';
      return;
    }
    let h=sites.map((s)=>{
      const urls=[s.localUrl,s.baseUrl,s.domainUrl].filter(Boolean);
      return '<div class="card" style="padding:12px"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        +'<strong>'+esc(s.name)+'</strong>'+(s.provider?'<span class="badge">'+esc(s.provider)+'</span>':'')
        +'<span class="dim">'+esc(s.domain||'-')+'</span>'
        +'<span class="'+(s.running?'ok':'dim')+'">'+(s.running?esc(tr('ui.sites.running')):esc(tr('ui.sites.stopped')))+'</span>'
        +'<div class="spacer"></div>'
        +(urls.length?urls.map((u)=>'<span class="mono" style="font-size:10px">'+esc(u)+'</span>').join('<br>'):'')
        +'<button class="btn btn-sm" onclick="goSite(\''+esc(s.name)+'\',\'portal\')">'+esc(tr('ui.sites.block.users'))+'</button>'
        +(s.name!=='default'?'<button class="btn btn-sm btn-danger" onclick="removeSite(\''+esc(s.name)+'\')">'+esc(tr('ui.sites.del'))+'</button>':'')
        +'</div></div>';
    }).join('');
    h+='<div class="actions" style="margin-top:10px"><input id="ns-name" placeholder="'+esc(tr('ui.sites.newSite'))+'" style="max-width:130px"><button class="btn btn-sm btn-primary" onclick="addSite()">'+esc(tr('ui.btn.add'))+'</button></div>';
    c.innerHTML=h;
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}
window.addSite=async()=>{const name=document.getElementById('ns-name').value;if(!name)return;try{await api('/api/site-add',{method:'POST',body:{name}});toast(tr('ui.sites.added'));renderSites();}catch(e){toast(String(e),true);}};
window.removeSite=async(name)=>{confirmDlg(tr('ui.sites.removeConfirm'),esc(name),tr('ui.sites.remove'),async()=>{try{await api('/api/site-remove',{method:'POST',body:{name}});toast(tr('ui.sites.removed'));renderSites();}catch(e){toast(String(e),true);}});};
