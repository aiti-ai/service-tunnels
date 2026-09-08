async function renderTokens(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    const site=document.getElementById('tok-site')?document.getElementById('tok-site').value:'default';
    const d=await api('/api/token-list?site='+encodeURIComponent(site),{method:'GET'});
    const tokens=d.tokens||[];
    const sites=(state.status&&state.status.sites||[]).map((x)=>x.name);
    let h='<div class="actions" style="margin-bottom:10px"><select id="tok-site" style="max-width:160px" onchange="renderTokens()">'+(['default'].concat(sites.filter((x)=>x!=='default'))).map((x)=>'<option value="'+x+'"'+(x===site?' selected':'')+'>'+x+'</option>').join('')+'</select>'
      +'<input id="tok-desc" placeholder="'+esc(tr('ui.tokens.desc'))+'" style="max-width:180px"><select id="tok-exp"><option value="never">'+esc(tr('ui.tokens.never'))+'</option><option value="+7d">'+esc(tr('ui.tokens.7d'))+'</option><option value="+30d">'+esc(tr('ui.tokens.30d'))+'</option></select>'
      +'<button class="btn btn-sm btn-primary" onclick="createToken()">'+esc(tr('ui.tokens.create'))+'</button><div class="spacer"></div></div>';
    if(!tokens.length)h+='<div class="empty" style="padding:18px"><div style="font-size:22px;margin-bottom:4px">🔑</div>'+esc(tr('ui.empty.tokens'))+'</div>';
    h+='<div class="tbl-wrap"'+(tokens.length?'':' style="display:none"')+'><table><thead><tr><th>'+esc(tr('ui.tokens.col.id'))+'</th><th>'+esc(tr('ui.tokens.col.desc'))+'</th><th>'+esc(tr('ui.tokens.col.created'))+'</th><th>'+esc(tr('ui.tokens.col.expires'))+'</th><th></th></tr></thead><tbody>'
      +(tokens.length?tokens.map((t)=>'<tr><td class="mono">'+esc(t.id.slice(0,8))+'…</td><td>'+esc(t.description||'-')+'</td><td class="dim">'+new Date(t.createdAt).toLocaleString()+'</td><td>'+(t.expiresAt?new Date(t.expiresAt).toLocaleString():'<span class="badge">'+esc(tr('ui.tokens.never'))+'</span>')+'</td>'
        +'<td><button class="btn btn-sm btn-danger" onclick="revokeToken(\''+site+'\',\''+t.id+'\')">'+esc(tr('ui.tokens.revoke'))+'</button></td></tr>').join('')
        :'<tr><td colspan="5" class="muted">'+esc(tr('ui.empty.tokens'))+'</td></tr>')
      +'</tbody></table></div>';
    c.innerHTML=h;
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}
window.createToken=async()=>{
  const site=document.getElementById('tok-site').value;
  const description=document.getElementById('tok-desc').value;
  const expiresAt=document.getElementById('tok-exp').value;
  try{const d=await api('/api/token-create',{method:'POST',body:{description,expiresAt,site}});
    const tok=d.tokens&&d.tokens[0]&&d.tokens[0].token&&d.tokens[0].token.token;
    if(tok)openModal('<h3>'+esc(tr('ui.tokens.created'))+'</h3><div class="muted" style="word-break:break-all">'+esc(tr('ui.tokens.once'))+'</div><textarea readonly rows="3">'+esc(tok)+'</textarea><div class="actions" style="margin-top:10px"><button class="btn btn-sm btn-primary" onclick="copyText(document.querySelector(\'#modalRoot textarea\').value).then(()=>toast(tr(\'ui.copied\')))">'+esc(tr('ui.copy'))+'</button><button class="btn btn-sm" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');
    renderTokens();
  }catch(e){toast(String(e),true);}
};
window.revokeToken=async(site,id)=>{confirmDlg(tr('ui.tokens.revokeConfirm'),esc(id.slice(0,8))+'…',tr('ui.tokens.revoke'),async()=>{try{await api('/api/token-revoke',{method:'POST',body:{id,site}});toast(tr('ui.tokens.revoked'));renderTokens();}catch(e){toast(String(e),true);}});};
