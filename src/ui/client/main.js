const initial=(location.hash||'#/ports').replace(/^#\//,'');
if(TABS.includes(initial))state.tab=initial;
startPolling();
refreshAll();