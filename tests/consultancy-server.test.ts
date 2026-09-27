import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.js';
import { Auth } from '../src/server/auth.js';
import type { Config } from '../src/server/config.js';
import type { WorkerRuntime } from '../src/server/workers.js';

async function fixture(t: any) {
  const dir = mkdtempSync(path.join(tmpdir(), 'empire-consultancy-server-'));
  writeFileSync(path.join(dir, 'queue.json'), JSON.stringify({tasks:[],maxWorkers:1}));
  const cfg: Config = {dir,dataDir:dir,host:'127.0.0.1',port:0,passwordGenerated:false,verifier:Buffer.alloc(32,1),salt:Buffer.alloc(16,2),secret:'fixture-only-secret',claimed:true,markClaimed(){},agentCmd:'claude',agentArgs:[],trustProxy:false,iceServers:[],budgetPause:false};
  let launches = 0;
  const childEnvs: Record<string,string>[] = [];
  const runtime: WorkerRuntime = {
    taskNaming:false, resolveCommand:() => '/fixture/claude', processExists:() => false,
    spawn: ((_command: string, _args: string[], options: {env:Record<string,string>}) => { childEnvs.push(options.env); launches++; let exit: ((v:{exitCode:number})=>void)|undefined; return {
      pid:8200 + launches,onData:()=>({dispose(){}}),onExit:(cb:typeof exit) => {exit=cb; return {dispose(){}};},
      write(){},resize(){},kill(){exit?.({exitCode:0});},
    }; }) as WorkerRuntime['spawn'],
  };
  let running = await startServer(cfg,{publicDir:dir,backgroundServices:false,workers:runtime,telegram:false});
  const connection = () => { const port = (running.server.address() as {port:number}).port; return {origin:`http://127.0.0.1:${port}`,cookie:`ao_session_${port}=${new Auth(cfg.verifier,cfg.salt,cfg.secret).issue()}`}; };
  t.after(async () => { await new Promise<void>(resolve=>{running.server.once('close',resolve);running.shutdown();}); rmSync(dir,{recursive:true,force:true}); });
  return {
    dir, get launches(){return launches;}, childEnvs, get office(){return running.consultancy;},
    async request(route:string, body?:unknown, headers: Record<string,string>|false = {}) {
      const {origin,cookie}=connection();
      return fetch(`${origin}/api/consultancy/${route}`,{method:body===undefined?'GET':'POST',headers:headers===false?{}:{cookie,origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    },
    async restart(){await new Promise<void>(resolve=>{running.server.once('close',resolve);running.shutdown();});running=await startServer(cfg,{publicDir:dir,backgroundServices:false,workers:runtime,telegram:false});},
  };
}
const brief = {requestId:'client-a-job-1',client:'Client A',title:'Portal',brief:'Build a fixture portal; do not invoke any external service.'};
test('consultancy API requires authentication and same-origin mutations',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request('jobs',undefined,false)).status,401);
  assert.equal((await f.request('jobs',brief,{origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.request('jobs',{})).status,400);
  assert.equal((await f.request('unknown')).status,404);
  assert.equal(f.launches,0);
});
test('approved jobs seat a worker with no game connected; another client stays independent',async t=>{
  const f=await fixture(t);
  const created=await f.request('jobs',brief); assert.equal(created.status,200); const job=await created.json();
  const other=await (await f.request('jobs',{...brief,requestId:'client-b-job-1',client:'Client B'})).json();
  assert.notEqual(job.id,other.id);assert.equal(f.launches,0);
  const approved=await f.request(`jobs/${job.id}/approve`,{});assert.equal(approved.status,200);
  assert.equal(f.launches,1);
  assert.equal((await f.request(`jobs/${job.id}/approve`,{})).status,200);assert.equal(f.launches,1);
  const state=await (await f.request('jobs')).json();
  assert.equal(state.jobs.find((j:any)=>j.id===other.id).status,'awaiting_approval');
  const status=await (await f.request('status')).json();assert.equal(status.resources.workers,1);assert.equal(status.telegram.configured,false);
  await f.restart();
  const restored=await (await f.request('jobs')).json();assert.equal(restored.jobs.length,2);assert.equal(f.launches,1);
  assert.equal(restored.jobs.find((j:any)=>j.id===job.id).status,'needs_attention');
});

test('Telegram host credentials are not inherited by task workers',async t=>{
  const keys=['AGENT_EMPIRE_TELEGRAM_TOKEN','AGENT_EMPIRE_TELEGRAM_OWNER_ID'] as const;
  const previous=keys.map(k=>process.env[k]);
  process.env[keys[0]]='fixture-secret-not-for-workers';process.env[keys[1]]='42';
  t.after(()=>{keys.forEach((k,i)=>{if(previous[i]===undefined)delete process.env[k];else process.env[k]=previous[i];});});
  const f=await fixture(t);const job=await (await f.request('jobs',brief)).json();
  await f.request(`jobs/${job.id}/approve`,{});
  assert.equal(f.childEnvs.length,1);
  for(const key of keys)assert.equal(f.childEnvs[0][key],undefined);
});

test('real queue journal failure remains visible and cannot start or bind a ghost task',async t=>{
  const f=await fixture(t);const job=await (await f.request('jobs',brief)).json();
  const queueFile=path.join(f.dir,'queue.json');rmSync(queueFile);mkdirSync(queueFile);
  const response=await f.request(`jobs/${job.id}/approve`,{});assert.equal(response.status,200);
  const state=await (await f.request('jobs')).json();
  assert.ok(state.storageError);assert.equal(state.jobs[0].status,'needs_attention');
  assert.equal(state.jobs[0].items[0].queueTaskId,undefined);assert.equal(f.launches,0);
  await assert.rejects(f.restart(), /Cannot restore queue/);
  assert.equal(f.launches,0);
});
