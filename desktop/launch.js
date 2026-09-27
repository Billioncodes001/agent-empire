const $=id=>document.getElementById(id),status=$('status');
async function action(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);status.textContent='Working…';try{const r=await fn();status.textContent=r?.error||r?.message||'';}catch{status.textContent='Unable to complete this action. Your project has not been replaced.';}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function paint(){const s=await window.connection.launcherState();$('host').value=s.origin||'';$('project').textContent=s.project||'A new local project will be created in the app’s data folder.';$('credential-state').textContent=s.credentials?.error?'Storage needs attention':`${s.credentials?.anthropic?'Claude saved':'Claude not connected'} · ${s.credentials?.github?'GitHub saved':'GitHub not connected'}`;if(s.credentials?.error)status.textContent=s.credentials.error;}
$('local').onclick=()=>action(()=>window.connection.openLocal(false));
$('choose').onclick=()=>action(()=>window.connection.openLocal(true));
$('remote').onsubmit=e=>{e.preventDefault();void action(()=>window.connection.connect($('host').value));};
$('secrets').onsubmit=e=>{e.preventDefault();void action(async()=>{const r=await window.connection.saveCredentials({anthropicKey:$('anthropic').value,githubToken:$('github').value});$('anthropic').value='';$('github').value='';await paint();return r;});};
void paint();
