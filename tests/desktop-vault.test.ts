import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,statSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {createVault}=createRequire(import.meta.url)('../desktop/credential-vault.cjs');
const fakeCrypto={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s.split('').reverse().join('')),decryptString:(b:Buffer)=>b.toString().split('').reverse().join('')};
test('desktop vault returns flags only and refuses unprotected storage without replacing credentials',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'empire-vault-test-')),file=path.join(dir,'vault');
 try{
  const vault=createVault(file,fakeCrypto);
  assert.deepEqual(vault.save({anthropicKey:'test-anthropic',githubToken:'test-github'}),{available:true,anthropic:true,github:true});
  assert.equal(readFileSync(file,'utf8').includes('test-anthropic'),false);
  assert.equal(statSync(file).mode & 0o777,0o600);
  vault.save({anthropicKey:''});assert.equal(vault.read().anthropicKey,'test-anthropic');
  const before=readFileSync(file);
  assert.throws(()=>vault.save({anthropicKey:'bad\nkey'}));
  assert.throws(()=>vault.save({password:'not-allowed'}));
  assert.throws(()=>createVault(file,{...fakeCrypto,isEncryptionAvailable:()=>false}).save({githubToken:'changed'}));
  assert.throws(()=>createVault(file,{...fakeCrypto,getSelectedStorageBackend:()=> 'basic_text'}).save({githubToken:'changed'}));
  assert.deepEqual(readFileSync(file),before);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('desktop vault corruption fails closed instead of forgetting saved credentials',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'empire-vault-test-')),file=path.join(dir,'vault');
 try{writeFileSync(file,'broken');const vault=createVault(file,fakeCrypto);assert.throws(()=>vault.read(),/could not be opened/);assert.throws(()=>vault.save({githubToken:'new'}));assert.equal(readFileSync(file,'utf8'),'broken');}
 finally{rmSync(dir,{recursive:true,force:true});}
});
