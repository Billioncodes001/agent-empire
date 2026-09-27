/** Authenticated real-server QA with a disposable Git project and no executable workers. */
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadConfig} from '../src/server/config.js';
import {startServer} from '../src/server/server.js';
import {initialEmpire} from '../src/shared/empire.js';
const resume=process.env.CONTINUITY_FIXTURE_ROOT;
const root=resume || mkdtempSync(path.join(tmpdir(),'empire-continuity-preview-'));
if (!path.basename(root).startsWith('empire-continuity-preview-') || !path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Only this disposable fixture root may be resumed.');
const project=path.join(root,'project'),laptop=path.join(root,'laptop');if (!resume) mkdirSync(project);
const git=(dir:string,...args:string[])=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
if (!resume) {
git(project,'init','-b','main');git(project,'config','user.name','QA fixture');git(project,'config','user.email','qa@example.invalid');
writeFileSync(path.join(project,'result.txt'),'original\n');git(project,'add','.');git(project,'commit','-m','fixture base');
const base=git(project,'rev-parse','HEAD');git(root,'clone',project,laptop);writeFileSync(path.join(laptop,'result.txt'),'local work must survive\n');
}
const cfg=loadConfig([project,'--host','127.0.0.1','--port','4614','--password','continuity-qa-only']);
if (!resume) {
const base=git(project,'rev-parse','HEAD');
const wt='.agent-office/worktrees/fixture';git(project,'worktree','add','-b','office/fixture',wt);
writeFileSync(path.join(project,wt,'result.txt'),'completed host work\n');git(path.join(project,wt),'commit','-am','fixture result');
writeFileSync(path.join(cfg.dataDir,'workers.json'),JSON.stringify([{id:'fixture-result',kind:'agent',deskId:'desk-1',name:'Published work fixture',color:'#54bab6',createdBy:'Fixture',createdAt:Date.now(),processState:'stopped',worktree:{path:wt,branch:'office/fixture',base,from:'main'}}]));
writeFileSync(path.join(cfg.dataDir,'queue.json'),JSON.stringify({tasks:[],maxWorkers:0}));
const state=initialEmpire();state.setup={completed:true,selected:[],completedAt:Date.now()};writeFileSync(path.join(cfg.dataDir,'empire.json'),JSON.stringify(state));
}
const app=await startServer(cfg,{publicDir:path.resolve('dist/public'),backgroundServices:false,workers:{taskNaming:false,resolveCommand:()=>'/disabled/fixture',processExists:()=>false,spawn:()=>{throw new Error('Provider execution disabled in QA fixture');}}});
console.log(JSON.stringify({url:'http://localhost:4614',laptop,project,password:'continuity-qa-only'}));
process.on('SIGTERM',()=>{app.shutdown();setTimeout(()=>process.exit(),300);});
process.on('SIGINT',()=>{app.shutdown();setTimeout(()=>process.exit(),300);});
