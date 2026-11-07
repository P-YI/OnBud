// What the chat widget shows (Widget/ChatWidget.swift): the last question and answer, written by the app to
// ~/Library/Application Support/OnBud/widget/snapshot.json (owner-only). The widget runs sandboxed and may
// read only that folder (a read-only home-relative exception in its entitlements). This file is compiled into
// both the app (SpotlightCore) and the widget extension.
import Foundation

public struct WidgetSnapshot: Codable, Sendable, Equatable {
    public var question: String
    public var answer: String
    public var folder: String?       // folder name, not the path
    public var running: Bool
    public var date: Date
    public init(question: String = "", answer: String = "", folder: String? = nil, running: Bool = false, date: Date = Date()) {
        self.question = question; self.answer = answer; self.folder = folder; self.running = running; self.date = date
    }

    public static let kind = "dev.onbud.chat"
    public static let maxAnswer = 600

    /** The real home folder (inside the widget's sandbox, NSHomeDirectory() is its container). */
    public static var realHome: String {
        if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir { return String(cString: dir) }
        return NSHomeDirectory()
    }
    public static var file: URL {
        URL(fileURLWithPath: realHome).appendingPathComponent("Library/Application Support/OnBud/widget/snapshot.json")
    }

    public static func load(from file: URL = file) -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        return try? dec.decode(WidgetSnapshot.self, from: data)
    }

    /** Writes the snapshot (answer shortened, Markdown kept: the widget shows plain lines). */
    public func save(to file: URL = file) {
        var s = self
        if s.answer.count > Self.maxAnswer { s.answer = String(s.answer.prefix(Self.maxAnswer)) + "…" }
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(s) else { return }
        let fm = FileManager.default
        try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try? data.write(to: file, options: .atomic)
        try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }

    public static func clear(file: URL = file) { try? FileManager.default.removeItem(at: file) }

    /** Answer text for a small widget: Markdown markers dropped, tables as "a · b" lines. */
    public static func plain(_ markdown: String) -> String {
        markdown.components(separatedBy: "\n").compactMap { line -> String? in
            var t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") || t.isEmpty { return nil }
            if t.hasPrefix("|") {
                if t.allSatisfy({ "|-: ".contains($0) }) { return nil }
                t = t.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " · ")
            }
            while t.hasPrefix("#") || t.hasPrefix(">") { t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces) }
            if t.hasPrefix("- ") || t.hasPrefix("* ") { t = "• " + t.dropFirst(2) }
            return t.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
        }.joined(separator: "\n")
    }
}
