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
