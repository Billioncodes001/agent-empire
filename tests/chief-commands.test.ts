import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Consultancy } from '../src/server/consultancy.js';
import { chiefCommands } from '../src/server/chief-commands.js';
import type { QueueTask } from '../src/shared/protocol.js';

test('Telegram commands share durable client jobs and approval idempotency',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'empire-chief-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tasks:QueueTask[]=[];
 const queue={state:()=>({tasks,maxWorkers:0}),add:(prompt:string,by:string,title?:string,_issue?:number,jobKey?:string)=>{
  if(!tasks.some(t=>t.jobKey===jobKey))tasks.push({id:String(tasks.length),jobKey,prompt,addedBy:by,title:title??'',addedAt:Date.now(),status:'queued'});return undefined;
 }};
 const office=new Consultancy(dir,queue),chief=chiefCommands(office,()=> '4 funded desks');
 const initial=chief.summary();
 const reply=chief.execute('/new Northstar | Portal | Implement booking','telegram-1-100');assert.match(reply,/saved/);assert.equal(tasks.length,0);
 chief.execute('/new Northstar | Portal | Implement booking','telegram-1-100');assert.equal(office.snapshot().jobs.length,1);
 const job=office.snapshot().jobs[0];assert.match(chief.execute(`/job ${job.id}`,'telegram-1-101'),/Implement booking/);
 assert.notEqual(chief.summary().fingerprint,initial.fingerprint);
 assert.match(chief.execute(`/approve ${job.id}`,'telegram-1-102'),/queued/);chief.execute(`/approve ${job.id}`,'telegram-1-102');assert.equal(tasks.length,1);
 assert.match(chief.execute('/status','telegram-1-103'),/4 funded desks/);
 assert.match(chief.execute('rm -rf /','telegram-1-104'),/Use a command/);
 assert.match(chief.execute('/new invalid','telegram-1-105'),/Use \/new/);
 assert.match(chief.execute('/job absent','telegram-1-106'),/not found/);
 assert.doesNotMatch(chief.summary().text,/Implement booking/);
});

test('ORG-02 review: /approve ID 25 records that budget; trailing words are refused, never ignored',t=>{
 const dir=mkdtempSync(path.join(tmpdir(),'empire-chief-budget-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const tasks:QueueTask[]=[];
 const queue={state:()=>({tasks,maxWorkers:0}),add:(prompt:string,by:string,title?:string,_issue?:number,jobKey?:string)=>{tasks.push({id:String(tasks.length),jobKey,prompt,addedBy:by,title:title??'',addedAt:1,status:'queued'});return undefined;}};
 const office=new Consultancy(dir,queue,undefined,{estimate:()=>({costUsd:{low:1,high:4.2},calendarMs:{low:1,high:2},items:[{phase:'build',costUsd:{low:1,high:4.2},durationMs:{low:1,high:2},basis:{samples:0,source:'default'}}],basis:{samples:0,source:'default'},maxWorkers:1,estimatedAt:1})});
 const chief=chiefCommands(office,()=> 'desks');
 chief.execute('/new Northstar | Portal | Build','telegram-2-1');
 const job=office.snapshot().jobs[0];
 assert.match(chief.execute(`/job ${job.id}`,'telegram-2-2'),/Estimate \(not a quote\): \$1\.00–\$4\.20/);
 assert.match(chief.execute(`/approve ${job.id} 25 please`,'telegram-2-3'),/Use \/approve ID/);
 assert.equal(office.snapshot().jobs[0].decision,'pending_approval','nothing was approved');
 assert.match(chief.execute(`/approve ${job.id} 25`,'telegram-2-4'),/Approved budget \$25\.00/);
 assert.equal(office.snapshot().jobs[0].approvedBudgetUsd,25);
});
