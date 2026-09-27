const path = require('node:path');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {pathToFileURL} = require('node:url');

/** Starts only the packaged runtime, on loopback, with a fresh in-memory office password. */
async function startLocalHost({project, runtimeDir, credentials}) {
  fs.mkdirSync(project,{recursive:true,mode:0o700});
  const git=(...args)=>execFileSync('git',args,{cwd:project,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  try { git('rev-parse','--git-dir'); }
  catch {
    if (fs.readdirSync(project).length) throw new Error('Choose an existing Git repository or an empty project directory.');
    try {git('init','-b','main');git('-c','user.name=Agent Empire','-c','user.email=local@agent-empire.invalid','commit','--allow-empty','-m','Create local city workspace');}
    catch {throw new Error('Git is required to prepare this project. Install Git, then reopen the app.');}
  }
  if (fs.realpathSync(git('rev-parse','--show-toplevel')) !== fs.realpathSync(project)) throw new Error('Choose the root of the Git project, not a subfolder.');
  const password=randomBytes(32).toString('base64url');
  const {loadConfig}=await import(pathToFileURL(path.join(runtimeDir,'server/server/config.js')).href);
  const {startServer}=await import(pathToFileURL(path.join(runtimeDir,'server/server/server.js')).href);
  const config=loadConfig([project,'--host','127.0.0.1','--port','4600','--password',password]);
  config.port=0;
  const host=await startServer(config,{publicDir:path.join(runtimeDir,'public'),backgroundServices:false,requireExecutionSetup:true,execution:{apiKey:()=>credentials().anthropicKey,githubToken:()=>credentials().githubToken}});
  const port=host.server.address().port;config.port=port;
  return {origin:`http://127.0.0.1:${port}`,password,shutdown:host.shutdown,project};
}
module.exports={startLocalHost};
