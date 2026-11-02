// A small order-preserving JSON value with a JSONC reader (// and /* */ comments, trailing commas),
// so merging into a user's OpenCode config keeps their key order and the diff stays readable.
import Foundation

public indirect enum JSONValue: Equatable, Sendable {
    case object([(String, JSONValue)])
    case array([JSONValue])
    case string(String)
    case number(String)              // kept as written
    case bool(Bool)
    case null

    public static func == (a: JSONValue, b: JSONValue) -> Bool {
        switch (a, b) {
        case let (.object(x), .object(y)): return x.count == y.count && zip(x, y).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        case let (.array(x), .array(y)): return x == y
        case let (.string(x), .string(y)), let (.number(x), .number(y)): return x == y
        case let (.bool(x), .bool(y)): return x == y
        case (.null, .null): return true
        default: return false
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let kv) = self { return kv.first { $0.0 == key }?.1 }
        return nil
    }
    public var keys: [String] { if case .object(let kv) = self { return kv.map(\.0) }; return [] }

    /** Sets (or appends) a key on an object; no-op on other values. */
    public mutating func set(_ key: String, _ value: JSONValue) {
        guard case .object(var kv) = self else { return }
        if let i = kv.firstIndex(where: { $0.0 == key }) { kv[i].1 = value } else { kv.append((key, value)) }
        self = .object(kv)
    }

    public func pretty(_ indent: Int = 0) -> String {
        let pad = String(repeating: "  ", count: indent + 1), end = String(repeating: "  ", count: indent)
        switch self {
        case .object(let kv):
            if kv.isEmpty { return "{}" }
            return "{\n" + kv.map { "\(pad)\(Self.quote($0.0)): \($0.1.pretty(indent + 1))" }.joined(separator: ",\n") + "\n\(end)}"
        case .array(let xs):
            if xs.isEmpty { return "[]" }
            // Short scalar arrays on one line, like the hand-written config.
            if xs.allSatisfy({ if case .object = $0 { return false }; if case .array = $0 { return false }; return true }) {
                let line = "[" + xs.map { $0.pretty() }.joined(separator: ", ") + "]"
                if line.count <= 100 { return line }
            }
            return "[\n" + xs.map { pad + $0.pretty(indent + 1) }.joined(separator: ",\n") + "\n\(end)]"
        case .string(let s): return Self.quote(s)
        case .number(let n): return n
        case .bool(let b): return b ? "true" : "false"
        case .null: return "null"
        }
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 { out += String(format: "\\u%04x", u.value) } else { out.unicodeScalars.append(u) }
            }
        }
        return out + "\""
    }
}

public struct JSONCError: Error, CustomStringConvertible {
    public let message: String; public let offset: Int
    public var description: String { "JSONC parse error at \(offset): \(message)" }
}

public enum JSONC {
    public static func parse(_ text: String) throws -> JSONValue {
        var p = Parser(Array(text.unicodeScalars))
        let v = try p.value()
        try p.skip()
        if p.i < p.s.count { throw JSONCError(message: "trailing content", offset: p.i) }
        return v
    }

    struct Parser {
        let s: [Unicode.Scalar]; var i = 0
        init(_ s: [Unicode.Scalar]) { self.s = s }
        func err(_ m: String) -> JSONCError { JSONCError(message: m, offset: i) }

        mutating func skip() throws {
            while i < s.count {
                let c = s[i]
                if c == " " || c == "\n" || c == "\r" || c == "\t" { i += 1 }
                else if c == "/" && i + 1 < s.count && s[i + 1] == "/" { while i < s.count && s[i] != "\n" { i += 1 } }
                else if c == "/" && i + 1 < s.count && s[i + 1] == "*" {
                    i += 2
                    while i + 1 < s.count && !(s[i] == "*" && s[i + 1] == "/") { i += 1 }
                    guard i + 1 < s.count else { throw err("unterminated comment") }
                    i += 2
                } else { return }
            }
        }

        mutating func value() throws -> JSONValue {
            try skip()
            guard i < s.count else { throw err("unexpected end") }
            switch s[i] {
            case "{":
                i += 1; var kv: [(String, JSONValue)] = []
                while true {
                    try skip()
                    guard i < s.count else { throw err("unterminated object") }
                    if s[i] == "}" { i += 1; return .object(kv) }
                    guard s[i] == "\"" else { throw err("expected key") }
                    let k = try string()
                    try skip()
                    guard i < s.count, s[i] == ":" else { throw err("expected ':'") }
                    i += 1
                    kv.append((k, try value()))
                    try skip()
                    if i < s.count && s[i] == "," { i += 1 }
                    else if i < s.count && s[i] == "}" { continue }
                    else { throw err("expected ',' or '}'") }
                }
            case "[":
                i += 1; var xs: [JSONValue] = []
                while true {
                    try skip()
                    guard i < s.count else { throw err("unterminated array") }
                    if s[i] == "]" { i += 1; return .array(xs) }
                    xs.append(try value())
                    try skip()
                    if i < s.count && s[i] == "," { i += 1 }
                    else if i < s.count && s[i] == "]" { continue }
                    else { throw err("expected ',' or ']'") }
                }
            case "\"": return .string(try string())
            case "t": try word("true"); return .bool(true)
            case "f": try word("false"); return .bool(false)
            case "n": try word("null"); return .null
            default:
                let start = i
                while i < s.count, "+-0123456789.eE".unicodeScalars.contains(s[i]) { i += 1 }
                guard i > start else { throw err("unexpected character") }
                return .number(String(String.UnicodeScalarView(s[start..<i])))
            }
        }

        mutating func word(_ w: String) throws {
            for u in w.unicodeScalars { guard i < s.count, s[i] == u else { throw err("expected \(w)") }; i += 1 }
        }

        mutating func string() throws -> String {
            i += 1; var out = String.UnicodeScalarView()
            while i < s.count {
                let c = s[i]; i += 1
                if c == "\"" { return String(out) }
                if c == "\\" {
                    guard i < s.count else { break }
                    let e = s[i]; i += 1
                    switch e {
                    case "n": out.append("\n"); case "t": out.append("\t"); case "r": out.append("\r")
                    case "b": out.append("\u{08}"); case "f": out.append("\u{0C}")
                    case "u":
                        guard i + 4 <= s.count, let v = UInt32(String(String.UnicodeScalarView(s[i..<i + 4])), radix: 16) else { throw err("bad \\u escape") }
                        i += 4
                        var scalar = v
                        // Surrogate pair
                        if (0xD800...0xDBFF).contains(v), i + 6 <= s.count, s[i] == "\\", s[i + 1] == "u",
                           let lo = UInt32(String(String.UnicodeScalarView(s[i + 2..<i + 6])), radix: 16), (0xDC00...0xDFFF).contains(lo) {
                            scalar = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00); i += 6
                        }
                        out.append(Unicode.Scalar(scalar) ?? "\u{FFFD}")
                    default: out.append(e)
                    }
                } else { out.append(c) }
            }
            throw err("unterminated string")
        }
    }
}
