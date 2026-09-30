package com.agentempire.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Secure storage for the bridge's allowlisted keys, without androidx.security.
 *
 * Each value is encrypted with AES-256-GCM under a non-exportable key held by the Android Keystore
 * (hardware-backed where the device offers it). The key name is bound as associated data, so a ciphertext cannot be
 * moved to another key. Only "v1:" + base64(iv || ciphertext) is written to a private SharedPreferences file, which
 * is excluded from backup (allowBackup=false and data_extraction_rules). If the Keystore key is lost (for example
 * after a device restore), the unreadable entry is deleted and reported as absent.
 *
 * Calls block on the Keystore; call them off the UI thread.
 */
final class SecureStore {
    private static final String TAG = "AgentEmpire";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "agent-empire.secure.v1";
    private static final String FILE = "agent_empire_secure";
    private static final String PREFIX = "v1:";
    private static final int IV_BYTES = 12, TAG_BITS = 128;

    private final SharedPreferences prefs;

    SecureStore(Context context) {
        prefs = context.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    synchronized String get(String key) {
        requireKey(key);
        String stored = prefs.getString(key, null);
        if (stored == null) return null;
        try {
            if (!stored.startsWith(PREFIX)) throw new IllegalStateException("unknown format");
            byte[] blob = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
            if (blob.length <= IV_BYTES) throw new IllegalStateException("short");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(TAG_BITS, blob, 0, IV_BYTES));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            return new String(cipher.doFinal(blob, IV_BYTES, blob.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (Exception unreadable) {
            Log.w(TAG, "Secure value for " + key + " could not be decrypted; removing it (" + unreadable.getClass().getSimpleName() + ")");
            prefs.edit().remove(key).commit();
            return null;
        }
    }

    synchronized void set(String key, String value) throws Exception {
        requireKey(key);
        if (!BridgePolicy.isValue(value)) throw new IllegalArgumentException("Value too long");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true)); // the Keystore chooses a fresh random IV
        cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = cipher.getIV();
        if (iv.length != IV_BYTES) throw new IllegalStateException("Unexpected IV length");
        byte[] blob = ByteBuffer.allocate(iv.length + sealed.length).put(iv).put(sealed).array();
        if (!prefs.edit().putString(key, PREFIX + Base64.encodeToString(blob, Base64.NO_WRAP)).commit())
            throw new IllegalStateException("Could not save");
    }

    synchronized void delete(String key) {
        requireKey(key);
        prefs.edit().remove(key).commit();
    }

    /** app.signedOut: removes every session credential in one write. */
    synchronized void clearSession() {
        SharedPreferences.Editor editor = prefs.edit();
        for (String key : BridgePolicy.SESSION_KEYS) editor.remove(key);
        editor.commit();
    }

    private static void requireKey(String key) {
        if (!BridgePolicy.isKey(key)) throw new IllegalArgumentException("Key not allowed");
    }

    private static SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance(KEYSTORE);
        store.load(null);
        KeyStore.Entry entry = store.getEntry(ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        if (!create) throw new IllegalStateException("No key");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }
}
