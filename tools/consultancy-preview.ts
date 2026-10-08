/** Isolated manual review fixture. No real worker process, provider call or Telegram connection. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.js';
import { scryptSync } from 'node:crypto';
import type { Config } from '../src/server/config.js';
import { syntheticParsed } from './research-fixture.js';
if (Number(process.env.PREVIEW_PORT) === 4610) throw new Error('Refusing the protected 4610 session; use an isolated preview port.');
const dataDir = mkdtempSync(path.join(tmpdir(),'empire-founder-preview-'));
writeFileSync(path.join(dataDir,'queue.json'),JSON.stringify({tasks:[],maxWorkers:0}));
// ORG-05: PREVIEW_RESEARCH=seed starts with one synthetic imported report (two tool proposals) in research.json.
if (process.env.PREVIEW_RESEARCH === 'seed') {
  const parsed = syntheticParsed();
  writeFileSync(path.join(dataDir,'research.json'),JSON.stringify({version:1,revision:1,reports:[{jobId:'consultancy-00000000f1c5',requestId:'research-preview-1',question:parsed.question,askedAt:Date.now()-86_400_000,askedBy:'Preview fixture',
    import:{taskId:'preview-task',attempt:0,at:Date.now()-3_600_000,worker:'Bea',ok:true,feasibility:parsed.feasibility,confidence:parsed.confidence,sources:parsed.sources,sections:parsed.sections},
    tools:parsed.tools.map((t,i)=>({...t,decision:i===0?'approved':'pending',...(i===0?{decidedAt:Date.now()-1_800_000,decidedBy:'CEO'}:{})}))}]}));
}
const cfg: Config = {dir:dataDir,dataDir,host:'127.0.0.1',port:Number(process.env.PREVIEW_PORT||4622),passwordGenerated:false,verifier:scryptSync('founder-preview',Buffer.alloc(16,2),32),salt:Buffer.alloc(16,2),secret:'isolated-founder-preview-only',claimed:true,markClaimed(){},agentCmd:'disabled-fixture',agentArgs:[],trustProxy:false,iceServers:[],budgetPause:false};
const host = await startServer(cfg,{publicDir:process.env.PREVIEW_PUBLIC||'/tmp/agent-empire-consultancy-preview',backgroundServices:false,telegram:false,workers:{taskNaming:false,resolveCommand:()=>null,processExists:()=>false,spawn(){throw new Error('Preview cannot launch workers');}}});
console.log('Isolated founder preview: http://127.0.0.1:'+cfg.port+'/consultancy.html (fixture password: founder-preview)');
for(const [requestId,client,title,brief] of [
 ['fixture-northstar','Northstar Studio','Customer booking portal','Build a clear booking journey for studio clients. Deliver accessible forms, availability and confirmation, with tests.'],
 ['fixture-harbour','Harbour Health','Patient intake workflow','Review the intake experience using synthetic sample data only. Propose an accessible workflow before implementation.'],
 ['fixture-atlas','Atlas Commerce','Storefront performance review','Measure current page performance and propose a prioritized improvement plan. Use fixture data only.'],
]) host.consultancy.create({requestId,client,title,brief,tasks:[{title:'Build the first version',prompt:brief},{title:'Iterate with the client',prompt:'Iterate on feedback. Fixture only.',phase:'iteration'},{title:'Accessibility and test pass',prompt:'Test the result. Fixture only.',phase:'testing',parallel:true},{title:'Field test with five users',prompt:'Field test. Fixture only.',phase:'field_testing'}]},'Preview fixture');
const jobs=host.consultancy.snapshot().jobs;host.consultancy.approve(jobs[0].id,'Preview fixture');
process.on('SIGINT',()=>{host.shutdown();});process.on('SIGTERM',()=>{host.shutdown();});
