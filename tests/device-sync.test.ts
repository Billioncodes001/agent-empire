import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {importArtifact,pinServer,validateServerUrl,readBounded} from '../src/server/device-sync.js';
import type {SyncArtifactManifest} from '../src/shared/continuity.js';
const git=(dir:string,...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(){
 const dir=mkdtempSync(path.join(tmpdir(),'empire-device-')),remote=path.join(dir,'remote'),local=path.join(dir,'local');mkdirSync(remote);
 git(remote,'init','-b','main');git(remote,'config','user.name','Fixture');git(remote,'config','user.email','fixture@example.invalid');
 writeFileSync(path.join(remote,'work.txt'),'base\n');git(remote,'add','.');git(remote,'commit','-m','base');const base=git(remote,'rev-parse','HEAD');
 git(dir,'clone',remote,local);writeFileSync(path.join(remote,'work.txt'),'cloud\n');git(remote,'commit','-am','cloud work');
 const commit=git(remote,'rev-parse','HEAD'),bundle=path.join(dir,'work.bundle');git(remote,'bundle','create',bundle,'HEAD');const bytes=readFileSync(bundle),artifactId=createHash('sha256').update(bytes).digest('hex');
 const manifest:SyncArtifactManifest={schemaVersion:1,serverId:'test-host-identity',artifactId,createdAt:Date.now(),workerId:'worker-one',branch:'office/test',commit,base,bundle:{sha256:artifactId,bytes:bytes.length,ref:'HEAD',url:`/api/sync/artifacts/${artifactId}/bundle`}};
 return {dir,remote,local,manifest,bytes,close:()=>rmSync(dir,{recursive:true,force:true})};
}
test('imports cloud work without altering dirty laptop branch, index or files; detects overlap and reuses receipt',()=>{
 const f=fixture();try{
 writeFileSync(path.join(f.local,'work.txt'),'my local edit\n');writeFileSync(path.join(f.local,'new.txt'),'keep me');
 const before=git(f.local,'status','--porcelain'),head=git(f.local,'rev-parse','HEAD');
 pinServer(f.local,'https://empire.example.com',f.manifest.serverId,f.manifest.serverId);
 const receipt=importArtifact(f.local,f.manifest,f.bytes,f.manifest.serverId);
 assert.deepEqual(receipt.conflicts,['work.txt']);assert.equal(readFileSync(path.join(receipt.worktree,'work.txt'),'utf8'),'cloud\n');
 assert.equal(git(f.local,'status','--porcelain'),before);assert.equal(git(f.local,'rev-parse','HEAD'),head);assert.equal(readFileSync(path.join(f.local,'work.txt'),'utf8'),'my local edit\n');
 writeFileSync(path.join(receipt.worktree,'work.txt'),'review edit\n');
 assert.equal(importArtifact(f.local,f.manifest,f.bytes,f.manifest.serverId).reused,true);assert.equal(readFileSync(path.join(receipt.worktree,'work.txt'),'utf8'),'review edit\n');
 }finally{f.close();}
});
test('rejects substituted bytes, host identity and mismatched commit',()=>{
 const f=fixture();try{
 assert.throws(()=>importArtifact(f.local,f.manifest,Buffer.from('bad'),f.manifest.serverId),/hash or size/);
 assert.throws(()=>importArtifact(f.local,f.manifest,f.bytes,'other-host'),/identity/);
 assert.throws(()=>importArtifact(f.local,{...f.manifest,commit:f.manifest.base},f.bytes,f.manifest.serverId),/reference/);
 }finally{f.close();}
});
test('requires explicit host trust and refuses identity or origin changes',()=>{
 const f=fixture();try{
 assert.throws(()=>pinServer(f.local,'https://empire.example.com',undefined as unknown as string),/Invalid host identity/);
 assert.throws(()=>pinServer(f.local,'https://empire.example.com',f.manifest.serverId),/explicitly trust/);
 pinServer(f.local,'https://empire.example.com',f.manifest.serverId,f.manifest.serverId);
 assert.throws(()=>pinServer(f.local,'https://other.example.com',f.manifest.serverId,f.manifest.serverId),/identity changed/);
 assert.throws(()=>pinServer(f.local,'https://empire.example.com','other-host-identity','other-host-identity'),/identity changed/);
 }finally{f.close();}
});
test('does not invoke hooks configured in the laptop repository during checkout',()=>{
 const f=fixture();try{
 const hooks=path.join(f.dir,'hooks');mkdirSync(hooks);const marker=path.join(f.dir,'executed');
 writeFileSync(path.join(hooks,'post-checkout'),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});git(f.local,'config','core.hooksPath',hooks);
 importArtifact(f.local,f.manifest,f.bytes,f.manifest.serverId);assert.equal(existsSync(marker),false);
 }finally{f.close();}
});
test('rejects nonmatching repositories before checkout',()=>{
 const f=fixture();try{
 assert.throws(()=>importArtifact(f.local,{...f.manifest,base:'a'.repeat(40)},f.bytes,f.manifest.serverId),/base is not/);
 }finally{f.close();}
});
test('host URLs reject credentials, insecure remote HTTP and paths',()=>{
 for(const u of ['http://example.com','https://user:pw@example.com','https://example.com/path','https://example.com/?token=x','file:///tmp/a'])assert.throws(()=>validateServerUrl(u));
 assert.equal(validateServerUrl('http://localhost:4613'),'http://localhost:4613');
});
test('bounded downloads reject oversized and failed responses',async()=>{
 await assert.rejects(readBounded(new Response('too large'),2),/size limit/);
 await assert.rejects(readBounded(new Response('secret',{status:401}),100),/401/);
});
