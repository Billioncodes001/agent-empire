const path = require('node:path');
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const {pathToFileURL} = require('node:url');

/** Starts only the packaged runtime, on loopback, with a fresh in-memory office password. */
async function startLocalHost({project, runtimeDir, credentials, secrets, port:preferredPort}) {
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
  config.port=Number.isInteger(preferredPort) && preferredPort > 1024 && preferredPort < 65536 ? preferredPort : 0;
  const host=await startServer(config,{publicDir:path.join(runtimeDir,'public'),backgroundServices:false,requireExecutionSetup:true,execution:{apiKey:()=>credentials().anthropicKey,githubToken:()=>credentials().githubToken},
    // FREE-01: sealed keys reach only their own engine's workers (env scrub); the panel sees names, never values.
    engines:{providerKeys:()=>{try{const c=credentials();return {ANTHROPIC_API_KEY:c.anthropicKey,OPENAI_API_KEY:c.openaiKey,OPENROUTER_API_KEY:c.openrouterKey,GEMINI_API_KEY:c.geminiKey,GROQ_API_KEY:c.groqKey};}catch{return {};}}},
    // FREE-08: onboarding's notification secrets go to the same OS credential vault; the page only sees "present".
    // Review 1: the desktop keeps its other background services off, but its notification channels deliver (start), and
    // ntfy/SMTP on this computer (loopback) are allowed for self-hosting.
    ...(secrets?{notify:{secrets,start:true,allowLocalTargets:true}}:{})});
  const port=host.server.address().port;config.port=port;
  return {origin:`http://127.0.0.1:${port}`,password,shutdown:host.shutdown,project,port,hasLocalWorkers:()=>host.workers.list().some(w=>w.processState==='running'||w.processState==='unknown')};
}
/**
 * Signs the bundled game into the local host with a device token (APP-01), using the in-memory office password.
 * The password changes every launch, which invalidates earlier device tokens, so this runs once per launch and
 * the token is kept in memory only.
 */
async function localDeviceSession(host, deviceName, fetchImpl=fetch) {
  const response=await fetchImpl(host.origin+'/api/device/login',{method:'POST',headers:{'content-type':'application/json',accept:'application/json'},body:JSON.stringify({password:host.password,deviceName:String(deviceName||'This computer').slice(0,64)}),redirect:'error'});
  const body=response.ok?await response.json().catch(()=>null):null;
  if(!body||typeof body.token!=='string'||!/^[A-Za-z0-9_-]{16,256}$/.test(body.token)||typeof body.deviceId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(body.deviceId))
    throw new Error('The Empire on this computer could not sign the app in.');
  return {host:host.origin,token:body.token,deviceId:body.deviceId};
}
module.exports={startLocalHost,localDeviceSession};
