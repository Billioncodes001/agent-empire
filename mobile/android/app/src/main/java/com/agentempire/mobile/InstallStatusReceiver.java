package com.agentempire.mobile;

import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInstaller;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.util.Log;

/**
 * The system installer's answer for an app update (GameUpdater.installApk). Not exported: only the PendingIntent this
 * app handed to PackageInstaller can reach it, and the intent must carry the in-memory nonce of the session this app
 * started. The confirmation activity in EXTRA_INTENT is launched only when it resolves to the system package installer,
 * so a crafted intent can never make this app launch another activity on its behalf (security review #4).
 */
public final class InstallStatusReceiver extends BroadcastReceiver {
    private static final String TAG = "AgentEmpire";
    static final String EXTRA_NONCE = "com.agentempire.mobile.INSTALL_NONCE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !GameUpdater.INSTALL_ACTION.equals(intent.getAction())) return;
        if (!UpdatePolicy.installStatusAccepted(GameUpdater.installNonce, intent.getStringExtra(EXTRA_NONCE))) {
            Log.w(TAG, "Ignored an install status without this app's session nonce");
            return;
        }
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Integer.MIN_VALUE);
        if (status != PackageInstaller.STATUS_PENDING_USER_ACTION) {
            GameUpdater.installNonce = null; // the session is over
            if (status != PackageInstaller.STATUS_SUCCESS) Log.w(TAG, "App update not installed: " + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            return;
        }
        Intent confirm = confirmIntent(intent);
        if (confirm == null) return;
        ResolveInfo target = context.getPackageManager().resolveActivity(confirm, 0);
        boolean system = target != null && target.activityInfo != null && (target.activityInfo.applicationInfo.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
        if (target == null || !UpdatePolicy.isSystemInstaller(target.activityInfo.packageName, system)) {
            Log.w(TAG, "Refused an install confirmation that is not the system package installer");
            return;
        }
        confirm.setComponent(new android.content.ComponentName(target.activityInfo.packageName, target.activityInfo.name));
        confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(confirm);
        } catch (ActivityNotFoundException none) {
            Log.w(TAG, "No installer to confirm the app update");
        }
    }

    @SuppressWarnings("deprecation")
    private static Intent confirmIntent(Intent intent) {
        return Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class) : (Intent) intent.getParcelableExtra(Intent.EXTRA_INTENT);
    }
}
