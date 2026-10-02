#!/usr/bin/env node
import('../dist/server/server/device-sync-cli.js').then(m => m.syncCli(process.argv.slice(2))).catch(error => {
  console.error(`Sync: ${error.message}`);
  process.exitCode = 1;
});
