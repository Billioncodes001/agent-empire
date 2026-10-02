package com.agentempire.mobile;

import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Ed25519 signature verification (RFC 8032 section 5.1.7), following the RFC's section 6 reference code.
 *
 * Android has no software Ed25519 an app can use with an imported key on every supported version (Android Keystore's
 * only handles keys kept in the Keystore, and Conscrypt on Android 15 has none), so the shell carries its own. It only
 * verifies: every input (release key, signed file, signature) is public, so constant time is not needed.
 */
final class Ed25519 {
    private Ed25519() {}

    private static final BigInteger TWO = BigInteger.valueOf(2); // BigInteger.TWO needs API 33
    private static final BigInteger P =BigInteger.ONE.shiftLeft(255).subtract(BigInteger.valueOf(19));
    /** Order of the base point. */
    private static final BigInteger L = BigInteger.ONE.shiftLeft(252).add(new BigInteger("27742317777372353535851937790883648493"));
    private static final BigInteger D = BigInteger.valueOf(-121665).multiply(inv(BigInteger.valueOf(121666))).mod(P);
    private static final BigInteger SQRT_M1 = TWO.modPow(P.subtract(BigInteger.ONE).shiftRight(2), P);
    private static final BigInteger[] BASE;
    static {
        BigInteger y = BigInteger.valueOf(4).multiply(inv(BigInteger.valueOf(5))).mod(P);
        BigInteger x = recoverX(y, 0);
        BASE = new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
    }

    /** True only for a valid signature by the 32-byte public key over the message. */
    static boolean verify(byte[] publicKey, byte[] message, byte[] signature) {
        if (publicKey == null || signature == null || message == null || publicKey.length != 32 || signature.length != 64) return false;
        BigInteger[] a = decompress(publicKey, 0);
        BigInteger[] r = decompress(signature, 0);
        if (a == null || r == null) return false;
        BigInteger s = littleEndian(signature, 32);
        if (s.compareTo(L) >= 0) return false;
        MessageDigest sha512;
        try {
            sha512 = MessageDigest.getInstance("SHA-512");
        } catch (NoSuchAlgorithmException impossible) {
            return false;
        }
        sha512.update(signature, 0, 32);
        sha512.update(publicKey);
        sha512.update(message);
        BigInteger h = littleEndian(sha512.digest(), 0, 64).mod(L);
        return equal(multiply(s, BASE), add(r, multiply(h, a)));
    }

    private static BigInteger inv(BigInteger x) {
        return x.modPow(P.subtract(TWO), P);
    }

    private static BigInteger littleEndian(byte[] bytes, int offset) {
        return littleEndian(bytes, offset, 32);
    }

    private static BigInteger littleEndian(byte[] bytes, int offset, int length) {
        byte[] big = new byte[length];
        for (int i = 0; i < length; i++) big[i] = bytes[offset + length - 1 - i];
        return new BigInteger(1, big);
    }

    private static BigInteger recoverX(BigInteger y, int sign) {
        if (y.compareTo(P) >= 0) return null;
        BigInteger y2 = y.multiply(y);
        BigInteger x2 = y2.subtract(BigInteger.ONE).multiply(inv(D.multiply(y2).add(BigInteger.ONE))).mod(P);
        if (x2.signum() == 0) return sign == 1 ? null : BigInteger.ZERO;
        BigInteger x = x2.modPow(P.add(BigInteger.valueOf(3)).shiftRight(3), P);
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) x = x.multiply(SQRT_M1).mod(P);
        if (x.multiply(x).subtract(x2).mod(P).signum() != 0) return null;
        if (x.testBit(0) != (sign == 1)) x = P.subtract(x);
        return x;
    }

    /** Extended coordinates (X, Y, Z, T) of an encoded point, or null when the encoding is not a curve point. */
    private static BigInteger[] decompress(byte[] bytes, int offset) {
        BigInteger value = littleEndian(bytes, offset);
        int sign = value.testBit(255) ? 1 : 0;
        BigInteger y = value.clearBit(255);
        BigInteger x = recoverX(y, sign);
        if (x == null) return null;
        return new BigInteger[] {x, y, BigInteger.ONE, x.multiply(y).mod(P)};
    }

    private static BigInteger[] add(BigInteger[] p, BigInteger[] q) {
        BigInteger a = p[1].subtract(p[0]).multiply(q[1].subtract(q[0])).mod(P);
        BigInteger b = p[1].add(p[0]).multiply(q[1].add(q[0])).mod(P);
        BigInteger c = p[3].multiply(TWO).multiply(D).multiply(q[3]).mod(P);
        BigInteger d = p[2].multiply(TWO).multiply(q[2]).mod(P);
        BigInteger e = b.subtract(a), f = d.subtract(c), g = d.add(c), h = b.add(a);
        return new BigInteger[] {e.multiply(f).mod(P), g.multiply(h).mod(P), f.multiply(g).mod(P), e.multiply(h).mod(P)};
    }

    private static BigInteger[] multiply(BigInteger s, BigInteger[] point) {
        BigInteger[] result = {BigInteger.ZERO, BigInteger.ONE, BigInteger.ONE, BigInteger.ZERO};
        BigInteger[] addend = point;
        for (int i = 0; i < s.bitLength(); i++) {
            if (s.testBit(i)) result = add(result, addend);
            addend = add(addend, addend);
        }
        return result;
    }

    private static boolean equal(BigInteger[] p, BigInteger[] q) {
        return p[0].multiply(q[2]).subtract(q[0].multiply(p[2])).mod(P).signum() == 0
            && p[1].multiply(q[2]).subtract(q[1].multiply(p[2])).mod(P).signum() == 0;
    }
}
