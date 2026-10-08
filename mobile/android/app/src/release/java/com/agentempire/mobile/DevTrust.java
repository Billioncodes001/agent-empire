package com.agentempire.mobile;

/**
 * Release variant (REL-07): no development key. A release APK trusts only UpdatePolicy.RELEASE_PUBLIC_KEY, and
 * mobile/tools/build-android.py fails the build if the development key string appears anywhere in it. The debug variant's
 * copy is src/debug/java/com/agentempire/mobile/DevTrust.java.
 */
final class DevTrust {
    private DevTrust() {}

    static final String DEV_RELEASE_PUBLIC_KEY = null;
}
