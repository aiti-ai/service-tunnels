async function renderUsers(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    const d=await api('/api/user-summary',{method:'POST',body:{}});
    const rows=d.rows||[];
    const sites=[...new Set(rows.map((r)=>r.site))];
    const cols=[...new Set(rows.map((r)=>r.provider))];
    if(cols.includes('ssh'))cols.sort((a,b)=>(a==='ssh'?-1:b==='ssh'?1:a.localeCompare(b)));
    let h='<div class="section-label">'+esc(tr('ui.users.sitesTitle'))+'</div>';
    h+='<table><thead><tr><th>site</th>'+cols.map((p)=>'<th>'+esc(p)+'</th>').join('')+'</tr></thead><tbody>';
    h+=sites.map((s)=>{
      const cells=cols.map((p)=>{
        const r=rows.find((x)=>x.site===s&&x.provider===p);
        const n=r?r.count:0;const tot=r?r.totp:0;
        const extra=p==='ssh'?esc(tr('ui.users.keys'))+' ':(tot?'<span class="dim">· 2FA '+tot+'</span>':'');
        return '<td><div class="matrix-cell" onclick="goSite(\''+esc(s)+'\',\''+(p==='ssh'?'keys':'users')+'\')"><b>'+(p==='ssh'?n:n)+'</b><span class="dim" style="font-size:10px">'+extra+'</span></div></td>';
      });
      return '<tr><td><strong>'+esc(s)+'</strong></td>'+cells.join('')+'</tr>';
    }).join('');
    h+='</tbody></table>';
    h+='<div class="hint" style="margin-top:8px">'+esc(tr('ui.users.clickToEdit'))+'</div>';
    c.innerHTML=h;
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}
window.goSite=async(site,block)=>{
  const active=block||'users';
  openModal('<h3>'+esc(site)+'</h3>'
    +'<div class="tabs" style="margin:6px 0 10px">'
    +['users','keys','tokens'].map((b)=>'<button class="tab'+(b===active?' active':'')+'" onclick="goSite(\''+esc(site)+'\',\''+b+'\')">'+esc(tr('ui.sites.block.'+b))+'</button>').join('')
    +'</div><div id="siteBlock"></div>'
    +'<div class="actions" style="margin-top:12px"><div class="spacer"></div><button class="btn" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');
  await loadSiteBlock(site,active);
};
window.loadSiteBlock=async(site,block)=>{
  const el=document.getElementById('siteBlock');if(!el)return;
  el.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    if(block==='users'){
      const u=await api('/api/user-list?site='+encodeURIComponent(site)+'&provider=all',{method:'GET'});
      el.innerHTML=renderUsersTable(site,(u.users||[]));
    }else if(block==='keys'){
      const k=await api('/api/ssh-keys?site='+encodeURIComponent(site),{method:'GET'});
      el.innerHTML=renderKeys(site,k.keys||[]);
    }else if(block==='tokens'){
      const t=await api('/api/token-list?site='+encodeURIComponent(site),{method:'GET'});
      el.innerHTML=renderTokensTable(site,t.tokens||[]);
    }
  }catch(e){el.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
};
function renderUsersTable(site,users){
  const providers=(state.status&&state.status.userManagers)||[];
  const totps=(state.status&&state.status.totpProviders)||[];
  const bios=(state.status&&state.status.biometricProviders)||[];
  let h='<div class="actions" style="margin:8px 0;flex-wrap:wrap"><input id="nu-name" placeholder="'+esc(tr('ui.promptUsername'))+'" style="max-width:110px"><input id="nu-pass" type="password" placeholder="'+esc(tr('ui.promptPassword'))+'" style="max-width:110px">'
    +'<select id="nu-provider" style="max-width:130px">'+providers.map((p)=>'<option value="'+esc(p)+'">'+esc(p)+'</option>').join('')+'</select>'
    +'<button class="btn btn-sm btn-primary" onclick="addUser(\''+site+'\')">'+esc(tr('ui.btn.addUser'))+'</button></div>';
    h+='<table><thead><tr><th>'+esc(tr('ui.promptUsername'))+'</th><th>provider</th><th>2FA</th><th>bio</th><th></th></tr></thead><tbody>'
    +(users.length?users.map((u)=>{
      const pv=esc(u.provider||'');
      const bio=u.biometrics||{};
      const bioCell=bios.includes(u.provider)
        ?(bio.face?'<span class="ok" title="face">●</span>':'<span class="dim" title="face">○</span>')+' '
         +(bio.voice?'<span class="ok" title="voice">●</span>':'<span class="dim" title="voice">○</span>')
        :'';
      const bioBtns=bios.includes(u.provider)
        ?((bio.face
            ?'<button class="btn btn-sm" onclick="bioDisable(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\',\'face\')">face off</button>'
            :'<button class="btn btn-sm" onclick="bioEnroll(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\',\'face\')">face on</button>')
          +(bio.voice
            ?'<button class="btn btn-sm" onclick="bioDisable(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\',\'voice\')">voice off</button>'
            :'<button class="btn btn-sm" onclick="bioEnroll(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\',\'voice\')">voice on</button>'))
        :'';
      return '<tr><td>'+esc(u.name)+'</td><td><span class="badge">'+pv+'</span></td><td>'+(u.totp?'<span class="ok">●</span>':'<span class="dim">○</span>')+'</td><td>'+bioCell+'</td>'
      +'<td><div class="actions"><button class="btn btn-sm" onclick="userPass(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\')">'+esc(tr('ui.btn.setPassword'))+'</button>'
      +(totps.includes(u.provider)?(u.totp
        ?'<button class="btn btn-sm" onclick="totpDisable(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\')">2fa off</button>'
        :'<button class="btn btn-sm" onclick="totpEnroll(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\')">2fa on</button>'):'')
      +bioBtns
      +'<button class="btn btn-sm btn-danger" onclick="userRemove(\''+site+'\',\''+pv+'\',\''+esc(u.name)+'\')">'+esc(tr('ui.ssh.removeBtn'))+'</button></div></td></tr>';
    }).join('')
      :'<tr><td colspan="5" class="muted">'+esc(tr('ui.empty.users'))+'</td></tr>')
    +'</tbody></table>';
  return h;
}
function renderTokensTable(site,tokens){
  let h='<div class="actions" style="margin:8px 0;flex-wrap:wrap"><input id="tok-desc" placeholder="'+esc(tr('ui.tokens.desc'))+'" style="max-width:160px"><select id="tok-exp"><option value="never">never</option><option value="+7d">+7d</option><option value="+30d">+30d</option></select>'
    +'<button class="btn btn-sm btn-primary" onclick="createTokenFor(\''+site+'\')">create</button></div>';
  h+='<table><thead><tr><th>id</th><th>description</th><th>created</th><th>expires</th><th></th></tr></thead><tbody>'
    +(tokens.length?tokens.map((t)=>'<tr><td class="mono">'+esc(t.id.slice(0,8))+'…</td><td>'+esc(t.description||'-')+'</td><td class="dim">'+new Date(t.createdAt).toLocaleString()+'</td><td>'+(t.expiresAt?new Date(t.expiresAt).toLocaleString():'<span class="badge">never</span>')+'</td>'
      +'<td><button class="btn btn-sm btn-danger" onclick="revokeToken(\''+site+'\',\''+t.id+'\')">revoke</button></td></tr>').join('')
      :'<tr><td colspan="5" class="muted">'+esc(tr('ui.empty.tokens'))+'</td></tr>')
    +'</tbody></table>';
  return h;
}
function renderKeys(site,keys){
  let h='<div class="actions" style="margin:8px 0"><button class="btn btn-sm btn-primary" onclick="sshGen(\''+site+'\')">generate</button></div>';
  h+='<textarea id="ssh-pub" rows="2" placeholder="ssh-ed25519 AAAA… user@host" style="margin:4px 0"></textarea>'
    +'<button class="btn btn-sm btn-primary" onclick="sshAdd(\''+site+'\')">'+esc(tr('ui.ssh.addKey'))+'</button>';
  h+='<table style="margin-top:8px"><thead><tr><th>alias</th><th>fingerprint</th><th></th></tr></thead><tbody>'
    +(keys.length?keys.map((k)=>'<tr><td class="mono">'+esc(k.alias||k.comment||'')+'</td><td class="mono">'+esc(k.fingerprint)+'</td>'
      +'<td><button class="btn btn-sm btn-danger" onclick="sshRevoke(\''+site+'\',\''+esc(k.fingerprint)+'\')">'+esc(tr('ui.ssh.removeBtn'))+'</button></td></tr>').join('')
      :'<tr><td colspan="3" class="muted">'+esc(tr('ui.ssh.empty'))+'</td></tr>')
    +'</tbody></table>';
  return h;
}
window.addUser=async(site)=>{const name=document.getElementById('nu-name').value,pass=document.getElementById('nu-pass').value;const provider=document.getElementById('nu-provider')?document.getElementById('nu-provider').value:undefined;if(!name||!pass)return;try{await api('/api/user-add',{method:'POST',body:{name,password:pass,site,provider}});toast('added');goSite(site,'users');}catch(e){toast(String(e),true);}};
window.createTokenFor=async(site)=>{const description=document.getElementById('tok-desc').value;const expiresAt=document.getElementById('tok-exp').value;try{const d=await api('/api/token-create',{method:'POST',body:{description,expiresAt,site}});const tok=d.tokens&&d.tokens[0]&&d.tokens[0].token&&d.tokens[0].token.token;if(tok)openModal('<h3>'+esc(tr('ui.tokens.created'))+'</h3><div class="muted">'+esc(tr('ui.tokens.once'))+'</div><textarea readonly rows="3">'+esc(tok)+'</textarea><div class="actions" style="margin-top:10px"><button class="btn btn-sm btn-primary" onclick="copyText(document.querySelector(\'#modalRoot textarea\').value).then(()=>toast(\'copied\'))">copy</button><button class="btn btn-sm" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');loadSiteBlock(site,'tokens');}catch(e){toast(String(e),true);}};
window.userPass=async(site,provider,name)=>{const p=prompt('new password');if(!p)return;try{await api('/api/user-set-password',{method:'POST',body:{name,password:p,site,provider}});toast('ok');}catch(e){toast(String(e),true);}};
window.userRemove=async(site,provider,name)=>{confirmDlg('remove user',esc(name),'remove',async()=>{try{await api('/api/user-remove',{method:'POST',body:{name,site,provider}});toast('removed');goSite(site,provider);}catch(e){toast(String(e),true);}});};
window.totpEnroll=async(site,provider,name)=>{try{const d=await api('/api/totp-enroll',{method:'POST',body:{name,site,provider}});openModal('<h3>2FA · '+esc(name)+'</h3><div class="muted" style="word-break:break-all">'+esc(d.otpauthUrl||'')+'</div><div class="hint">'+esc(d.secret||'')+'</div><div class="actions" style="margin-top:10px"><input id="totp-code" placeholder="6-digit" style="max-width:100px"><button class="btn btn-sm btn-primary" onclick="totpActivate(\''+site+'\',\''+provider+'\',\''+esc(name)+'\')">activate</button></div>');}catch(e){toast(String(e),true);}};
window.totpActivate=async(site,provider,name)=>{const code=document.getElementById('totp-code').value;if(!/^\d{6}$/.test(code)){toast('6-digit code');return;}try{const d=await api('/api/totp-activate',{method:'POST',body:{name,code,site,provider}});toast(d.activated?'activated':'wrong code');closeModal();}catch(e){toast(String(e),true);}};
window.totpDisable=async(site,provider,name)=>{try{await api('/api/totp-disable',{method:'POST',body:{name,site,provider}});toast('2fa off');}catch(e){toast(String(e),true);}};
window.bioEnroll=async(site,provider,name,method)=>{try{const d=await api('/api/biometric-enroll-ticket',{method:'POST',body:{name,method,site,provider}});if(d.url){window.open(d.url,'_blank');toast(tr('ui.biometricEnrollTicket',{method}));}else{toast(String(d),true);}}catch(e){toast(String(e),true);}};
window.bioDisable=async(site,provider,name,method)=>{try{if(!confirm(tr('ui.confirmDisableBiometric',{name,method})))return;await api('/api/biometric-disable',{method:'POST',body:{name,method,site,provider}});toast(method+' off');loadSiteBlock(site,'users');}catch(e){toast(String(e),true);}};
window.sshAdd=async(site)=>{const pub=document.getElementById('ssh-pub').value;if(!pub)return;try{await api('/api/ssh-keys',{method:'POST',body:{action:'add',site,publicKey:pub}});toast('added');goSite(site,'ssh');}catch(e){toast(String(e),true);}};
window.sshRevoke=async(site,fp)=>{confirmDlg('revoke key',esc(fp),'revoke',async()=>{try{await api('/api/ssh-keys',{method:'POST',body:{action:'revoke',site,fingerprint:fp}});toast('revoked');goSite(site,'ssh');}catch(e){toast(String(e),true);}});};
window.sshGen=async(site)=>{try{const d=await api('/api/ssh-keys',{method:'POST',body:{action:'generate',site,type:'ed25519'}});const k=Array.isArray(d)?d[0]:d;openModal('<h3>'+esc(tr('ui.ssh.privateKeyTitle'))+'</h3><div class="muted">'+esc(tr('ui.ssh.privateKeyHint'))+'</div><textarea readonly rows="10" id="ssh-priv">'+esc(k.privateKey)+'</textarea><div class="actions" style="margin-top:10px"><button class="btn btn-sm btn-primary" onclick="copyPriv()">copy</button><button class="btn btn-sm" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');}catch(e){toast(String(e),true);}};
window.copyPriv=()=>{const t=document.getElementById('ssh-priv').value;copyText(t).then(()=>toast('copied')).catch(()=>toast('copy failed',true));};
