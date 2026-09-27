import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {WebSocket, type RawData} from 'ws';
import {loadConfig} from '../src/server/config';
import {startServer} from '../src/server/server';
import type {WorkerRuntime} from '../src/server/workers';
import type {ClientMsg, QueueState, ServerMsg} from '../src/shared/protocol';

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
  const cloud={...setup.config,completed:true,mode:'anthropic_cloud',repository:{owner:'fixture',name:'repo',baseBranch:'main'},anthropic:{agentId:'agent_fixture1',environmentId:'env_fixture1'}};
  const saved=await fetch(base+'/api/execution/setup',{method:'PUT',headers,body:JSON.stringify(cloud)});assert.equal(saved.status,200,await saved.clone().text());
  assert.match(String(app.workers.spawn('desk-1','fixture','do nothing')),/Provider cloud/);
  const checked=await fetch(base+'/api/execution/check',{method:'POST',headers});assert.equal(checked.status,200);
  const state=await checked.json();assert.equal(state.ready,false);assert.equal(requests,0);assert.equal(launches,0);
  const tasks=await (await fetch(base+'/api/execution/tasks',{headers})).json();assert.deepEqual(tasks,{tasks:[]});
 }finally{app.shutdown();await new Promise(r=>setTimeout(r,25));rmSync(root,{recursive:true,force:true});}
});

test('founding briefs require positive queue approval after execution setup, not before it',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'empire-setup-queue-'));
 const pub=path.join(root,'public');mkdirSync(pub);writeFileSync(path.join(pub,'index.html'),'fixture');
 const cfg=loadConfig([root,'--host','127.0.0.1','--password','fixture-only']);cfg.port=0;
 let launches=0,requests=0;
 const runtime:WorkerRuntime={
  taskNaming:false,resolveCommand:()=>'/fixture/claude',processExists:()=>false,
  spawn:(()=>{
   launches++;
   let onExit:((event:{exitCode:number})=>void)|undefined;
   return {pid:900000+launches,onData:()=>({dispose(){}}),onExit:(callback:typeof onExit)=>{onExit=callback;return {dispose(){}};},write(){},resize(){},kill(){onExit?.({exitCode:0});}};
  }) as WorkerRuntime['spawn'],
 };
 const app=await startServer(cfg,{publicDir:pub,backgroundServices:false,requireExecutionSetup:true,workers:runtime,execution:{apiKey:()=>undefined,githubToken:()=>undefined,fetch:async()=>{requests++;throw new Error('Network forbidden in fixture');}}});
 const base=`http://127.0.0.1:${(app.server.address() as {port:number}).port}`;
 let ws:WebSocket|undefined;
 let queue:QueueState={maxWorkers:0,tasks:[]};
 const message=(predicate:(msg:ServerMsg)=>boolean):Promise<ServerMsg>=>new Promise((resolve,reject)=>{
  const socket=ws!;
  const cleanup=()=>{clearTimeout(timer);socket.off('message',received);socket.off('error',failed);};
  const received=(raw:RawData)=>{const msg=JSON.parse(raw.toString()) as ServerMsg;if(predicate(msg)){cleanup();resolve(msg);}};
  const failed=(error:Error)=>{cleanup();reject(error);};
  const timer=setTimeout(()=>{cleanup();reject(new Error('Expected fixture WebSocket response did not arrive'));},3000);
  socket.on('message',received);socket.once('error',failed);
 });
 const send=(msg:ClientMsg)=>ws!.send(JSON.stringify(msg));
 const barrier=async(text:string)=>{const reply=message(msg=>msg.t==='chat'&&msg.text===text);send({t:'chat',text});await reply;};
 try{
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'fixture-only'})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  const headers={'content-type':'application/json',cookie,origin:base};
  ws=new WebSocket(base.replace('http','ws')+'/ws',{origin:base,headers:{cookie}});
  ws.on('message',raw=>{const msg=JSON.parse(raw.toString()) as ServerMsg;if(msg.t==='welcome')queue=msg.queue;else if(msg.t==='queue')queue=msg.state;});
  await message(msg=>msg.t==='welcome');
  assert.equal(queue.maxWorkers,0);

  const founded=message(msg=>msg.t==='queue'&&msg.state.tasks.length===2);
  send({t:'empire.action',action:{kind:'found',sites:['cafe']}});
  await founded;
  const foundingIds=queue.tasks.map(task=>task.id);
  assert.ok(queue.tasks.every(task=>task.status==='queued'&&task.jobKey?.startsWith('empire-manager-')));
  assert.equal(launches,0);

  const rejected=message(msg=>msg.t==='toast'&&/Choose where workers run/.test(msg.text));
  send({t:'queue.limit',maxWorkers:1});
  await rejected;
  assert.equal(queue.maxWorkers,0,'a rejected positive limit must not become deferred approval');
  send({t:'queue.limit',maxWorkers:0});
  await barrier('paused before setup');
  assert.equal(launches,0);

  const setup=await (await fetch(base+'/api/execution/setup',{headers})).json();
  const saved=await fetch(base+'/api/execution/setup',{method:'PUT',headers,body:JSON.stringify({...setup.config,completed:true,mode:'local'})});
  assert.equal(saved.status,200,await saved.clone().text());
  // Reordering real pending briefs invokes the queue pump without granting launch approval.
  send({t:'queue.move',taskId:foundingIds[0],delta:1});
  await barrier('setup saved and queue pumped');
  assert.equal(queue.maxWorkers,0);
  assert.equal(launches,0,'saving setup and pumping pending briefs must not start a worker');
  assert.deepEqual(new Set(queue.tasks.map(task=>task.id)),new Set(foundingIds));
  assert.ok(queue.tasks.every(task=>task.status==='queued'&&!task.workerId));

  const started=message(msg=>msg.t==='queue'&&msg.state.tasks.some(task=>task.status==='running'&&!!task.workerId));
  send({t:'queue.limit',maxWorkers:1});
  await started;
  assert.equal(queue.maxWorkers,1);
  assert.equal(launches,1,'only the explicit post-setup queue approval starts a fake worker');
  assert.equal(queue.tasks.filter(task=>task.status==='running').length,1);
  assert.equal(queue.tasks.filter(task=>task.status==='queued').length,1);
  assert.equal(requests,0);
 }finally{
  ws?.terminate();
  const closed=new Promise<void>(resolve=>app.server.once('close',()=>resolve()));
  app.shutdown();await closed;rmSync(root,{recursive:true,force:true});
 }
});
