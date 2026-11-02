// Hands a request to Codex in OpenCode (the codex plugin), with OpenCode's own approvals and security gate:
//   desktop app installed → new session in its local service (agent "codex", project folder, the request as
//                           first prompt), then the app is brought forward with the session in its list
//   CLI only              → Terminal opens `opencode <folder> --agent codex --prompt <request>`
// The service's address and password come from ~/.local/state/opencode/service.json (mode 600, written
// by OpenCode); only a 127.0.0.1 address is accepted, as in services/controller/opencode-session.ts.
import Foundation

public enum HandoffResult: Equatable, Sendable {
    case desktopSession(String)      // session id
    case desktopNeedsService         // app installed, but its service is not up (app was just launched)
    case cli
    case failed(String)
}

public struct OpenCodeService: Sendable {
    public let url: URL
    let auth: String

    public static var stateFile: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/state/opencode/service.json")
    }

    public static func load() -> OpenCodeService? {
        guard let data = try? Data(contentsOf: stateFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let u = obj["url"] as? String, let pw = obj["password"] as? String, !pw.isEmpty,
              u.range(of: #"^http://127\.0\.0\.1:\d+$"#, options: .regularExpression) != nil,
              let url = URL(string: u) else { return nil }
        return OpenCodeService(url: url, auth: "Basic " + Data("opencode:\(pw)".utf8).base64EncodedString())
    }

    func post(_ path: String, _ body: [String: Any]) async throws -> (Int, Data) {
        var req = URLRequest(url: url.appendingPathComponent(path), timeoutInterval: 10)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(auth, forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
    }

    /** Creates a session in `dir` on `agent` and sends `text` as its first prompt. Returns the session id. */
    public func startSession(dir: String, agent: String, title: String, text: String) async throws -> String {
        let (code, data) = try await post("api/session", ["title": title, "agent": agent, "location": ["directory": dir]])
        guard code == 200 || code == 201, let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = ((obj["data"] as? [String: Any])?["id"] ?? obj["id"]) as? String,
              id.range(of: #"^ses_[A-Za-z0-9]{8,80}$"#, options: .regularExpression) != nil
        else { throw HandoffError("could not create the OpenCode session (HTTP \(code))") }
        let (pc, _) = try await post("api/session/\(id)/prompt", ["text": text])
        guard pc == 200 || pc == 201 || pc == 204 else { throw HandoffError("session created but the prompt was refused (HTTP \(pc))") }
        return id
    }
}

public struct HandoffError: Error, LocalizedError, Equatable {
    public let message: String
    public init(_ m: String) { message = m }
    public var errorDescription: String? { message }
}

public enum OpenCodeHandoff {
    /** The text Codex receives: the request plus where it came from. */
    public static func task(prompt: String, root: String?) -> String {
        prompt + "\n\n---\n(Sent from the OpenAFM launcher: the on-device AFM Agent judged this too big to do locally."
            + (root.map { " Project folder: \($0)." } ?? "") + ")"
    }

    /** A zsh script that opens the OpenCode CLI on the codex agent with the request. Arguments are single-quoted. */
    public static func cliScript(cli: String, dir: String, prompt: String) -> String {
        "#!/bin/zsh\ncd \(shellQuote(dir)) || exit 1\nexec \(shellQuote(cli)) \(shellQuote(dir)) --agent codex --prompt \(shellQuote(prompt))\n"
    }
}

public func shellQuote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
