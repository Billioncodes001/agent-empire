import Foundation

/// Pure rules for in-app updates (docs/team/RELEASE_PLAN.md, REL-04), Foundation only, so Checks/run.sh covers them on
/// the Mac. GameUpdater applies them to files and downloads. Same rules as desktop/bridge-policy.cjs,
/// desktop/update-store.cjs and Android UpdatePolicy.java.
enum UpdatePolicy {
    /// The pinned release key (src/shared/release-key.ts; listed in tools/release/config.json pinnedKeyFiles so the
    /// release gate checks this copy). While it is the development key, a Debug build honours the loopback update
    /// fixture; the page verifies channel signatures against the same key.
    static let devReleasePublicKey = "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU="
    static let releasePublicKey = "q7m8HRpNA8EClSZsC3KSzzInRy3LxrjPIXNU41+WLYU="
    static var releaseKeyIsDevelopment: Bool { releasePublicKey == devReleasePublicKey }

    /// Releases come only from this repository (src/client/update/channel.ts RELEASE_REPO).
    static let releaseRepo = "Billioncodes001/agent-empire"
    static let releasesAPI = "https://api.github.com/repos/\(releaseRepo)/releases?per_page=20"
    static let assetRedirectHosts: Set<String> = ["objects.githubusercontent.com", "release-assets.githubusercontent.com"]
    static let appleHosts: Set<String> = ["apps.apple.com", "testflight.apple.com", "itunes.apple.com"]
    static let bootTimeout: TimeInterval = 20
    static let maxTextBytes = 6 * 1024 * 1024
    static let maxZipBytes = 512 * 1024 * 1024
    static let maxUnpackedBytes = 1024 * 1024 * 1024
    static let maxEntries = 20_000

    // MARK: versions

    private static let identifier = "(?:0|[1-9][0-9]{0,8}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    private static let semverPattern = "^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(?:-(\(identifier)(?:\\.\(identifier))*))?$"

    static func isSemver(_ v: String?) -> Bool {
        guard let v, v.count <= 64 else { return false }
        return v.range(of: semverPattern, options: .regularExpression) != nil
    }

    static func isSha256(_ v: String?) -> Bool {
        guard let v else { return false }
        return v.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    private static func parts(_ v: String) -> (core: [Int], pre: [String]) {
        let split = v.split(separator: "-", maxSplits: 1).map(String.init)
        let core = split[0].split(separator: ".").map { Int($0) ?? 0 }
        let pre = split.count > 1 ? split[1].split(separator: ".").map(String.init) : []
        return (core, pre)
    }

    /// SemVer 2.0 precedence: <0, 0, >0. Both must be valid versions.
    static func compare(_ a: String, _ b: String) -> Int {
        let x = parts(a), y = parts(b)
        for i in 0..<3 where x.core[i] != y.core[i] { return x.core[i] < y.core[i] ? -1 : 1 }
        if x.pre.isEmpty || y.pre.isEmpty { return (x.pre.isEmpty ? 0 : -1) + (y.pre.isEmpty ? 0 : 1) }
        for i in 0..<max(x.pre.count, y.pre.count) {
            if i >= x.pre.count { return -1 }
            if i >= y.pre.count { return 1 }
            let p = x.pre[i], q = y.pre[i]
            if p == q { continue }
            switch (Int(p), Int(q)) {
            case let (pn?, qn?): return pn < qn ? -1 : 1
            case (.some, nil): return -1
            case (nil, .some): return 1
            default: return p < q ? -1 : 1
            }
        }
        return 0
    }

    /// The app's own version. iOS MARKETING_VERSION is numeric X.Y.Z, so a pre-release is recovered from the build
    /// number (tools/release/version.mjs versionCode: MAJOR*10^7 + MINOR*10^5 + PATCH*10^3 + rank; alpha.N=100+N,
    /// beta.N=300+N, rc.N=600+N, final=999) when the two agree; otherwise the marketing version.
    static func shellVersion(marketing: String?, build: String?) -> String? {
        guard let marketing, isSemver(marketing) else { return nil }
        guard let build, let code = Int(build), code >= 10_000_000 else { return marketing }
        let major = code / 10_000_000, minor = code / 100_000 % 100, patch = code / 1000 % 100, rank = code % 1000
        guard "\(major).\(minor).\(patch)" == marketing else { return marketing }
        switch rank {
        case 999: return marketing
        case 100...299: return "\(marketing)-alpha.\(rank - 100)"
        case 300...599: return "\(marketing)-beta.\(rank - 300)"
        case 600...799: return "\(marketing)-rc.\(rank - 600)"
        default: return marketing
        }
    }

    // MARK: URLs

    private static func segment(_ s: String) -> Bool {
        s != "." && s != ".." && s.range(of: "^[A-Za-z0-9._+-]{1,128}$", options: .regularExpression) != nil
    }

    /// (tag, file) for https://github.com/<repo>/releases/download/<tag>/<file>; tag nil for .../releases/latest/download/<file>.
    static func releaseAsset(_ text: String?) -> (tag: String?, file: String)? {
        guard let text, text.count <= 512, let c = URLComponents(string: text), c.scheme == "https", c.host == "github.com",
              c.port == nil, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil, !c.percentEncodedPath.contains("%") else { return nil }
        let p = c.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let repo = releaseRepo.lowercased().split(separator: "/").map(String.init)
        guard p.count == 7, p[1].lowercased() == repo[0], p[2].lowercased() == repo[1], p[3] == "releases" else { return nil }
        if p[4] == "download", segment(p[5]), segment(p[6]) { return (p[5], p[6]) }
        if p[4] == "latest", p[5] == "download", segment(p[6]) { return (nil, p[6]) }
        return nil
    }

    static func isTaggedAsset(_ text: String?) -> Bool { releaseAsset(text)?.tag != nil }

    /// update.fetch: a release asset, or the releases listing.
    static func isFetchURL(_ text: String?) -> Bool { text == releasesAPI || releaseAsset(text) != nil }

    /// A redirect GitHub uses for release downloads (https, its asset hosts only).
    static func isAssetRedirect(_ url: URL) -> Bool {
        url.scheme == "https" && assetRedirectHosts.contains(url.host?.lowercased() ?? "") && url.port == nil && url.user == nil && url.password == nil
    }

    /// TestFlight / App Store links for update.openNative.
    static func isAppleURL(_ text: String?) -> Bool {
        guard let text, let c = URLComponents(string: text), c.scheme == "https", let host = c.host?.lowercased() else { return false }
        return appleHosts.contains(host) && c.port == nil && c.user == nil && c.password == nil
    }

    /// Debug builds only: github.com and api.github.com URLs mapped onto a loopback test server.
    static func fixtureURL(_ text: String, origin: String) -> URL? {
        guard let c = URLComponents(string: text) else { return nil }
        let rest = c.percentEncodedPath + (c.percentEncodedQuery.map { "?\($0)" } ?? "")
        return URL(string: (c.host == "api.github.com" ? "\(origin)/api" : origin) + rest)
    }

    /// A zip entry name that stays inside the bundle (zip-slip): no absolute path, drive letter, backslash, NUL or
    /// control character, "." / ".." / empty segment, or over-long name.
    static func safeEntryName(_ name: String) -> Bool {
        guard !name.isEmpty, name.utf8.count <= 512, !name.hasPrefix("/"), name.range(of: "^[A-Za-z]:", options: .regularExpression) == nil else { return false }
        if name.unicodeScalars.contains(where: { $0 == "\\" || $0.value < 0x20 || $0.value == 0x7f }) { return false }
        let trimmed = name.hasSuffix("/") ? String(name.dropLast()) : name
        return trimmed.split(separator: "/", omittingEmptySubsequences: false).allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    // MARK: bundle state machine (files are GameUpdater's)

    struct State: Codable, Equatable {
        var active: String?
        var knownGood: String?
        var pending: String?
        var trialVersion: String?
        var trialStartedAt: TimeInterval = 0
        var bad: [String] = []
    }

    /// Served only if usable and newer than the game built into the app.
    static func servable(_ version: String?, builtin: String?, usable: (String) -> Bool) -> Bool {
        guard let version, usable(version) else { return false }
        guard let builtin else { return true }
        return compare(version, builtin) > 0
    }

    @discardableResult
    static func rollback(_ s: inout State, builtin: String?, usable: (String) -> Bool) -> String? {
        let failed = s.trialVersion ?? s.active
        if let failed, !s.bad.contains(failed) { s.bad.append(failed) }
        if s.bad.count > 20 { s.bad.removeFirst(s.bad.count - 20) }
        s.trialVersion = nil
        s.trialStartedAt = 0
        s.active = servable(s.knownGood, builtin: builtin, usable: usable) ? s.knownGood : nil
        return failed
    }

    /// At app start: an unfinished trial rolls back; a pending bundle becomes the trial. Returns the rolled-back version.
    static func launch(_ s: inout State, builtin: String?, usable: (String) -> Bool, now: TimeInterval) -> String? {
        let back = s.trialVersion != nil ? rollback(&s, builtin: builtin, usable: usable) : nil
        if servable(s.pending, builtin: builtin, usable: usable) {
            s.trialVersion = s.pending
            s.trialStartedAt = now
            s.active = s.pending
        }
        s.pending = nil
        if s.active != nil, !servable(s.active, builtin: builtin, usable: usable) {
            s.active = servable(s.knownGood, builtin: builtin, usable: usable) ? s.knownGood : nil
        }
        return back
    }

    static func activate(_ s: inout State, builtin: String?, usable: (String) -> Bool, now: TimeInterval) -> Bool {
        guard servable(s.pending, builtin: builtin, usable: usable) else { return false }
        s.trialVersion = s.pending
        s.trialStartedAt = now
        s.active = s.pending
        s.pending = nil
        return true
    }

    static func bootOk(_ s: inout State) {
        s.trialVersion = nil
        s.trialStartedAt = 0
        s.knownGood = s.active
    }

    static func trialExpired(_ s: State, now: TimeInterval) -> Bool {
        s.trialVersion != nil && now - s.trialStartedAt >= bootTimeout
    }

    /// Why `version` can't be installed (forward only; never one that failed to boot), or nil.
    static func refuse(_ s: State, builtin: String?, version: String) -> String? {
        guard isSemver(version) else { return "Malformed version." }
        for v in [s.active, s.pending, s.knownGood, builtin].compactMap({ $0 }) where isSemver(v) && compare(version, v) <= 0 {
            return "Version \(version) is not newer than what this app has."
        }
        if s.bad.contains(version) { return "Version \(version) failed to start before, so it is not installed again." }
        return nil
    }
}
