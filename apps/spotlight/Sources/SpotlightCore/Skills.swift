// Settings > Skills: per-skill switches in ~/OnBud/config/skills.json, the file the controller reads on every
// request (services/skills/settings.ts):
//   { "disabled": ["web"], "enabled": ["personal"], "options": { "convert": { "maxMB": 500 } } }
// A skill is on unless listed in "disabled"; a default-off skill (personal: Calendar/Reminders) is on only when
// listed in "enabled". Unknown keys are kept; the file is written atomically with mode 600.
import Foundation

public struct SkillInfo: Identifiable, Equatable, Sendable {
    public let id: String
    public let description: String
    public var capabilities: [String] = []
    public var lane: String = "contained"
    public var egress: String = "none"
    public var isPrivate = false
    public var examples: [String] = []
    public var version: String = ""
    public init(id: String, description: String, capabilities: [String] = [], lane: String = "contained", egress: String = "none",
                isPrivate: Bool = false, examples: [String] = [], version: String = "") {
        self.id = id; self.description = description; self.capabilities = capabilities; self.lane = lane
        self.egress = egress; self.isPrivate = isPrivate; self.examples = examples; self.version = version
    }
}

/** What the Skills window shows for a skill: a name, a symbol, the plugins and macOS pieces it uses. */
public struct SkillLink: Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case plugin(PluginID), copilot, macPermission, tool, setting }
    public let kind: Kind
    public let label: String
    public let detail: String
}

public enum SkillCatalog {
    public static func title(_ id: String) -> String {
        switch id {
        case "core": return "Core"
        case "files": return "Files"
        case "code": return "Code"
        case "git": return "Git & GitHub"
        case "writing": return "Writing"
        case "mac": return "Mac"
        case "security": return "Security"
        case "web": return "Web search"
        case "frontier": return "Frontier hand-off"
        case "convert": return "Convert"
        case "shortcuts": return "Shortcuts"
        case "personal": return "Calendar & Reminders"
        default: return id
        }
    }

    public static func symbol(_ id: String) -> String {
        switch id {
        case "core": return "cpu"
        case "files": return "doc.text.magnifyingglass"
        case "code": return "chevron.left.forwardslash.chevron.right"
        case "git": return "arrow.triangle.pull"
        case "writing": return "pencil.and.outline"
        case "mac": return "macwindow"
        case "security": return "lock.shield"
        case "web": return "globe"
        case "frontier": return "arrow.up.forward.app"
        case "convert": return "arrow.2.squarepath"
        case "shortcuts": return "square.stack.3d.up"
        case "personal": return "calendar"
        case "server": return "server.rack"
        default: return "puzzlepiece"
        }
    }

    /** One line per capability in the manifest (contract 1.1). */
    public static func capability(_ c: String) -> (label: String, symbol: String, detail: String) {
        switch c {
        case "read": return ("Read", "eye", "Reads files and data on this Mac that the request is about")
        case "propose": return ("Propose", "text.badge.checkmark", "Suggests changes; nothing is applied until you approve")
        case "job": return ("Local jobs", "hammer", "Runs code jobs in their own git branch/worktree, never on your working copy")
        case "run_approved": return ("Run after approval", "play.circle", "Runs a command or shortcut only after you approve it")
        case "network": return ("Network", "network", "Makes network requests (search engine or GitHub API)")
        case "frontier": return ("Cloud model", "cloud", "Hands work to Codex or Copilot chat after you approve")
        case "write_new": return ("Write new files", "doc.badge.plus", "Creates new files next to the originals; never overwrites or deletes")
        case "remote": return ("Your server", "server.rack", "Uploads the project (no secrets, no big files) and runs commands on a server you named, over your own SSH, after you approve")
        default: return (c, "questionmark.circle", c)
        }
    }

    public static func lane(_ l: String) -> (label: String, detail: String) {
        switch l {
        case "contained": return ("Contained", "No lasting change outside its answer or new files")
        case "wide": return ("Wide", "Can change a project, a branch or run a shortcut — always after your approval")
        case "irreversible": return ("Closed", "Irreversible actions (send, delete, pay) are never automatic")
        default: return (l, "")
        }
    }

    public static func egress(_ e: String) -> (label: String, detail: String, leaves: Bool) {
        switch e {
        case "none": return ("Stays on this Mac", "Nothing leaves this Mac", false)
        case "query": return ("Sends a query", "Only the approved search query or a GitHub API request leaves this Mac", true)
        case "capsule": return ("Sends a redacted capsule", "A redacted summary of the task goes to a cloud model you approved (Codex, Copilot)", true)
        case "remote": return ("Sends to your server", "Project files (secrets and files over 50 MB left out) and the approved command go to your own server over SSH; keys stay with ssh", true)
        default: return (e, "", true)
        }
    }

    /** Plugins, Backend parts and macOS permissions each skill uses. */
    public static func links(_ id: String) -> [SkillLink] {
        switch id {
        case "core": return [SkillLink(kind: .plugin(.decima), label: PluginID.decima.name, detail: "Optional: advises where a request goes (AFM + router model)")]
        case "files": return [SkillLink(kind: .tool, label: "Spotlight index", detail: "Finds files by name, title and content (mdfind)")]
        case "code": return [SkillLink(kind: .copilot, label: "GitHub Copilot", detail: "Inline completion writes the code of local jobs (Backend › GitHub Copilot)"),
                             SkillLink(kind: .plugin(.codex), label: PluginID.codex.name, detail: "Takes code the tests reject or that is too large")]
        case "git": return [SkillLink(kind: .tool, label: "git, GitHub CLI (gh)", detail: "Pull requests and checks, read-only")]
        case "writing": return [SkillLink(kind: .plugin(.latex), label: PluginID.latex.name, detail: "Compiles papers"),
                                SkillLink(kind: .plugin(.translate), label: PluginID.translate.name, detail: "On-device translation")]
        case "mac": return [SkillLink(kind: .setting, label: "Apps OnBud opens", detail: "Your terminal, editor and browser (Settings)")]
        case "security": return []
        case "web": return [SkillLink(kind: .plugin(.web), label: PluginID.web.name, detail: "Private search on this Mac; else DuckDuckGo Lite, arXiv, Wikipedia")]
        case "frontier": return [SkillLink(kind: .plugin(.codex), label: PluginID.codex.name, detail: "Read-only answer or its own worktree session"),
                                 SkillLink(kind: .tool, label: "VS Code Copilot chat", detail: "Hand-off you start")]
        case "convert": return [SkillLink(kind: .tool, label: "sips, PDFKit, textutil, zip", detail: "Built into macOS")]
        case "shortcuts": return [SkillLink(kind: .tool, label: "Shortcuts app", detail: "Apple's import dialog confirms every install")]
        case "server": return [SkillLink(kind: .plugin(.server), label: PluginID.server.name, detail: "Fresh on this Mac, or TTT / a shell / tmux on the server; ssh from macOS"),
                               SkillLink(kind: .plugin(.codex), label: PluginID.codex.name, detail: "Code is still written on this Mac: Copilot → cheap tier → strong tier")]
        case "personal": return [SkillLink(kind: .macPermission, label: "Calendars, Reminders (macOS privacy)", detail: "The helper afm-pim asks once; change it in System Settings › Privacy & Security")]
        default: return []
        }
    }
}

public enum Skills {
    /** Display order; descriptions come from skills/<id>/skill.json at runtime. */
    public static let order = ["core", "files", "code", "git", "writing", "mac", "security", "web", "frontier", "server", "convert", "shortcuts", "personal"]
    public static let alwaysOn: Set<String> = ["core"]
    public static let defaultOff: Set<String> = ["personal"]
    public static let defaultConvertMaxMB = 500

    public static func file(_ paths: OnBudPaths = OnBudPaths()) -> URL { paths.home.appendingPathComponent("config/skills.json") }

    public static func manifests(_ paths: OnBudPaths = OnBudPaths()) -> [SkillInfo] {
        order.compactMap { id in
            let url = paths.repo.appendingPathComponent("skills/\(id)/skill.json")
            guard let data = try? Data(contentsOf: url),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return SkillInfo(id: id, description: o["description"] as? String ?? "",
                             capabilities: o["capabilities"] as? [String] ?? [], lane: o["lane"] as? String ?? "contained",
                             egress: o["egress"] as? String ?? "none", isPrivate: o["private"] as? Bool ?? false,
                             examples: o["examples"] as? [String] ?? [], version: o["version"] as? String ?? "")
        }
    }
}

public struct SkillSettings: Equatable {
    public var raw: [String: Any]

    public init(raw: [String: Any] = [:]) { self.raw = raw }
    public static func == (a: SkillSettings, b: SkillSettings) -> Bool {
        NSDictionary(dictionary: a.raw).isEqual(to: b.raw)
    }

    public static func load(from file: URL = Skills.file()) -> SkillSettings {
        guard let data = try? Data(contentsOf: file),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return SkillSettings() }
        return SkillSettings(raw: o)
    }

    private func list(_ key: String) -> [String] { raw[key] as? [String] ?? [] }

    public func isOn(_ id: String) -> Bool {
        if Skills.alwaysOn.contains(id) { return true }
        if list("disabled").contains(id) { return false }
        return !Skills.defaultOff.contains(id) || list("enabled").contains(id)
    }

    public mutating func set(_ id: String, on: Bool) {
        guard !Skills.alwaysOn.contains(id) else { return }
        var disabled = list("disabled").filter { $0 != id }
        var enabled = list("enabled").filter { $0 != id }
        if on { if Skills.defaultOff.contains(id) { enabled.append(id) } }
        else if !Skills.defaultOff.contains(id) { disabled.append(id) }
        if disabled.isEmpty { raw.removeValue(forKey: "disabled") } else { raw["disabled"] = disabled }
        if enabled.isEmpty { raw.removeValue(forKey: "enabled") } else { raw["enabled"] = enabled }
    }

    public var convertMaxMB: Int {
        get { ((raw["options"] as? [String: Any])?["convert"] as? [String: Any])?["maxMB"] as? Int ?? Skills.defaultConvertMaxMB }
        set {
            var options = raw["options"] as? [String: Any] ?? [:]
            var convert = options["convert"] as? [String: Any] ?? [:]
            convert["maxMB"] = newValue
            options["convert"] = convert
            raw["options"] = options
        }
    }

    /** Temp file in the same folder + rename (atomic), mode 600. */
    public func save(to file: URL = Skills.file()) throws {
        let fm = FileManager.default
        let dir = file.deletingLastPathComponent()
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: raw, options: [.prettyPrinted, .sortedKeys])
        let tmp = dir.appendingPathComponent(".skills.json.\(UUID().uuidString).tmp")
        guard fm.createFile(atPath: tmp.path, contents: data + Data("\n".utf8), attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: tmp.path])
        }
        if rename(tmp.path, file.path) != 0 {
            let err = errno
            try? fm.removeItem(at: tmp)
            throw POSIXError(POSIXErrorCode(rawValue: err) ?? .EIO)
        }
    }
}
