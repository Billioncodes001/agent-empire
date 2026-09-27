/** Disposable UI QA only: every provider request is intercepted locally; no real API or process runs. */
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/server/config.js';
import {startServer} from '../src/server/server.js';
import {initialEmpire} from '../src/shared/empire.js';
const root=mkdtempSync(path.join(tmpdir(),'empire-execution-qa-'));
const project=path.join(root,'Execution-QA');mkdirSync(project);
const cfg=loadConfig([project,'--host','127.0.0.1','--port','4617','--password','execution-qa-only']);
const city=initialEmpire();city.setup={completed:true,selected:[],completedAt:Date.now()};
writeFileSync(path.join(cfg.dataDir,'empire.json'),JSON.stringify(city));
writeFileSync(path.join(cfg.dataDir,'queue.json'),JSON.stringify({tasks:[],maxWorkers:0}));
const sessions=new Map<string,{id:string,status:string,archived_at:string|null,started:number,budget:unknown,usage:{list_cost:{amount:string,currency:string}}}>();
let dispatched=0;
const reply=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const transport:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));const method=init?.method||'GET';
 if(url.hostname==='api.github.com'){
  if(url.pathname==='/repos/fixture/example')return reply({full_name:'fixture/example',archived:false,disabled:false});
  if(url.pathname==='/repos/fixture/example/commits/main')return reply({sha:'a'.repeat(40)});
 }
 if(url.hostname==='api.anthropic.com'){
  if(url.pathname==='/v1/agents/agent_fixture01')return reply({id:'agent_fixture01',type:'agent',version:1,archived_at:null,tools:[{type:'agent_toolset_20260401'}]});
  if(url.pathname==='/v1/environments/env_fixture01')return reply({id:'env_fixture01',archived_at:null,config:{type:'cloud'}});
  if(url.pathname==='/v1/sessions'&&method==='POST'){
   const id=`sesn_fixture${String(++dispatched).padStart(4,'0')}`;
   const requested=JSON.parse(String(init?.body));
   const session={id,status:'running',archived_at:null,started:Date.now(),budget:requested.budget,usage:{list_cost:{amount:'12',currency:'USD'}}};sessions.set(id,session);return reply(session);
  }
  const match=/^\/v1\/sessions\/(sesn_fixture\d+)(\/events|\/archive)?$/.exec(url.pathname);
  const s=match&&sessions.get(match[1]);
  if(match&&s){
   if(Date.now()-s.started>3000)s.status='idle';
   if(match[2]==='/events'&&method==='POST'){s.status='idle';return reply({data:[]});}
   if(match[2]==='/archive'&&method==='POST'){s.archived_at=new Date().toISOString();return reply(s);}
   if(match[2]==='/events')return reply({data:[{id:'sevt_fixture0001',type:s.status==='idle'?'session.status_idle':'session.status_running',processed_at:new Date().toISOString(),...(s.status==='idle'?{stop_reason:{type:'end_turn'}}:{})}],next_page:null});
   return reply(s);
  }
 }
 throw new Error('Unexpected fixture provider request; external network is disabled.');
};
const app=await startServer(cfg,{publicDir:path.resolve('dist/public'),backgroundServices:false,requireExecutionSetup:true,execution:{apiKey:()=> 'fixture-key',githubToken:()=> 'fixture-github',fetch:transport,pollIntervalMs:5000},workers:{taskNaming:false,resolveCommand:()=>null,processExists:()=>false,spawn:()=>{throw new Error('Real workers disabled in QA');}}});
const setup=app.execution.setup();app.execution.updateSetup({...setup.config,mode:'anthropic_cloud',repository:{owner:'fixture',name:'example',baseBranch:'main'},anthropic:{agentId:'agent_fixture01',environmentId:'env_fixture01'}});
console.log(JSON.stringify({url:'http://localhost:4617',password:'execution-qa-only',project,notice:'Fake provider; no paid API calls'}));
process.on('SIGTERM',()=>{app.shutdown();setTimeout(()=>process.exit(),250);});
process.on('SIGINT',()=>{app.shutdown();setTimeout(()=>process.exit(),250);});
