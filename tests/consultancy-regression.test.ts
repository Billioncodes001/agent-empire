import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Consultancy} from '../src/server/consultancy.js';

function setup(t:any){const dir=mkdtempSync(path.join(tmpdir(),'empire-consultancy-regression-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
const queue={state:()=>({tasks:[],maxWorkers:0}),add:()=> 'Paused fixture'};
const input={requestId:'regression-job',client:'Fixture',title:'Build portal',brief:'Fixture brief'};
test('every valid maximum-size multi-item plan can be restored',t=>{
 const dir=setup(t);const office=new Consultancy(dir,queue);
 const job=office.create({...input,tasks:Array.from({length:8},(_,i)=>({title:`Part ${i}`,prompt:'x'.repeat(8000)}))},'CEO');
 const restored=new Consultancy(dir,queue);
 assert.equal(restored.recoveryError,undefined);assert.equal(restored.snapshot().jobs[0].items.length,8);assert.equal(restored.snapshot().jobs[0].id,job.id);
});
test('corrupt empty work plan is refused on restore and cannot dispatch',t=>{
 const dir=setup(t);new Consultancy(dir,queue).create(input,'CEO');
 const file=path.join(dir,'consultancy.json');const data=JSON.parse(readFileSync(file,'utf8'));data.jobs[0].items=[];writeFileSync(file,JSON.stringify(data));
 let calls=0;const restored=new Consultancy(dir,{state:queue.state,add:()=>{calls++;return undefined;}});
 assert.ok(restored.recoveryError);assert.equal(calls,0);
});
test('failed queue persistence never reports a task as durably queued',t=>{
 const dir=setup(t);let error:string|undefined;const tasks:any[]=[];
 const q={state:()=>({tasks,maxWorkers:0,storageError:error}),add:(prompt:string,by:string,title?:string,_issue?:number,jobKey?:string)=>{tasks.push({id:'in-memory-only',jobKey,prompt,title,addedBy:by,addedAt:Date.now(),status:'queued'});error='Queue storage failed';return error;}};
 const office=new Consultancy(dir,q);const job=office.create(input,'CEO');office.approve(job.id,'CEO');
 const view=office.snapshot();assert.ok(view.storageError);assert.equal(view.jobs[0].status,'needs_attention');
});
test('observer errors cannot roll back a durably saved approval',t=>{
 const dir=setup(t);let throwObserver=false;const office=new Consultancy(dir,queue,()=>{if(throwObserver)throw new Error('observer unavailable');});
 const job=office.create(input,'CEO');throwObserver=true;
 try {office.approve(job.id,'CEO');} catch {}
 assert.equal(office.snapshot().jobs[0].decision,'approved');
 assert.equal(new Consultancy(dir,queue).snapshot().jobs[0].decision,'approved');
});
test('missing observed queue identity is not replaced by a different task with the same key',t=>{
 const dir=setup(t);const tasks:any[]=[];
 const q={state:()=>({tasks,maxWorkers:0}),add:(prompt:string,by:string,title?:string,_issue?:number,jobKey?:string)=>{tasks.push({id:'original',jobKey,prompt,title,addedBy:by,addedAt:Date.now(),status:'queued'});return undefined;}};
 const office=new Consultancy(dir,q);const job=office.create(input,'CEO');office.approve(job.id,'CEO');
 tasks[0]={...tasks[0],id:'replacement',status:'running'};office.reconcile();
 assert.equal(office.snapshot().jobs[0].status,'needs_attention');
});

test('journal write failure is exposed through recoveryError',t=>{
 const dir=setup(t);const office=new Consultancy(dir,queue);mkdirSync(path.join(dir,'consultancy.json'));
 assert.throws(()=>office.create(input,'CEO'));assert.ok(office.recoveryError);
});

test('saved approval cannot restore a changed work item or dispatch identity',t=>{
 for (const field of ['prompt','jobKey']) {
  const dir=setup(t);const office=new Consultancy(dir,queue);const job=office.create(input,'CEO');office.approve(job.id,'CEO');
  const file=path.join(dir,'consultancy.json');const data=JSON.parse(readFileSync(file,'utf8'));data.jobs[0].items[0][field]='changed';writeFileSync(file,JSON.stringify(data));
  let calls=0;const restored=new Consultancy(dir,{state:queue.state,add:()=>{calls++;return undefined;}});
  assert.ok(restored.recoveryError);assert.equal(calls,0);
 }
});
