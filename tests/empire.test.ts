import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Empire } from '../src/server/empire.js';
import { DEFAULT_KEYS, sanitizeKeys, officeCode } from '../src/client/controls.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function fixture() { const dir=mkdtempSync(path.join(tmpdir(),'empire-test-'));return {dir,empire:new Empire(dir,()=>{}),close:()=>rmSync(dir,{recursive:true,force:true})}; }
test('construction charges once, staffing has capacity, and state survives a restart',()=>{
 const f=fixture();try {
  assert.equal(f.empire.action({kind:'build',site:'hospital'}),undefined);
  assert.equal(f.empire.state.funds,76000);
  assert.equal(f.empire.action({kind:'build',site:'hospital'}),'Already built');
  assert.equal(f.empire.state.funds,76000);
  for(let i=0;i<12;i++) assert.equal(f.empire.action({kind:'hire',site:'hospital'}),undefined);
  assert.equal(f.empire.action({kind:'hire',site:'hospital'}),'Team is at capacity');
  const restarted=new Empire(f.dir,()=>{});
  assert.deepEqual(restarted.state,f.empire.state);
 }finally{f.close();}
});
test('invalid actions and unaffordable construction cannot spend credits',()=>{
 const f=fixture();try {
  assert.equal(f.empire.action({kind:'hire',site:'school'}),'Build this site first');
  assert.equal(f.empire.action({kind:'build',site:'missing'} as any),'Unknown site');
  assert.equal(f.empire.action({kind:'delegate',enabled:'false'} as any),'Invalid delegation setting');
  f.empire.state.funds=0;
  assert.equal(f.empire.action({kind:'build',site:'school'}),'Insufficient simulation credits');
  assert.equal(f.empire.state.sectors.find(s=>s.id==='school')?.built,false);
 }finally{f.close();}
});
test('chief reports actual worker exceptions and bounded sector history',()=>{
 const f=fixture();try {
  f.empire.action({kind:'delegate',enabled:true});
  const workers=[{status:'needs_input'},{status:'working'},{status:'done'}] as WorkerInfo[];
  f.empire.tick(workers,{tasks:[],maxWorkers:3});
  assert.deepEqual(f.empire.state.workforce,{attention:1,working:1,done:1,queued:0});
  assert.ok(f.empire.state.reports.some(r=>r.sector==='Chief of staff'&&r.text.includes('need your input')));
  for(let i=0;i<100;i++) f.empire.tick(workers,{tasks:[],maxWorkers:3},30);
  assert.equal(f.empire.state.reports.length,80);
 }finally{f.close();}
});
test('controls use arrows, restore malformed saves, and remap without old-key actions',()=>{
 assert.equal(DEFAULT_KEYS.forward,'ArrowUp');
 assert.deepEqual(sanitizeKeys({forward:'KeyW'}),DEFAULT_KEYS);
 const remapped={...DEFAULT_KEYS,interact:'KeyQ'};
 assert.deepEqual(sanitizeKeys(remapped),remapped);
 assert.equal(officeCode('KeyQ',remapped),'KeyE');
 assert.equal(officeCode('KeyE',remapped),'');
 assert.deepEqual(sanitizeKeys({...DEFAULT_KEYS,left:'ArrowUp'}),DEFAULT_KEYS);
});
