import { mkdirSync, copyFileSync, cpSync, readFileSync, existsSync, rmSync } from 'node:fs';
import {execFileSync} from 'node:child_process';
const root='desktop/runtime';
mkdirSync(root,{recursive:true});
copyFileSync('dist/server/server/device-sync.js',`${root}/device-sync.js`);
for (const [from,to] of [['dist/server',`${root}/server`],['dist/public',`${root}/public`]]) {
  if (!existsSync(from)) throw new Error('Build the complete client and server before packaging desktop.');
  rmSync(to,{recursive:true,force:true});cpSync(from,to,{recursive:true});
}
const lock=readFileSync('package-lock.json','utf8');
const install=!existsSync(`${root}/node_modules`)||!existsSync(`${root}/package-lock.json`)||readFileSync(`${root}/package-lock.json`,'utf8')!==lock;
copyFileSync('package.json',`${root}/package.json`);copyFileSync('package-lock.json',`${root}/package-lock.json`);
if(install)execFileSync('npm',['ci','--prefix',root,'--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit'});
