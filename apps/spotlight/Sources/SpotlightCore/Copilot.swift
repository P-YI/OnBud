// GitHub Copilot tier (S5): the controller asks Copilot's official language server (@github/copilot-language-server,
// MIT, in ~/OnBud/runtime/copilot-ls) for inline completions to write the code of local jobs; AFM keeps planning,
// tests and repair, Codex takes what fails. Only inline completion is used (unlimited on every plan, no premium
// requests). This file holds what the launcher needs: the status/sign-in script's output, the quota from
// `gh api /copilot_internal/user` (read-only), routing.yaml's copilot_mode line, and the LaunchAgent switch.
import Foundation

public enum Copilot {
    public static func languageServer(_ paths: OnBudPaths = OnBudPaths()) -> URL {
        paths.home.appendingPathComponent("runtime/copilot-ls/node_modules/@github/copilot-language-server/dist/language-server.js")
    }
    public static func installed(_ paths: OnBudPaths = OnBudPaths()) -> Bool {
        FileManager.default.fileExists(atPath: languageServer(paths).path)
    }
    /** The controller's CLI: `status` or `signin` (services/frontier/copilot-ls.ts). */
    public static func script(_ paths: OnBudPaths = OnBudPaths()) -> URL {
        paths.repo.appendingPathComponent("services/frontier/copilot-ls.ts")
    }

    /** Last "status: <kind> [user]" line: kind OK / AlreadySignedIn = signed in. */
    public static func parseStatus(_ out: String) -> (status: String, user: String?)? {
        guard let line = out.components(separatedBy: "\n").last(where: { $0.hasPrefix("status:") }) else { return nil }
        let parts = line.dropFirst("status:".count).split(separator: " ").map(String.init)
        guard let kind = parts.first else { return nil }
        return (kind, parts.count > 1 ? parts[1] : nil)
    }
    public static func signedIn(_ status: String) -> Bool { status == "OK" || status == "AlreadySignedIn" }

    /** "Open <url> and enter the code: XXXX-XXXX" → (url, code); only github.com URLs are accepted. */
    public static func parseDeviceCode(_ line: String) -> (url: URL, code: String)? {
        guard let r = line.range(of: #"Open (https://github\.com/\S+) and enter the code: ([A-Z0-9]{4}-[A-Z0-9]{4})"#, options: .regularExpression) else { return nil }
        let words = line[r].split(separator: " ").map(String.init)
        guard words.count >= 7, let url = URL(string: words[1]), url.host == "github.com" else { return nil }
        return (url, words.last!)
    }

    public struct Quota: Equatable, Sendable {
        public var plan: String = ""
        public var completionsUnlimited = false
        public var premiumRemaining: Double?
        public var premiumPercent: Double?
        public var resetDate: String?
        public var summary: String {
            var parts: [String] = []
            if !plan.isEmpty { parts.append("plan \(plan)") }
            parts.append(completionsUnlimited ? "code completions unlimited" : "code completions limited")
            if let r = premiumRemaining { parts.append(String(format: "premium requests %.0f left", r) + (premiumPercent.map { String(format: " (%.0f%%)", $0) } ?? "")) }
            if let d = resetDate { parts.append("resets \(d)") }
            return parts.joined(separator: " · ")
        }
    }

    /** `gh api /copilot_internal/user` → the quota line (read-only; OnBud never uses premium requests). */
    public static func parseQuota(_ data: Data) -> Quota? {
        guard let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let q = o["quota_snapshots"] as? [String: Any] else { return nil }
        var out = Quota()
        out.plan = [o["copilot_plan"] as? String, o["access_type_sku"] as? String].compactMap { $0 }.joined(separator: ", ")
        out.completionsUnlimited = (q["completions"] as? [String: Any])?["unlimited"] as? Bool ?? false
        if let p = q["premium_interactions"] as? [String: Any], (p["unlimited"] as? Bool) != true {
            out.premiumRemaining = (p["quota_remaining"] as? NSNumber)?.doubleValue
            out.premiumPercent = (p["percent_remaining"] as? NSNumber)?.doubleValue
        }
        out.resetDate = o["quota_reset_date"] as? String
        return out
    }
}

/** routing.yaml's `copilot_mode:` (decision section); edited as that one line, comments kept. */
public enum CopilotMode: String, CaseIterable, Sendable, Identifiable {
    case balanced, saver
    public var id: String { rawValue }
    public var detail: String {
        switch self {
        case .balanced: return "Code the tests or examples can check → Copilot first, Codex if it fails; contest-style code → Copilot only when the difficulty classifier calls it easy, otherwise Codex first."
        case .saver: return "Copilot first for all checkable code, and untested code Decima calls easy. Fewer Codex calls, but slower and less accurate."
        }
    }
    static let line = #"(?m)^(\s*copilot_mode:\s*)([A-Za-z]+)"#

    public static func read(_ yaml: String) -> CopilotMode? {
        guard let r = yaml.range(of: line, options: .regularExpression) else { return nil }
        return CopilotMode(rawValue: String(yaml[r]).components(separatedBy: ":").last!.trimmingCharacters(in: .whitespaces))
    }
    /** The YAML with only the copilot_mode value replaced; nil if the policy has no such line. */
    public static func write(_ yaml: String, _ mode: CopilotMode) -> String? {
        guard let r = yaml.range(of: line, options: .regularExpression) else { return nil }
        let current = String(yaml[r])
        let prefix = current.replacingOccurrences(of: #"[A-Za-z]+$"#, with: "", options: .regularExpression)
        return yaml.replacingCharacters(in: r, with: prefix + mode.rawValue)
    }
    public static func policy(_ paths: OnBudPaths = OnBudPaths()) -> URL { paths.repo.appendingPathComponent("policies/routing.yaml") }
}
