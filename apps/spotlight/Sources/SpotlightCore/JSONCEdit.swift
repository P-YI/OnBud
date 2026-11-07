// Small in-place edits of a JSONC file (OpenCode's config): set or remove one value by key path and leave
// everything else (comments, order, formatting) exactly as it was. JSONC.parse + pretty() would drop comments.
import Foundation

public enum JSONCEdit {
    /** Spans (in Unicode scalars) of each member found while scanning: the key's opening quote, the value. */
    struct Member { let path: [String]; let keyStart: Int; let valueStart: Int; let valueEnd: Int }
    struct Object { let path: [String]; let open: Int; let close: Int }

    /** Sets path (e.g. ["agent", "codex", "model"]) to a string. The parent object must exist. */
    public static func setString(_ text: String, _ path: [String], _ value: String) throws -> String {
        let s = Array(text.unicodeScalars)
        let (members, objects) = try scan(s)
        let literal = JSONValue.quote(value)
        if let m = members.first(where: { $0.path == path }) {
            return String(String.UnicodeScalarView(s[..<m.valueStart])) + literal + String(String.UnicodeScalarView(s[m.valueEnd...]))
        }
        let parent = Array(path.dropLast())
        guard let obj = objects.first(where: { $0.path == parent }) else {
            throw JSONCError(message: "no \(parent.joined(separator: ".")) object", offset: 0)
        }
        // New member right after "{": same indentation as the object's first member, else parent + 2 spaces.
        let first = members.first { $0.path.count == path.count && Array($0.path.dropLast()) == parent }
        let indent = first.map { lineIndent(s, $0.keyStart) } ?? lineIndent(s, obj.open) + "  "
        let hasMembers = first != nil
        let insert = "\n" + indent + JSONValue.quote(path.last!) + ": " + literal + (hasMembers ? "," : "")
        let tail = hasMembers ? "" : "\n" + lineIndent(s, obj.open)
        return String(String.UnicodeScalarView(s[...obj.open])) + insert + tail + String(String.UnicodeScalarView(s[(obj.open + 1)...]))
    }

    /** Removes the member at path (with its comma and line) if present. */
    public static func remove(_ text: String, _ path: [String]) throws -> String {
        let s = Array(text.unicodeScalars)
        let (members, _) = try scan(s)
        guard let m = members.first(where: { $0.path == path }) else { return text }
        var start = m.keyStart, end = m.valueEnd
        var j = end
        while j < s.count, s[j] == " " || s[j] == "\t" { j += 1 }
        if j < s.count, s[j] == "," { end = j + 1 }
        else {   // last member: drop the comma before it instead
            var k = start - 1
            while k >= 0, " \t\r\n".unicodeScalars.contains(s[k]) { k -= 1 }
            if k >= 0, s[k] == "," { start = k; return String(String.UnicodeScalarView(s[..<start])) + String(String.UnicodeScalarView(s[end...])) }
        }
        // Remove the whole line when the member sits alone on it.
        var ls = start
        while ls > 0, s[ls - 1] == " " || s[ls - 1] == "\t" { ls -= 1 }
        var le = end
        while le < s.count, s[le] == " " || s[le] == "\t" { le += 1 }
        if (ls == 0 || s[ls - 1] == "\n"), le < s.count, s[le] == "\n" { start = ls; end = le + 1 }
        return String(String.UnicodeScalarView(s[..<start])) + String(String.UnicodeScalarView(s[end...]))
    }

    /** The string at path, if it is one. */
    public static func string(_ text: String, _ path: [String]) -> String? {
        guard var v = try? JSONC.parse(text) else { return nil }
        for k in path { guard let n = v[k] else { return nil }; v = n }
        if case .string(let x) = v { return x }
        return nil
    }

    static func lineIndent(_ s: [Unicode.Scalar], _ at: Int) -> String {
        var i = at
        while i > 0, s[i - 1] != "\n" { i -= 1 }
        var out = ""
        while i < s.count, s[i] == " " || s[i] == "\t" { out.unicodeScalars.append(s[i]); i += 1 }
        return out
    }

    /** One pass over the document, validating it like JSONC.parse and recording member and object spans. */
    static func scan(_ s: [Unicode.Scalar]) throws -> ([Member], [Object]) {
        var members: [Member] = [], objects: [Object] = []
        var p = JSONC.Parser(s)
        func value(_ path: [String]) throws {
            try p.skip()
            guard p.i < s.count else { throw p.err("unexpected end") }
            if s[p.i] == "{" {
                let open = p.i
                p.i += 1
                while true {
                    try p.skip()
                    guard p.i < s.count else { throw p.err("unterminated object") }
                    if s[p.i] == "}" { objects.append(Object(path: path, open: open, close: p.i)); p.i += 1; return }
                    guard s[p.i] == "\"" else { throw p.err("expected key") }
                    let keyStart = p.i
                    let k = try p.string()
                    try p.skip()
                    guard p.i < s.count, s[p.i] == ":" else { throw p.err("expected ':'") }
                    p.i += 1
                    try p.skip()
                    let vs = p.i
                    try value(path + [k])
                    members.append(Member(path: path + [k], keyStart: keyStart, valueStart: vs, valueEnd: p.i))
                    try p.skip()
                    if p.i < s.count, s[p.i] == "," { p.i += 1 } else if p.i < s.count, s[p.i] == "}" { continue } else { throw p.err("expected ',' or '}'") }
                }
            } else if s[p.i] == "[" {
                p.i += 1
                var n = 0
                while true {
                    try p.skip()
                    guard p.i < s.count else { throw p.err("unterminated array") }
                    if s[p.i] == "]" { p.i += 1; return }
                    try value(path + ["\(n)"]); n += 1
                    try p.skip()
                    if p.i < s.count, s[p.i] == "," { p.i += 1 } else if p.i < s.count, s[p.i] == "]" { continue } else { throw p.err("expected ',' or ']'") }
                }
            } else {
                _ = try p.value()
            }
        }
        try value([])
        try p.skip()
        if p.i < s.count { throw JSONCError(message: "trailing content", offset: p.i) }
        return (members, objects)
    }
}
