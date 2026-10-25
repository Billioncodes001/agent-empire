import Compression
import CryptoKit
import Foundation

/// Game bundle store and downloads for in-app updates (docs/team/RELEASE_PLAN.md, REL-04). Foundation, CryptoKit and
/// Compression only, so Checks/run.sh exercises it on the Mac. Rules live in UpdatePolicy.
///
/// Layout: Application Support/game-bundles/<version>/ (an unpacked game zip) and state.json (written atomically).
/// GameSchemeHandler serves the active folder; the app's own Game folder stays the final fallback.
final class GameUpdater {
    enum Failure: Error, CustomStringConvertible {
        case refused(String)
        var description: String { if case .refused(let m) = self { return m }; return "Update failed." }
    }

    let root: URL
    let builtinRoot: URL?
    let builtinVersion: String?
    /// Debug builds only: a loopback stand-in for GitHub releases (launch argument / environment AE_UPDATE_FIXTURE).
    var fixtureOrigin: String?
    /// The app's own version, for the signed release's minShell.
    var shellVersion: String?
    private(set) var state: UpdatePolicy.State
    private var rolledBack: String?
    private var installing = false
    private let lock = NSLock()
    private let now: () -> TimeInterval

    init(root: URL, builtinRoot: URL?, now: @escaping () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.root = root
        self.builtinRoot = builtinRoot
        self.now = now
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        builtinVersion = builtinRoot.flatMap { GameUpdater.version(of: $0) }
        let saved = (try? Data(contentsOf: root.appendingPathComponent("state.json"))).flatMap { try? JSONDecoder().decode(UpdatePolicy.State.self, from: $0) }
        state = saved ?? UpdatePolicy.State()
        state.bad = state.bad.filter(UpdatePolicy.isSemver)
    }

    /// The default store for the app.
    static func standard(builtinRoot: URL?) -> GameUpdater {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let store = GameUpdater(root: support.appendingPathComponent("game-bundles", isDirectory: true), builtinRoot: builtinRoot)
        #if DEBUG
        let env = ProcessInfo.processInfo.environment["AE_UPDATE_FIXTURE"] ?? UserDefaults.standard.string(forKey: "AE_UPDATE_FIXTURE")
        if UpdatePolicy.devReleasePublicKey != nil, let env, case .success(let url) = HostPolicy.origin(from: env, allowLoopbackHTTP: true), url.scheme == "http" {
            store.fixtureOrigin = HostPolicy.originString(url)
        }
        #endif
        return store
    }

    static func version(of dir: URL) -> String? {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("game-version.json")),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let v = obj["version"] as? String, UpdatePolicy.isSemver(v) else { return nil }
        return v
    }

    private func usable(_ version: String) -> Bool {
        let dir = root.appendingPathComponent(version, isDirectory: true)
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent("index.html").path) && GameUpdater.version(of: dir) == version
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: root.appendingPathComponent("state.json"), options: .atomic)
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try body()
    }

    // MARK: lifecycle

    /// At app start. Returns true when a trial is running (the caller arms the 20 s timer).
    @discardableResult
    func launch() -> Bool {
        locked {
            if let back = UpdatePolicy.launch(&state, builtin: builtinVersion, usable: usable, now: now()) { rolledBack = back }
            save()
            return state.trialVersion != nil
        }
    }

    /// The folder to serve now: the active installed bundle, else the built-in Game folder.
    func servingRoot() -> URL? {
        locked { UpdatePolicy.servable(state.active, builtin: builtinVersion, usable: usable) ? root.appendingPathComponent(state.active!, isDirectory: true) : builtinRoot }
    }

    var installedGame: String? { locked { UpdatePolicy.servable(state.active, builtin: builtinVersion, usable: usable) ? state.active : builtinVersion } }
    var pendingGame: String? { locked { state.pending } }

    func takeRolledBack() -> String? {
        locked {
            defer { rolledBack = nil }
            return rolledBack
        }
    }

    func activate() -> Bool {
        locked {
            guard UpdatePolicy.activate(&state, builtin: builtinVersion, usable: usable, now: now()) else { return false }
            save()
            return true
        }
    }

    func bootOk() {
        locked {
            UpdatePolicy.bootOk(&state)
            save()
            cleanup()
        }
    }

    /// True (and rolled back) when the trial ran 20 s without bootOk.
    func checkTrial() -> Bool {
        locked {
            guard UpdatePolicy.trialExpired(state, now: now()) else { return false }
            rolledBack = UpdatePolicy.rollback(&state, builtin: builtinVersion, usable: usable)
            save()
            return true
        }
    }

    /// Seconds left in the trial, or nil without one.
    var trialRemaining: TimeInterval? {
        locked { state.trialVersion == nil ? nil : max(0, state.trialStartedAt + UpdatePolicy.bootTimeout - now()) }
    }

    private func cleanup() {
        let keep = Set([state.active, state.knownGood, state.pending].compactMap { $0 })
        for name in (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [] where name != "state.json" && !keep.contains(name) {
            if UpdatePolicy.isSemver(name) || (name.hasPrefix(".tmp-") && !installing) { try? FileManager.default.removeItem(at: root.appendingPathComponent(name)) }
        }
    }

    // MARK: downloads

    /// Follows redirects only to GitHub's asset hosts (or, with a Debug fixture, the fixture origin).
    private final class RedirectGuard: NSObject, URLSessionTaskDelegate {
        let fixture: String?
        init(fixture: String?) { self.fixture = fixture }
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            guard let url = request.url else { return completionHandler(nil) }
            let allowed: Bool
            if let fixture { allowed = url.absoluteString.hasPrefix(fixture + "/") } else { allowed = UpdatePolicy.isAssetRedirect(url) || UpdatePolicy.releaseAsset(url.absoluteString) != nil }
            completionHandler(allowed ? request : nil)
        }
    }

    private func request(for text: String, etag: String? = nil) throws -> URLRequest {
        guard UpdatePolicy.isFetchURL(text) else { throw Failure.refused("That address is not an Agent Empire release.") }
        let mapped = fixtureOrigin.flatMap { UpdatePolicy.fixtureURL(text, origin: $0) } ?? URL(string: text)
        guard let url = mapped else { throw Failure.refused("Malformed address.") }
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 60)
        r.setValue("AgentEmpire-iOS", forHTTPHeaderField: "User-Agent")
        r.setValue(text.hasPrefix("https://api.github.com/") ? "application/vnd.github+json" : "application/octet-stream", forHTTPHeaderField: "Accept")
        if let etag { r.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        return r
    }

    /// update.fetch: a small text file (channel, signature, releases listing, coordinator).
    func fetch(_ text: String, etag: String?) async throws -> (status: Int, body: Data, etag: String?) {
        let (data, response) = try await URLSession.shared.data(for: try request(for: text, etag: etag), delegate: RedirectGuard(fixture: fixtureOrigin))
        guard let http = response as? HTTPURLResponse else { throw Failure.refused("GitHub returned an unexpected answer.") }
        // A redirect the guard refused comes back as the final answer.
        if (300..<400).contains(http.statusCode) && http.statusCode != 304 { throw Failure.refused("The download was redirected somewhere unexpected.") }
        if data.count > UpdatePolicy.maxTextBytes { throw Failure.refused("The download is too large.") }
        return (http.statusCode, data, http.value(forHTTPHeaderField: "ETag"))
    }

    /// update.installGame: downloads, checks the sha256 from the signed channel, unpacks and marks pending.
    func installGame(url: String, sha256: String, version: String) async throws -> String {
        guard UpdatePolicy.isTaggedAsset(url), UpdatePolicy.isSha256(sha256) else { throw Failure.refused("That update is not an Agent Empire release.") }
        try locked {
            if let why = UpdatePolicy.refuse(state, builtin: builtinVersion, version: version) { throw Failure.refused(why) }
            if installing { throw Failure.refused("An update is already being installed.") }
            installing = true
        }
        // Defense in depth: the release's own signed channel, verified with the pinned key, must name exactly this zip.
        do {
            let channel = UpdatePolicy.releaseChannelURL(version)
            let (doc, sig) = try await (fetch(channel, etag: nil), fetch(channel + ".sig", etag: nil))
            guard doc.status == 200, sig.status == 200 else { throw Failure.refused("The signed release \(version) could not be read.") }
            guard UpdatePolicy.verifyTrusted(doc.body, signatureBase64: String(decoding: sig.body, as: UTF8.self)) else {
                throw Failure.refused("The release's signature does not match this app's release key. Nothing was installed.")
            }
            guard let parsed = try? JSONSerialization.jsonObject(with: doc.body) as? [String: Any] else { throw Failure.refused("The signed release is not readable.") }
            if let why = UpdatePolicy.releaseMismatch(parsed, version: version, url: url, sha256: sha256, shellVersion: shellVersion) { throw Failure.refused(why) }
        } catch {
            locked { installing = false }
            throw error
        }
        defer { locked { installing = false } }
        let (file, response) = try await URLSession.shared.download(for: try request(for: url), delegate: RedirectGuard(fixture: fixtureOrigin))
        defer { try? FileManager.default.removeItem(at: file) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw Failure.refused("GitHub answered \((response as? HTTPURLResponse)?.statusCode ?? 0) for the update.") }
        let zip = try Data(contentsOf: file, options: .alwaysMapped)
        guard zip.count <= UpdatePolicy.maxZipBytes else { throw Failure.refused("The download is too large.") }
        let digest = SHA256.hash(data: zip).map { String(format: "%02x", $0) }.joined()
        guard digest == sha256 else { throw Failure.refused("The download does not match the signed release (sha256). Nothing was installed.") }
        return try place(zip: zip, version: version)
    }

    /// Unpacks into a temp folder, checks it, renames it into place and marks it pending. Public for the checks.
    func place(zip: Data, version: String) throws -> String {
        let tmp = root.appendingPathComponent(".tmp-\(version)-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        try ZipExtractor.extract(zip, to: tmp)
        guard FileManager.default.fileExists(atPath: tmp.appendingPathComponent("index.html").path) else { throw Failure.refused("The update has no game in it.") }
        guard GameUpdater.version(of: tmp) == version else { throw Failure.refused("The update's files are for a different version.") }
        let dest = root.appendingPathComponent(version, isDirectory: true)
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        try locked {
            if let why = UpdatePolicy.refuse(state, builtin: builtinVersion, version: version) { throw Failure.refused(why) }
            state.pending = version
            save()
        }
        return version
    }
}

/// A zip reader for stored and deflated entries, refusing anything that could escape the destination (zip-slip),
/// symlinks, special files, encryption, duplicates and oversize archives.
enum ZipExtractor {
    struct Entry {
        let name: String, dir: Bool, method: UInt16, compressed: Int, size: Int, local: Int
    }

    private static func u16(_ d: Data, _ o: Int) -> Int { Int(d[d.startIndex + o]) | Int(d[d.startIndex + o + 1]) << 8 }
    private static func u32(_ d: Data, _ o: Int) -> Int { u16(d, o) | u16(d, o + 2) << 16 }

    static func entries(_ d: Data) throws -> [Entry] {
        let fail = { (m: String) in GameUpdater.Failure.refused(m) }
        guard d.count >= 22 else { throw fail("Not a zip file.") }
        var eocd = -1
        var i = d.count - 22
        while i >= max(0, d.count - 22 - 0xffff) {
            if u32(d, i) == 0x06054b50 { eocd = i; break }
            i -= 1
        }
        guard eocd >= 0 else { throw fail("Not a zip file.") }
        let count = u16(d, eocd + 10), cdSize = u32(d, eocd + 12), cdOffset = u32(d, eocd + 16)
        guard count != 0xffff, cdOffset != 0xffffffff else { throw fail("ZIP64 archives are not supported.") }
        guard count <= UpdatePolicy.maxEntries else { throw fail("The archive has too many files.") }
        guard cdOffset + cdSize <= eocd else { throw fail("The archive is damaged.") }
        var out: [Entry] = []
        var seen = Set<String>()
        var total = 0
        var p = cdOffset
        for _ in 0..<count {
            guard p + 46 <= d.count, u32(d, p) == 0x02014b50 else { throw fail("The archive is damaged.") }
            let flags = u16(d, p + 8), method = u16(d, p + 10), compressed = u32(d, p + 20), size = u32(d, p + 24)
            let nameLen = u16(d, p + 28), extraLen = u16(d, p + 30), commentLen = u16(d, p + 32)
            let madeBy = u16(d, p + 4) >> 8, external = u32(d, p + 38), local = u32(d, p + 42)
            guard p + 46 + nameLen <= d.count, let name = String(data: d.subdata(in: d.startIndex + p + 46 ..< d.startIndex + p + 46 + nameLen), encoding: .utf8) else { throw fail("The archive is damaged.") }
            p += 46 + nameLen + extraLen + commentLen
            guard UpdatePolicy.safeEntryName(name) else { throw fail("Unsafe path in the archive: \(name.prefix(80))") }
            guard flags & 1 == 0 else { throw fail("Encrypted archives are not supported.") }
            let type = madeBy == 3 ? (external >> 16) & 0o170000 : 0
            guard type != 0o120000 else { throw fail("The archive contains a symbolic link: \(name)") }
            guard type == 0 || type == 0o100000 || type == 0o040000 else { throw fail("The archive contains a special file: \(name)") }
            guard method == 0 || method == 8 else { throw fail("The archive uses an unsupported compression method.") }
            let key = (name.hasSuffix("/") ? String(name.dropLast()) : name).lowercased()
            guard seen.insert(key).inserted else { throw fail("The archive lists \(name) twice.") }
            total += size
            guard total <= UpdatePolicy.maxUnpackedBytes else { throw fail("The archive is too large once unpacked.") }
            out.append(Entry(name: name, dir: name.hasSuffix("/"), method: UInt16(method), compressed: compressed, size: size, local: local))
        }
        return out
    }

    static func data(_ d: Data, _ e: Entry) throws -> Data {
        let fail = GameUpdater.Failure.refused("The archive is damaged (\(e.name)).")
        guard e.local + 30 <= d.count, u32(d, e.local) == 0x04034b50 else { throw fail }
        let start = e.local + 30 + u16(d, e.local + 26) + u16(d, e.local + 28)
        guard start + e.compressed <= d.count else { throw fail }
        let raw = d.subdata(in: d.startIndex + start ..< d.startIndex + start + e.compressed)
        if e.method == 0 {
            guard raw.count == e.size else { throw fail }
            return raw
        }
        if e.size == 0 { return Data() }
        var out = Data(count: e.size)
        let written = out.withUnsafeMutableBytes { dst in
            raw.withUnsafeBytes { src in
                compression_decode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, e.size, src.bindMemory(to: UInt8.self).baseAddress!, raw.count, nil, COMPRESSION_ZLIB)
            }
        }
        guard written == e.size else { throw fail }
        return out
    }

    /// Unpacks into `dest`, which must not exist. Every target is re-checked to stay inside it.
    static func extract(_ d: Data, to dest: URL) throws {
        let list = try entries(d)
        try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: false)
        let base = dest.standardizedFileURL.resolvingSymlinksInPath().path + "/"
        for e in list {
            let rel = e.dir ? String(e.name.dropLast()) : e.name
            let target = rel.split(separator: "/").reduce(dest) { $0.appendingPathComponent(String($1)) }
            guard target.standardizedFileURL.path.hasPrefix(base) || target.standardizedFileURL.resolvingSymlinksInPath().path.hasPrefix(base) else {
                throw GameUpdater.Failure.refused("Unsafe path in the archive: \(e.name)")
            }
            if e.dir {
                try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                continue
            }
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            guard target.deletingLastPathComponent().resolvingSymlinksInPath().path.hasPrefix(String(base.dropLast())) else {
                throw GameUpdater.Failure.refused("Unsafe path in the archive: \(e.name)")
            }
            guard !FileManager.default.fileExists(atPath: target.path) else { throw GameUpdater.Failure.refused("The archive lists \(e.name) twice.") }
            try data(d, e).write(to: target, options: .withoutOverwriting)
        }
    }
}
