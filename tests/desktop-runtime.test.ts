import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../src/server/config';
import {startServer} from '../src/server/server';

test('execution routes require session and origin, keep setup secrets out, and gate local workers',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'empire-setup-http-'));
 const pub=path.join(root,'public');mkdirSync(pub);writeFileSync(path.join(pub,'index.html'),'fixture');
 const cfg=loadConfig([root,'--host','127.0.0.1','--password','fixture-only']);cfg.port=0;
 let launches=0,requests=0;
 const app=await startServer(cfg,{publicDir:pub,backgroundServices:false,requireExecutionSetup:true,execution:{apiKey:()=>undefined,githubToken:()=>undefined,fetch:async()=>{requests++;throw new Error('Network forbidden in fixture');}},workers:{taskNaming:false,resolveCommand:()=>null,processExists:()=>false,spawn:()=>{launches++;throw new Error('No real process allowed');}}});
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 try{
  assert.equal((await fetch(base+'/api/execution/setup')).status,401);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'fixture-only'})});
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const headers={'content-type':'application/json',cookie,origin:base};
  const setup=await (await fetch(base+'/api/execution/setup',{headers})).json();
  assert.equal(setup.config.completed,false);
  assert.match(String(app.workers.spawn('desk-1','fixture','do nothing')),/Choose where/);
  assert.equal((await fetch(base+'/api/execution/setup',{method:'PUT',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(setup.config)})).status,403);
  assert.equal((await fetch(base+'/api/execution/setup',{method:'PUT',headers,body:JSON.stringify({...setup.config,apiKey:'must-not-save'})})).status,400);
  const cloud={...setup.config,completed:true,mode:'anthropic_cloud',repository:{owner:'fixture',name:'repo',baseBranch:'main'},anthropic:{agentId:'agent_fixture',environmentId:'env_fixture'}};
  const saved=await fetch(base+'/api/execution/setup',{method:'PUT',headers,body:JSON.stringify(cloud)});assert.equal(saved.status,200,await saved.clone().text());
  assert.match(String(app.workers.spawn('desk-1','fixture','do nothing')),/Provider cloud/);
  const checked=await fetch(base+'/api/execution/check',{method:'POST',headers});assert.equal(checked.status,200);
  const state=await checked.json();assert.equal(state.ready,false);assert.equal(requests,0);assert.equal(launches,0);
  const tasks=await (await fetch(base+'/api/execution/tasks',{headers})).json();assert.deepEqual(tasks,{tasks:[]});
 }finally{app.shutdown();await new Promise(r=>setTimeout(r,25));rmSync(root,{recursive:true,force:true});}
});
