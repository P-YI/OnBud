// Opt-in "Link OpenCode": merges OpenAFM's provider, agent and MCP entries into the global OpenCode config,
// so the OpenCode CLI and desktop app get the AFM agent and the codex agent. Never overwrites a key the user has,
// does nothing when the config is already the repo's file (symlink) or already has the entries, and backs up
// before writing. The app shows the diff first; writing happens only on the user's click.
import Foundation

public enum LinkState: Equatable, Sendable {
    case symlinkedToRepo(String)       // config is a symlink to opencode/opencode.global.jsonc → nothing to do
    case alreadyLinked                 // config already contains every entry
    case needsMerge(LinkPlan)
    case sourceMissing                 // no ~/OpenAFM checkout to merge from
    case unreadable(String)            // config exists but does not parse; we do not touch it
}

public struct LinkPlan: Equatable, Sendable {
    public let target: URL
    public let targetExists: Bool
    public let added: [String]         // e.g. "provider.afm-agent", "agent.codex", "mcp.openafm"
    public let before: String
    public let after: String
}

public struct OpenCodeLink: Sendable {
    public let configDir: URL
    public let source: URL
    /** Top-level sections whose entries are merged key by key. */
    public static let sections = ["provider", "agent", "mcp"]

    public init(configDir: URL? = nil, source: URL = OpenAFMPaths().globalOpenCodeSource) {
        if let configDir { self.configDir = configDir }
        else {
            let xdg = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"].flatMap { $0.isEmpty ? nil : $0 }
            let base = xdg.map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config")
            self.configDir = base.appendingPathComponent("opencode")
        }
        self.source = source
    }

    /** The global config OpenCode reads: opencode.jsonc, else opencode.json (new files get .jsonc's sibling .json). */
    public var target: URL {
        for name in ["opencode.jsonc", "opencode.json"] {
            let u = configDir.appendingPathComponent(name)
            if (try? FileManager.default.destinationOfSymbolicLink(atPath: u.path)) != nil || FileManager.default.fileExists(atPath: u.path) { return u }
        }
        return configDir.appendingPathComponent("opencode.json")
    }

    public func inspect() -> LinkState {
        let fm = FileManager.default
        let t = target
        if let dest = try? fm.destinationOfSymbolicLink(atPath: t.path) {
            let abs = URL(fileURLWithPath: dest, relativeTo: t.deletingLastPathComponent()).standardizedFileURL.resolvingSymlinksInPath().path
            if abs == source.standardizedFileURL.resolvingSymlinksInPath().path || abs.hasSuffix("/opencode/opencode.global.jsonc") {
                return .symlinkedToRepo(dest)
            }
        }
        guard let srcText = try? String(contentsOf: source, encoding: .utf8), let src = try? JSONC.parse(srcText) else { return .sourceMissing }
        let exists = fm.fileExists(atPath: t.path)
        let before = exists ? ((try? String(contentsOf: t, encoding: .utf8)) ?? "") : ""
        let current: JSONValue
        if exists && !before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            do { current = try JSONC.parse(before) } catch { return .unreadable("\(error)") }
            guard case .object = current else { return .unreadable("top level is not an object") }
        } else {
            current = .object([("$schema", .string("https://opencode.ai/config.json"))])
        }
        let (merged, added) = Self.merge(current, from: src)
        if added.isEmpty { return .alreadyLinked }
        return .needsMerge(LinkPlan(target: t, targetExists: exists, added: added, before: before, after: merged.pretty() + "\n"))
    }

    /** Adds the source's provider/agent/mcp entries the config lacks, and the providers to enabled_providers if the config limits them. */
    public static func merge(_ current: JSONValue, from src: JSONValue) -> (JSONValue, [String]) {
        var out = current, added: [String] = []
        for section in sections {
            guard case .object(let entries)? = src[section] else { continue }
            var have = out[section] ?? .object([])
            guard case .object = have else { continue }       // user has something odd there; leave it
            for (k, v) in entries where have[k] == nil { have.set(k, v); added.append("\(section).\(k)") }
            if out[section] != have { out.set(section, have) }
        }
        if case .array(var enabled)? = out["enabled_providers"], case .object(let providers)? = src["provider"] {
            for (k, _) in providers where !enabled.contains(.string(k)) { enabled.append(.string(k)); added.append("enabled_providers.\(k)") }
            out.set("enabled_providers", .array(enabled))
        }
        return (out, added)
    }

    /** Unified diff (via /usr/bin/diff) for the confirmation sheet. */
    public static func diff(_ plan: LinkPlan) -> String {
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("afm-spotlight-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let a = tmp.appendingPathComponent("before"), b = tmp.appendingPathComponent("after")
        try? plan.before.write(to: a, atomically: true, encoding: .utf8)
        try? plan.after.write(to: b, atomically: true, encoding: .utf8)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/diff")
        p.arguments = ["-u", "--label", plan.targetExists ? plan.target.path : "/dev/null", "--label", plan.target.path, a.path, b.path]
        let pipe = Pipe(); p.standardOutput = pipe
        do { try p.run() } catch { return plan.after }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    /** Backs up the current file (if any) next to it, then writes the merged config. Returns the backup path. */
    @discardableResult
    public func apply(_ plan: LinkPlan) throws -> URL? {
        let fm = FileManager.default
        // Re-check: the file must still be what the user saw in the diff.
        let now = fm.fileExists(atPath: plan.target.path) ? ((try? String(contentsOf: plan.target, encoding: .utf8)) ?? "") : ""
        guard now == plan.before else { throw CocoaError(.fileWriteUnknown, userInfo: [NSLocalizedDescriptionKey: "The config changed since the diff was shown; review it again."]) }
        try fm.createDirectory(at: plan.target.deletingLastPathComponent(), withIntermediateDirectories: true)
        var backup: URL?
        if plan.targetExists {
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "")
            let b = plan.target.deletingLastPathComponent().appendingPathComponent("\(plan.target.lastPathComponent).afm-spotlight-backup-\(stamp)")
            try fm.copyItem(at: plan.target, to: b)
            backup = b
        }
        try plan.after.write(to: plan.target, atomically: true, encoding: .utf8)
        return backup
    }
}
