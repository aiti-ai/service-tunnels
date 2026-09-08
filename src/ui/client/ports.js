function exposeForPort(p){return (state.live&&state.live.exposes||[]).filter((e)=>e.port===p);}
function renderPorts(){
  const c=document.getElementById('content');
  const ports=(state.live&&state.live.ports)||[];
  const exposes=(state.live&&state.live.exposes)||[];
  const allowToolDownload=state.status&&state.status.tools?state.status.tools.allowDownload:null;
  let html='';
  // allow-tool-download quick switch
  if(allowToolDownload!==null){
    const missing=(state.status&&state.status.tools&&state.status.tools.list||[]).filter((x)=>!x.source).map((x)=>x.name);
    html+='<label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer"><input type="checkbox" id="allowDl" '+(allowToolDownload?'checked':'')+'> '+esc(tr('ui.ports.allowDownload'))+(missing.length?' <span class="dim">('+esc(tr('ui.ports.toolsMissing'))+': '+esc(missing.join(', '))+')</span>':'')+'</label>';
  }
  // active exposes summary
  const running=exposes.filter((e)=>e.running);
  if(running.length){
    html+='<div class="card" style="border-color:var(--accent);padding:10px 12px;margin-bottom:10px">';
    html+='<div class="section-label">'+esc(tr('ui.ports.activeExposes'))+' ('+running.length+')</div>';
    html+=running.map((e)=>{
      const u=e.url||e.localUrl||e.baseUrl||e.domainUrl||'';
      return '<div class="row" style="padding:6px 0;cursor:default">'
        +'<span class="mono">127.0.0.1:'+e.port+'</span>'
        +'<span class="badge">'+esc(modeOf(e)||'?')+'</span>'
        +'<span class="badge">'+(e.protocol||'http')+'</span>'
        +(e.provider?'<span class="badge">auth: '+esc(e.provider)+'</span>':'<span class="badge authnone">⚠ none</span>')
        +'<span class="ok" style="font-size:10px">● running</span>'
        +'<div class="spacer"></div>'
        +'<button class="btn btn-sm" onclick="showExposeDetail(\''+e.name+'\')">'+esc(tr('ui.ports.detail'))+'</button>'
        +'<button class="btn btn-sm btn-danger" onclick="stopExpose(\''+e.name+'\')">'+esc(tr('ui.ports.stop'))+'</button>'
        +'</div>';
    }).join('');
    html+='</div>';
  }
  if(!ports.length){
    html+='<div class="empty">'+esc(tr('ui.ports.none'))+'</div>';
  } else {
    html+=ports.map((s)=>{
      const open=state.expanded.has(s.port);
      const exs=exposeForPort(s.port);
      const urls=exs.flatMap((e)=>[(e.localUrl?{u:e.localUrl,l:tr('ui.ports.proxyLocal')+' '+esc(e.name),n:e.name}:null),(e.baseUrl?{u:e.baseUrl,l:tr('ui.ports.proxyDomain')+' '+esc(e.name),n:e.name}:null),(e.domainUrl?{u:e.domainUrl,l:tr('ui.ports.proxyDomain')+' '+esc(e.name),n:e.name}:null)].filter(Boolean));
      // 服务识别：用户 label（人工事实）> HTTP 探测 title；tooltip 附探测元信息
      const id=s.identity||{};
      const isHttp=id.protocol&&id.protocol!=='tcp';
      const idMeta=isHttp?[id.protocol+(id.status?' '+id.status:''),id.server].filter(Boolean).join(' · '):'';
      const tooltip=[(id.label&&id.title)?tr('ui.ports.detected')+': '+id.title:null,idMeta].filter(Boolean).join(' · ');
      // title/server 等来自对端响应，不可信——整串 esc 后再进 HTML 属性
      const tooltipAttr=tooltip?' title="'+esc(tooltip)+'"':'';
      const icon=id.favicon?('<img class="svc-icon" src="'+id.favicon+'" alt="" loading="lazy"'+tooltipAttr+'>'):"";
      const svcName=id.label||id.title;
      const titleLine=svcName?('<div class="svc-title"'+tooltipAttr+'>'+esc(svcName)+'</div>'):"";
      return '<div class="card" id="pc-'+s.port+'">'
        +'<div class="row" onclick="togglePort('+s.port+')" role="button">'
        +'<span class="port">'+s.port+'</span>'
        +icon
        +'<div style="flex:1;min-width:0">'
        +titleLine
        +'<div'+(titleLine?' class="dim"':'')+' style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(s.cmdline||s.process||('pid '+s.pid))+'</div>'
        +'<div class="dim" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(tr('ui.ports.listenOn'))+' '+esc((s.addresses||[]).join(', '))+' · pid '+s.pid+'</div></div>'
        +(exs.some((e)=>e.running)?'<span class="badge ok">●</span>':'')
        +'<button class="btn btn-sm svc-rename" title="'+esc(tr('ui.ports.rename'))+'" onclick="event.stopPropagation();renameService('+s.port+')">✎</button>'
        +'<span class="dim">'+(open?'▾':'▸')+'</span></div>'
        +(open?expandPort(s,exs,urls):'')
        +'</div>';
    }).join('');
  }
  c.innerHTML=html;
  const dl=document.getElementById('allowDl');
  if(dl)dl.onchange=()=>{api('/api/settings',{method:'POST',body:{allowToolDownload:dl.checked}}).catch((e)=>toast(String(e),true));};
}
function expandPort(s,exs,urls){
  let h='<div class="expand">';
  // direct URLs
  const addrs=(s.addresses||[]);
  if(addrs.length){
    h+='<div class="section-label">'+esc(tr('ui.ports.direct'))+'</div>';
    h+=addrs.map((a)=>'<div class="url-row"><span class="lbl">'+(a==='127.0.0.1'||a==='::1'?'localhost':esc(a))+'</span><a href="http://'+fmtAddr(a)+':'+s.port+'/" target="_blank" rel="noopener">http://'+fmtAddr(a)+':'+s.port+'/</a></div>').join('');
  }
  // vhost URLs (proxy/both exposes)
  if(urls.length){
    h+='<div class="section-label">'+esc(tr('ui.ports.viaProxy'))+'</div>';
    h+=urls.map((x)=>'<div class="url-row"><span class="lbl">'+x.l+'</span><a href="'+esc(x.u)+'" target="_blank" rel="noopener">'+esc(x.u)+'</a></div>').join('');
  }
  // expose form
  h+='<div class="section-label">'+esc(tr('ui.ports.exposeTitle'))+'</div>'+exposeForm(s.port);
  // active exposes for this port
  if(exs.length){
    h+='<div class="section-label">'+esc(tr('ui.ports.thisPortExposes'))+'</div>';
    h+=exs.map((e)=>'<div class="row" style="padding:5px 0;cursor:default"><span class="badge">'+esc(modeOf(e)||'?')+'</span>'
      +(e.provider?'<span class="badge">'+esc(e.provider)+'</span>':'<span class="badge authnone">⚠ none</span>')
      +'<span class="'+(e.running?'ok':'dim')+'" style="font-size:10px">'+(e.running?'● '+esc(tr('ui.tunnelRunning')):esc(tr('ui.tunnelStopped')))+'</span>'
      +'<div class="spacer"></div>'
      +'<button class="btn btn-sm" onclick="showExposeDetail(\''+e.name+'\')">'+esc(tr('ui.ports.detail'))+'</button>'
      +'<button class="btn btn-sm btn-danger" onclick="stopExpose(\''+e.name+'\')">'+esc(tr('ui.ports.stop'))+'</button></div>').join('');
  }
  h+='</div>';
  return h;
}
function exposeForm(port){
  const st=state.status;if(!st)return '<div class="muted">'+esc(tr('ui.ports.loading'))+'</div>';
  const noneAllowed=!!st.allowAuthNone;
  const providerOpts=(noneAllowed?['none']:[]).concat(['ssh']).concat(st.providerOrder||[]);
  const tunnelTypes=Object.keys(st.tunnelSchemas||{}).filter((t)=>!(st.tunnelMetas&&st.tunnelMetas[t]&&st.tunnelMetas[t].dangerous));
  const metas=st.tunnelMetas||{};
  const sites=(st.sites||[]).map((x)=>x.name);
  const siteOpts=['default'].concat(sites.filter((x)=>x!=='default'));
  const defAuth=st.defaultProvider||'portal';
  // protocol/auth 默认持久化到 state（detect 结果不被 10s 轮询重置）
  const protoDef=state.protoDetect[port]||'auto';
  const authDef=state.authDefault||(protoDef==='tcp'?'ssh':defAuth);
  // sel: def===undefined → 首项占位(无默认)；否则默认选中 def
  const sel=(id,opts,def)=>'<select id="'+id+'">'+(def===undefined?'<option value="">'+esc(tr('ui.ports.selectHint'))+'</option>':'')+opts.map((o)=>'<option value="'+o.value+'"'+((def!==undefined&&o.value===def)?' selected':'')+'>'+esc(o.label||o.value)+'</option>').join('')+'</select>';
  const ov=(v)=>({value:v});
  // 顺序: protocol(auto detect) → mode(tunnel) → tunnel(无默认) → auth(协议联动) → site → 2FA(two_factor)
  return '<div class="form-grid" style="margin-bottom:8px">'
    +fld('protocol','<div id="exp-protocol-wrap">'+sel('exp-protocol',[{value:'auto',label:tr('ui.ports.protoAuto')}].concat(['http','https','tcp'].map(ov)),protoDef)+'</div>')
    +fld('mode',sel('exp-mode',['tunnel','proxy','both','portmap','ipv6'].map(ov),'tunnel'))
    +fld('tunnel',sel('exp-tunnel',tunnelTypes.slice().sort((a,b)=>(metas[b]&&metas[b].favorite?1:0)-(metas[a]&&metas[a].favorite?1:0)).map((t)=>({value:t,label:t+(metas[t]&&metas[t].favorite?' ★':'')}))))
    +'<div id="exp-ipv6-wrap" style="display:none">'
    +'<label>'+esc(tr('ui.ports.ipv6Address'))+' <span class="dim" style="font-weight:normal">('+esc(tr('ui.ports.ipv6Optional'))+')</span></label>'
    +'<input id="exp-ipv6-address" placeholder="auto (first global v6)" style="width:100%">'
    +'<div class="hint">'+esc(tr('ui.ports.ipv6Hint'))+'</div>'
    +'</div>'
    +fld('auth',sel('exp-provider',providerOpts.map((p)=>({value:p,label:p==='none'?'none (no auth)':p})),authDef))
    +fld('site',sel('exp-site',siteOpts.map(ov),'default'))
    +fld('policy',sel('exp-policy',['one_factor','two_factor'].map(ov),'two_factor'))
    +'</div>'
    +'<div id="exp-tunnel-params"></div>'
    +'<div id="exp-auth-params"></div>'
    +'<div style="display:flex;gap:8px;align-items:center;margin-top:8px">'
    +'<button class="btn btn-primary btn-sm" id="expBtn" onclick="doExpose('+port+')">'+esc(tr('ui.expose.doExpose'))+'</button>'
    +'<span class="dim" id="exp-hint" style="font-size:10px"></span>'
    +'</div>';
  function fld(label,inner){return '<div><label>'+label+'</label>'+inner+'</div>';}
}
function schemaFields(specs){
  if(!specs||!specs.length)return '';
  return '<div class="form-grid" style="margin-top:6px">'+specs.map((s)=>{
    const required=s.required?' *':'';
    const hint=s.description?'<div class="hint">'+esc(s.description)+'</div>':'';
    let input;
    if(s.fixed){
      // 固定参数(provider 名/端点等): 只读回显, 值随提交
      input='<input type="text" data-k="'+esc(s.key)+'" value="'+esc(s.value||s.default||'')+'" disabled title="'+esc(tr('ui.ports.fixedHint'))+'" style="opacity:.75;cursor:not-allowed">';
    } else if(s.options&&s.options.length){
      input='<select data-k="'+esc(s.key)+'">'+s.options.map((o)=>'<option value="'+esc(o.value)+'">'+esc(o.label||o.value)+'</option>').join('')+'</select>';
    } else if(s.type==='password'){
      input='<input type="password" data-k="'+esc(s.key)+'" placeholder="'+esc(s.placeholder||'')+'">';
    } else if(s.type==='number'){
      input='<input type="number" data-k="'+esc(s.key)+'" placeholder="'+esc(s.placeholder||'')+'">';
    } else {
      input='<input data-k="'+esc(s.key)+'" placeholder="'+esc(s.placeholder||'')+'" value="'+esc(s.default||'')+'">';
    }
    return '<div><label>'+esc(s.label||s.key)+required+(s.fixed?' 🔒':'')+'</label>'+input+hint+'</div>';
  }).join('')+'</div>';
}
// exposed globals used by inline onclick
window.togglePort=(p)=>{if(state.expanded.has(p))state.expanded.delete(p);else state.expanded.add(p);state._exposePort=p;renderTab();setTimeout(afterExposeFormMount,0);};
// 服务重命名：用户自定义识别（label > 探测 title；留空清除）
window.renameService=async(port)=>{
  const cur=((((state.live||{}).ports)||[]).find((p)=>p.port===port)||{}).identity?.label||'';
  const name=prompt(tr('ui.ports.renamePrompt'),cur);
  if(name===null)return;
  try{await api('/api/port-label',{method:'POST',body:{port,label:name}});toast(tr('ui.ports.renamed'));await loadLive();}catch(e){toast(String(e),true);}
};
window.stopExpose=async(name)=>{
  confirmDlg(tr('ui.ports.stopConfirm',{name}),tr('ui.ports.stopHint'),tr('ui.ports.stop'),async()=>{
    try{await api('/api/expose-stop',{method:'POST',body:{name}});toast(tr('ui.ports.stopped'));await loadLive();}catch(e){toast(String(e),true);}
  });
};
window.showExposeDetail=async(name)=>{
  try{
    const e=(state.live&&state.live.exposes||[]).find((x)=>x.name===name)||{name};
    let logs='';
    if(e.accessLog){
      try{const d=await api('/api/logs?name='+encodeURIComponent(name));logs='<div class="section-label">access</div><pre class="log">'+esc(d.access||'(empty)')+'</pre><div class="section-label">error</div><pre class="log" style="color:var(--danger)">'+esc(d.error||'(empty)')+'</pre>';}catch(err){logs='<div class="muted">'+(err.message||'')+'</div>';}
      // log files (M2): list *.log under the expose's nginx logs dir
      try{
        const lf=await api('/api/logs-list?name='+encodeURIComponent(name));
        if(lf.files&&lf.files.length){
          logs+='<div class="section-label">'+esc(tr('ui.ports.logFiles'))+'</div>'
            +lf.files.map((f)=>'<div class="row" style="padding:3px 0;cursor:default"><span class="mono" style="font-size:10px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">'+esc(f.name)+'</span>'
            +'<span class="dim" style="font-size:10px">'+(f.size>=1048576?(f.size/1048576).toFixed(1)+' MB':f.size>=1024?(f.size/1024).toFixed(1)+' KB':f.size+' B')+'</span>'
            +'<button class="btn btn-sm" onclick="showLogFile(\''+esc(f.path)+'\')">'+esc(tr('ui.ports.view'))+'</button></div>').join('');
        }
      }catch(err){/* logs-list best-effort */}
    }
    const links=[e.url,e.localUrl,e.baseUrl,e.domainUrl,e.loginUrl].filter(Boolean);
    openModal('<h3>'+esc(e.name)+' · <span class="mono">127.0.0.1:'+e.port+'</span></h3>'
      +kv('mode',modeOf(e)||'')
      +kv('provider',e.provider||'<span class="bad">⚠ none</span>')
      +kv('tunnel',e.tunnelType||'—')+kv('site',e.site||'default')+kv('protocol',e.protocol||'http')
      +kv('started',e.startedAt?new Date(e.startedAt).toLocaleString():'—')
      +(e.params&&Object.keys(e.params).length?kv('params','<div class="mono">'+Object.entries(e.params).map(([k,v])=>esc(k)+': '+esc(v)).join('<br>')+'</div>'):'')
      +(links.length?kv('urls',links.map((u)=>'<div class="url-row"><a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(u)+'</a></div>').join('')):'')
      +logs
      +'<div class="actions" style="margin-top:12px"><div class="spacer"></div>'
      +'<button class="btn btn-danger" onclick="closeModal();stopExpose(\''+e.name+'\')">'+esc(tr('ui.ports.stop'))+'</button>'
      +'<button class="btn" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');
  }catch(err){toast(String(err),true);}
};
function kv(k,v){return '<div class="kv"><span class="k">'+esc(k)+'</span><span class="v">'+v+'</span></div>';}
window.showLogFile=async(path)=>{
  try{
    const d=await api('/api/logs?path='+encodeURIComponent(path));
    openModal('<h3>'+esc(path.split('/').pop())+'</h3><pre class="log" style="max-height:60vh">'+esc(d.access||'(empty)')+'</pre><div class="actions" style="margin-top:10px"><div class="spacer"></div><button class="btn" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');
  }catch(err){toast(String(err),true);}
};
let authManual=false; // 用户手动改过 auth → 协议联动不再覆盖
function afterExposeFormMount(){refreshTunnelParams();renderAuthParams();syncProviderFields();syncModeFields();detectPortProtocol(state._exposePort||0);loadPresets();
  const modeSel=document.getElementById('exp-mode');if(modeSel)modeSel.onchange=syncModeFields;
}
// mode 联动: ipv6/portmap 不需要 tunnel 选择; ipv6 显示入口地址输入框
function syncModeFields(){
  const sel=document.getElementById('exp-mode');if(!sel)return;
  const mode=sel.value;
  const tunnelWrap=document.getElementById('exp-tunnel')&&document.getElementById('exp-tunnel').closest('div');
  const ipv6Wrap=document.getElementById('exp-ipv6-wrap');
  if(tunnelWrap)tunnelWrap.style.display=(mode==='tunnel'||mode==='both')?'':'none';
  if(ipv6Wrap)ipv6Wrap.style.display=(mode==='ipv6')?'':'none';
  // tunnel-param 区域: 非 tunnel/both 清空
  if(mode!=='tunnel'&&mode!=='both'){const el=document.getElementById('exp-tunnel-params');if(el)el.innerHTML='';}
}
// provider=ssh: hide protocol (port-forward); auth change → render auth params group
function syncProviderFields(){
  const sel=document.getElementById('exp-provider');if(!sel)return;
  const protoWrap=document.getElementById('exp-protocol-wrap');
  const proto=document.getElementById('exp-protocol');
  const hint=document.getElementById('exp-hint');
  const v=sel.value;
  const ssh=v==='ssh';
  if(protoWrap)protoWrap.style.display=ssh?'none':'';
  if(proto&&ssh)proto.value='tcp';
  renderAuthParams();
  if(hint)hint.textContent=ssh?tr('ui.ports.sshHint'):(v==='token'?tr('ui.ports.tokenHint'):'');
}
// auth 默认随协议: tcp → ssh; http/https/auto → defaultProvider(portal)
function syncAuthDefault(){
  const prov=document.getElementById('exp-provider');if(!prov||authManual)return;
  const proto=document.getElementById('exp-protocol').value;
  state.authDefault=(proto==='tcp')?'ssh':((state.status&&state.status.defaultProvider)||'portal');
  prov.value=state.authDefault;
  renderAuthParams();
}
window.detectPortProtocol=async(port)=>{
  if(!port)return;
  try{
    const d=await api('/api/port-detect?port='+port);
    if(d&&d.protocol){
      state.protoDetect[port]=d.protocol;
      state.authDefault=(d.protocol==='tcp')?'ssh':((state.status&&state.status.defaultProvider)||'portal');
      const sel=document.getElementById('exp-protocol');
      if(sel){
        sel.value=d.protocol;
        const opt=[...sel.options].find((o)=>o.value===d.protocol);
        if(opt)opt.textContent=d.protocol+' (auto)';
      }
      syncAuthDefault();
    }
  }catch(e){/* keep auto */}
};
window.doExpose=async(port)=>{
  const st=state.status;
  const provider=document.getElementById('exp-provider').value;
  const ssh=provider==='ssh';
  const protocol=ssh?'tcp':document.getElementById('exp-protocol').value;
  const mode=document.getElementById('exp-mode').value;
  const needsTunnel=(mode==='tunnel'||mode==='both');
  const tunnel=needsTunnel?document.getElementById('exp-tunnel').value:'';
  // 必选校验: 仅 tunnel/both 需要 tunnel; protocol 默认 auto → 不传由库 detect
  const req=(v,n)=>{if(!v){toast(esc(n)+' '+tr('ui.ports.fieldRequired'),true);return false;}return true;};
  if(needsTunnel&&!req(tunnel,'tunnel'))return;
  const body={
    port, mode,
    provider:provider==='none'||provider==='ssh'?undefined:provider,
    auth:provider==='none'?false:true,
    site:document.getElementById('exp-site').value||'default',
    // protocol 'auto' → 不传, 库 detectProtocol 自动判定
    ...(protocol&&protocol!=='auto'?{protocol}:{}),
    policy:document.getElementById('exp-policy').value||undefined,
  };
  if(needsTunnel)body.tunnel=tunnel;
  // ipv6 模式: 显式入口地址（可选, 缺省自动检测第一个 global v6）
  if(mode==='ipv6'){
    const addrEl=document.getElementById('exp-ipv6-address');
    const addr=addrEl?addrEl.value.trim():'';
    if(addr)body.ipv6={address:addr};
  }
  if(ssh)body.provider='ssh';
  if(needsTunnel&&protocol==='tcp'){const tcp=(st.tunnelTcpSupport||[]);if(tcp.length&&!tcp.includes(tunnel)){toast(tr('ui.ports.tcpNotSupport'),true);return;}}
  // tunnel / auth 参数分组
  const read=(root)=>{const o={};document.querySelectorAll(root+' [data-k]').forEach((el)=>{const v=el.value;if(v!=='')o[el.dataset.k]=el.type==='number'?Number(v):v;});return o;};
  // TODO-2: 选中 preset 时,表单留空的字段用已存值(敏感字段不回显,提交时合并明文)
  const mergePreset=async(kind,cur)=>{const n=kind==='tunnel'?state._tunnelPresetName:state._authPresetName;if(!n)return cur;const type=document.getElementById(kind==='tunnel'?'exp-tunnel':'exp-provider').value;try{const d=await api('/api/presets?kind='+kind+'&type='+encodeURIComponent(type)+'&name='+encodeURIComponent(n));if(d&&d.params){const out={...cur};for(const[k,v]of Object.entries(d.params)){if(!(k in out))out[k]=v;}return out;}}catch(e){}return cur;};
  const tp=needsTunnel?await mergePreset('tunnel',read('#exp-tunnel-params')):{};
  if(Object.keys(tp).length)body.tunnelParams=tp;
  const pp=await mergePreset('auth',read('#exp-auth-params'));
  if(Object.keys(pp).length)body.providerParams=pp;
  const hint=document.getElementById('exp-hint');if(hint)hint.textContent=tr('ui.ports.exposing');
  try{
    const r=await api('/api/expose',{method:'POST',body});
    const urls=[r.url,r.localUrl,r.baseUrl,r.domainUrl].filter(Boolean);
    if(urls.length){
      openModal('<h3>'+esc(tr('ui.ports.exposeDone'))+'</h3>'
        +urls.map((u)=>'<div class="url-row" style="margin:6px 0"><a href="'+esc(u)+'" target="_blank" rel="noopener">'+esc(u)+'</a></div>').join('')
        +'<div class="actions" style="margin-top:12px"><div class="spacer"></div>'
        +'<button class="btn" onclick="closeModal()">'+esc(tr('ui.close'))+'</button></div>');
    } else if(r.error){toast(r.error,true);}
    await loadLive();
  }catch(e){toast(String(e),true);if(hint)hint.textContent='';}
};
// tunnel-param schema render on tunnel change
window.refreshTunnelParams=()=>{
  const st=state.status;if(!st)return;
  const t=document.getElementById('exp-tunnel')?document.getElementById('exp-tunnel').value:'';
  const el=document.getElementById('exp-tunnel-params');
  const specs=(st.tunnelSchemas&&st.tunnelSchemas[t])||[];
  el.innerHTML=(specs.length?('<div class="section-label">'+esc(tr('ui.ports.tunnelParams'))+'</div>'+schemaFields(specs)):'')
    +presetBar('tunnel',t);
  state._tunnelPresetName=null;
};
window.renderAuthParams=()=>{
  const st=state.status;if(!st)return;
  const p=document.getElementById('exp-provider')?document.getElementById('exp-provider').value:'';
  const el=document.getElementById('exp-auth-params');
  if(!p||p==='none'||p==='ssh'){el.innerHTML='';state._authPresetName=null;return;}
  const specs=(st.authProviderSchemas&&st.authProviderSchemas[p])||[];
  el.innerHTML=(specs.length?('<div class="section-label">'+esc(tr('ui.ports.authParams'))+'</div>'+schemaFields(specs)):'')
    +presetBar('auth',p);
  state._authPresetName=null;
};
function presetSummary(params){
  const plain=Object.entries(params||{}).filter(([k])=>!/token|secret|password|key/i.test(k)).map(([k,v])=>k+'='+v).join(', ');
  const sec=Object.keys(params||{}).filter((k)=>/token|secret|password|key/i.test(k)).length;
  return plain+(sec?(plain?' · ':'')+sec+' 🔒':'');
}
// ── Presets (TODO-2): 参数变体栏（下拉选用/另存为/编辑/删除） ──────────────
function presetBar(kind,type){
  if(!type)return '';
  const presets=(state.presets&&state.presets[kind+'Presets']&&state.presets[kind+'Presets'][type])||[];
  return '<div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">'
    +'<select id="pre-'+kind+'" style="max-width:220px" onchange="applyPreset(\''+kind+'\',\''+esc(type)+'\')">'
    +'<option value="">'+esc(tr('ui.ports.presetUse'))+'</option>'
    +presets.map((p)=>'<option value="'+esc(p.name)+'">'+esc(p.name+' — '+presetSummary(p.params))+'</option>').join('')
    +'</select>'
    +'<button class="btn btn-sm" onclick="savePresetAs(\''+kind+'\',\''+esc(type)+'\')">'+esc(tr('ui.ports.presetSave'))+'</button>'
    +(presets.length?'<button class="btn btn-sm btn-danger" onclick="delPreset(\''+kind+'\',\''+esc(type)+'\')">'+esc(tr('ui.ports.presetDel'))+'</button>':'')
    +'</div>';
}
window.applyPreset=async(kind,type)=>{
  const name=document.getElementById('pre-'+kind).value;
  if(!name){if(kind==='tunnel')state._tunnelPresetName=null;else state._authPresetName=null;return;}
  try{
    const d=await api('/api/presets?kind='+kind+'&type='+encodeURIComponent(type)+'&name='+encodeURIComponent(name));
    if(!d||d.error){toast((d&&d.error)||'preset load failed',true);return;}
    // 非敏感字段带入; 敏感字段留空 + placeholder 提示用已存值
    const root=kind==='tunnel'?'exp-tunnel-params':'exp-auth-params';
    document.querySelectorAll('#'+root+' [data-k]').forEach((el)=>{
      const k=el.dataset.k;
      if(k in d.params){ if(!/token|secret|password|key/i.test(k)){el.value=d.params[k];} else {el.value='';el.placeholder=tr('ui.ports.presetSensitiveHint');} }
    });
    if(kind==='tunnel')state._tunnelPresetName=name;else state._authPresetName=name;
    toast(tr('ui.ports.presetApplied'));
  }catch(e){toast(String(e),true);}
};
window.savePresetAs=async(kind,type)=>{
  const name=prompt(tr('ui.ports.presetNamePrompt'));
  if(!name)return;
  const root=kind==='tunnel'?'exp-tunnel-params':'exp-auth-params';
  const params={};
  document.querySelectorAll('#'+root+' [data-k]').forEach((el)=>{const v=el.value;if(v!=='')params[el.dataset.k]=el.type==='number'?Number(v):v;});
  if(!Object.keys(params).length){toast(tr('ui.ports.presetEmpty'),true);return;}
  try{
    await api('/api/presets',{method:'POST',body:{action:'save',kind,type,name,params}});
    await loadPresets();
    if(kind==='tunnel')refreshTunnelParams();else renderAuthParams();
    toast(tr('ui.ports.presetSaved'));
  }catch(e){toast(String(e),true);}
};
window.delPreset=async(kind,type)=>{
  const name=document.getElementById('pre-'+kind).value;
  if(!name){toast(tr('ui.ports.presetPick'),true);return;}
  confirmDlg(tr('ui.ports.presetDel'),esc(name),tr('ui.ports.presetDel'),async()=>{
    try{await api('/api/presets',{method:'POST',body:{action:'remove',kind,type,name}});await loadPresets();if(kind==='tunnel')refreshTunnelParams();else renderAuthParams();toast('deleted');}catch(e){toast(String(e),true);}
  });
};
window.loadPresets=async()=>{
  try{
    const t=await api('/api/presets?kind=tunnel');
    const a=await api('/api/presets?kind=auth');
    const byT={};(t.presets||[]).forEach((p)=>{byT[p.type]=byT[p.type]||[];byT[p.type].push(p);});
    const byA={};(a.presets||[]).forEach((p)=>{byA[p.type]=byA[p.type]||[];byA[p.type].push(p);});
    state.presets={tunnelPresets:byT,authPresets:byA};
  }catch(e){/* best-effort */}
};
document.addEventListener('change',(e)=>{
  if(e.target&&e.target.id==='exp-tunnel')refreshTunnelParams();
  if(e.target&&e.target.id==='exp-provider'){authManual=true;syncProviderFields();}
  if(e.target&&e.target.id==='exp-protocol')syncAuthDefault();
});
document.addEventListener('change',(e)=>{if(e.target&&e.target.id==='exp-tunnel')refreshTunnelParams();});
