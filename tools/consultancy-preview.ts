/** Isolated manual review fixture. No real worker process, provider call or Telegram connection. */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server/server.js';
import { scryptSync } from 'node:crypto';
import type { Config } from '../src/server/config.js';
if (Number(process.env.PREVIEW_PORT) === 4610) throw new Error('Refusing the protected 4610 session; use an isolated preview port.');
const dataDir = mkdtempSync(path.join(tmpdir(),'empire-founder-preview-'));
// ORG-04a (PREVIEW_OUTREACH=1): synthetic leads and campaigns. Each drafting task already finished for a reserved job id
// (nothing runs), its draft sits in this temp folder, and a fake transport records sends without any network.
const outreachOn = process.env.PREVIEW_OUTREACH === '1';
const JOBS = { autumn: 'consultancy-00000000a001', webinar: 'consultancy-00000000a002', spring: 'consultancy-00000000a003' };
const done = (id: string, job: string, worker: string) => ({ id, jobKey: `consultancy:${job}:item-1`, title: 'Draft the campaign', prompt: 'Preview fixture', addedBy: 'Preview fixture', addedAt: 1, status: 'done', outcome: 'done', workerName: worker, finishedAt: Date.now() - 600_000 });
writeFileSync(path.join(dataDir,'queue.json'),JSON.stringify({tasks:outreachOn ? [done('pv-a', JOBS.autumn, 'Wren'), done('pv-b', JOBS.webinar, 'Bea'), done('pv-c', JOBS.spring, 'Cyrus')] : [],maxWorkers:0}));
if (outreachOn) {
  mkdirSync(path.join(dataDir, 'docs/empire/campaigns'), { recursive: true });
  const art = (job: string, text: string) => writeFileSync(path.join(dataDir, 'docs/empire/campaigns', `${job}.md`), text);
  art(JOBS.autumn, '---\nsubject: You are invited, {{name}} — autumn open day\naudience: [customers]\n---\n\nHi {{name}},\n\nWe are opening the studio on 24 October for customers like {{company}}: short demos, the new booking tools, and coffee.\n\nReply to this email to save a place.\n\nThe Northstar team\n');
  art(JOBS.webinar, '---\nsubject: A 30-minute walkthrough for {{company}}\naudience: [events]\nproposedLeads:\n  - Fay Lin | fay@client-preview.example | Zed Works | trade show | met at stand 12\n  - Gus Ode | gus@client-preview.example | Lumen | inbound inquiry | asked for a demo\n---\n\nHi {{name}},\n\nWould a short walkthrough of the booking portal help {{company}}? Pick any slot next week.\n');
  art(JOBS.spring, '---\nsubject: Spring follow-up\naudience: [customers]\n---\n\nHello {{first_name}}, thanks again.\n');
}
const cfg: Config = {dir:dataDir,dataDir,host:'127.0.0.1',port:Number(process.env.PREVIEW_PORT||4622),passwordGenerated:false,verifier:scryptSync('founder-preview',Buffer.alloc(16,2),32),salt:Buffer.alloc(16,2),secret:'isolated-founder-preview-only',claimed:true,markClaimed(){},agentCmd:'disabled-fixture',agentArgs:[],trustProxy:false,iceServers:[],budgetPause:false};
const sentPreview: string[] = [];
const host = await startServer(cfg,{...(outreachOn ? { outreach: { config: { from: 'hello@northstar-preview.example', fromName: 'Northstar Studio', address: 'Northstar Studio Ltd, 14 Harbour Row, Bristol BS1 4XX, United Kingdom', dailyCap: 200, intervalMs: 3_600_000, problems: [] }, transport: { send: async (m: { to: string }) => { sentPreview.push(m.to); } } } } : {}),publicDir:process.env.PREVIEW_PUBLIC||'/tmp/agent-empire-consultancy-preview',backgroundServices:false,telegram:false,workers:{taskNaming:false,resolveCommand:()=>null,processExists:()=>false,spawn(){throw new Error('Preview cannot launch workers');}}});
console.log('Isolated founder preview: http://127.0.0.1:'+cfg.port+'/consultancy.html (fixture password: founder-preview)');
for(const [requestId,client,title,brief] of [
 ['fixture-northstar','Northstar Studio','Customer booking portal','Build a clear booking journey for studio clients. Deliver accessible forms, availability and confirmation, with tests.'],
 ['fixture-harbour','Harbour Health','Patient intake workflow','Review the intake experience using synthetic sample data only. Propose an accessible workflow before implementation.'],
 ['fixture-atlas','Atlas Commerce','Storefront performance review','Measure current page performance and propose a prioritized improvement plan. Use fixture data only.'],
]) host.consultancy.create({requestId,client,title,brief,tasks:[{title:'Build the first version',prompt:brief},{title:'Iterate with the client',prompt:'Iterate on feedback. Fixture only.',phase:'iteration'},{title:'Accessibility and test pass',prompt:'Test the result. Fixture only.',phase:'testing',parallel:true},{title:'Field test with five users',prompt:'Field test. Fixture only.',phase:'field_testing'}]},'Preview fixture');
const jobs=host.consultancy.snapshot().jobs;host.consultancy.approve(jobs[0].id,'Preview fixture');
process.on('SIGINT',()=>{host.shutdown();});process.on('SIGTERM',()=>{host.shutdown();});

if (outreachOn) {
  const o = host.outreach;
  o.importCsv(['name,email,company,source,basis,tags',
    'Ann Lee,ann.lee@client-preview.example,Harbor Labs,inbound inquiry,existing customer,customers',
    'Bob Ray,bob.ray@client-preview.example,Atlas Commerce,conference contact,legitimate interest,customers events',
    'Cleo Park,cleo@client-preview.example,Orbit Health,referral,existing customer,customers',
    'Dev Shah,dev@client-preview.example,Kite Labs,inbound inquiry,consent,customers events',
    'Eli Moss,eli@client-preview.example,Fjord Bank,existing customer,existing customer,customers'].join('\n'), 'Preview fixture');
  o.suppress('dev@client-preview.example', 'opt_out', 'Preview fixture', 'Replied STOP');
  const brief = 'Synthetic preview campaign. Fixture only.';
  for (const [key, title] of [['autumn', 'Autumn studio open day'], ['webinar', 'Booking portal walkthrough'], ['spring', 'Spring follow-up']] as const) {
    const c = o.createCampaign({ requestId: `pv-${key}`, title, brief }, 'Preview fixture', { jobId: JOBS[key] });
    const plan = host.inbox!.state().items.find((i) => i.kind === 'job_plan' && i.jobId === c.jobId)!;
    host.inbox!.approve(plan.id, 'Preview fixture');
  }
  o.createCampaign({ requestId: 'pv-winter', title: 'Winter newsletter', brief }, 'Preview fixture');
  host.consultancy.reconcile();
  o.reconcile();
  const autumn = host.inbox!.state().items.find((i) => i.kind === 'external_action' && i.title.includes('Autumn'))!;
  host.inbox!.approve(autumn.id, 'Preview fixture');
  console.log('Outreach preview: 4 campaigns (sending, awaiting approval, needs attention, drafting); the fake transport records sends only.');
}
