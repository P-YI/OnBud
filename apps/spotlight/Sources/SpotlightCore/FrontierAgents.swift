// The frontier models behind the controller's hand-offs and the "Send to Codex" button, in two tiers:
//   strong  OpenCode's agents codex (interactive), codex-handoff (read-only hand-off) and codex-solve
//           (self-contained problems); default GPT-6.1 Sol
//   cheap   codex-solve-cheap, the code skill's first escalation (kept only when a check passes); default
//           GPT-6.1 Terra
// The agent names say the role, not the model, so a newer model is one setting here, not a rename. Both tiers are
// defined in the global OpenCode config. The controller runs `opencode run --agent codex-handoff …` per hand-off, so a model
// set here applies to OpenCode and to OnBud's routing at once. Credentials stay in OpenCode
// (`opencode auth login` → ~/.local/share/opencode/auth.json); OnBud never reads or stores a key.
import Foundation

public enum FrontierAgents {
    public enum Tier: String, CaseIterable, Sendable, Identifiable {
        case strong, cheap
        public var id: String { rawValue }
        public var agents: [String] { self == .strong ? FrontierAgents.agents : FrontierAgents.cheapAgents }
        public var defaultModel: String { self == .strong ? "openai/gpt-6.1-sol" : "openai/gpt-6.1-terra" }
        public var label: String { self == .strong ? "Strong" : "Cheap" }
        public var detail: String {
            self == .strong ? "Hand-offs, Send to Codex, and code the cheap tier could not verify."
                            : "The code skill's first escalation; its answer is kept only when the examples pass or it agrees with Copilot's code."
        }
    }
    public static let agents = ["codex", "codex-handoff", "codex-solve"]
    public static let cheapAgents = ["codex-solve-cheap"]

    public struct Current: Equatable, Sendable {
        public var model: String?        // "openai/gpt-6.1-sol"
        public var variant: String?      // "medium"; nil = the model's default
        public var present: [String]     // which of `agents` the config defines
        public init(model: String?, variant: String?, present: [String]) { self.model = model; self.variant = variant; self.present = present }
    }

    public static func current(_ text: String, tier: Tier = .strong) -> Current {
        let parsed = try? JSONC.parse(text)
        let present = tier.agents.filter { a in parsed?["agent"]?[a] != nil }
        let main = present.first ?? tier.agents[0]
        return Current(model: JSONCEdit.string(text, ["agent", main, "model"]), variant: JSONCEdit.string(text, ["agent", main, "variant"]), present: present)
    }

    /** The config with every present agent of `tier` on `model` (and `variant`, nil = remove it). */
    public static func apply(_ text: String, model: String, variant: String?, tier: Tier = .strong) throws -> String {
        var out = text
        let present = current(text, tier: tier).present
        guard !present.isEmpty else {
            throw JSONCError(message: tier == .strong ? "the OpenCode config has no codex agents (link it in Settings first)"
                                                      : "the OpenCode config has no codex-solve-cheap agent (re-link it in Settings to get the current agents)", offset: 0)
        }
        for a in present {
            out = try JSONCEdit.setString(out, ["agent", a, "model"], model)
            if let v = variant { out = try JSONCEdit.setString(out, ["agent", a, "variant"], v) }
            else { out = try JSONCEdit.remove(out, ["agent", a, "variant"]) }
        }
        _ = try JSONC.parse(out)   // still valid
        return out
    }

    /** Writes through a symlink to the real file, after a backup next to it; refuses if the file changed since `expected`. */
    @discardableResult
    public static func write(_ new: String, to target: URL, expected: String) throws -> URL {
        let real = target.resolvingSymlinksInPath()
        let now = try String(contentsOf: real, encoding: .utf8)
        guard now == expected else { throw JSONCError(message: "the OpenCode config changed meanwhile; check again", offset: 0) }
        let f = DateFormatter(); f.dateFormat = "yyyyMMdd-HHmmss"
        let backup = real.deletingLastPathComponent().appendingPathComponent(real.lastPathComponent + ".afm-spotlight-backup-" + f.string(from: Date()))
        try FileManager.default.copyItem(at: real, to: backup)
        try new.write(to: real, atomically: true, encoding: .utf8)
        return backup
    }

    /** `opencode models` output → model ids by provider, without OnBud's own local providers. */
    public static func parseModels(_ out: String) -> [String: [String]] {
        var byProvider: [String: [String]] = [:]
        for line in out.components(separatedBy: "\n") {
            let m = line.trimmingCharacters(in: .whitespaces)
            guard let slash = m.firstIndex(of: "/"), !m.contains(" "), !m.isEmpty else { continue }
            let provider = String(m[..<slash])
            if provider == "afm" || provider == "afm-agent" { continue }
            byProvider[provider, default: []].append(m)
        }
        return byProvider
    }

    /** `opencode auth list` output → provider names with stored credentials (names only).
     *  1.x: "●  OpenAI oauth" rows in a box; 2.x: "OpenAI  OAuth  stored" columns. */
    public static func parseAuth(_ out: String) -> [String] {
        let clean = out.replacingOccurrences(of: #"\u001B\[[0-9;]*m"#, with: "", options: .regularExpression)
        let lines = clean.components(separatedBy: "\n")
        if clean.contains("●") {
            return lines.compactMap { line in
                guard let r = line.range(of: "●") else { return nil }
                let rest = line[r.upperBound...].trimmingCharacters(in: .whitespaces)
                return rest.components(separatedBy: " ").first.flatMap { $0.isEmpty ? nil : $0 }
            }
        }
        return lines.compactMap { line in
            let cols = line.trimmingCharacters(in: .whitespaces).components(separatedBy: "  ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            return cols.count >= 2 ? cols[0] : nil
        }
    }
}
