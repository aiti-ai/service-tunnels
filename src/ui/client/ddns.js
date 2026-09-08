/** DDNS tab（L-e 重做）— provider 凭据 / profiles / 注册条目 三卡片。
 *  provider 枚举走 /api/ddns-providers（120 家下拉）；token 遮蔽 + 👁 切换；
 *  必填/格式校验行内报错；空态引导；文案全量 ui.ddns.*。零依赖，同其他 tab。 */

async function renderDdns(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    if(!state.ddnsProviders){
      try{const p=await api('/api/ddns-providers');state.ddnsProviders=p.providers||[];}
      catch(e){state.ddnsProviders=[];}
    }
    const d=await api('/api/ddns-registry',{method:'GET'});
    const pps=d.providerProfiles||{};
    const profs=d.profiles||{};
    const entries=d.entries||[];
    let h='';
    // 空态引导（L-k）：先凭据 → 再 profile → exposes 表单绑定自动注册
    if(!Object.keys(pps).length&&!Object.keys(profs).length&&!entries.length){
      h+='<div class="empty"><div style="font-size:26px;margin-bottom:6px">🌐</div>'
        +'<p>'+esc(tr('ui.ddns.emptyTitle'))+'</p>'
        +'<p class="hint" style="margin-top:6px;line-height:1.8">'+esc(tr('ui.ddns.emptyGuide'))+'</p></div>';
    }
    // ── 卡片 1：provider 凭据 ──
    h+='<div class="card" style="padding:12px;margin-bottom:10px">'
      +'<div class="section-label">'+esc(tr('ui.ddns.pp.title'))+'</div>'
      +(Object.keys(pps).length
        ?'<div class="tbl-wrap"><table><thead><tr><th>'+esc(tr('ui.ddns.pp.name'))+'</th><th>'+esc(tr('ui.ddns.pp.provider'))+'</th><th>token</th><th></th></tr></thead><tbody>'
          +Object.keys(pps).map((k)=>'<tr><td class="mono">'+esc(k)+'</td><td>'+esc(pps[k].provider||'')+'</td>'
            +'<td class="mono"><span class="ddns-tok" data-tok="'+esc(pps[k].token||'')+'">••••••••</span> '
            +'<button class="icon-btn" title="'+esc(tr('ui.ddns.reveal'))+'" onclick="toggleToken(this)" aria-label="'+esc(tr('ui.ddns.reveal'))+'">👁</button></td>'
            +'<td><button class="btn btn-sm btn-danger" data-del-pp="'+esc(k)+'">'+esc(tr('ui.ddns.del'))+'</button></td></tr>').join('')
          +'</tbody></table></div>'
        :'<div class="muted">'+esc(tr('ui.ddns.pp.empty'))+'</div>')
      +'<div class="form-grid" style="margin-top:8px">'
      +'<div><label>'+esc(tr('ui.ddns.pp.name'))+' *</label><input id="ddns-pp-name" placeholder="cloudflare-main"></div>'
      +'<div><label>'+esc(tr('ui.ddns.pp.provider'))+' *</label><select id="ddns-pp-provider">'+ddnsProviderOptions()+'</select></div>'
      +'<div><label>token *</label><input id="ddns-pp-token" type="password" autocomplete="off" style="padding-right:26px"><button class="icon-btn ddns-eye" onclick="toggleTokenInput(this)" title="'+esc(tr('ui.ddns.reveal'))+'">👁</button></div>'
      +'</div><div class="bad hint" id="ddns-pp-err" style="display:none"></div>'
      +'<div style="margin-top:6px"><button class="btn btn-sm btn-primary" id="ddns-pp-add">'+esc(tr('ui.ddns.add'))+'</button></div></div>';
    // ── 卡片 2：profiles（provider+域名目标）──
    h+='<div class="card" style="padding:12px;margin-bottom:10px">'
      +'<div class="section-label">'+esc(tr('ui.ddns.pf.title'))+'</div>'
      +(Object.keys(profs).length
        ?'<div class="tbl-wrap"><table><thead><tr><th>'+esc(tr('ui.ddns.pf.name'))+'</th><th>'+esc(tr('ui.ddns.pp.name'))+'</th><th>zone</th><th>record</th><th>txtName</th><th></th></tr></thead><tbody>'
          +Object.keys(profs).map((k)=>'<tr><td class="mono">'+esc(k)+'</td>'
            +'<td class="mono">'+esc(profs[k].providerProfile||'-')+'</td>'
            +'<td class="mono">'+esc(profs[k].zone||'')+'</td>'
            +'<td class="mono">'+esc(profs[k].record||'-')+'</td>'
            +'<td class="mono">'+esc(profs[k].txtName||'-')+'</td>'
            +'<td><button class="btn btn-sm btn-danger" data-del-pf="'+esc(k)+'">'+esc(tr('ui.ddns.del'))+'</button></td></tr>').join('')
          +'</tbody></table></div>'
        :'<div class="muted">'+esc(tr('ui.ddns.pf.empty'))+'</div>')
      +'<div class="form-grid" style="margin-top:8px">'
      +'<div><label>'+esc(tr('ui.ddns.pf.name'))+' *</label><input id="ddns-pf-name" placeholder="home-tunnel"></div>'
      +'<div><label>'+esc(tr('ui.ddns.pf.pp'))+' *</label><select id="ddns-pf-pp">'+Object.keys(pps).map((k)=>'<option value="'+esc(k)+'">'+esc(k)+'</option>').join('')+'</select></div>'
      +'<div><label>zone *</label><input id="ddns-pf-zone" placeholder="example.com"></div>'
      +'<div><label>record</label><input id="ddns-pf-record" placeholder="CNAME / A"></div>'
      +'<div><label>txtName</label><input id="ddns-pf-txt" placeholder="_st.home.example.com"></div>'
      +'</div><div class="bad hint" id="ddns-pf-err" style="display:none"></div>'
      +'<div style="margin-top:6px"><button class="btn btn-sm btn-primary" id="ddns-pf-add">'+esc(tr('ui.ddns.add'))+'</button></div></div>';
    // ── 卡片 3：注册条目 ──
    const kindSel=(id)=>'<select id="'+id+'"><option value="tunnel">tunnel</option><option value="portmap">portmap</option><option value="ipv6">ipv6</option></select>';
    const flagBoxes=(p)=>['cname:CNAME','txtUrl:TXT(url)','ip:A','aaaa:AAAA','txt:TXT(ip:port)'].map((f)=>{const [k,l]=f.split(':');return '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px"><input type="checkbox" id="ddns-'+p+'-'+k+'"> '+l+'</label>';}).join('');
    h+='<div class="card" style="padding:12px">'
      +'<div class="section-label">'+esc(tr('ui.ddns.e.title'))+'</div>'
      +(entries.length
        ?'<div class="tbl-wrap"><table><thead><tr><th>'+esc(tr('ui.ddns.e.name'))+'</th><th>kind</th><th>'+esc(tr('ui.ddns.e.target'))+'</th><th>zone</th><th>record</th><th>txtName</th><th>follow</th><th>'+esc(tr('ui.ddns.e.flags'))+'</th><th></th></tr></thead><tbody>'
          +entries.map((e,i)=>'<tr><td class="mono">'+esc(e.name)+'</td><td>'+esc(e.kind||'')+'</td>'
            +'<td>'+(e.profile?'<span class="badge">profile: '+esc(e.profile)+'</span>':(e.provider?'<span class="badge">'+esc(e.provider)+'</span>':(e.providerProfile?'<span class="badge">pp: '+esc(e.providerProfile)+'</span>':'<span class="dim">-</span>')))+'</td>'
            +'<td class="mono">'+esc(e.zone||'-')+'</td>'
            +'<td class="mono">'+esc(e.record||'-')+'</td>'
            +'<td class="mono">'+esc(e.txtName||'-')+'</td>'
            +'<td class="mono">'+esc(e.followTunnel||'-')+'</td>'
            +'<td>'+['ip:A','aaaa:AAAA','txt:TXT','cname:CNAME','txtUrl:TXT(url)'].map((f)=>{const [k,l]=f.split(':');return e[k]?'<span class="badge">'+l+'</span>':'';}).join(' ')+'</td>'
            +'<td><button class="btn btn-sm btn-danger" data-del-entry="'+i+'">'+esc(tr('ui.ddns.del'))+'</button></td></tr>').join('')
          +'</tbody></table></div>'
        :'<div class="muted">'+esc(tr('ui.ddns.e.empty'))+'</div>')
      // 添加表单 A：profile 引用
      +'<div class="section-label" style="margin-top:10px">'+esc(tr('ui.ddns.e.addByProfile'))+'</div>'
      +'<div class="form-grid">'
      +'<div><label>'+esc(tr('ui.ddns.e.name'))+' *</label><input id="ddns-e-name" placeholder="web-tunnel"></div>'
      +'<div><label>'+esc(tr('ui.ddns.pf.name'))+' *</label><select id="ddns-e-profile">'+Object.keys(profs).map((k)=>'<option value="'+esc(k)+'">'+esc(k)+'</option>').join('')+'</select></div>'
      +'<div><label>kind *</label>'+kindSel('ddns-e-kind')+'</div>'
      +'<div><label>followTunnel</label><input id="ddns-e-follow" placeholder="tunnel name"></div>'
      +'</div>'
      +'<div style="margin-top:6px">'+flagBoxes('e')+'</div>'
      +'<div class="bad hint" id="ddns-e-err" style="display:none"></div>'
      +'<div style="margin-top:4px"><button class="btn btn-sm btn-primary" id="ddns-e-add">'+esc(tr('ui.ddns.add'))+'</button></div>'
      // 添加表单 B：完整信息直填
      +'<div class="section-label" style="margin-top:12px">'+esc(tr('ui.ddns.e.addFull'))+'</div>'
      +'<div class="form-grid">'
      +'<div><label>'+esc(tr('ui.ddns.e.name'))+' *</label><input id="ddns-e2-name" placeholder="home-a"></div>'
      +'<div><label>'+esc(tr('ui.ddns.pp.provider'))+' *</label><select id="ddns-e2-provider">'+ddnsProviderOptions()+'</select></div>'
      +'<div><label>token</label><input id="ddns-e2-token" type="password" autocomplete="off"></div>'
      +'<div><label>zone *</label><input id="ddns-e2-zone" placeholder="example.com"></div>'
      +'<div><label>record</label><input id="ddns-e2-record" placeholder="home.example.com"></div>'
      +'<div><label>txtName</label><input id="ddns-e2-txtname" placeholder="_st.home.example.com"></div>'
      +'<div><label>kind *</label>'+kindSel('ddns-e2-kind')+'</div>'
      +'<div><label>followTunnel</label><input id="ddns-e2-follow" placeholder="tunnel name"></div>'
      +'</div>'
      +'<div style="margin-top:6px">'+flagBoxes('e2')+'</div>'
      +'<div class="bad hint" id="ddns-e2-err" style="display:none"></div>'
      +'<div style="margin-top:4px"><button class="btn btn-sm btn-primary" id="ddns-e2-add">'+esc(tr('ui.ddns.add'))+'</button></div></div>';
    c.innerHTML=h;

    const save=async()=>{await saveDdns({providerProfiles:pps,profiles:profs,entries});renderDdns();};
    const err=(id,msg)=>{const el=document.getElementById(id);if(el){el.textContent=msg;el.style.display=msg?'':'none';}return !msg;};
    c.querySelectorAll('[data-del-pp]').forEach((b)=>b.onclick=async()=>{delete pps[b.dataset.delPp];await save();});
    c.querySelectorAll('[data-del-pf]').forEach((b)=>b.onclick=async()=>{delete profs[b.dataset.delPf];await save();});
    c.querySelectorAll('[data-del-entry]').forEach((b)=>b.onclick=async()=>{entries.splice(Number(b.dataset.delEntry),1);await save();});
    document.getElementById('ddns-pp-add').onclick=async()=>{
      const name=document.getElementById('ddns-pp-name').value.trim();
      const provider=document.getElementById('ddns-pp-provider').value;
      const token=document.getElementById('ddns-pp-token').value;
      if(!err('ddns-pp-err',!name?tr('ui.ddns.err.name'):(!provider?tr('ui.ddns.err.provider'):(!token?tr('ui.ddns.err.token'):''))))return;
      pps[name]={provider,token};
      await save();
    };
    document.getElementById('ddns-pf-add').onclick=async()=>{
      const name=document.getElementById('ddns-pf-name').value.trim();
      const pp=document.getElementById('ddns-pf-pp').value;
      const zone=document.getElementById('ddns-pf-zone').value.trim();
      if(!err('ddns-pf-err',!name?tr('ui.ddns.err.name'):(!pp?tr('ui.ddns.err.pp'):(!zone?tr('ui.ddns.err.zone'):(zone.indexOf('.')<0||/\s/.test(zone)?tr('ui.ddns.err.zoneFormat'):'')))))return;
      profs[name]={
        providerProfile:pp,
        zone,
        record:document.getElementById('ddns-pf-record').value.trim()||undefined,
        txtName:document.getElementById('ddns-pf-txt').value.trim()||undefined,
      };
      await save();
    };
    const readEntry=(p,withProvider)=>{
      const o={
        name:document.getElementById('ddns-'+p+'-name').value.trim(),
        kind:document.getElementById('ddns-'+p+'-kind').value,
        followTunnel:document.getElementById('ddns-'+p+'-follow').value.trim()||undefined,
        cname:document.getElementById('ddns-'+p+'-cname').checked,
        txtUrl:document.getElementById('ddns-'+p+'-txturl').checked,
        ip:document.getElementById('ddns-'+p+'-ip').checked,
        aaaa:document.getElementById('ddns-'+p+'-aaaa').checked,
        txt:document.getElementById('ddns-'+p+'-txt').checked,
      };
      if(withProvider){
        o.provider=document.getElementById('ddns-'+p+'-provider').value||undefined;
        o.token=document.getElementById('ddns-'+p+'-token').value||undefined;
        o.zone=document.getElementById('ddns-'+p+'-zone').value.trim()||undefined;
        o.record=document.getElementById('ddns-'+p+'-record').value.trim()||undefined;
        o.txtName=document.getElementById('ddns-'+p+'-txtname').value.trim()||undefined;
      }else{
        o.profile=document.getElementById('ddns-'+p+'-profile').value||undefined;
      }
      return o;
    };
    document.getElementById('ddns-e-add').onclick=async()=>{
      const e=readEntry('e',false);
      const anyFlag=e.cname||e.txtUrl||e.ip||e.aaaa||e.txt;
      if(!err('ddns-e-err',!e.name?tr('ui.ddns.err.name'):(!e.profile?tr('ui.ddns.err.profile'):(!anyFlag?tr('ui.ddns.err.flag'):''))))return;
      entries.push(e);await save();
    };
    document.getElementById('ddns-e2-add').onclick=async()=>{
      const e=readEntry('e2',true);
      const anyFlag=e.cname||e.txtUrl||e.ip||e.aaaa||e.txt;
      const zoneOk=!e.zone||(e.zone.indexOf('.')>=0&&!/\s/.test(e.zone));
      if(!err('ddns-e2-err',!e.name?tr('ui.ddns.err.name'):(!e.provider?tr('ui.ddns.err.provider'):(!e.zone?tr('ui.ddns.err.zone'):(!zoneOk?tr('ui.ddns.err.zoneFormat'):(!anyFlag?tr('ui.ddns.err.flag'):''))))))return;
      entries.push(e);await save();
    };
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}
function ddnsProviderOptions(){
  const list=state.ddnsProviders||[];
  return '<option value="">'+esc(tr('ui.ddns.pickProvider',(list.length?String(list.length):'—')))+'…</option>'
    +list.map((p)=>{const name=typeof p==='string'?p:(p.name||String(p));return '<option value="'+esc(name)+'">'+esc(name)+'</option>';}).join('');
}
// token 遮蔽 👁：表格行内（data-tok 存原文，点击切换显示）
window.toggleToken=(btn)=>{
  const span=btn.parentElement.querySelector('.ddns-tok');
  const shown=span.dataset.shown==='1';
  span.textContent=shown?'••••••••':(span.dataset.tok||'—');
  span.dataset.shown=shown?'':'1';
  btn.title=tr(shown?'ui.ddns.reveal':'ui.ddns.hide');
};
// token 输入框 👁：password ⇄ text
window.toggleTokenInput=(btn)=>{
  const input=btn.parentElement.querySelector('input');
  const show=input.type==='password';
  input.type=show?'text':'password';
  btn.title=tr(show?'ui.ddns.hide':'ui.ddns.reveal');
};

async function saveDdns(cfg){
  await api('/api/ddns-registry',{method:'POST',body:JSON.stringify(cfg)});
  toast(tr('ui.ddns.saved'));
}
