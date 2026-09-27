package com.agentempire.mobile;
public final class HostPolicyTest {
    public static void main(String[] args) {
        check(HostPolicy.validate(" https://City.Example:443/ ").equals("https://city.example"));
        check(HostPolicy.validate("https://city.example:8443").equals("https://city.example:8443"));
        for (String bad : new String[]{"http://city.example", "javascript:alert(1)", "file:///tmp/index.html", "https://user:token@city.example", "https://city.example/?token=x", "https://city.example/#secret", "https://city.example/login", "https://city.example:0", "https://city.example:65536", "//city.example", "https://city.example\\@other.example"}) {
            try { HostPolicy.validate(bad); throw new AssertionError("Accepted invalid host: " + bad); } catch (IllegalArgumentException expected) {}
        }
        check(HostPolicy.allows("https://city.example", "https://city.example/login?next=%2F"));
        check(HostPolicy.allows("https://city.example", "https://CITY.example:443/#world"));
        for (String bad : new String[]{"https://city.example.evil.test", "https://city.example@evil.test", "https://evil.test", "http://city.example", "https://city.example:444", "intent://city.example", "file:///tmp/test", "data:text/html,hello"}) check(!HostPolicy.allows("https://city.example", bad));
        System.out.println("HostPolicy: normalization, credentials, paths, schemes and origin isolation passed");
    }
    private static void check(boolean result) { if (!result) throw new AssertionError(); }
}
