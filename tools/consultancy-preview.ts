/** Isolated manual review fixture. No real worker process, provider call or Telegram connection. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.js';
import { scryptSync } from 'node:crypto';
import type { Config } from '../src/server/config.js';
const dataDir = mkdtempSync(path.join(tmpdir(),'empire-founder-preview-'));
writeFileSync(path.join(dataDir,'queue.json'),JSON.stringify({tasks:[],maxWorkers:0}));
const cfg: Config = {dir:dataDir,dataDir,host:'127.0.0.1',port:4622,passwordGenerated:false,verifier:scryptSync('founder-preview',Buffer.alloc(16,2),32),salt:Buffer.alloc(16,2),secret:'isolated-founder-preview-only',claimed:true,markClaimed(){},agentCmd:'disabled-fixture',agentArgs:[],trustProxy:false,iceServers:[],budgetPause:false};
const host = await startServer(cfg,{publicDir:'/tmp/agent-empire-consultancy-preview',backgroundServices:false,telegram:false,workers:{taskNaming:false,resolveCommand:()=>null,processExists:()=>false,spawn(){throw new Error('Preview cannot launch workers');}}});
console.log('Isolated founder preview: http://127.0.0.1:4622/consultancy.html (fixture password: founder-preview)');
for(const [requestId,client,title,brief] of [
 ['fixture-northstar','Northstar Studio','Customer booking portal','Build a clear booking journey for studio clients. Deliver accessible forms, availability and confirmation, with tests.'],
 ['fixture-harbour','Harbour Health','Patient intake workflow','Review the intake experience using synthetic sample data only. Propose an accessible workflow before implementation.'],
 ['fixture-atlas','Atlas Commerce','Storefront performance review','Measure current page performance and propose a prioritized improvement plan. Use fixture data only.'],
]) host.consultancy.create({requestId,client,title,brief},'Preview fixture');
const jobs=host.consultancy.snapshot().jobs;host.consultancy.approve(jobs[0].id,'Preview fixture');
process.on('SIGINT',()=>{host.shutdown();});process.on('SIGTERM',()=>{host.shutdown();});
