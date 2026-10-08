import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/**
 * `vite build --mode fixture` (npm run build:client:fixture) is the only build that may point the GitHub client at a
 * loopback fake (VITE_AGENT_EMPIRE_FAKE_GITHUB_API, simulator checks). It writes to dist/public-fixture and carries a
 * marker that packaging refuses (tools/check-no-fixture.mjs). Every other build defines no override at all and refuses
 * to run with the variable set, so a fixture origin can never land in dist/public.
 */
const FIXTURE_MARKER = '__AGENT_EMPIRE_FIXTURE_BUILD__';
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}$/;
/**
 * The game's own version (one version for everything: docs/team/RELEASE_PLAN.md), from package.json. The page reads it
 * as __AGENT_EMPIRE_GAME_VERSION__; the native shells read game-version.json at the bundle root to know which game
 * they carry, and check that an installed update's file names the version they were asked to install (REL-04).
 */
const GAME_VERSION: string = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')).version;
/**
 * REL-07: development page builds (the dev server and fixture builds) also trust the public development release key, so
 * the local update fixture works; production builds trust only the owner's key and must not even carry the dev key
 * string (tools/check-no-fixture.mjs refuses dist/public when it does). Read from src/shared/release-key.ts here so no
 * client module imports it.
 */
const DEV_RELEASE_PUBLIC_KEY = /export const DEV_RELEASE_PUBLIC_KEY = '([A-Za-z0-9+/]{43}=)';/.exec(readFileSync(resolve(import.meta.dirname, 'src/shared/release-key.ts'), 'utf8'))?.[1];
if (!DEV_RELEASE_PUBLIC_KEY) throw new Error('src/shared/release-key.ts must declare DEV_RELEASE_PUBLIC_KEY as a string literal.');
const gameVersionFile = (): Plugin => ({
  name: 'agent-empire-game-version',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'game-version.json', source: `${JSON.stringify({ version: GAME_VERSION })}\n` });
  },
});

export default defineConfig(({ mode, command }) => {
  const fake = process.env.VITE_AGENT_EMPIRE_FAKE_GITHUB_API?.trim();
  const fixture = mode === 'fixture';
  if (fixture && (!fake || !LOOPBACK.test(fake))) throw new Error('A fixture build needs VITE_AGENT_EMPIRE_FAKE_GITHUB_API=http://127.0.0.1:<port>.');
  if (!fixture && fake) throw new Error('VITE_AGENT_EMPIRE_FAKE_GITHUB_API is set: unset it, or build a fixture with `npm run build:client:fixture` (writes dist/public-fixture).');
  // Renamed with the VITE_PUBLIC_ prefix below; fail loudly instead of silently ignoring a fork's OAuth App id.
  if (process.env.VITE_AGENT_EMPIRE_GITHUB_CLIENT_ID) throw new Error('VITE_AGENT_EMPIRE_GITHUB_CLIENT_ID was renamed: set VITE_PUBLIC_AGENT_EMPIRE_GITHUB_CLIENT_ID instead.');
  return {
  root: resolve(import.meta.dirname, 'src/client'),
  publicDir: resolve(import.meta.dirname, 'src/client/public'),
  // The override never reaches import.meta.env; only the define below carries it, and only in fixture mode.
  envPrefix: 'VITE_PUBLIC_',
  define: {
    __AGENT_EMPIRE_FIXTURE__: fixture ? JSON.stringify({ marker: FIXTURE_MARKER, api: fake }) : 'undefined',
    __AGENT_EMPIRE_GAME_VERSION__: JSON.stringify(GAME_VERSION),
    __AGENT_EMPIRE_DEV_UPDATE_KEY__: fixture || command === 'serve' ? JSON.stringify(DEV_RELEASE_PUBLIC_KEY) : 'undefined',
  },
  plugins: [gameVersionFile()],
  build: {
    outDir: resolve(import.meta.dirname, fixture ? 'dist/public-fixture' : 'dist/public'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: {
        consultancy: resolve(import.meta.dirname, 'src/client/consultancy.html'),
        main: resolve(import.meta.dirname, 'src/client/index.html'),
        login: resolve(import.meta.dirname, 'src/client/login.html'),
        claim: resolve(import.meta.dirname, 'src/client/claim.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // Not the string shorthand: that sets changeOrigin, so /api would see Host :4600 while /ws sees
      // Vite's port, and the session cookie (named per port, see auth.ts) would never reach the socket.
      '/api': { target: 'http://localhost:4600', changeOrigin: false },
      '/ws': { target: 'ws://localhost:4600', ws: true },
    },
  },
  };
});
