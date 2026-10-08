#!/usr/bin/env python3
"""Build the Agent Empire Android game app with an existing SDK and JDK 17+, without Gradle or app libraries.

The built web client (dist/public, from `npm run build:client`) is bundled into the APK as assets/game and served
in-app at https://appassets.androidplatform.net/. Two variants:

  release  HTTPS only; not debuggable. Trusts only the owner's release key (REL-07): it compiles
           app/src/release/java (DevTrust without a key), and the build fails if the public development key appears
           anywhere in the APK.
  debug    debuggable (WebView remote debugging, debug-only test hooks) and cleartext allowed only to the local
           test hosts 10.0.2.2 / 127.0.0.1 / localhost through the src/debug/res network security config overlay.

Both are signed with a local development key kept under the ignored build/ folder (never an existing signing identity)
and are for sideloaded testing, not Google Play. No global installs, SDK licenses or network access.

Release builds (the release workflow, docs/RELEASING.md) can instead sign the release variant with the owner's upload
key: --release-keystore FILE --key-alias NAME, with the passwords read from the environment variables
ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_PASSWORD (never from the command line). --aab --bundletool JAR also builds
a Play App Bundle (Agent-Empire-android-release.aab), signed with the same key when one is given.
"""
import argparse
import hashlib
import re
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
parser.add_argument('--sdk', required=True, type=Path)
parser.add_argument('--jdk', required=True, type=Path)
parser.add_argument('--variant', choices=['release', 'debug', 'all'], default='all')
parser.add_argument('--game', type=Path, help='built web client folder (default: <repo>/dist/public)')
parser.add_argument('--release-keystore', type=Path, help='upload keystore for the release variant (passwords from env)')
parser.add_argument('--key-alias', help='key alias in --release-keystore')
parser.add_argument('--aab', action='store_true', help='also build a Play App Bundle of the release variant')
parser.add_argument('--bundletool', type=Path, help='bundletool-all jar, required with --aab')
args = parser.parse_args()
if args.release_keystore and not (args.key_alias and os.environ.get('ANDROID_KEYSTORE_PASSWORD') and os.environ.get('ANDROID_KEY_PASSWORD')):
    raise SystemExit('--release-keystore needs --key-alias and the ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_PASSWORD environment variables')
if args.release_keystore and not args.release_keystore.is_file():
    raise SystemExit(f'Missing release keystore: {args.release_keystore}')
if args.aab and not (args.bundletool and args.bundletool.is_file()):
    raise SystemExit('--aab needs --bundletool <bundletool-all.jar>')

project = Path(__file__).resolve().parents[2]
android = project / 'mobile/android'
source = android / 'app/src/main'
debug_res = android / 'app/src/debug/res'
# Per-variant sources (REL-07): app/src/debug/java has DevTrust with the public development key, app/src/release/java
# has DevTrust without one.
variant_java = lambda variant: android / f'app/src/{variant}/java'
dev_key_text = (project / 'tools/release/dev-release-public-key.txt').read_text(encoding='utf-8').strip()
if not re.fullmatch(r'[A-Za-z0-9+/]{43}=', dev_key_text):
    raise SystemExit('tools/release/dev-release-public-key.txt must hold one base64 key')
DEV_KEY = dev_key_text.encode('ascii')
build = android / 'build/portable'
game = (args.game or project / 'dist/public').resolve()
if not (game / 'index.html').is_file():
    raise SystemExit(f'Missing built game client: {game}/index.html\nRun `npm run build:client` first (it writes dist/public).')
# A fixture client (vite --mode fixture, fake GitHub API) must never be packaged.
for item in game.rglob('*'):
    if item.suffix.lower() in ('.js', '.mjs', '.html', '.json') and item.is_file():
        text = item.read_text(encoding='utf-8', errors='replace')
        if '__AGENT_EMPIRE_FIXTURE_BUILD__' in text or 'VITE_AGENT_EMPIRE_FAKE_GITHUB_API' in text or DEV_KEY.decode() in text:
            raise SystemExit(f'{item} is from a fixture or development build (fake GitHub, or trusts the development release key).\nRun `npm run build:client` first.')

tools = args.sdk.resolve() / 'build-tools/35.0.0'
android_jar = args.sdk.resolve() / 'platforms/android-35/android.jar'
java = args.jdk.resolve() / 'bin/java'
jarsigner = args.jdk.resolve() / 'bin/jarsigner'
javac = args.jdk.resolve() / 'bin/javac'
keytool = args.jdk.resolve() / 'bin/keytool'
for required in [java, javac, keytool, android_jar, tools / 'core-lambda-stubs.jar', tools / 'aapt2', tools / 'zipalign', tools / 'lib/d8.jar', tools / 'lib/apksigner.jar']:
    if not required.is_file():
        raise SystemExit(f'Missing build tool: {required}')


def run(*command):
    subprocess.run([str(part) for part in command], cwd=android, check=True)


build.mkdir(parents=True, exist_ok=True)
# Rebuild from source every time, keeping only the development signing identity.
for entry in build.iterdir():
    if entry.name != 'development.keystore':
        shutil.rmtree(entry) if entry.is_dir() else entry.unlink()

# 1. Stage the game as assets/game. Hidden files are never shipped (the asset loader refuses them anyway).
assets = build / 'assets'
shutil.copytree(game, assets / 'game', ignore=shutil.ignore_patterns('.*'))
game_files = sum(1 for p in (assets / 'game').rglob('*') if p.is_file())
game_bytes = sum(p.stat().st_size for p in (assets / 'game').rglob('*') if p.is_file())

# 2. Policy tests on the desktop JVM: origin, asset paths/traversal, MIME, injection, server address, bridge rules,
#    plus every staged game file being reachable with a known MIME type.
#    Run once per variant built, with that variant's DevTrust (the release run proves it trusts only the release key).
variants = ['release', 'debug'] if args.variant == 'all' else [args.variant]
policies = [source / f'java/com/agentempire/mobile/{name}.java' for name in ('AssetPolicy', 'ServerPolicy', 'BridgePolicy', 'UpdatePolicy', 'Ed25519')]
for variant in variants:
    tests = build / f'test-classes-{variant}'
    tests.mkdir()
    run(javac, '-d', tests, *policies, variant_java(variant) / 'com/agentempire/mobile/DevTrust.java', android / 'tests/PolicyTest.java')
    run(java, f'-Dae.variant={variant}', '-cp', tests, 'com.agentempire.mobile.PolicyTest', assets / 'game')

# 3. Resources, compiled once; the debug variant links the debug overlay on top.
compiled = build / 'res-main.zip'
run(tools / 'aapt2', 'compile', '--dir', source / 'res', '-o', compiled)
compiled_debug = build / 'res-debug.zip'
run(tools / 'aapt2', 'compile', '--dir', debug_res, '-o', compiled_debug)

keystore = build / 'development.keystore'
if not keystore.exists():
    run(keytool, '-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA',
        '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Agent Empire Development,O=Local Build,C=US')
    os.chmod(keystore, 0o600)

release_dir = project / 'release/android'
release_dir.mkdir(parents=True, exist_ok=True)
bootclasspath = os.pathsep.join([str(android_jar), str(tools / 'core-lambda-stubs.jar')])
for variant in variants:
    out = build / variant
    out.mkdir()
    unsigned = out / 'unsigned.apk'
    generated = out / 'generated'
    generated.mkdir()
    link = [tools / 'aapt2', 'link', '-o', unsigned, '-I', android_jar, '--manifest', source / 'AndroidManifest.xml', '--java', generated, '-A', assets, compiled]
    if variant == 'debug':
        link += ['-R', compiled_debug, '--auto-add-overlay', '--debug-mode']
    run(*link)
    classes = out / 'classes'
    classes.mkdir()
    run(javac, '-source', '8', '-target', '8', '-Xlint:-options', '-bootclasspath', bootclasspath, '-d', classes,
        *sorted(source.glob('java/**/*.java')), *sorted(variant_java(variant).glob('**/*.java')), *sorted(generated.glob('**/*.java')))
    dex = out / 'dex'
    dex.mkdir()
    run(java, '-cp', tools / 'lib/d8.jar', 'com.android.tools.r8.D8', '--debug' if variant == 'debug' else '--release', '--min-api', '26',
        '--lib', android_jar, '--output', dex, *sorted(classes.glob('**/*.class')))
    with zipfile.ZipFile(unsigned, 'a') as archive:
        for file in dex.glob('*.dex'):
            archive.write(file, file.name)
    aligned = out / 'aligned.apk'
    run(tools / 'zipalign', '-f', '-p', '4', unsigned, aligned)
    apk = release_dir / f'Agent-Empire-android-{variant}.apk'
    if variant == 'release' and args.release_keystore:
        run(java, '-jar', tools / 'lib/apksigner.jar', 'sign', '--ks', args.release_keystore.resolve(), '--ks-key-alias', args.key_alias,
            '--ks-pass', 'env:ANDROID_KEYSTORE_PASSWORD', '--key-pass', 'env:ANDROID_KEY_PASSWORD', '--out', apk, aligned)
    else:
        run(java, '-jar', tools / 'lib/apksigner.jar', 'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, aligned)
    run(java, '-jar', tools / 'lib/apksigner.jar', 'verify', '--verbose', apk)
    run(tools / 'zipalign', '-c', '-p', '4', apk)
    with zipfile.ZipFile(apk) as archive:
        names = set(archive.namelist())
        for required in ['assets/game/index.html', 'classes.dex', 'AndroidManifest.xml']:
            if required not in names:
                raise SystemExit(f'{apk.name} is missing {required}')
        shipped = sum(1 for n in names if n.startswith('assets/game/') and not n.endswith('/'))
        if shipped != game_files:
            raise SystemExit(f'{apk.name} has {shipped} game files, expected {game_files}')
        # REL-07: every entry, decompressed. The release APK must not carry the development key at all; the debug APK's
        # dex must (DevTrust from app/src/debug/java), or the local update fixture could not work.
        carriers = [n for n in sorted(names) if not n.endswith('/') and DEV_KEY in archive.read(n)]
        if variant == 'release' and carriers:
            raise SystemExit(f'{apk.name} carries the development release key in {", ".join(carriers[:5])}: a release build must trust only the release key')
        if variant == 'debug' and 'classes.dex' not in carriers:
            raise SystemExit(f'{apk.name}: classes.dex does not carry the development key (DevTrust from app/src/debug/java)')
        print(f'{variant} APK development-key check: ' + ('absent from every entry' if variant == 'release' else 'present in classes.dex (debug only)'))
    digest = hashlib.sha256(apk.read_bytes()).hexdigest()
    apk.with_suffix('.apk.sha256').write_text(f'{digest}  {apk.name}\n')
    print(f'{variant} APK: {apk}\n  SHA256: {digest}\n  size: {apk.stat().st_size / 1e6:.1f} MB, game: {game_files} files, {game_bytes / 1e6:.1f} MB')

    if variant == 'release' and args.aab:
        # App Bundle: link the same resources in protobuf format, lay them out as the base module, let bundletool
        # assemble the bundle, then sign it (Play re-signs installs with its app signing key).
        proto = out / 'proto.zip'
        run(tools / 'aapt2', 'link', '--proto-format', '-o', proto, '-I', android_jar, '--manifest', source / 'AndroidManifest.xml', '-A', assets, compiled)
        module = out / 'base.zip'
        with zipfile.ZipFile(proto) as linked, zipfile.ZipFile(module, 'w', zipfile.ZIP_DEFLATED) as base:
            for info in linked.infolist():
                if info.is_dir():
                    continue
                name = 'manifest/AndroidManifest.xml' if info.filename == 'AndroidManifest.xml' else info.filename
                base.writestr(name, linked.read(info.filename))
            for file in sorted(dex.glob('*.dex')):
                base.write(file, f'dex/{file.name}')
        aab = release_dir / 'Agent-Empire-android-release.aab'
        if aab.exists():
            aab.unlink()
        run(java, '-jar', args.bundletool.resolve(), 'build-bundle', f'--modules={module}', f'--output={aab}')
        run(java, '-jar', args.bundletool.resolve(), 'validate', f'--bundle={aab}')
        # REL-07: the Play bundle, like the release APK, must not carry the development key in any entry.
        with zipfile.ZipFile(aab) as bundle:
            carriers = [n for n in sorted(bundle.namelist()) if not n.endswith('/') and DEV_KEY in bundle.read(n)]
        if carriers:
            raise SystemExit(f'{aab.name} carries the development release key in {", ".join(carriers[:5])}')
        print('release AAB development-key check: absent from every entry')
        if args.release_keystore:
            run(jarsigner, '-keystore', args.release_keystore.resolve(), '-storepass:env', 'ANDROID_KEYSTORE_PASSWORD', '-keypass:env', 'ANDROID_KEY_PASSWORD',
                '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256', aab, args.key_alias)
            run(jarsigner, '-verify', aab)
        with zipfile.ZipFile(aab) as archive:
            names = set(archive.namelist())
            for required in ['base/manifest/AndroidManifest.xml', 'base/dex/classes.dex', 'base/assets/game/index.html', 'base/resources.pb']:
                if required not in names:
                    raise SystemExit(f'{aab.name} is missing {required}')
        digest = hashlib.sha256(aab.read_bytes()).hexdigest()
        aab.with_suffix('.aab.sha256').write_text(f'{digest}  {aab.name}\n')
        print(f'release AAB: {aab}\n  SHA256: {digest}\n  signed: {"upload key" if args.release_keystore else "NO (unsigned; Play rejects it)"}')
if args.release_keystore:
    print('Release variant signed with the provided upload key; the debug variant uses the local development key.')
else:
    print('Signed with a local development key for sideloaded testing only; not a store release.')
