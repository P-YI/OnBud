// Talks to the OpenAFM controller's OpenAI-compatible endpoint (bin/afm-agent-server.ts) on 127.0.0.1:11435.
// The controller keeps approvals (run this command? apply this edit?) per chat, keyed by project folder and
// first user message, so a conversation is the full message list and "yes"/"no" is just the next user turn.
import Foundation

public enum Setting: String, Sendable, CaseIterable {
    case s2, s3                      // S2 = AFM + tools; S3 = S2 + a router model (advise). Codex is a plugin (OpenCode).
    public var label: String { self == .s2 ? "AFM Agent" : "AFM + Router" }
    public var detail: String { self == .s2 ? "On-device AFM with local tools" : "AFM Agent, advised by a local router model" }
}

public struct ChatMessage: Sendable, Equatable, Codable {
    public var role: String          // "user" | "assistant"
    public var content: String
    public init(role: String, content: String) { self.role = role; self.content = content }
}

public enum StreamEvent: Sendable, Equatable {
    case text(String)
    /** A controller step while the request runs (launcher only): kind (route, seed, tool, answer…) and detail. */
    case step(String, String)
    /** Final chunk: what the controller now waits for (command, edit, apply, handoff, web, job, reveal) or nil. */
    case done(awaiting: String?)
}

public enum ClientError: Error, LocalizedError, Equatable {
    case noToken, busy, unauthorized, http(Int, String)
    public var errorDescription: String? {
        switch self {
        case .noToken: return "No token at ~/OpenAFM/config/apfel.token."
        case .busy: return "The AFM controller is busy with another request. Try again in a moment."
        case .unauthorized: return "The controller rejected the token (401)."
        case .http(let code, let body): return "Controller HTTP \(code): \(body.prefix(200))"
        }
    }
}

/** Parses one SSE line from the controller. Returns nil for keep-alives (": working"), blanks and [DONE]. */
public func parseSSELine(_ line: String) -> StreamEvent? {
    guard line.hasPrefix("data:") else { return nil }
    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
    guard payload != "[DONE]", let data = payload.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let choice = (obj["choices"] as? [[String: Any]])?.first else { return nil }
    if let finish = choice["finish_reason"] as? String, !finish.isEmpty {
        let meta = obj["openafm"] as? [String: Any]
        return .done(awaiting: meta?["awaiting"] as? String)
    }
    if let delta = choice["delta"] as? [String: Any], let text = delta["content"] as? String, !text.isEmpty {
        return .text(text)
    }
    if let step = (obj["openafm"] as? [String: Any])?["step"] as? String {
        return .step(step, ((obj["openafm"] as? [String: Any])?["detail"] as? String) ?? "")
    }
    return nil
}

/** Removes the controller's trailing "— AFM controller · route · reason · 1.2s" line, returning (body, meta). */
public func splitMeta(_ text: String) -> (body: String, meta: String?) {
    guard let r = text.range(of: "\n\n— ", options: .backwards) else { return (text, nil) }
    let meta = String(text[r.upperBound...])
    guard meta.hasPrefix("AFM controller") || meta.hasPrefix("codex") else { return (text, nil) }
    return (String(text[..<r.lowerBound]), meta)
}

public struct ControllerClient: Sendable {
    public let token: String
    public var setting: Setting
    public var web: Bool
    public var routerModel: String?   // s3: which installed router model advises (else the policy's decima_model)
    public init(token: String, setting: Setting, web: Bool = false, routerModel: String? = nil) {
        self.token = token; self.setting = setting; self.web = web; self.routerModel = routerModel
    }

    /** The controller reads the project folder from an OpenCode-style "Working directory:" line. */
    public static func systemPrompt(root: String?) -> String {
        "OpenAFM launcher.\n" + (root.map { "Working directory: \($0)\n" } ?? "")
    }

    public func request(messages: [ChatMessage], root: String?) throws -> URLRequest {
        var req = URLRequest(url: Backend.url(Port.controller, "/v1/chat/completions"), timeoutInterval: 900)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(setting.rawValue, forHTTPHeaderField: "x-openafm-setting")
        if web { req.setValue("on", forHTTPHeaderField: "x-openafm-web") }
        if setting == .s3, let m = routerModel { req.setValue(m, forHTTPHeaderField: "x-openafm-router-model") }
        let all: [[String: String]] = [["role": "system", "content": Self.systemPrompt(root: root)]]
            + messages.map { ["role": $0.role, "content": $0.content] }
        req.httpBody = try JSONSerialization.data(withJSONObject: ["model": "afm-controller", "stream": true, "messages": all])
        return req
    }

    public func stream(messages: [ChatMessage], root: String?) -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, resp) = try await URLSession.shared.bytes(for: try request(messages: messages, root: root))
                    let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    if code != 200 {
                        var body = ""
                        for try await line in bytes.lines { body += line; if body.count > 400 { break } }
                        throw code == 429 ? ClientError.busy : code == 401 ? ClientError.unauthorized : ClientError.http(code, body)
                    }
                    var finished = false
                    for try await line in bytes.lines {
                        guard let ev = parseSSELine(line) else { continue }
                        continuation.yield(ev)
                        if case .done = ev { finished = true }
                    }
                    if !finished { continuation.yield(.done(awaiting: nil)) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /** Non-streaming convenience for the smoke tool: full reply text plus what is awaited. */
    public func send(messages: [ChatMessage], root: String?) async throws -> (text: String, awaiting: String?) {
        var text = "", awaiting: String?
        for try await ev in stream(messages: messages, root: root) {
            switch ev { case .text(let t): text += t; case .done(let a): awaiting = a; case .step: break }
        }
        return (text, awaiting)
    }
}

/** A launcher conversation: the message list plus what the controller waits for. */
public struct Conversation: Sendable {
    public var messages: [ChatMessage] = []
    public var awaiting: String?
    public var root: String?
    public init(root: String?) { self.root = root }

    /** Kinds the panel answers with yes/no buttons (the controller's approve/deny flow). */
    public static let approvable: Set<String> = ["command", "edit", "apply", "web", "job"]
    public var needsApproval: Bool { awaiting.map { Self.approvable.contains($0) } ?? false }
    public var offersHandoff: Bool { awaiting == "handoff" }
}
