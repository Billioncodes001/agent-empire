package com.agentempire.mobile;

/**
 * Debug variant only (REL-07): mobile/tools/build-android.py compiles src/debug/java into the debug APK and
 * src/release/java into the release APK, so the development key exists only in debug builds. Same string as
 * DEV_RELEASE_PUBLIC_KEY in src/shared/release-key.ts, whose private half is derived from a public seed: a debug build
 * trusts it so the local update fixture (tools/update-fixture.ts) works. The release gate refuses a release when this key
 * appears in src/main or src/release.
 */
final class DevTrust {
    private DevTrust() {}

    static final String DEV_RELEASE_PUBLIC_KEY = "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU=";
}
