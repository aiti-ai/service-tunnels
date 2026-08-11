async function renderConfig(){
  const c=document.getElementById('content');
  c.innerHTML='<div class="muted">'+esc(tr('ui.ports.loading'))+'…</div>';
  try{
    const d=await api('/api/config',{method:'GET'});
    let h='<div class="card" style="padding:12px;margin-bottom:10px"><div class="section-label">'+esc(tr('ui.config.dirs'))+'</div>'
      +'<table><tbody>'
      +['configDir','cacheDir'].map((k)=>'<tr><td class="mono">'+esc(k)+'</td><td class="mono">'+esc(d.dirs[k]||'')+'</td></tr>').join('')
      +'</tbody></table></div>';
    h+='<div class="card" style="padding:12px"><div class="section-label">'+esc(tr('ui.config.file'))+'</div>'
      +'<pre style="max-height:50vh;overflow:auto;padding:8px;background:var(--bg);border:1px solid var(--border);border-radius:6px;font-size:11px">'+esc(JSON.stringify(d.config,null,2))+'</pre></div>';
    c.innerHTML=h;
  }catch(e){c.innerHTML='<div class="bad">'+esc(String(e))+'</div>';}
}
// ── boot ──────────────────────────────────────────────────────────────────
document.getElementById('refreshBtn').onclick=refreshAll;
document.getElementById('langBtn').onclick=()=>{const next=state.lang==='zh'?'en':'zh';location.href='/?lang='+next;};
document.addEventListener('change',(e)=>{if(e.target&&e.target.id==='exp-provider')syncProviderFields();});
