import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('desktop/runtime', {recursive:true});
await copyFile('dist/server/server/device-sync.js', 'desktop/runtime/device-sync.js');
