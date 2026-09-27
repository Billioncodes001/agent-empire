import { mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const crossPackage = args.length > 0;
if (crossPackage && args.join(' ') !== '--platform=win32 --arch=x64') throw new Error('Supported target: --platform=win32 --arch=x64; omit flags to prepare the local desktop.');
const platform = crossPackage ? 'win32' : process.platform;
const arch = crossPackage ? 'x64' : process.arch;
// Cross packages have their own input and output trees; never replace a running macOS bundle.
const desktop = crossPackage ? path.join(project, 'release/staging/win32-x64/desktop') : path.join(project, 'desktop');
if (crossPackage) {
  rmSync(desktop, { recursive: true, force: true }); mkdirSync(desktop, { recursive: true });
  for (const name of ['package.json', 'main.cjs', 'local-host.cjs', 'credential-vault.cjs', 'preload.cjs', 'launch.html', 'launch.js', 'launch.css'])
    copyFileSync(path.join(project, 'desktop', name), path.join(desktop, name));
  copyFileSync(path.join(project, 'docs/PLATFORMS.md'), path.join(desktop, 'PLATFORMS.md'));
}
const root = path.join(desktop, 'runtime');
mkdirSync(root, { recursive: true });
for (const [from, to] of [['dist/server', 'server'], ['dist/public', 'public']]) {
  const source = path.join(project, from);
  if (!existsSync(source)) throw new Error('Build the complete client and server before packaging desktop.');
  rmSync(path.join(root, to), { recursive: true, force: true }); cpSync(source, path.join(root, to), { recursive: true });
}
copyFileSync(path.join(project, 'dist/server/server/device-sync.js'), path.join(root, 'device-sync.js'));
copyFileSync(path.join(project, 'THIRD_PARTY_NOTICES.md'), path.join(root, 'THIRD_PARTY_NOTICES.md'));
copyFileSync(path.join(project, 'docs/LICENSE-Tidewater.txt'), path.join(root, 'LICENSE-Tidewater.txt'));
const lock = readFileSync(path.join(project, 'package-lock.json'), 'utf8');
const marker = JSON.stringify({ platform, arch, lock: createHash('sha256').update(lock).digest('hex') });
const markerPath = path.join(root, '.target.json');
const install = !existsSync(path.join(root, 'node_modules')) || !existsSync(markerPath) || readFileSync(markerPath, 'utf8') !== marker;
copyFileSync(path.join(project, 'package.json'), path.join(root, 'package.json'));
copyFileSync(path.join(project, 'package-lock.json'), path.join(root, 'package-lock.json'));
if (install) {
  // npm's OS/CPU override selects optional native packages for the target, not this build host.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--prefix', root, '--omit=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund', `--os=${platform}`, `--cpu=${arch}`], { stdio: 'inherit' });
  writeFileSync(markerPath, marker);
}
const nativeRoot = path.join(root, 'node_modules/@lydell', `node-pty-${platform}-${arch}`);
if (!existsSync(path.join(nativeRoot, 'package.json'))) throw new Error(`Missing target PTY dependency: ${platform}-${arch}`);
if (crossPackage) {
  const binaries = verifyWindowsPty(nativeRoot);
  const { packager } = await import('../desktop/node_modules/@electron/packager/dist/index.js');
  const electronVersion = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')).devDependencies.electron;
  const outputs = await packager({ dir: desktop, name: 'Agent Empire', platform, arch, electronVersion, out: path.join(project, 'release/windows'), overwrite: true, prune: false, asar: false });
  const output = outputs[0];
  copyFileSync(path.join(project, 'docs/PLATFORMS.md'), path.join(output, 'READ-ME-PLATFORMS.md'));
  verifyWindowsPty(path.join(output, 'resources/app/runtime/node_modules/@lydell/node-pty-win32-x64'));
  assertWindowsX64(path.join(output, 'Agent Empire.exe'));
  const zip = `${output}.zip`;
  rmSync(zip, { force: true });
  execFileSync('zip', ['-q', '-r', zip, path.basename(output)], { cwd: path.dirname(output), stdio: 'inherit' });
  execFileSync('unzip', ['-tq', zip], { stdio: 'inherit' });
  const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
  writeFileSync(`${zip}.sha256`, `${sha256}  ${path.basename(zip)}\n`);
  writeFileSync(`${zip}.verification.json`, JSON.stringify({ platform, arch, sha256, nativeBinaries: binaries, executable: 'Agent Empire.exe', runtimeTested: false, note: 'Cross-packaged and PE/archive checked. Run the Windows smoke test before claiming Windows runtime support.' }, null, 2));
  console.log(`Windows ZIP: ${zip}\nSHA256: ${sha256}\nWindows runtime execution has not been tested on this build host.`);
}

function assertWindowsX64(file) {
  const bytes = readFileSync(file);
  const offset = bytes.readUInt32LE(0x3c);
  if (bytes.subarray(0, 2).toString() !== 'MZ' || bytes.subarray(offset, offset + 4).toString() !== 'PE\0\0' || bytes.readUInt16LE(offset + 4) !== 0x8664)
    throw new Error(`Expected a Windows x64 PE binary: ${file}`);
}
function verifyWindowsPty(dir) {
  const meta = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (meta.name !== '@lydell/node-pty-win32-x64' || !meta.os.includes('win32') || !meta.cpu.includes('x64')) throw new Error('Wrong PTY target package');
  const files = readdirSync(dir, { recursive: true }).filter(name => /\.(node|dll|exe)$/.test(name));
  if (!files.some(name => name.endsWith('.node'))) throw new Error('No native PTY addon was packaged');
  for (const name of files) {
    const file = path.join(dir, name); assertWindowsX64(file);
    if (name.endsWith('.node') && !readFileSync(file).includes(Buffer.from('napi_register_module_v1'))) throw new Error(`Expected a Node-API PTY addon: ${name}`);
  }
  return files;
}
