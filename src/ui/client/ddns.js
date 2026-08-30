/** DDNS registration tab — provider profiles (credentials), profiles
 *  (provider+domain targets) and registration entries (portmap/tunnel →
 *  A/TXT/CNAME auto-registration). Zero-dependency, like the other tabs. */

async function renderDdns(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    const d=await api('/api/ddns-registry',{method:'GET'});
    const pps=d.providerProfiles||{};
    const profs=d.profiles||{};
    const entries=d.entries||[];

    let h='<div class="card" style="padding:12px;margin-bottom:10px">'
      +'<div class="section-label">Provider Profiles（凭据）</div>'
      +'<table><tbody>'
      +Object.keys(pps).map((k)=>'<tr><td class="mono">'+esc(k)+'</td><td>'+esc(pps[k].provider||'')+'</td>'
        +'<td><button data-del-pp="'+esc(k)+'">删除</button></td></tr>').join('')
      +'</tbody></table>'
      +'<div style="margin-top:6px"><input id="ddns-pp-name" placeholder="profile名" style="width:110px"> '
      +'<input id="ddns-pp-provider" placeholder="provider" style="width:110px"> '
      +'<input id="ddns-pp-token" type="password" placeholder="token" style="width:160px"> '
      +'<button id="ddns-pp-add">+ 添加</button></div></div>';

    h+='<div class="card" style="padding:12px;margin-bottom:10px">'
      +'<div class="section-label">Profiles（provider+域名目标）</div>'
      +'<table><tbody>'
      +Object.keys(profs).map((k)=>'<tr><td class="mono">'+esc(k)+'</td>'
        +'<td>pp: '+esc(profs[k].providerProfile||'-')+'</td>'
        +'<td class="mono">'+esc(profs[k].zone||'')+'</td>'
        +'<td class="mono">'+esc(profs[k].record||'')+'</td>'
        +'<td class="mono">txt: '+esc(profs[k].txtName||'-')+'</td>'
        +'<td><button data-del-pf="'+esc(k)+'">删除</button></td></tr>').join('')
      +'</tbody></table>'
      +'<div style="margin-top:6px"><input id="ddns-pf-name" placeholder="profile名" style="width:100px"> '
      +'<input id="ddns-pf-pp" placeholder="providerProfile" style="width:110px"> '
      +'<input id="ddns-pf-zone" placeholder="zone" style="width:130px"> '
      +'<input id="ddns-pf-record" placeholder="record(CNAME/A)" style="width:150px"> '
      +'<input id="ddns-pf-txt" placeholder="txtName" style="width:150px"> '
      +'<button id="ddns-pf-add">+ 添加</button></div></div>';

    h+='<div class="card" style="padding:12px">'
      +'<div class="section-label">Registration Entries（portmap/tunnel → 自动注册）</div>'
      +'<table><tbody>'
      +entries.map((e,i)=>'<tr><td class="mono">'+esc(e.name)+'</td>'
        +'<td>'+esc(e.kind||'')+'</td>'
        +'<td>'+(e.profile?'profile: '+esc(e.profile):(e.provider?'provider: '+esc(e.provider):(e.providerProfile?'pp: '+esc(e.providerProfile):'-')))+'</td>'
        +'<td>'+(e.zone?esc(e.zone):'-')+'</td>'
        +'<td class="mono">'+esc(e.record||'-')+'</td>'
        +'<td class="mono">txt: '+esc(e.txtName||'-')+'</td>'
        +'<td>follow: '+esc(e.followTunnel||'-')+'</td>'
        +'<td>'+(e.ip?'A ':'')+(e.txt?'TXT(ip:port) ':'')+(e.cname?'CNAME ':'')+(e.txtUrl?'TXT(url) ':'')+'</td>'
        +'<td><button data-del-entry="'+i+'">删除</button></td></tr>').join('')
      +'</tbody></table>'
      // 添加表单：profile 引用（快捷）
      +'<div class="section-label" style="margin-top:10px">添加（profile 引用）</div>'
      +'<div style="margin-top:4px"><input id="ddns-e-name" placeholder="条目名" style="width:90px"> '
      +'<input id="ddns-e-profile" placeholder="profile" style="width:100px"> '
      +'<select id="ddns-e-kind"><option value="tunnel">tunnel</option><option value="portmap">portmap</option></select> '
      +'<input id="ddns-e-follow" placeholder="followTunnel" style="width:110px"> '
      +'<label><input type="checkbox" id="ddns-e-cname"> CNAME</label> '
      +'<label><input type="checkbox" id="ddns-e-txturl"> TXT(url)</label> '
      +'<label><input type="checkbox" id="ddns-e-ip"> A</label> '
      +'<label><input type="checkbox" id="ddns-e-txt"> TXT(ip:port)</label> '
      +'<button id="ddns-e-add">+ 添加</button></div>'
      // 添加表单：完整信息直填（不依赖 profile）
      +'<div class="section-label" style="margin-top:10px">添加（完整信息，单独注册）</div>'
      +'<div style="margin-top:4px"><input id="ddns-e2-name" placeholder="条目名" style="width:90px"> '
      +'<input id="ddns-e2-provider" placeholder="provider" style="width:110px"> '
      +'<input id="ddns-e2-token" type="password" placeholder="token" style="width:140px"> '
      +'<input id="ddns-e2-zone" placeholder="zone" style="width:130px"> '
      +'<input id="ddns-e2-record" placeholder="record" style="width:140px"> '
      +'<input id="ddns-e2-txtname" placeholder="txtName" style="width:130px"> '
      +'<select id="ddns-e2-kind"><option value="tunnel">tunnel</option><option value="portmap">portmap</option></select> '
      +'<input id="ddns-e2-follow" placeholder="followTunnel" style="width:110px"> '
      +'<label><input type="checkbox" id="ddns-e2-cname"> CNAME</label> '
      +'<label><input type="checkbox" id="ddns-e2-txturl"> TXT(url)</label> '
      +'<label><input type="checkbox" id="ddns-e2-ip"> A</label> '
      +'<label><input type="checkbox" id="ddns-e2-txt"> TXT(ip:port)</label> '
      +'<button id="ddns-e2-add">+ 添加</button></div></div>';
    c.innerHTML=h;

    c.querySelectorAll('[data-del-pp]').forEach((b)=>b.onclick=async()=>{
      delete pps[b.dataset.delPp]; await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    });
    c.querySelectorAll('[data-del-pf]').forEach((b)=>b.onclick=async()=>{
      delete profs[b.dataset.delPf]; await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    });
    c.querySelectorAll('[data-del-entry]').forEach((b)=>b.onclick=async()=>{
      entries.splice(Number(b.dataset.delEntry),1); await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    });
    document.getElementById('ddns-pp-add').onclick=async()=>{
      pps[document.getElementById('ddns-pp-name').value]={
        provider:document.getElementById('ddns-pp-provider').value,
        token:document.getElementById('ddns-pp-token').value,
      };
      await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    };
    document.getElementById('ddns-pf-add').onclick=async()=>{
      profs[document.getElementById('ddns-pf-name').value]={
        providerProfile:document.getElementById('ddns-pf-pp').value,
        zone:document.getElementById('ddns-pf-zone').value,
        record:document.getElementById('ddns-pf-record').value||undefined,
        txtName:document.getElementById('ddns-pf-txt').value||undefined,
      };
      await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    };
    document.getElementById('ddns-e-add').onclick=async()=>{
      entries.push({
        name:document.getElementById('ddns-e-name').value,
        profile:document.getElementById('ddns-e-profile').value||undefined,
        kind:document.getElementById('ddns-e-kind').value,
        followTunnel:document.getElementById('ddns-e-follow').value||undefined,
        cname:document.getElementById('ddns-e-cname').checked,
        txtUrl:document.getElementById('ddns-e-txturl').checked,
        ip:document.getElementById('ddns-e-ip').checked,
        txt:document.getElementById('ddns-e-txt').checked,
      });
      await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    };
    document.getElementById('ddns-e2-add').onclick=async()=>{
      entries.push({
        name:document.getElementById('ddns-e2-name').value,
        provider:document.getElementById('ddns-e2-provider').value||undefined,
        token:document.getElementById('ddns-e2-token').value||undefined,
        zone:document.getElementById('ddns-e2-zone').value||undefined,
        record:document.getElementById('ddns-e2-record').value||undefined,
        txtName:document.getElementById('ddns-e2-txtname').value||undefined,
        kind:document.getElementById('ddns-e2-kind').value,
        followTunnel:document.getElementById('ddns-e2-follow').value||undefined,
        cname:document.getElementById('ddns-e2-cname').checked,
        txtUrl:document.getElementById('ddns-e2-txturl').checked,
        ip:document.getElementById('ddns-e2-ip').checked,
        txt:document.getElementById('ddns-e2-txt').checked,
      });
      await saveDdns({providerProfiles:pps,profiles:profs,entries}); renderDdns();
    };
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}

async function saveDdns(cfg){
  await api('/api/ddns-registry',{method:'POST',body:JSON.stringify(cfg)});
  toast('ddns 配置已保存');
}
