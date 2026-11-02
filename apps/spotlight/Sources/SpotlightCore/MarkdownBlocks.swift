// Block-level Markdown for controller replies: headings, tables, bullet/numbered lists, quotes, fenced code,
// rules and paragraphs. Inline Markdown (bold, `code`, links) is left to the view.
import Foundation

public enum MDBlock: Equatable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullet(indent: Int, marker: String, text: String)   // marker: "•" or "1."
    case quote(String)
    case code(lang: String, text: String)
    case table(header: [String], rows: [[String]])
    case rule
}

public enum MarkdownBlocks {
    public static func parse(_ text: String) -> [MDBlock] {
        // <details> blocks are pre-analysis for Codex; keep the summary line only.
        let cleaned = text.replacingOccurrences(of: #"<details><summary>([^<]*)</summary>[\s\S]*?</details>"#, with: "▸ $1", options: .regularExpression)
        let lines = cleaned.components(separatedBy: "\n")
        var out: [MDBlock] = []
        var para: [String] = []
        func flush() {
            let p = para.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !p.isEmpty { out.append(.paragraph(p)) }
            para = []
        }
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") {
                flush()
                let lang = String(t.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { body.append(lines[i]); i += 1 }
                out.append(.code(lang: lang, text: body.joined(separator: "\n")))
                i += 1; continue
            }
            if t.isEmpty { flush(); i += 1; continue }
            if let h = heading(t) { flush(); out.append(h); i += 1; continue }
            if t == "---" || t == "***" || t == "___" { flush(); out.append(.rule); i += 1; continue }
            // Table: a pipe row followed by a |---|---| separator.
            if t.hasPrefix("|"), i + 1 < lines.count, isSeparator(lines[i + 1]) {
                flush()
                let header = cells(t)
                var rows: [[String]] = []
                i += 2
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
                    var r = cells(lines[i].trimmingCharacters(in: .whitespaces))
                    if r.count < header.count { r += Array(repeating: "", count: header.count - r.count) }
                    rows.append(Array(r.prefix(header.count)))
                    i += 1
                }
                out.append(.table(header: header, rows: rows)); continue
            }
            if let b = bullet(line) { flush(); out.append(b); i += 1; continue }
            if t.hasPrefix(">") { flush(); out.append(.quote(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))); i += 1; continue }
            para.append(line)
            i += 1
        }
        flush()
        return out
    }

    static func heading(_ t: String) -> MDBlock? {
        let hashes = t.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), t.dropFirst(hashes).first == " " else { return nil }
        return .heading(level: hashes, text: String(t.dropFirst(hashes + 1)).trimmingCharacters(in: .whitespaces))
    }

    static func isSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
    }

    /** Splits a table row on unescaped pipes; `\|` stays a literal pipe. */
    static func cells(_ row: String) -> [String] {
        var out: [String] = [], cur = "", escaped = false
        for ch in row {
            if escaped { cur.append(ch == "|" ? "|" : "\\" + String(ch)); escaped = false; continue }
            if ch == "\\" { escaped = true; continue }
            if ch == "|" { out.append(cur); cur = "" } else { cur.append(ch) }
        }
        out.append(cur)
        if out.first?.trimmingCharacters(in: .whitespaces).isEmpty == true { out.removeFirst() }
        if out.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { out.removeLast() }
        return out.map { $0.trimmingCharacters(in: .whitespaces) }
    }

    static func bullet(_ line: String) -> MDBlock? {
        let indent = line.prefix { $0 == " " }.count / 2
        let t = line.trimmingCharacters(in: .whitespaces)
        for m in ["- ", "* ", "• "] where t.hasPrefix(m) {
            return .bullet(indent: indent, marker: "•", text: String(t.dropFirst(2)))
        }
        if let r = t.range(of: #"^\d{1,3}[.)] "#, options: .regularExpression) {
            return .bullet(indent: indent, marker: String(t[r]).trimmingCharacters(in: .whitespaces), text: String(t[r.upperBound...]))
        }
        return nil
    }
}

/** Links in answers: bare URLs and file paths (the view makes them clickable; AppState.openLink opens them). */
public enum MarkdownLinks {
    /** Bare http(s) URLs become <autolinks> (outside `code` spans). */
    public static func autolinked(_ s: String) -> String {
        guard s.contains("http") else { return s }
        return s.components(separatedBy: "`").enumerated().map { i, part in
            i % 2 == 1 ? part : part.replacingOccurrences(of: #"(?<![(<\[\w])https?://[^\s<>()\[\]`]+[^\s<>()\[\]`.,;:!?'"]"#, with: "<$0>", options: .regularExpression)
        }.joined(separator: "`")
    }

    /** A path from an answer ("src/a.ts", "~/x", "/Users/…", "src/a.ts:12") as a file URL, relative to the project folder. */
    public static func fileURL(_ raw: String, root: String?, mustExist: Bool) -> URL? {
        var p = raw.trimmingCharacters(in: .whitespaces)
        if let r = p.range(of: #":\d+(:\d+)?$"#, options: .regularExpression) { p.removeSubrange(r) }   // file:line
        guard !p.isEmpty, !p.contains(" ") || !mustExist, p.count < 400, !p.contains("://") else { return nil }
        if mustExist && !(p.contains("/") || p.range(of: #"\.[A-Za-z0-9]{1,6}$"#, options: .regularExpression) != nil) { return nil }
        let path: String
        if p.hasPrefix("~") { path = (p as NSString).expandingTildeInPath }
        else if p.hasPrefix("/") { path = p }
        else if let root { path = (root as NSString).appendingPathComponent(p) }
        else { return nil }
        if mustExist && !FileManager.default.fileExists(atPath: path) { return nil }
        return URL(fileURLWithPath: path).standardizedFileURL
    }
}
