// Launcher conveniences that need no UI: chat history, attachments (files, clipboard text), recent folders,
// the controller's local jobs and background sessions, folder-aware quick actions, and step labels.
import Foundation

// MARK: - History (~/Library/Application Support/OpenAFM/history.json, mode 600)

public struct SavedChat: Codable, Sendable, Identifiable, Equatable {
    public var id: UUID
    public var date: Date
    public var root: String?
    public var messages: [ChatMessage]
    public init(id: UUID = UUID(), date: Date = Date(), root: String?, messages: [ChatMessage]) {
        self.id = id; self.date = date; self.root = root; self.messages = messages
    }
    public var title: String { messages.first { $0.role == "user" }?.content.split(separator: "\n").first.map(String.init) ?? "Chat" }
}

public struct HistoryStore: Sendable {
    public let file: URL
    public static let limit = 50
    public init(file: URL? = nil) {
        self.file = file ?? FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/OpenAFM/history.json")
    }
    public func load() -> [SavedChat] {
        guard let data = try? Data(contentsOf: file) else { return [] }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        return (try? dec.decode([SavedChat].self, from: data)) ?? []
    }
    /** Inserts or replaces `chat` (newest first), keeps the last 50, writes owner-only. */
    @discardableResult
    public func save(_ chat: SavedChat) -> [SavedChat] {
        var all = load().filter { $0.id != chat.id }
        all.insert(chat, at: 0)
        all = Array(all.prefix(Self.limit))
        write(all)
        return all
    }
    public func clear() { try? FileManager.default.removeItem(at: file) }
    func write(_ all: [SavedChat]) {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(all) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        try? data.write(to: file, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}

// MARK: - Attachments

public enum Attachment: Equatable, Sendable, Identifiable {
    case file(URL)
    case text(String, source: String)   // e.g. clipboard, selection
    public var id: String {
        switch self { case .file(let u): return u.path; case .text(let t, let s): return s + String(t.hashValue) }
    }
    public var label: String {
        switch self {
        case .file(let u): return u.lastPathComponent
        case .text(let t, let s): return "\(s): " + String(t.prefix(24)).replacingOccurrences(of: "\n", with: " ") + (t.count > 24 ? "…" : "")
        }
    }
}

public enum Attachments {
    public static let maxText = 4000

    /** The folder the files call for: the common parent when they are outside `root`, else `root`. */
    public static func root(for files: [URL], current: String?) -> String? {
        guard !files.isEmpty else { return current }
        if let current, files.allSatisfy({ $0.standardizedFileURL.path.hasPrefix(current + "/") }) { return current }
        let parents = files.map { $0.standardizedFileURL.deletingLastPathComponent().path }
        var common = parents[0]
        for p in parents.dropFirst() { while !(p == common || p.hasPrefix(common + "/")) { common = (common as NSString).deletingLastPathComponent } }
        return common
    }

    /** The user turn sent to the controller: the request, then the files (relative to `root`) and quoted text. */
    public static func compose(_ prompt: String, _ items: [Attachment], root: String?) -> String {
        var out = prompt
        let files = items.compactMap { if case .file(let u) = $0 { return u } else { return nil } }
        if !files.isEmpty {
            let names = files.map { u -> String in
                let p = u.standardizedFileURL.path
                if let root, p.hasPrefix(root + "/") { return String(p.dropFirst(root.count + 1)) }
                return u.lastPathComponent
            }
            out += "\n\nFiles: " + names.joined(separator: ", ")
        }
        for case .text(let t, let source) in items {
            let body = t.count > maxText ? String(t.prefix(maxText)) + "\n[… truncated]" : t
            out += "\n\nText (\(source)):\n\"\"\"\n\(body)\n\"\"\""
        }
        return out
    }
}

// MARK: - Recent folders

public enum RecentFolders {
    public static func updated(_ list: [String], adding path: String, limit: Int = 6) -> [String] {
        Array(([path] + list.filter { $0 != path }).prefix(limit))
    }
}

// MARK: - Activity: local jobs and background sessions

public struct JobSummary: Sendable, Identifiable, Equatable {
    public let id: String, request: String, status: String, branch: String, root: String, createdAt: String
}

public enum Activity {
    public static func jobs(paths: OpenAFMPaths = OpenAFMPaths(), limit: Int = 20) -> [JobSummary] {
        let dir = paths.home.appendingPathComponent("runtime/jobs")
        let ids = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        let jobs: [JobSummary] = ids.compactMap { id in
            guard let data = try? Data(contentsOf: dir.appendingPathComponent("\(id)/job.json")),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            let ws = o["workspace"] as? [String: Any]
            return JobSummary(id: o["id"] as? String ?? id, request: o["request"] as? String ?? "",
                              status: o["status"] as? String ?? "?", branch: ws?["branch"] as? String ?? "",
                              root: o["root"] as? String ?? "", createdAt: o["createdAt"] as? String ?? "")
        }
        return Array(jobs.sorted { $0.createdAt > $1.createdAt }.prefix(limit))
    }

    /** Background sessions the controller started (tmux -L openafm): names only. */
    public static func sessions() -> [String] {
        let tmux = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let tmux else { return [] }
        let p = Process(); p.executableURL = URL(fileURLWithPath: tmux)
        p.arguments = ["-L", "openafm", "list-sessions", "-F", "#{session_name}"]
        let pipe = Pipe(); p.standardOutput = pipe; p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return [] }
        let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        return out.split(separator: "\n").map(String.init)
    }
}

// MARK: - Quick actions for the current folder

public struct QuickAction: Sendable, Equatable, Identifiable {
    public let title: String, prompt: String, symbol: String
    public var id: String { title }
}

public enum QuickActions {
    /** A few one-click requests that fit what is in `root` (top level only, cheap). */
    public static func suggest(root: String?, latex: Bool) -> [QuickAction] {
        var out: [QuickAction] = []
        guard let root, let names = try? FileManager.default.contentsOfDirectory(atPath: root) else {
            return [QuickAction(title: "Commands", prompt: "show commands", symbol: "questionmark.circle")]
        }
        let ext = Set(names.map { ($0 as NSString).pathExtension.lowercased() })
        if ext.contains("tex") {
            if latex { out.append(QuickAction(title: "Compile the paper", prompt: "compile the paper and fix errors", symbol: "doc.text")) }
            out.append(QuickAction(title: "Check citations", prompt: "check citations and references", symbol: "quote.opening"))
        }
        if !ext.isDisjoint(with: ["pdf", "docx", "doc", "pptx", "hwpx", "png", "jpg", "jpeg", "heic", "xlsx"]) {
            out.append(QuickAction(title: "Describe the documents", prompt: "describe the documents in this folder", symbol: "doc.on.doc"))
        }
        if names.contains(".git") {
            out.append(QuickAction(title: "Summarize changes", prompt: "summarize the uncommitted changes", symbol: "list.bullet.indent"))
            out.append(QuickAction(title: "Commit message", prompt: "write a commit message for my changes", symbol: "text.badge.checkmark"))
            out.append(QuickAction(title: "Recent commits", prompt: "What are the 5 most recent commit messages?", symbol: "clock.arrow.circlepath"))
            out.append(QuickAction(title: "Local jobs", prompt: "local jobs", symbol: "list.bullet.rectangle"))
        }
        out.append(QuickAction(title: "Commands", prompt: "show commands", symbol: "questionmark.circle"))
        return out
    }
}

// MARK: - Step labels (live progress)

public enum StepLabel {
    public static func text(_ kind: String, _ detail: String) -> String {
        switch kind {
        case "redact": return "Hiding secrets in the request…"
        case "triage", "route": return "Choosing how to handle it…"
        case "health": return "Checking the on-device model…"
        case "memory": return "Recalling earlier notes…"
        case "seed", "find_terms", "find", "inventory", "select": return "Searching the folder…"
        case "tool": return "Using a tool" + (detail.isEmpty ? "…" : ": " + String(detail.prefix(60)))
        case "loop": return "Working through the steps…"
        case "answer", "answer_retry": return "Writing the answer…"
        case "grounding", "verify": return "Checking the answer against the files…"
        case "edit", "edit_retry": return "Drafting the edit…"
        case "latex_fix", "latex_polish": return "Working on the LaTeX…"
        case "web_query": return "Preparing a web search…"
        case "job_plan": return "Planning the steps…"
        case "decima_code", "escalate", "frontier": return "Judging whether this needs a bigger model…"
        case "translate", "translate_question": return "Translating…"
        case "skill": return skill(detail)
        case "frame", "answer_type", "answer_focused": return "Reading the question…"
        case "file_summary", "lines", "function", "code": return "Reading the files…"
        case "quotes_in_evidence", "cited_paths_exist", "inventory_paths_exist": return "Checking the answer against the files…"
        case "edit_trial", "worktree", "copy": return "Trying the edit in a sandbox…"
        case "secret": return "Checking for secrets…"
        case "episode", "lesson": return "Recalling earlier notes…"
        default:
            if kind.hasPrefix("skill_") { return skill(String(kind.dropFirst(6))) }
            // Unknown (newer controller): its name in words, never the raw identifier.
            let words = kind.replacingOccurrences(of: "_", with: " ")
            return words.prefix(1).uppercased() + words.dropFirst() + "…"
        }
    }

    /** Local skills (services/controller/local-skills.ts). */
    static func skill(_ name: String) -> String {
        switch name {
        case "commit_message": return "Writing a commit message…"
        case "change_summary": return "Summarizing the changes…"
        case "release_notes": return "Writing release notes…"
        case "error_triage": return "Reading the error log…"
        case "extract_table": return "Collecting the action items…"
        case "translate": return "Translating the document…"
        case "docstrings": return "Writing docstrings…"
        case "privacy_scan": return "Checking for personal data…"
        case "csv_json": return "Converting the table…"
        case "sheet_lookup": return "Looking it up in the spreadsheet…"
        case "slides_outline": return "Reading the slides…"
        case "git_overview": return "Checking the git repository…"
        case "github_status": return "Checking GitHub…"
        default: return "Using a local skill…"
        }
    }
}
