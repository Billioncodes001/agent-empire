#!/usr/bin/env python3
"""Build the dependency-free Android shell using an existing SDK and JDK 17+.

No global installs or SDK licenses are changed. The generated development signing
key stays under ignored build/. Production signing is deliberately separate.
"""
import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import shutil
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--sdk', required=True, type=Path)
parser.add_argument('--jdk', required=True, type=Path)
args = parser.parse_args()
project = Path(__file__).resolve().parents[2]
android = project / 'mobile/android'
source = android / 'app/src/main'
build = android / 'build/portable'
build.mkdir(parents=True, exist_ok=True)
# Rebuild from source, without replacing the development signing identity.
for name in ['classes', 'generated', 'dex']:
    shutil.rmtree(build / name, ignore_errors=True)
for name in ['resources.zip', 'unsigned.apk', 'aligned.apk']:
    (build / name).unlink(missing_ok=True)
tools = args.sdk.resolve() / 'build-tools/35.0.0'
android_jar = args.sdk.resolve() / 'platforms/android-35/android.jar'
java = args.jdk.resolve() / 'bin/java'
javac = args.jdk.resolve() / 'bin/javac'
keytool = args.jdk.resolve() / 'bin/keytool'
for required in [java, javac, keytool, android_jar, tools / 'core-lambda-stubs.jar', tools / 'aapt2', tools / 'zipalign', tools / 'lib/d8.jar', tools / 'lib/apksigner.jar']:
    if not required.is_file(): raise SystemExit(f'Missing build tool: {required}')

def run(*command):
    subprocess.run([str(part) for part in command], cwd=android, check=True)

classes = build / 'classes'
classes.mkdir(exist_ok=True)
run(javac, '-d', classes, source / 'java/com/agentempire/mobile/HostPolicy.java', android / 'tests/HostPolicyTest.java')
run(java, '-cp', classes, 'com.agentempire.mobile.HostPolicyTest')
resources = build / 'resources.zip'
run(tools / 'aapt2', 'compile', '--dir', source / 'res', '-o', resources)
unsigned = build / 'unsigned.apk'
generated = build / 'generated'
generated.mkdir(exist_ok=True)
run(tools / 'aapt2', 'link', '-o', unsigned, '-I', android_jar, '--manifest', source / 'AndroidManifest.xml', '--java', generated, resources)
bootclasspath = os.pathsep.join([str(android_jar), str(tools / 'core-lambda-stubs.jar')])
run(javac, '-source', '8', '-target', '8', '-bootclasspath', bootclasspath, '-d', classes, *source.glob('java/**/*.java'), *generated.glob('**/*.java'))
dex = build / 'dex'
dex.mkdir(exist_ok=True)
# Exclude the desktop-only policy harness from the shipped app.
class_files = [file for file in classes.glob('**/*.class') if not file.name.startswith('HostPolicyTest')]
run(java, '-cp', tools / 'lib/d8.jar', 'com.android.tools.r8.D8', '--min-api', '26', '--lib', android_jar, '--output', dex, *class_files)
with zipfile.ZipFile(unsigned, 'a') as archive:
    for file in dex.glob('*.dex'): archive.write(file, file.name)
aligned = build / 'aligned.apk'
run(tools / 'zipalign', '-f', '-p', '4', unsigned, aligned)
keystore = build / 'development.keystore'
if not keystore.exists():
    run(keytool, '-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Agent Empire Development,O=Local Build,C=US')
    os.chmod(keystore, 0o600)
release = project / 'release/android'
release.mkdir(parents=True, exist_ok=True)
apk = release / 'Agent-Empire-android-development.apk'
run(java, '-jar', tools / 'lib/apksigner.jar', 'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, aligned)
run(java, '-jar', tools / 'lib/apksigner.jar', 'verify', '--verbose', apk)
run(tools / 'zipalign', '-c', '-p', '4', apk)
digest = hashlib.sha256(apk.read_bytes()).hexdigest()
apk.with_suffix('.apk.sha256').write_text(f'{digest}  {apk.name}\n')
print(f'Development APK: {apk}\nSHA256: {digest}\nSigned for local testing only; not a store release.')
