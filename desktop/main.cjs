const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync, writeFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const {createVault}=require('./credential-vault.cjs');
const {startLocalHost}=require('./local-host.cjs');
process.env.PATH = ['/opt/homebrew/bin','/usr/local/bin',process.env.PATH].filter(Boolean).join(path.delimiter);
let localHost, vault;
const stopLocal=()=>{localHost?.shutdown();localHost=undefined;};
let win, origin, syncEngine, busy = false, syncTimer;
const launcher = pathToFileURL(path.join(__dirname, 'launch.html')).href;
const configPath = () => path.join(app.getPath('userData'), 'connection.json');
function readConfig() { try { return JSON.parse(readFileSync(configPath(), 'utf8')); } catch { return {}; } }
function saveConfig(value) { writeFileSync(configPath(), JSON.stringify(value), {mode:0o600}); }
const request = (url, init = {}) => win.webContents.session.fetch(origin + url, {...init, credentials:'include', redirect:'error', signal:AbortSignal.timeout(60000), headers:{...init.headers,Origin:origin}});
async function json(url, init) { return JSON.parse((await syncEngine.readBounded(await request(url,init), 4*1024*1024)).toString()); }
async function synchronize(automatic = false) {
  if (busy || !origin) return;
  const config = readConfig(); if (!config.repo || config.origin !== origin) { if (!automatic) await configureSync(); return; }
  busy = true;
  try {
    const list = await json('/api/sync/artifacts');
    syncEngine.pinServer(config.repo,origin,list.serverId);
    let imported = 0, conflicts = 0;
    for (const value of list.artifacts) {
      const m = syncEngine.validateManifest(value,list.serverId);
      const bytes = await syncEngine.readBounded(await request(m.bundle.url),syncEngine.MAX_BUNDLE_BYTES);
      const receipt = syncEngine.importArtifact(config.repo,m,bytes,list.serverId);
      if (!receipt.reused) imported++;
      conflicts += receipt.conflicts.length;
    }
    if (!automatic || imported) await dialog.showMessageBox(win,{type:'info',message:`${imported} new worktree${imported===1?'':'s'} ready for review`,detail:`${conflicts} overlapping local file changes. Your active branch and edits were preserved.\nUse File → Open sync inbox to inspect the work.`});
  } catch (error) {
    // Authentication on launch may not be ready; explicit sync always exposes the failure.
    if (!automatic || !String(error.message).includes('(401)')) await dialog.showMessageBox(win,{type:'warning',message:'Synchronization needs attention',detail:error.message});
  } finally { busy = false; }
}
async function configureSync() {
  if (!origin) return;
  try {
    const list = await json('/api/sync/artifacts');
    const chosen = await dialog.showOpenDialog(win,{title:'Choose the laptop project repository',properties:['openDirectory']});
    if (chosen.canceled) return;
    const decision = await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Trust host and enable sync'],defaultId:0,cancelId:0,
      message:'Import published work from this host?',detail:`${origin}\nHost ID: ${list.serverId}\n\nNew work goes into isolated review worktrees. Nothing is merged into your active branch. Reopening the app will check for published work.`,checkboxLabel:'Also check for new published work every minute while this app is open',checkboxChecked:false});
    if (decision.response !== 1) return;
    syncEngine.pinServer(chosen.filePaths[0],origin,list.serverId,list.serverId);
    saveConfig({...readConfig(),origin,repo:chosen.filePaths[0],autoSync:decision.checkboxChecked});
    startSyncTimer(); await synchronize();
  } catch(error) { await dialog.showMessageBox(win,{type:'error',message:'Could not configure synchronization',detail:error.message}); }
}
function startSyncTimer() {
  clearInterval(syncTimer);
  if (readConfig().autoSync) syncTimer = setInterval(()=>void synchronize(true),60000);
}
async function publish() {
  try {
    const feed = await json('/api/continuity/events?after=0');
    const workers = (feed.snapshot?.workers || []).filter(w=>w.kind==='agent'&&w.processState==='stopped'&&w.worktree).slice(0,12);
    if (!workers.length) return dialog.showMessageBox(win,{message:'No stopped worker worktrees to publish',detail:'Commit the worker’s changes and stop its process first. A finished turn can still leave the process running.'});
    const choice = await dialog.showMessageBox(win,{message:'Publish committed work for device sync',detail:'Only clean, stopped worker worktrees can be published. Uncommitted work stays on the host.',buttons:['Cancel',...workers.map(w=>`${w.name} · ${w.id}`)],defaultId:0,cancelId:0});
    if (!choice.response) return;
    await json('/api/sync/artifacts',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workerId:workers[choice.response-1].id})});
    await synchronize();
  } catch(error) { await dialog.showMessageBox(win,{type:'warning',message:'Work was not published',detail:error.message}); }
}
function menu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{role:'appMenu'}]:[]),
    {label:'File',submenu:[
      {label:'Choose city or host…',click:()=>showLauncher()},
      {label:'Provider credentials…',click:()=>showLauncher()},
      {label:'Configure laptop synchronization…',click:()=>void configureSync()},
      {label:'Synchronize published work',click:()=>void synchronize()},
      {label:'Publish stopped worker work…',click:()=>void publish()},
      {label:'Open sync inbox',click:async()=>{const c=readConfig();if(c.repo) await shell.openPath(syncEngine.syncDirectory(c.repo));}},
      {type:'separator'},{role:'close'}]},
    {role:'editMenu'},{label:'View',submenu:[{role:'reload'},{role:'togglefullscreen'}]},
    {label:'Help',submenu:[{label:'How continuity works',click:()=>dialog.showMessageBox(win,{message:'The host runs your agents',detail:'The local city and its assets are bundled with this app. Local workers stop when the app quits. Submitted provider-cloud jobs run independently; their status is refreshed when you return. Cloud outputs are not automatically imported yet. Remote host sync imports explicitly published code into review worktrees. Voice and screen capture are available through your browser.'})}]}
  ]));
}
async function connect(value, local = undefined) {
  if (busy) throw new Error('Wait for the current synchronization to finish before changing hosts.');
  const next = syncEngine.validateServerUrl(value);
  const previous = readConfig();
  if(!local && localHost){
    if(localHost.hasLocalWorkers())throw new Error('Stop or reconcile local workers before connecting to another host.');
    stopLocal();
  }
  origin = next;
  const partition = local ? 'persist:local-' + createHash('sha256').update(local.project).digest('hex').slice(0,20) : 'persist:host-' + createHash('sha256').update(origin).digest('hex').slice(0,20);
  const ses = session.fromPartition(partition);
  ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  ses.setPermissionCheckHandler(()=>false);
  if (local) {
    const response=await ses.fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json',Origin:origin},body:JSON.stringify({password:local.password}),redirect:'error'});
    if(!response.ok)throw new Error('The local city could not authenticate.');
  }
  const old=win;
  win=new BrowserWindow({width:1400,height:900,minWidth:390,minHeight:600,title:'Agent Empire',backgroundColor:'#111a20',webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin) event.preventDefault();});
  win.webContents.on('will-redirect',(event,url)=>{if(new URL(url).origin!==origin) event.preventDefault();});
  win.webContents.on('did-fail-load',(_event,code)=>{if(code!==-3)win.setTitle('Agent Empire · host unavailable — reload to reconnect');});
  let checked=false;
  win.webContents.on('did-finish-load',()=>{if(!checked&&new URL(win.webContents.getURL()).pathname==='/'){checked=true;void synchronize(true);}});
  win.on('closed',()=>{clearInterval(syncTimer);});
  saveConfig(local ? {...previous,localProject:local.project,localPort:local.port,lastMode:'local'} : {localProject:previous.localProject,localPort:previous.localPort,...(previous.origin===origin?previous:{origin}),lastMode:'remote'});
  old?.close(); menu();startSyncTimer();
  await win.loadURL(origin);
}
function showLauncher() {
  if (busy) return;
  clearInterval(syncTimer);origin=undefined;
  const old=win;
  win=new BrowserWindow({width:760,height:900,minWidth:580,minHeight:600,resizable:true,title:'Agent Empire',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',(e,url)=>{if(url!==launcher)e.preventDefault();});
  old?.close();menu();void win.loadURL(launcher);
}
app.setName('Agent Empire');
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
else app.whenReady().then(async()=>{
  syncEngine=await import('./runtime/device-sync.js');
  vault=createVault(path.join(app.getPath('userData'),'provider-credentials.enc'),safeStorage);
  const fromLauncher=event=>{if(event.senderFrame?.url!==launcher)throw new Error('Request denied.');};
  ipcMain.handle('launcher-state',event=>{fromLauncher(event);const c=readConfig();let credentials;try{credentials=vault.status();}catch(error){credentials={error:error.message};}return {origin:c.origin,project:c.localProject,credentials};});
  ipcMain.handle('save-credentials',(event,value)=>{fromLauncher(event);try{vault.save(value);return {message:'Credentials saved securely on this computer. No task was started.'};}catch(error){return {error:error.message};}});
  ipcMain.handle('open-local',async(event,choose)=>{
    fromLauncher(event);
    if(busy)return {error:'Wait for synchronization to finish.'};
    try{
      let project=readConfig().localProject||path.join(app.getPath('userData'),'city-project');
      if(choose){const picked=await dialog.showOpenDialog(win,{title:'Choose a Git project or empty folder for your city',properties:['openDirectory','createDirectory']});if(picked.canceled)return {};project=picked.filePaths[0];}
      if(localHost && localHost.project!==project)return {error:'Quit and reopen the app before switching the active local project.'};
      if(!localHost)localHost=await startLocalHost({project,runtimeDir:path.join(__dirname,'runtime'),credentials:()=>vault.read(),port:readConfig().localProject===project?readConfig().localPort:undefined});
      await connect(localHost.origin,localHost);return {ok:true};
    }catch(error){return {error:error.message};}
  });
  ipcMain.handle('connect',async(event,url)=>{
    if(event.senderFrame?.url!==launcher||typeof url!=='string') throw new Error('Connection request denied.');
    try { await connect(url); return {ok:true}; } catch(error) {return {error:error.message};}
  });

  showLauncher();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)showLauncher();});
});
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.on('before-quit',stopLocal);
app.on('window-all-closed',()=>{app.quit();});
