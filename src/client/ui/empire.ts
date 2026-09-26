import { keyLabel, type Action } from '../controls';
import { SITES, type SiteId } from '../../shared/empire';
import { store } from '../state';
import type { Net } from '../net';
import type { PlayerController } from '../player';
import { h, openModal, toast } from './dom';

export function mountEmpire(net: Net, player: PlayerController, travel: (place: 'office'|'city'|'home') => void, toggleCar: () => void, research: () => void) {
  const status = h('div.empire-status');
  const map = h('canvas.empire-map', { width: 240, height: 200, 'aria-label': 'District map. The gold marker shows your position.' });
  const caption = h('p.empire-caption');
  const panel = h('section.empire-dock', {}, h('div.empire-eyebrow', {}, 'AGENT EMPIRE / FOUNDING DISTRICT'), h('h2', {}, 'Your world, at work.'),status,
    h('div.empire-actions', {},
      h('button.btn.primary', { onclick: () => openOperations() }, 'Operations'),
      h('button.btn', { onclick: () => travel(player.pos.z<30?'city':'office') }, 'Office ↔ City'),
      h('button.btn', { onclick: () => travel('home') }, 'Go home'),
      h('button.btn', { onclick: toggleCar }, 'Enter / exit car'),
      h('button.btn', { onclick: () => {if(player.pos.z<30)travel('city');player.setView('third');player.camDist=player.camDist>50?24:70;player.camPitch=.8;} }, 'District view'),
    ), map,
    caption,
  );
  const touch = h('div.empire-touch', { 'aria-label': 'Touch movement controls' });
  for (const [action, symbol] of [['forward','↑'],['left','←'],['backward','↓'],['right','→']] as [Action,string][]) {
    const button=h('button.btn',{'aria-label':`Move ${action}`},symbol);
    button.onpointerdown=e=>{e.preventDefault();button.setPointerCapture(e.pointerId);player.setAction(action,true);};
    button.onpointerup=button.onpointercancel=()=>player.setAction(action,false);
    touch.append(button);
  }
  touch.append(h('button.btn',{onclick:()=>interact()},'Use'));
  document.getElementById('hud')!.append(panel,touch);
  let needs = { energy: 90, nourishment: 85 };
  try {const saved=JSON.parse(localStorage.getItem('agent-empire.needs')??'null');if(saved && Number.isFinite(saved.energy) && Number.isFinite(saved.nourishment)) needs={energy:Math.max(0,Math.min(100,saved.energy)),nourishment:Math.max(0,Math.min(100,saved.nourishment))};}catch{}
  function openOperations(selected?: SiteId) {
    const body=h('div.body.empire-body');
    let off=()=>{};
    const close=h('button.btn', {'aria-label':'Close operations'}, '✕');
    const modal=openModal(h('div.modal.empire-modal', {role:'dialog','aria-label':'Empire operations'},h('header',{},h('h2',{},'Empire operations'),close),body),{onClose:()=>off()});
    close.onclick=()=>modal.close();
    const render=()=> {
      const state=store.empire;
      const delegate=h('button.btn.primary',{onclick:()=>net.send({t:'empire.action',action:{kind:'delegate',enabled:!state.delegated}})},state.delegated?'Resume CEO oversight':'Delegate to chief of staff');
      body.replaceChildren(h('p.empire-eyebrow',{},'LIVE SERVER STATE · PERSISTENT DISTRICT'),
        h('div.empire-metrics',{},
          metric('Treasury',`${state.funds.toLocaleString()} cr`),metric('AI workers active',String(state.workforce.working)),metric('Need your input',String(state.workforce.attention)),metric('Queued tasks',String(state.workforce.queued))),
        h('div.empire-brief',{},h('h3',{},state.delegated?'Chief of staff on duty':'CEO in command'),h('p',{},'The chief of staff monitors status and reports exceptions. Real coding agents continue through the existing task queue while the server runs. Simulated service staff do not run AI tasks.'),delegate),
        h('h3',{},'Develop your district'),
        h('div.empire-sites',{},...SITES.filter(site=>!selected||site.id===selected).map(site=> {
          const sector=state.sectors.find(s=>s.id===site.id)!;
          return h('article.empire-site',{},h('span.empire-eyebrow',{},site.sector),h('h3',{},site.name),h('p',{},sector.built?`${sector.staff}/${site.capacity} service staff · ${sector.service}% coverage`:`Available plot · ${site.cost.toLocaleString()} credits`),
            h('progress',{max:100,value:sector.service,'aria-label':`${site.name} service coverage`}),
            h('button.btn',{disabled:sector.built?(sector.staff>=site.capacity||state.funds<1200):state.funds<site.cost,onclick:()=>net.send({t:'empire.action',action:{kind:sector.built?'hire':'build',site:site.id}})},sector.built?'Hire service staff · 1,200 cr':`Build · ${site.cost.toLocaleString()} cr`),
            sector.built?h('button.btn',{style:'margin-top:8px',onclick:()=>assignTask(site.id)},'Assign AI task'):null);
        })),
        selected?h('button.btn',{onclick:()=>{selected=undefined;render();}},'Show all sectors'):h('span'),
        h('h3',{},'Sector briefings'),h('div.empire-reports',{},...state.reports.slice(0,18).map(r=>h('article',{},h('small',{},`${new Date(r.at).toLocaleTimeString()} / ${r.sector}`),h('p',{},r.text)))),
        h('p.setting-note',{},'Simulation credits are fictional. Actual AI usage costs are shown in the workers panel. Closing the browser keeps work running only while its server remains online.'));
    };off=store.on('empire',render);render();
  }
  function assignTask(id: SiteId) {
    const site=SITES.find(s=>s.id===id)!;
    const input=h('textarea',{rows:5,'aria-label':'Sector task',placeholder:`Describe real research or coding work for ${site.name}…`});
    const close=h('button.btn',{},'Cancel');
    const submit=h('button.btn.primary',{},'Send to real worker queue');
    const modal=openModal(h('div.modal',{role:'dialog','aria-label':'Assign sector task'},h('header',{},h('h2',{},`AI work / ${site.sector}`),close),h('div.body',{},h('p',{},'This runs an actual agent in the connected project and uses your configured AI account.'),input,submit)));
    close.onclick=()=>modal.close();
    submit.onclick=()=>{const prompt=input.value.trim();if(!prompt){input.focus();return;}net.send({t:'queue.add',title:`[${site.sector}] ${prompt.slice(0,90)}`,prompt:`Sector: ${site.sector} / ${site.name}\n\n${prompt}`});modal.close();};
    input.focus();
  }
  function interact() {
    if(player.pos.z<30) return false;
    const site=SITES.find(s=>Math.hypot(s.x-player.pos.x,s.z+6-player.pos.z)<13);
    if(!site)return false;
    if(site.id==='hq') {travel('office');return true;}
    if(site.id==='home'||site.id==='cafe') {
      if(!store.empire.sectors.find(s=>s.id===site.id)?.built){openOperations(site.id);return true;}
      const close=h('button.btn',{},'Close');
      const modal=openModal(h('div.modal',{role:'dialog','aria-label':site.name},h('header',{},h('h2',{},site.name),close),h('div.body',{},
        h('p',{},`Energy ${Math.round(needs.energy)}% · Nourishment ${Math.round(needs.nourishment)}%`),
        h('button.btn',{onclick:()=>{needs.nourishment=100;saveNeeds();modal.close();toast('Meal enjoyed. Nourishment restored.','info');}},'Have a meal'),
        site.id==='home'?h('button.btn',{onclick:()=>{needs.energy=100;saveNeeds();modal.close();toast('Rested at home. Energy restored.','info');}},'Rest'):null,
        site.id==='home'?h('button.btn.primary',{onclick:()=>{modal.close();research();}},'Use research computer'):null,
        h('button.btn',{onclick:()=>{modal.close();openOperations(site.id);}},'Manage building'))));close.onclick=()=>modal.close();return true;
    }
    openOperations(site.id);return true;
  }
  function saveNeeds(){try{localStorage.setItem('agent-empire.needs',JSON.stringify(needs));}catch{}}
  let elapsed=0;
  return {openOperations,interact,update(dt:number){
    elapsed+=dt;
    const near=SITES.find(site=>Math.hypot(site.x-player.pos.x,site.z+6-player.pos.z)<13);
    caption.textContent=player.driving?`${keyLabel(player.bindings.forward)} / ${keyLabel(player.bindings.backward)} accelerate / reverse · ${keyLabel(player.bindings.left)} / ${keyLabel(player.bindings.right)} steer`:player.pos.z>=30&&near?`${keyLabel(player.bindings.interact)} · ${near.id==='hq'?'Enter office':near.name}`:`${[player.bindings.forward,player.bindings.backward,player.bindings.left,player.bindings.right].map(keyLabel).join(' ')} move · drag to look · Settings to remap`;
    if(elapsed<.5)return;
    needs.energy=Math.max(0,needs.energy-elapsed*.015);needs.nourishment=Math.max(0,needs.nourishment-elapsed*.02);elapsed=0;
    const s=store.empire;const minutes=Math.floor(s.minutes%1440);
    status.textContent=`Day ${Math.floor(s.minutes/1440)+1} · ${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')} · ${s.delegated?'Chief of staff on duty':'CEO oversight'}\nEnergy ${Math.round(needs.energy)}% · Food ${Math.round(needs.nourishment)}%`;
    const ctx=map.getContext('2d')!;ctx.fillStyle='#173c3c';ctx.fillRect(0,0,240,200);
    const px=(x:number)=>120+x*1.8,pz=(z:number)=>12+(z-30)*1.85;
    ctx.fillStyle='#46706c';ctx.fillRect(108,5,24,188);ctx.fillRect(12,pz(58),216,15);ctx.fillRect(12,pz(86),216,15);
    SITES.forEach(site=>{const built=s.sectors.find(v=>v.id===site.id)?.built;ctx.fillStyle=built?'#ccdbca':'#547370';ctx.fillRect(px(site.x)-17,pz(site.z)-9,34,18);ctx.fillStyle='#edf2de';ctx.font='9px system-ui';ctx.textAlign='center';ctx.fillText(site.id.toUpperCase(),px(site.x),pz(site.z)+23);});
    ctx.fillStyle='#f2c66d';ctx.beginPath();ctx.arc(px(player.pos.z<30?-24:player.pos.x),pz(player.pos.z<30?48:player.pos.z),4,0,Math.PI*2);ctx.fill();
  }};
}
function metric(label:string,value:string){return h('div',{},h('strong',{},value),h('span',{},label));}
